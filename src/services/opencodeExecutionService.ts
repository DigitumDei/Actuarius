import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import type { Logger } from "pino";
import {
  runProviderRequest,
  type ProviderErrorDetails,
  type ProviderRequestInput,
  type ProviderTimeoutKind
} from "../utils/runProviderRequest.js";
import { spawnCollect } from "../utils/spawnCollect.js";
import { OPENCODE_TEMPFILE_DIRECTIVE } from "./llmPromptBuilders.js";

export { OPENCODE_TEMPFILE_DIRECTIVE };

export const ALLOWED_OPENCODE_PROVIDERS = ["deepseek", "openai", "anthropic", "google", "xai", "groq", "openrouter", "together"] as const;
export const OPENCODE_AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json");
const OPENAI_OPENCODE_AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const OPENAI_OPENCODE_AUTH_MAX_BUFFER = 4 * 1024 * 1024;

// opencode's `-f/--file` flag "attaches file(s) to the message" rather than
// replacing the message — so an oversized prompt delivered purely via --file
// with an empty message has undefined behavior (opencode may reject an empty
// message). We keep a short, explicit directive message that points at the
// attached file, which holds the full prompt. Robust regardless of whether
// opencode treats the file as the prompt or as attached context.
export interface OpencodeExecutionInput extends ProviderRequestInput {
  role?: OpencodeExecutionRole;
}

export interface OpencodeAgentExecutionInput extends ProviderRequestInput {
  agent: string;
  requiredSubagent?: string;
  sessionId?: string;
}

export type OpencodeExecutionRole = "implementation" | "planner" | "verification";

export interface OpencodeExecutionResult {
  text: string;
  completedSubagents?: string[];
  completedTasks?: CompletedOpencodeTask[];
  sessionId?: string | null;
}

export interface CompletedOpencodeTask {
  id: string;
  subagent: string;
  description?: string;
}

export interface ParsedOpencodeJsonEvents {
  text: string;
  completedSubagents: string[];
  completedTasks: CompletedOpencodeTask[];
  sessionId: string | null;
  diagnostics: string[];
}

export interface ParseOpencodeJsonEventsOptions {
  fallbackTaskIdPrefix?: string;
}

export class OpencodeExecutionError extends Error {
  public readonly code: "OPENCODE_UNAVAILABLE" | "OPENCODE_DISABLED" | "NOT_AUTHENTICATED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT";
  public partialStdout?: string;
  public partialStderr?: string;
  public timeoutKind?: ProviderTimeoutKind;
  public timeoutMs?: number;
  public providerSessionId?: string;
  public lastActivity?: string;

  public constructor(code: "OPENCODE_UNAVAILABLE" | "OPENCODE_DISABLED" | "NOT_AUTHENTICATED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT", message: string) {
    super(message);
    this.name = "OpencodeExecutionError";
    this.code = code;
  }
}

export interface OpenAIOpencodeAuthChallenge {
  url: string;
  code: string;
}

export interface OpenAIOpencodeAuthInput {
  cwd: string;
  onChallenge: (challenge: OpenAIOpencodeAuthChallenge) => void;
  timeoutMs?: number;
}

export function parseOpenAIOpencodeAuthChallenge(output: string): OpenAIOpencodeAuthChallenge | null {
  const normalized = stripVTControlCharacters(output);
  const candidateUrls = normalized.match(/https:\/\/[^\s<>()]+/gu) ?? [];
  const url = candidateUrls.find((candidate) => {
    try {
      const parsed = new URL(candidate);
      return parsed.protocol === "https:" && parsed.hostname === "auth.openai.com" && parsed.pathname === "/codex/device";
    } catch {
      return false;
    }
  });
  const code = /Enter code:\s*([A-Z0-9][A-Z0-9-]{3,})/iu.exec(normalized)?.[1];
  return url && code ? { url, code } : null;
}

async function hasSavedOpenAIOpencodeOAuthCredential(): Promise<boolean> {
  try {
    const raw = await readFile(OPENCODE_AUTH_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const credential = parsed.openai;
    if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
      return false;
    }

    const oauth = credential as Record<string, unknown>;
    return oauth.type === "oauth"
      && typeof oauth.access === "string"
      && oauth.access.trim().length > 0
      && typeof oauth.refresh === "string"
      && oauth.refresh.trim().length > 0
      && typeof oauth.expires === "number"
      && Number.isFinite(oauth.expires);
  } catch {
    return false;
  }
}

