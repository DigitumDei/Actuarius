import type { Logger } from "pino";
import { runProviderRequest, type ProviderErrorDetails, type ProviderRequestInput, type ProviderTimeoutKind } from "../utils/runProviderRequest.js";

export interface CodexExecutionInput extends ProviderRequestInput {}

export interface CodexExecutionResult {
  text: string;
}

export class CodexExecutionError extends Error {
  public readonly code: "CODEX_UNAVAILABLE" | "CODEX_DISABLED" | "NOT_AUTHENTICATED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT";
  public partialStdout?: string;
  public partialStderr?: string;
  public timeoutKind?: ProviderTimeoutKind;
  public timeoutMs?: number;
  public providerSessionId?: string;
  public lastActivity?: string;

  public constructor(code: "CODEX_UNAVAILABLE" | "CODEX_DISABLED" | "NOT_AUTHENTICATED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT", message: string) {
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
      extraArgs: ["--dangerously-bypass-approvals-and-sandbox"],
      // Verified contract (`codex exec --help`): "if not provided as an argument
      // … instructions are read from stdin". The oversized path removes the
      // positional prompt and pipes it via stdin — exactly this contract.
      supportsStdinFallback: true,
      logLabel: "Codex",
      makeError: (code, message, details) => {
        const err = new CodexExecutionError(code as CodexExecutionError["code"], message);
        if (details) {
          Object.assign(err, details satisfies ProviderErrorDetails);
        }
        return err;
      },
      unavailableCode: "CODEX_UNAVAILABLE",
      timeoutCode: "TIMEOUT",
      failedCode: "FAILED",
      emptyOutputCode: "EMPTY_OUTPUT",
    },
    logger
  );
  return { text };
}
