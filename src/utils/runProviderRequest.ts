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
  /** Args inserted before the prompt (e.g. ["exec"] for `codex exec <prompt>`). */
  prefixArgs?: string[];
  /** Extra CLI flags inserted after the prompt args. */
  extraArgs: string[];
  /** If true, pass the prompt as a positional arg instead of `-p <prompt>`. */
  positionalPrompt?: boolean;
  /** Human-readable label used in log messages, e.g. "Codex". */
  logLabel: string;
  makeError: (code: string, message: string) => Error;
  unavailableCode: string;
  notAuthenticatedCode?: string;
  /** Regex tested against stderr to detect authentication failures. */
  authFailurePattern?: RegExp;
  /** User-facing hint appended to the auth failure message (e.g. "Use `/codex-auth` to upload credentials."). */
  authHint?: string;
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
  const prefix = config.prefixArgs ?? [];
  const args = config.positionalPrompt
    ? [...prefix, input.prompt, ...config.extraArgs]
    : [...prefix, "-p", input.prompt, ...config.extraArgs];
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

    if (config.authFailurePattern && config.notAuthenticatedCode) {
      const combined = [nodeError.stderr, nodeError.stdout, message].filter(Boolean).join("\n");
      if (config.authFailurePattern.test(combined)) {
        const hint = config.authHint ? ` ${config.authHint}` : "";
        logger.warn({ stderr: nodeError.stderr, stdout: nodeError.stdout?.slice(0, 1000) }, `${config.logLabel} auth failure pattern matched on process error — logging output to assist diagnosis`);
        throw config.makeError(config.notAuthenticatedCode, `${config.logLabel} is not authenticated.${hint}`);
      }
    }

    if (nodeError.code === "EMSGSIZE") {
      throw config.makeError(config.failedCode, `${config.logLabel} output exceeded the buffer limit.`);
    }

    if (
      nodeError.code === "ETIMEDOUT" ||
      (nodeError.killed === true && nodeError.signal === "SIGTERM") ||
      message.toLowerCase().includes("timed out")
    ) {
      throw config.makeError(config.timeoutCode, `${config.logLabel} execution timed out after ${input.timeoutMs}ms.`);
    }

    const stderrLines = nodeError.stderr?.trim().split("\n") ?? [];
    const stderrHint = [...stderrLines].reverse().find(
      (line: string) => line.trim().length > 0 && !line.includes("[object Object]")
    );
    const detail = stderrHint ? `${message}: ${stderrHint}` : message;
    throw config.makeError(config.failedCode, detail);
  }

  if (stderr) {
    logger.debug({ stderr }, `${config.logLabel} subprocess stderr`);
  }
  logger.debug({ stdoutLength: stdout.length }, `${config.logLabel} subprocess exited cleanly`);

  // Detect auth prompts that the CLI printed to stdout instead of producing real output
  if (config.authFailurePattern && config.notAuthenticatedCode) {
    const combined = [stdout, stderr].join("\n");
    if (config.authFailurePattern.test(combined)) {
      const hint = config.authHint ? ` ${config.authHint}` : "";
      logger.warn({ stdout: stdout.slice(0, 1000), stderr }, `${config.logLabel} auth failure pattern matched on clean exit — logging output to assist diagnosis`);
      throw config.makeError(config.notAuthenticatedCode, `${config.logLabel} is not authenticated.${hint}`);
    }
  }

  const text = stdout.trim();
  if (!text) {
    throw config.makeError(config.emptyOutputCode, `${config.logLabel} returned empty output.`);
  }

  return text;
}