/**
 * Starts OpenCode's device-code flow for a ChatGPT Pro/Plus subscription.
 * The headless method is required because Actuarius normally runs remotely;
 * browser OAuth redirects to localhost on the machine opening the link.
 */
export async function authenticateOpenAIOpencode(input: OpenAIOpencodeAuthInput): Promise<void> {
  let challengeDelivered = false;

  const result = await spawnCollect(
    "opencode",
    [
      "providers",
      "login",
      "--provider",
      "OpenAI",
      "--method",
      "ChatGPT Pro/Plus (headless)"
    ],
    {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? OPENAI_OPENCODE_AUTH_TIMEOUT_MS,
      // Clack redraws its waiting spinner frequently for the entire device
      // flow. Keep enough headroom for the full ten-minute timeout.
      maxBuffer: OPENAI_OPENCODE_AUTH_MAX_BUFFER,
      maxStderrBuffer: 64 * 1024,
      onOutput: ({ stdout, stderr }) => {
        if (challengeDelivered) return;
        const challenge = parseOpenAIOpencodeAuthChallenge(`${stdout}\n${stderr}`);
        if (!challenge) return;
        challengeDelivered = true;
        input.onChallenge(challenge);
      }
    }
  );

  if (!challengeDelivered) {
    throw new Error("OpenCode completed without providing an OpenAI device authorization challenge.");
  }

  const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
  if (/Failed to authorize/iu.test(output)) {
    throw new Error("OpenCode failed to authorize the OpenAI subscription.");
  }

  if (!(await hasSavedOpenAIOpencodeOAuthCredential())) {
    throw new Error("OpenCode completed without saving a valid OpenAI OAuth credential.");
  }
}

export async function hasOpencodeAuth(): Promise<boolean> {
  if (existsSync(OPENCODE_AUTH_PATH)) {
    try {
      const raw = await readFile(OPENCODE_AUTH_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed === "object" && parsed !== null && Object.keys(parsed).length > 0) {
        return true;
      }
    } catch {
      // Malformed file — deem it absent
    }
  }

  return false;
}

export async function runOpencodeRequest(input: OpencodeExecutionInput, logger: Logger): Promise<OpencodeExecutionResult> {
  await assertOpencodeAuthenticated(input.env);

  const role = input.role ?? "implementation";
  const agent = role === "implementation" ? "build" : `actuarius-${role}`;
  const extraArgs = ["--agent", agent];
  const request = role === "implementation"
    ? { ...input, env: buildRestrictedImplementationEnvironment(input.env) }
    : { ...input, env: buildRestrictedRoleEnvironment(input.env, role) };

  return { text: await runOpencodeCommand(request, extraArgs, logger) };
}

export async function runOpencodeAgentRequest(
  input: OpencodeAgentExecutionInput,
  logger: Logger
): Promise<OpencodeExecutionResult> {
  await assertOpencodeAuthenticated(input.env);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(input.agent)) {
    throw new OpencodeExecutionError("FAILED", `Invalid managed OpenCode agent name: ${input.agent}`);
  }

  const { agent, requiredSubagent, sessionId, ...request } = input;
  const rawOutput = await runOpencodeCommand(
    request,
    [
      "--agent",
      agent,
      "--format",
      "json",
      ...(sessionId ? ["--session", sessionId] : [])
    ],
    logger
  );
  const parsed = parseOpencodeJsonEvents(rawOutput, {
    ...(input.diagnostics?.segment !== undefined
      ? { fallbackTaskIdPrefix: `segment-${String(input.diagnostics.segment)}` }
      : {})
  });

  if (parsed.diagnostics.length > 0) {
    throw new OpencodeExecutionError(
      "FAILED",
      `OpenCode emitted non-JSON diagnostic output, so the managed primary agent selection could not be verified: ${parsed.diagnostics[0]}`
    );
  }

  const completedRequiredTasks = requiredSubagent
    ? parsed.completedSubagents.filter((subagent) => subagent === requiredSubagent).length
    : 0;
  if (requiredSubagent && completedRequiredTasks === 0) {
    throw new OpencodeExecutionError(
      "FAILED",
      `OpenCode primary agent did not complete the required \`${requiredSubagent}\` subagent task.`
    );
  }
  if (!parsed.text) {
    throw new OpencodeExecutionError("EMPTY_OUTPUT", "OpenCode primary agent returned no final text output.");
  }

  return {
    text: parsed.text,
    completedSubagents: parsed.completedSubagents,
    completedTasks: parsed.completedTasks,
    sessionId: parsed.sessionId
  };
}

