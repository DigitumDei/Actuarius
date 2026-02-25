import type { Logger } from "pino";
import { spawnCollect } from "../utils/spawnCollect.js";

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
  public readonly code: "GEMINI_UNAVAILABLE" | "GEMINI_DISABLED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT";

  public constructor(code: "GEMINI_UNAVAILABLE" | "GEMINI_DISABLED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT", message: string) {
    super(message);
    this.name = "GeminiExecutionError";
    this.code = code;
  }
}

export async function runGeminiRequest(input: GeminiExecutionInput, logger: Logger): Promise<GeminiExecutionResult> {
  const args = ["-p", input.prompt];
  if (input.model) {
    args.push("--model", input.model);
  }

  logger.debug({ args, cwd: input.cwd, timeoutMs: input.timeoutMs }, "Gemini subprocess args");

  try {
    const { stdout, stderr } = await spawnCollect("gemini", args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });

    if (stderr) {
      logger.debug({ stderr }, "Gemini subprocess stderr");
    }
    logger.debug({ stdoutLength: stdout.length }, "Gemini subprocess exited cleanly");

    const text = stdout.trim() || null;
    if (!text) {
      throw new GeminiExecutionError("EMPTY_OUTPUT", "Gemini returned empty output.");
    }

    return { text };
  } catch (error) {
    if (error instanceof GeminiExecutionError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Gemini execution failed.";
    const nodeError = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
    };

    logger.error({
      errorCode: nodeError.code,
      signal: nodeError.signal,
      killed: nodeError.killed,
      stderr: nodeError.stderr,
      stdoutPartial: nodeError.stdout?.slice(0, 500),
      message,
    }, "Gemini subprocess failed");

    if (nodeError.code === "ENOENT") {
      throw new GeminiExecutionError("GEMINI_UNAVAILABLE", "Gemini CLI is not installed or not available in PATH.");
    }

    if (
      nodeError.code === "ETIMEDOUT" ||
      (nodeError.killed === true && nodeError.signal === "SIGTERM") ||
      message.toLowerCase().includes("timed out")
    ) {
      throw new GeminiExecutionError("TIMEOUT", `Gemini execution timed out after ${input.timeoutMs}ms.`);
    }

    throw new GeminiExecutionError("FAILED", message);
  }
}
