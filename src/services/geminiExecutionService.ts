import type { Logger } from "pino";
import { runProviderRequest } from "../utils/runProviderRequest.js";

export interface GeminiExecutionInput {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  model?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onActivity?: () => void;
}

export interface GeminiExecutionResult {
  text: string;
}

export class GeminiExecutionError extends Error {
  public readonly code: "GEMINI_UNAVAILABLE" | "GEMINI_DISABLED" | "NOT_AUTHENTICATED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT";
  public partialStdout?: string;
  public partialStderr?: string;

  public constructor(code: "GEMINI_UNAVAILABLE" | "GEMINI_DISABLED" | "NOT_AUTHENTICATED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT", message: string) {
    super(message);
    this.name = "GeminiExecutionError";
    this.code = code;
  }
}

export async function runGeminiRequest(input: GeminiExecutionInput, logger: Logger): Promise<GeminiExecutionResult> {
  if (!process.env.GEMINI_API_KEY?.trim()) {
    throw new GeminiExecutionError("NOT_AUTHENTICATED", "Gemini requires `GEMINI_API_KEY` to be set for API-key-based authentication.");
  }

  const text = await runProviderRequest(
    input,
    {
      binary: "gemini",
      extraArgs: ["--yolo"],
      // Verified contract (`gemini --help`): "-p/--prompt … Appended to input on
      // stdin (if any)." The oversized path keeps `-p ""` and pipes the prompt
      // via stdin, so the empty -p value plus stdin yields exactly the prompt.
      supportsStdinFallback: true,
      logLabel: "Gemini",
      makeError: (code, message, details) => {
        const err = new GeminiExecutionError(code as GeminiExecutionError["code"], message);
        if (details) {
          if (details.partialStdout) err.partialStdout = details.partialStdout;
          if (details.partialStderr) err.partialStderr = details.partialStderr;
        }
        return err;
      },
      unavailableCode: "GEMINI_UNAVAILABLE",
      notAuthenticatedCode: "NOT_AUTHENTICATED",
      authFailurePattern: /set an Auth method|authentication required|not authenticated|Enter the authorization code:/i,
      authHint: "Set `GEMINI_API_KEY` to a valid Gemini API key.",
      timeoutCode: "TIMEOUT",
      failedCode: "FAILED",
      emptyOutputCode: "EMPTY_OUTPUT",
    },
    logger
  );
  return { text };
}
