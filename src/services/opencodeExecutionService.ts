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

export async function runOpencodeRequest(input: OpencodeExecutionInput, logger: Logger): Promise<OpencodeExecutionResult> {
  if (!process.env.DEEPSEEK_API_KEY?.trim()) {
    throw new OpencodeExecutionError("NOT_AUTHENTICATED", "Opencode requires `DEEPSEEK_API_KEY` to be set for DeepSeek API access.");
  }

  // opencode --model expects bare model IDs (e.g. deepseek-v4-pro) without a provider prefix.
  // Omitting --model lets opencode use its configured default model.
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
      authHint: "Set `DEEPSEEK_API_KEY` to a valid DeepSeek API key.",
      timeoutCode: "TIMEOUT",
      failedCode: "FAILED",
      emptyOutputCode: "EMPTY_OUTPUT",
    },
    logger
  );
  return { text };
}
