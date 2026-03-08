import type { Logger } from "pino";
import { runProviderRequest } from "../utils/runProviderRequest.js";

export interface GeminiExecutionInput {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  model?: string;
}

export interface GeminiExecutionResult {
  text: string;
}

export class GeminiExecutionError extends Error {
  public readonly code: "GEMINI_UNAVAILABLE" | "GEMINI_DISABLED" | "NOT_AUTHENTICATED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT";

  public constructor(code: "GEMINI_UNAVAILABLE" | "GEMINI_DISABLED" | "NOT_AUTHENTICATED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT", message: string) {
    super(message);
    this.name = "GeminiExecutionError";
    this.code = code;
  }
}

export async function runGeminiRequest(input: GeminiExecutionInput, logger: Logger): Promise<GeminiExecutionResult> {
  const text = await runProviderRequest(
    input,
    {
      binary: "gemini",
      extraArgs: ["--yolo"],
      logLabel: "Gemini",
      makeError: (code, message) => new GeminiExecutionError(code as GeminiExecutionError["code"], message),
      unavailableCode: "GEMINI_UNAVAILABLE",
      notAuthenticatedCode: "NOT_AUTHENTICATED",
      authFailurePattern: /set an Auth method|authentication required|not authenticated|Enter the authorization code:/i,
      authHint: "Use `/gemini-auth` to authenticate.",
      timeoutCode: "TIMEOUT",
      failedCode: "FAILED",
      emptyOutputCode: "EMPTY_OUTPUT",
    },
    logger
  );
  return { text };
}