export function parseOpencodeJsonEvents(
  output: string,
  options: ParseOpencodeJsonEventsOptions = {}
): ParsedOpencodeJsonEvents {
  const textParts: string[] = [];
  const completedSubagents: string[] = [];
  const completedTasks: CompletedOpencodeTask[] = [];
  const completedTaskKeys = new Set<string>();
  const diagnostics: string[] = [];
  let sessionId: string | null = null;

  for (const [lineIndex, line] of output.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed) as unknown;
    } catch {
      diagnostics.push(stripVTControlCharacters(trimmed).slice(0, 500));
      continue;
    }
    if (!isRecord(event)) continue;

    const part = isRecord(event.part) ? event.part : null;
    const eventSessionId = typeof event.sessionID === "string"
      ? event.sessionID
      : part && typeof part.sessionID === "string" ? part.sessionID : null;
    if (eventSessionId) {
      sessionId = eventSessionId;
    }
    if (event.type === "text" && part && typeof part.text === "string" && part.text.trim()) {
      textParts.push(part.text.trim());
      continue;
    }

    if (event.type !== "tool_use" || !part || part.tool !== "task") continue;
    const state = isRecord(part.state) ? part.state : null;
    const taskInput = state && isRecord(state.input) ? state.input : null;
    if (state?.status === "completed" && taskInput && typeof taskInput.subagent_type === "string") {
      const fallbackTaskId = `line-${lineIndex}`;
      const taskId = typeof part.id === "string"
        ? part.id
        : options.fallbackTaskIdPrefix
          ? `${options.fallbackTaskIdPrefix}:${fallbackTaskId}`
          : fallbackTaskId;
      const taskKey = `${taskInput.subagent_type}\u0000${taskId}`;
      if (!completedTaskKeys.has(taskKey)) {
        completedTaskKeys.add(taskKey);
        completedSubagents.push(taskInput.subagent_type);
        completedTasks.push({
          id: taskId,
          subagent: taskInput.subagent_type,
          ...(typeof taskInput.description === "string" && taskInput.description.trim()
            ? { description: taskInput.description.trim() }
            : {})
        });
      }
    }
  }

  return {
    text: textParts.join("\n\n").trim(),
    completedSubagents,
    completedTasks,
    sessionId,
    diagnostics
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertOpencodeAuthenticated(env: NodeJS.ProcessEnv | undefined): Promise<void> {
  if (!(await hasOpencodeAuth()) && !(env?.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY)?.trim()) {
    throw new OpencodeExecutionError("NOT_AUTHENTICATED", "Opencode requires an API key. Use `/opencode-auth` to configure keys, or set `DEEPSEEK_API_KEY` on the instance.");
  }
}

async function runOpencodeCommand(
  input: OpencodeExecutionInput,
  extraArgs: string[],
  logger: Logger
): Promise<string> {
  return runProviderRequest(
    input,
    {
      binary: "opencode",
      prefixArgs: ["run"],
      positionalPrompt: true,
      cwdFlag: "--dir",
      extraArgs,
      supportsStdinFallback: false,
      reshapeArgsForTempfile: (_promptText: string, adjustedArgs: string[], tempFilePath: string) => {
        // Re-insert a short directive message (the full prompt lives in the
        // attached file) right after the `run` subcommand so opencode always
        // has a non-empty, unambiguous instruction; then attach the file with
        // `--file` before the role flags (order preserved).
        const runIdx = adjustedArgs.indexOf("run");
        const withMessage = [...adjustedArgs];
        withMessage.splice(runIdx >= 0 ? runIdx + 1 : 0, 0, OPENCODE_TEMPFILE_DIRECTIVE);

        const roleFlagIdx = withMessage.indexOf("--agent");
        if (roleFlagIdx === -1) {
          return [...withMessage, "--file", tempFilePath];
        }
        return [
          ...withMessage.slice(0, roleFlagIdx),
          "--file", tempFilePath,
          ...withMessage.slice(roleFlagIdx),
        ];
      },
      logLabel: "OpenCode",
      makeError: (code, message, details) => {
        const err = new OpencodeExecutionError(code as OpencodeExecutionError["code"], message);
        if (details) {
          Object.assign(err, details satisfies ProviderErrorDetails);
        }
        return err;
      },
      unavailableCode: "OPENCODE_UNAVAILABLE",
      timeoutCode: "TIMEOUT",
      failedCode: "FAILED",
      emptyOutputCode: "EMPTY_OUTPUT",
    },
    logger
  );
}

function buildRestrictedImplementationEnvironment(
  inputEnv: NodeJS.ProcessEnv | undefined
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = inputEnv ? { ...inputEnv } : { ...process.env };
  let inlineConfig: Record<string, unknown> = {};
  const currentInlineConfig = env.OPENCODE_CONFIG_CONTENT;
  if (currentInlineConfig) {
    try {
      const parsed = JSON.parse(currentInlineConfig) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        inlineConfig = parsed as Record<string, unknown>;
      }
    } catch {
      // Replace malformed inline configuration with the supervised build role.
    }
  }

  const configuredAgents = typeof inlineConfig.agent === "object" && inlineConfig.agent !== null && !Array.isArray(inlineConfig.agent)
    ? inlineConfig.agent as Record<string, unknown>
    : {};

  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...inlineConfig,
    agent: {
      ...configuredAgents,
      build: {
        description: "Actuarius implementation agent. Work directly; nested agents and interactive questions are denied.",
        mode: "primary",
        permission: {
          "*": "allow",
          question: "deny",
          external_directory: "deny",
          task: "deny",
          bash: {
            "*": "allow",
            "git push*": "deny",
            "git reset --hard*": "deny",
            "gh pr*": "deny"
          }
        }
      }
    }
  });
  return env;
}

