import type { Logger } from "pino";
import { spawnCollect, spawnCollectWithTransport, estimateSpawnPayloadBytes, DEFAULT_ARGV_TOTAL_LIMIT } from "./spawnCollect.js";

export interface ProviderRequestInput {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  model?: string;
  env?: NodeJS.ProcessEnv;
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
  /**
   * If set, inject `[cwdFlag, input.cwd]` immediately after prefixArgs.
   * Use for CLIs that don't honor the process cwd as their project root —
   * notably opencode, which resolves project context via `.git` and gets
   * confused by git worktrees.
   */
  cwdFlag?: string;
  /** Human-readable label used in log messages, e.g. "Codex". */
  logLabel: string;
  makeError: (code: string, message: string) => Error;
  unavailableCode: string;
  notAuthenticatedCode?: string;
  /** Regex tested against stderr to detect authentication failures. */
  authFailurePattern?: RegExp;
  /**
   * If true, the clean-exit auth failure check tests only stderr (not stdout).
   * Use for agentic CLIs whose stdout is task output and may contain arbitrary
   * subprocess text (e.g. OpenCode running `gemini` commands as part of a task).
   */
  authCheckOnlyStderr?: boolean;
  /** User-facing hint appended to the auth failure message (e.g. "Use `/codex-auth` to upload credentials."). */
  authHint?: string;
  timeoutCode: string;
  failedCode: string;
  emptyOutputCode: string;
  /**
   * Whether the CLI accepts prompt input via stdin when the payload
   * exceeds `DEFAULT_ARGV_TOTAL_LIMIT`.  Defaults to `true` (stdin is
   * attempted) when not set; set to `false` for providers that haven't
   * confirmed stdin compatibility or whose CLI rejects piped input.
   */
  supportsStdinFallback?: boolean;
  /**
   * Flag args for file-based input when stdin is unavailable
   * (e.g. `["--prompt-file", "<path>"]`). Any arg equal to
   * `TEMP_FILE_PATH_PLACEHOLDER` is replaced with the real temp-file path
   * by `spawnCollectWithTransport`.
   */
  tempfileFlag?: string[];
  /**
   * Optional callback for provider-specific argument reshaping when using
   * tempfile transport. Called after the temp file has been written, with
   * the prompt text, the adjusted args (prompt removed), and the resolved
   * temp file path. When provided, this takes priority over `tempfileFlag`
   * placeholder replacement in `spawnCollectWithTransport`. Use this when
   * the provider needs to attach the file via existing CLI flags in a
   * way the simple placeholder mechanism cannot express.
   */
  reshapeArgsForTempfile?: (promptText: string, adjustedArgs: string[], tempFilePath: string) => string[];
  /**
   * Optional output transformation applied to stdout before returning.
   * Used for CLIs that return structured output (e.g., JSON) instead of
   * plain text. Applied after auth-pattern checks on the raw output.
   */
  transformOutput?: (stdout: string) => string;
}

/**
 * Generic CLI runner shared by Codex and Gemini execution services.
 * Spawns the binary, handles timeout/ENOENT/empty-output errors, and returns
 * trimmed stdout.  Uses transport-aware spawning to move oversized prompts
 * from argv to stdin or a temp file when the payload exceeds
 * `DEFAULT_ARGV_TOTAL_LIMIT`.
 */
