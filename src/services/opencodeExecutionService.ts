import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "pino";
import { runProviderRequest } from "../utils/runProviderRequest.js";

export interface OpencodeExecutionInput {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  model?: string;
  env?: NodeJS.ProcessEnv;
}

export interface OpencodeExecutionResult {
  text: string;
}

export class OpencodeExecutionError extends Error {
  public readonly code: "OPENCODE_UNAVAILABLE" | "OPENCODE_DISABLED" | "NOT_AUTHENTICATED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT";

  public constructor(code: "OPENCODE_UNAVAILABLE" | "OPENCODE_DISABLED" | "NOT_AUTHENTICATED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT", message: string) {
    super(message);
    this.name = "OpencodeExecutionError";
    this.code = code;
  }
}

const OPENCODE_AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json");

export function hasOpencodeAuth(): boolean {
  if (existsSync(OPENCODE_AUTH_PATH)) {
    try {
      const raw = readFileSync(OPENCODE_AUTH_PATH, "utf-8");
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
  if (!hasOpencodeAuth() && !(input.env?.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY)?.trim()) {
    throw new OpencodeExecutionError("NOT_AUTHENTICATED", "Opencode requires an API key. Use `/opencode-auth` to configure keys, or set `DEEPSEEK_API_KEY` on the instance.");
  }

  const text = await runProviderRequest(
    input,
    {
      binary: "opencode",
      prefixArgs: ["run"],
      positionalPrompt: true,
      extraArgs: ["--dangerously-skip-permissions"],
      logLabel: "OpenCode",
      makeError: (code, message) => new OpencodeExecutionError(code as OpencodeExecutionError["code"], message),
      unavailableCode: "OPENCODE_UNAVAILABLE",
      notAuthenticatedCode: "NOT_AUTHENTICATED",
      authFailurePattern: /not authenticated|API key not found|authentication required|set an Auth method/i,
      authHint: "Use `/opencode-auth` to configure API keys.",
      timeoutCode: "TIMEOUT",
      failedCode: "FAILED",
      emptyOutputCode: "EMPTY_OUTPUT",
    },
    logger
  );
  return { text };
}
