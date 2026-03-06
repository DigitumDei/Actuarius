import type { Logger } from "pino";
import { runProviderRequest } from "../utils/runProviderRequest.js";

export interface CodexExecutionInput {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  model?: string;
}

export interface CodexExecutionResult {
  text: string;
}

export class CodexExecutionError extends Error {
  public readonly code: "CODEX_UNAVAILABLE" | "CODEX_DISABLED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT";

  public constructor(code: "CODEX_UNAVAILABLE" | "CODEX_DISABLED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT", message: string) {
    super(message);
    this.name = "CodexExecutionError";
    this.code = code;
  }
}

export async function runCodexRequest(input: CodexExecutionInput, logger: Logger): Promise<CodexExecutionResult> {
  const text = await runProviderRequest(
    input,
    {
      binary: "codex",
      prefixArgs: ["exec"],
      positionalPrompt: true,
      extraArgs: [],
      logLabel: "Codex",
      makeError: (code, message) => new CodexExecutionError(code as CodexExecutionError["code"], message),
      unavailableCode: "CODEX_UNAVAILABLE",
      timeoutCode: "TIMEOUT",
      failedCode: "FAILED",
      emptyOutputCode: "EMPTY_OUTPUT",
    },
    logger
  );
  return { text };
}