export async function runProviderRequest(
  input: ProviderRequestInput,
  config: ProviderRunnerConfig,
  logger: Logger
): Promise<string> {
  const prefix = config.prefixArgs ?? [];
  const cwdArgs = config.cwdFlag ? [config.cwdFlag, input.cwd] : [];
  const args = config.positionalPrompt
    ? [...prefix, ...cwdArgs, input.prompt, ...config.extraArgs]
    : [...prefix, ...cwdArgs, "-p", input.prompt, ...config.extraArgs];
  if (input.model) {
    args.push("--model", input.model);
  }

  logger.debug({ args, cwd: input.cwd, timeoutMs: input.timeoutMs }, `${config.logLabel} subprocess args`);

  // Calculate which indices in `args` contain the prompt text (and its flag)
  const promptStartIdx = prefix.length + (config.cwdFlag ? 2 : 0);
  const promptArgIndices: number[] = config.positionalPrompt
    ? [promptStartIdx]
    : [promptStartIdx, promptStartIdx + 1];

  const totalBytes = estimateSpawnPayloadBytes(args, input.env);

  // For providers using the -p <prompt> flag-pair pattern with stdin fallback,
  // keep the -p flag in args with an empty value and pipe the actual prompt via
  // stdin (the CLI appends stdin content to the -p value, e.g. Gemini).
  // This bypasses spawnCollectWithTransport's prompt-removal behavior which
  // would remove -p entirely, breaking headless mode.
  const useFlagPairStdin = !config.positionalPrompt
    && config.supportsStdinFallback !== false
    && totalBytes > DEFAULT_ARGV_TOTAL_LIMIT;

  let stdout: string;
  let stderr: string;

  try {
    if (useFlagPairStdin) {
      const stdinArgs = [
        ...prefix,
        ...cwdArgs,
        "-p",
        "",
        ...config.extraArgs,
      ];
      if (input.model) {
        stdinArgs.push("--model", input.model);
      }
      logger.info(
        {
          args: stdinArgs,
          stdinLength: input.prompt.length,
          transport: "stdin" as const,
          transportReason: "oversized_flag_pair_stdin" as const,
          totalBytes,
          limitBytes: DEFAULT_ARGV_TOTAL_LIMIT,
          useFlagPairStdin: true,
          logLabel: config.logLabel,
        },
        `${config.logLabel} oversized prompt via -p "" + stdin (${Math.round(totalBytes / 1024)} KB of ${Math.round(DEFAULT_ARGV_TOTAL_LIMIT / 1024)} KB threshold)`,
      );
      const result = await spawnCollect(config.binary, stdinArgs, {
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        ...(input.env ? { env: input.env } : {}),
        stdin: input.prompt,
      });
      ({ stdout, stderr } = result);
    } else {
      ({ stdout, stderr } = await spawnCollectWithTransport({
        file: config.binary,
        args,
        promptArgIndices,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        logger,
        logLabel: config.logLabel,
        ...(input.env ? { env: input.env } : {}),
        ...(config.supportsStdinFallback !== undefined ? { supportsStdinFallback: config.supportsStdinFallback } : {}),
        ...(config.tempfileFlag !== undefined ? { tempfileFlag: config.tempfileFlag } : {}),
        ...(config.reshapeArgsForTempfile !== undefined ? { reshapeArgsForTempfile: config.reshapeArgsForTempfile } : {}),
      }));
    }
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
      const combined = [
        nodeError.stderr,
        ...(config.authCheckOnlyStderr ? [] : [nodeError.stdout]),
        message,
      ].filter(Boolean).join("\n");
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

  // Detect auth prompts that the CLI printed to stdout instead of producing real output.
  // For agentic CLIs (authCheckOnlyStderr=true), skip stdout — it's task output and may
  // contain text from subprocesses the agent ran, causing false positives.
  if (config.authFailurePattern && config.notAuthenticatedCode) {
    const combined = config.authCheckOnlyStderr ? stderr : [stdout, stderr].join("\n");
    if (config.authFailurePattern.test(combined)) {
      const hint = config.authHint ? ` ${config.authHint}` : "";
      logger.warn({ stdout: stdout.slice(0, 1000), stderr }, `${config.logLabel} auth failure pattern matched on clean exit — logging output to assist diagnosis`);
      throw config.makeError(config.notAuthenticatedCode, `${config.logLabel} is not authenticated.${hint}`);
    }
  }

  // Apply optional output transformation (e.g. JSON parsing for Claude)
  if (config.transformOutput) {
    stdout = config.transformOutput(stdout);
  }

  const text = stdout.trim();
  if (!text) {
    throw config.makeError(config.emptyOutputCode, `${config.logLabel} returned empty output.`);
  }

  return text;
}
