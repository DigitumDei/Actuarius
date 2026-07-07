import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "pino";
import { runProviderRequest } from "../utils/runProviderRequest.js";

export const ALLOWED_OPENCODE_PROVIDERS = ["deepseek", "openai", "anthropic", "google", "xai", "groq", "openrouter", "together"] as const;
export const OPENCODE_AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json");

// opencode's `-f/--file` flag "attaches file(s) to the message" rather than
// replacing the message — so an oversized prompt delivered purely via --file
// with an empty message has undefined behavior (opencode may reject an empty
// message). We keep a short, explicit directive message that points at the
// attached file, which holds the full prompt. Robust regardless of whether
// opencode treats the file as the prompt or as attached context.
export const OPENCODE_TEMPFILE_DIRECTIVE =
  "Read the attached file and follow its full contents as your prompt.";

export interface OpencodeExecutionInput {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  model?: string;
  env?: NodeJS.ProcessEnv;
  role?: OpencodeExecutionRole;
}

export type OpencodeExecutionRole = "implementation" | "planner" | "verification";

export interface OpencodeExecutionResult {
  text: string;
}

export class OpencodeExecutionError extends Error {
  public readonly code: "OPENCODE_UNAVAILABLE" | "OPENCODE_DISABLED" | "NOT_AUTHENTICATED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT";
  public partialStdout?: string;
  public partialStderr?: string;

  public constructor(code: "OPENCODE_UNAVAILABLE" | "OPENCODE_DISABLED" | "NOT_AUTHENTICATED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT", message: string) {
    super(message);
    this.name = "OpencodeExecutionError";
    this.code = code;
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
  if (!(await hasOpencodeAuth()) && !(input.env?.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY)?.trim()) {
    throw new OpencodeExecutionError("NOT_AUTHENTICATED", "Opencode requires an API key. Use `/opencode-auth` to configure keys, or set `DEEPSEEK_API_KEY` on the instance.");
  }

  const role = input.role ?? "implementation";
  const agent = role === "implementation" ? "build" : `actuarius-${role}`;
  const extraArgs = ["--agent", agent, ...(role === "implementation" ? ["--dangerously-skip-permissions"] : [])];
  const request = role === "implementation"
    ? input
    : { ...input, env: buildRestrictedRoleEnvironment(input.env, role) };

  const text = await runProviderRequest(
    request,
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
          if (details.partialStdout) err.partialStdout = details.partialStdout;
          if (details.partialStderr) err.partialStderr = details.partialStderr;
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
  return { text };
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