// Role restriction is enforced only for the OpenCode provider; other providers
// accept `role` but ignore it. This relies on opencode's OPENCODE_CONFIG_CONTENT
// inline-config env var (second-highest config precedence) and per-agent
// permission maps with a "*" wildcard. Both must exist in the seeded opencode
// CLI — an older CLI would ignore this config and run the restricted roles as a
// default agent that stalls on interactive permission prompts until timeout,
// because --dangerously-skip-permissions is deliberately omitted here.
// Note: opencode does NOT apply {env:}/{file:} token substitution to inline
// config, so only literal values may be written into this JSON.
function buildRestrictedRoleEnvironment(
  inputEnv: NodeJS.ProcessEnv | undefined,
  role: Exclude<OpencodeExecutionRole, "implementation">
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = inputEnv ? { ...inputEnv } : { ...process.env };
  let inlineConfig: Record<string, unknown> = {};
  const currentInlineConfig = env.OPENCODE_CONFIG_CONTENT;
  if (currentInlineConfig) {
    try {
      const parsed = JSON.parse(currentInlineConfig) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        inlineConfig = parsed as Record<string, unknown>;
      }
    } catch {
      // Replace malformed inline configuration with a valid restrictive role.
    }
  }

  const configuredAgents = typeof inlineConfig.agent === "object" && inlineConfig.agent !== null && !Array.isArray(inlineConfig.agent)
    ? inlineConfig.agent as Record<string, unknown>
    : {};
  const agentName = `actuarius-${role}`;
  const permission: Record<string, "allow" | "deny"> = role === "planner"
    ? {
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      lsp: "allow"
    }
    : { "*": "deny" };

  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...inlineConfig,
    agent: {
      ...configuredAgents,
      [agentName]: {
        description: role === "planner"
          ? "Read-only Actuarius planner. Shell, edits, installs, and subagents are denied."
          : "Actuarius task verifier. All tools are denied; assess only the supplied output and diff.",
        mode: "primary",
        permission
      }
    }
  });
  return env;
}
