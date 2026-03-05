import type { Logger } from "pino";
import { spawnCollect } from "./spawnCollect.js";

export interface ProviderRequestInput {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  model?: string;
}

export interface ProviderRunnerConfig {
  /** CLI binary name, e.g. "codex" or "gemini". */
  binary: string;
  /** Extra CLI flags inserted after `-p <prompt>`, e.g. ["--approval-mode", "full-auto"]. */
  extraArgs: string[];
  /** Human-readable label used in log messages, e.g. "Codex". */
  logLabel: string;
  makeError: (code: string, message: string) => Error;
  unavailableCode: string;
  timeoutCode: string;
  failedCode: string;
  emptyOutputCode: string;
}

/**
 * Generic CLI runner shared by Codex and Gemini execution services.
 * Spawns the binary, handles timeout/ENOENT/empty-output errors, and returns
 * trimmed stdout.
 */
export async function runProviderRequest(
  input: ProviderRequestInput,
  config: ProviderRunnerConfig,
  logger: Logger
): Promise<string> {
  const args = ["-p", input.prompt, ...config.extraArgs];
  if (input.model) {
    args.push("--model", input.model);
  }

  logger.debug({ args, cwd: input.cwd, timeoutMs: input.timeoutMs }, `${config.logLabel} subprocess args`);

  let stdout: string;
  let stderr: string;

  try {
    ({ stdout, stderr } = await spawnCollect(config.binary, args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : `${config.logLabel} execution failed.`;
    const nodeError = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
    };

    logger.error(
      {
        errorCode: nodeError.code,
        signal: nodeError.signal,
        killed: nodeError.killed,
        stderr: nodeError.stderr,
        stdoutPartial: nodeError.stdout?.slice(0, 500),
        message,
      },
      `${config.logLabel} subprocess failed`
    );

    if (nodeError.code === "ENOENT") {
      throw config.makeError(config.unavailableCode, `${config.logLabel} CLI is not installed or not available in PATH.`);
    }

    if (
      nodeError.code === "ETIMEDOUT" ||
      (nodeError.killed === true && nodeError.signal === "SIGTERM") ||
      message.toLowerCase().includes("timed out")
    ) {
      throw config.makeError(config.timeoutCode, `${config.logLabel} execution timed out after ${input.timeoutMs}ms.`);
    }

    throw config.makeError(config.failedCode, message);
  }

  if (stderr) {
    logger.debug({ stderr }, `${config.logLabel} subprocess stderr`);
  }
  logger.debug({ stdoutLength: stdout.length }, `${config.logLabel} subprocess exited cleanly`);

  const text = stdout.trim();
  if (!text) {
    throw config.makeError(config.emptyOutputCode, `${config.logLabel} returned empty output.`);
  }

  return text;
}
