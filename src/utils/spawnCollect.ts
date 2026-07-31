import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "pino";

// ── Byte estimation helpers ──────────────────────────────────────────────

/**
 * Estimate total byte size of an argv array as the kernel would sum it
 * for ARG_MAX accounting. Each string is counted as its UTF-8 byte length
 * plus one byte for the null terminator.
 */
export function estimateArgvBytes(args: string[]): number {
  let total = 0;
  for (const arg of args) {
    total += Buffer.byteLength(arg, "utf-8") + 1;
  }
  return total;
}

/**
 * Estimate total byte size of an environment block as the kernel would sum it
 * for ARG_MAX accounting. Each entry is counted as `key=value` in UTF-8 bytes
 * plus one byte for the null terminator. Undefined values are skipped.
 */
export function estimateEnvBytes(env?: NodeJS.ProcessEnv): number {
  if (!env) return 0;
  let total = 0;
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (value !== undefined) {
      total += Buffer.byteLength(key, "utf-8") + 1; // key + '='
      total += Buffer.byteLength(value, "utf-8") + 1; // value + null
    }
  }
  return total;
}

/**
 * Combined byte size of argv + environment for spawn payload estimation.
 */
export function estimateSpawnPayloadBytes(args: string[], env?: NodeJS.ProcessEnv): number {
  return estimateArgvBytes(args) + estimateEnvBytes(env);
}

// ── Shared safety threshold ──────────────────────────────────────────────

/**
 * Safety threshold for total spawn payload (argv + env bytes).
 * Set at 1.5 MB to leave headroom below typical Linux ARG_MAX (2 MB).
 */
export const DEFAULT_ARGV_TOTAL_LIMIT = 1.5 * 1024 * 1024; // 1.5 MB

/**
 * Per-argument safety threshold.
 *
 * Linux `execve` enforces a SECOND limit independent of the ARG_MAX total:
 * `MAX_ARG_STRLEN` = `32 * PAGE_SIZE` = 131072 bytes (128 KB on 4 KB-page
 * systems) caps the length of any *single* argv or env string. A single
 * oversized prompt argument therefore triggers `E2BIG` long before the 1.5 MB
 * total threshold is reached — and a prompt in the 128 KB–1.5 MB band is the
 * most common real case. We move the prompt off argv when any single argument
 * approaches this cap, leaving ~6 KB of headroom below the hard 131072 ceiling.
 */
export const MAX_SINGLE_ARG_BYTES = 120 * 1024; // 122_880 bytes

/** Largest single-argument size in bytes (UTF-8) across an argv array. */
export function maxArgByteLength(args: string[]): number {
  let max = 0;
  for (const arg of args) {
    const len = Buffer.byteLength(arg, "utf-8");
    if (len > max) max = len;
  }
  return max;
}

/**
 * Decide whether an argv/env payload must be moved off the command line to
 * avoid `E2BIG`. Returns `exceeds: true` when EITHER the combined payload
 * exceeds `DEFAULT_ARGV_TOTAL_LIMIT` OR any single argument exceeds
 * `MAX_SINGLE_ARG_BYTES` (the per-string kernel cap). Both limits must be
 * honored: the total guards against many medium args + a large env, while the
 * per-arg guard catches a single huge prompt that fits well under the total.
 */
export function exceedsArgvLimits(
  args: string[],
  env?: NodeJS.ProcessEnv,
): { exceeds: boolean; totalBytes: number; maxArgBytes: number } {
  const totalBytes = estimateSpawnPayloadBytes(args, env);
  const maxArgBytes = maxArgByteLength(args);
  return {
    exceeds: totalBytes > DEFAULT_ARGV_TOTAL_LIMIT || maxArgBytes > MAX_SINGLE_ARG_BYTES,
    totalBytes,
    maxArgBytes,
  };
}

// ── Temp file helpers for prompt transport ────────────────────────────────

const TEMP_DIR_PREFIX = "actuarius-prompt-";

export interface TempPromptFile {
  /** Resolved path to the created prompt file. */
  filePath: string;
  /** The temporary directory containing the prompt file. */
  tempDir: string;
}

/**
 * Create a temporary file with the given content and return the file path
 * and temp directory.  The caller is responsible for calling
 * `cleanupTempPromptFile` with the returned `tempDir` after the spawned
 * process has completed.
 */
export async function writeTempPromptFile(content: string): Promise<TempPromptFile> {
  const tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  const filePath = join(tempDir, "prompt.txt");
  await writeFile(filePath, content, "utf-8");
  return { filePath, tempDir };
}

/**
 * Remove a temporary prompt directory created by `writeTempPromptFile`.
 * Only directories under the system temp dir with the `actuarius-prompt-`
 * prefix are removed; anything else is silently ignored as a safety guard.
 * No error is thrown if the path does not exist.
 */
export async function cleanupTempPromptFile(tempDir: string): Promise<void> {
  try {
    const systemTmp = await realpath(tmpdir());
    const realTempDir = await realpath(tempDir);
    const resolved = join(systemTmp, basename(realTempDir));
    if (
      resolved !== realTempDir ||
      !basename(realTempDir).startsWith(TEMP_DIR_PREFIX)
    ) {
      return;
    }
    await rm(realTempDir, { recursive: true, force: true });
  } catch {
    // Ignore — best-effort cleanup
  }
}

// ── Prompt transport primitives ──────────────────────────────────────────

/** How a prompt is delivered to a spawned process. */
export type PromptTransport = "argv" | "stdin" | "tempfile";

/**
 * Reason why a particular transport was chosen.
 * - `under_limit`: total payload at or below threshold, argv is safe.
 * - `oversized_stdin_fallback`: payload exceeded threshold, stdin fallback used.
 * - `oversized_flag_pair_stdin`: payload exceeded threshold, special `-p ""` + stdin path.
 * - `oversized_tempfile_fallback`: payload exceeded, stdin unavailable, temp file used.
 * - `oversized_no_fallback`: payload exceeded but no fallback configured — kept on argv (risks E2BIG).
 */
export type TransportReason = "under_limit" | "oversized_stdin_fallback" | "oversized_flag_pair_stdin" | "oversized_tempfile_fallback" | "oversized_no_fallback";

export interface PromptTransportDecision {
  /** The chosen transport method. */
  transport: PromptTransport;
  /** Reason this transport was chosen. */
  transportReason: TransportReason;
  /** Final argument list (prompt removed for stdin/tempfile transports). */
  args: string[];
  /**
   * For "stdin" transport: the prompt text to pipe via stdin.
   * For "tempfile" transport: the prompt text to write to a temp file.
   * Undefined for "argv" transport.
   */
  stdinPayload?: string;
  /**
   * For "tempfile" transport: the resolved path of the temp file.
   * Set by the caller after calling `writeTempPromptFile`.
   * Undefined for other transports.
   */
  promptFilePath?: string;
  /** Total estimated bytes of the original argv + env. */
  totalBytes: number;
}

/**
 * Decide how to transport a prompt to a child process based on total
 * spawn payload size (argv + env bytes).
 *
 * - **"argv"**: total bytes are at or below `DEFAULT_ARGV_TOTAL_LIMIT`.
 *   The original args are returned unmodified.
 * - **"stdin"**: total bytes exceed the threshold and `supportsStdinFallback`
 *   is true (default). The prompt-related args are removed from `args`
 *   and the extracted prompt text is returned in `stdinPayload`.
 * - **"tempfile"**: total bytes exceed, stdin is not available, and
 *   `tempfileFlag` or `reshapeArgsForTempfile` is provided. Prompt args are
 *   removed and, when `tempfileFlag` is given and no reshape callback is
 *   present, the flag array is inserted at the prompt position. The prompt
 *   text is returned in `stdinPayload` for the caller to write to a file.
 * - **"argv" (fallback)**: total bytes exceed but no fallback is configured.
 *   The original args are returned unmodified; callers SHOULD log a warning
 *   when this case is detected.
 *
 * @param args             Full argument list including any prompt args.
 * @param promptArgIndices Indices of args that constitute the prompt
 *   (e.g. `[1]` for a positional prompt at index 1, or `[0, 1]` for
 *   `["-p", "prompt"]` at indices 0 and 1). Provided in any order.
 * @param env              Optional environment block for size estimation.
 * @param supportsStdinFallback  Whether the CLI accepts input via stdin
 *   (default `true`).
 * @param tempfileFlag     Optional flag args for file-based input
 *   (e.g. `["--prompt-file", "<path>"]`). Ignored unless stdin fallback
 *   is also unavailable. When `reshapeArgsForTempfile` is provided,
 *   the flags are still inserted into the returned args but the
 *   reshape callback takes priority in `spawnCollectWithTransport`.
 * @param reshapeArgsForTempfile  Optional callback for provider-specific
 *   argument reshaping when using tempfile transport. Called by
 *   `spawnCollectWithTransport` after the temp file is written, with
 *   the prompt text, adjusted args, and resolved temp file path.
 *   When provided, `spawnCollectWithTransport` uses this callback
 *   instead of `TEMP_FILE_PATH_PLACEHOLDER` replacement.
 */
export function decidePromptTransport(
  args: string[],
  promptArgIndices: number[],
  env?: NodeJS.ProcessEnv,
  supportsStdinFallback?: boolean,
  tempfileFlag?: string[],
  reshapeArgsForTempfile?: (promptText: string, adjustedArgs: string[], tempFilePath: string) => string[],
): PromptTransportDecision {
  // ── Validate promptArgIndices ─────────────────────────────────────
  const seen = new Set<number>();
  for (const idx of promptArgIndices) {
    if (!Number.isInteger(idx)) {
      throw new RangeError(`promptArgIndices must be integers, got ${typeof idx}`);
    }
    if (seen.has(idx)) {
      throw new RangeError(`Duplicate promptArgIndex: ${idx}`);
    }
    seen.add(idx);
    if (idx < 0 || idx >= args.length) {
      throw new RangeError(
        `promptArgIndex ${idx} is out of bounds for args of length ${args.length}`,
      );
    }
  }

  const { exceeds, totalBytes } = exceedsArgvLimits(args, env);

  if (!exceeds) {
    return { transport: "argv", args, totalBytes, transportReason: "under_limit" };
  }

  // If no prompt indices are provided, we can't extract anything to move.
  if (promptArgIndices.length === 0) {
    return { transport: "argv", args, totalBytes, transportReason: "oversized_no_fallback" };
  }

  // Remove prompt-related args (descending order to keep indices stable)
  const sortedIdx = [...promptArgIndices].sort((a, b) => b - a);
  const adjustedArgs = [...args];
  const removed: string[] = [];
  for (const idx of sortedIdx) {
    removed.unshift(adjustedArgs.splice(idx, 1)[0]!);
  }
  const promptText = removed[removed.length - 1]!;

  if (supportsStdinFallback !== false) {
    return { transport: "stdin", args: adjustedArgs, stdinPayload: promptText, totalBytes, transportReason: "oversized_stdin_fallback" };
  }

  if (tempfileFlag || reshapeArgsForTempfile) {
    // Insert tempfile flags at the position of the first (lowest) removed prompt arg
    const insertAt = Math.min(...promptArgIndices);
    if (tempfileFlag) {
      adjustedArgs.splice(insertAt, 0, ...tempfileFlag);
    }
    return {
      transport: "tempfile",
      args: adjustedArgs,
      stdinPayload: promptText,
      totalBytes,
      transportReason: "oversized_tempfile_fallback",
    };
  }

  // No fallback available — keep argv (caller should log warning)
  return { transport: "argv", args, totalBytes, transportReason: "oversized_no_fallback" };
}

/**
 * Placeholder string used in `tempfileFlag` arrays; replaced with the real
 * temp-file path by `spawnCollectWithTransport`.
 */
export const TEMP_FILE_PATH_PLACEHOLDER = "<path>";

export interface SpawnCollectTransportOptions {
  /** Path to the binary to spawn. */
  file: string;
  /** Full argument list including any prompt args. */
  args: string[];
  /** Indices of args that constitute the prompt (see `decidePromptTransport`). */
  promptArgIndices: number[];
  /** Working directory for the child process. */
  cwd: string;
  /** Kill the process after this many milliseconds. */
  timeoutMs: number;
  /** Kill the process if neither stdout nor stderr has produced data for this long. */
  idleTimeoutMs?: number;
  /** Force-kill the child process tree after this SIGTERM grace period. */
  killGraceMs?: number;
  /** Hard limit for stdout in bytes. */
  maxBuffer: number;
  /** Soft limit for stderr in bytes (default 64 KB). */
  maxStderrBuffer?: number;
  /** Environment variables for the child process. */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onOutput?: (snapshot: SpawnOutputSnapshot) => void;
  /** Whether the CLI accepts prompt input via stdin (default `true`). */
  supportsStdinFallback?: boolean;
  /**
   * Flag args for file-based input when stdin is unavailable
   * (e.g. `["--prompt-file", "<path>"]`). Any arg equal to
   * `TEMP_FILE_PATH_PLACEHOLDER` is replaced with the real temp-file path.
   */
  tempfileFlag?: string[];
  /**
   * Optional callback for provider-specific argument reshaping when using
   * tempfile transport. Called after the temp file has been written, with
   * the prompt text, the adjusted args (prompt removed), and the resolved
   * temp file path. When provided, this takes priority over
   * `tempfileFlag` placeholder replacement for argument generation.
   */
  reshapeArgsForTempfile?: (promptText: string, adjustedArgs: string[], tempFilePath: string) => string[];
  /**
   * Optional logger for transport decision observability.
   * When provided, the transport decision (argv/stdin/tempfile) is logged
   * with structured fields: transport, transportReason, totalBytes, limitBytes,
   * useFlagPairStdin, logLabel.
   */
  logger?: Logger;
  /**
   * Optional human-readable provider label (e.g. "Codex", "Gemini", "OpenCode").
   * Included in transport decision log events for cross-provider observability.
   */
  logLabel?: string;
}

/**
 * Build a spawnCollect options object, only including optional fields that are
 * actually defined so the type system doesn't see explicit `undefined` values.
 */
function buildOptions(base: {
  cwd: string;
  timeoutMs: number;
  idleTimeoutMs?: number;
  killGraceMs?: number;
  maxBuffer: number;
  maxStderrBuffer?: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  signal?: AbortSignal;
  onOutput?: (snapshot: SpawnOutputSnapshot) => void;
}) {
  const opts: Parameters<typeof spawnCollect>[2] = {
    cwd: base.cwd,
    timeoutMs: base.timeoutMs,
    maxBuffer: base.maxBuffer,
  };
  if (base.maxStderrBuffer !== undefined) opts.maxStderrBuffer = base.maxStderrBuffer;
  if (base.idleTimeoutMs !== undefined) opts.idleTimeoutMs = base.idleTimeoutMs;
  if (base.killGraceMs !== undefined) opts.killGraceMs = base.killGraceMs;
  if (base.env !== undefined) opts.env = base.env;
  if (base.stdin !== undefined) opts.stdin = base.stdin;
  if (base.signal !== undefined) opts.signal = base.signal;
  if (base.onOutput !== undefined) opts.onOutput = base.onOutput;
  return opts;
}

/**
 * High-level wrapper that combines `decidePromptTransport` + `spawnCollect`
 * + temp-file lifecycle management.
 *
 * 1. Calls `decidePromptTransport` to pick the optimal transport.
 * 2. If "stdin": passes `stdinPayload` via `spawnCollect`'s stdin option.
 * 3. If "tempfile": creates a temp file, replaces placeholder args,
 *    spawns, and cleans up the temp file on completion (success or error).
 * 4. If "argv": spawns with the original args unmodified.
 *
 * Preserves the existing non-interactive stdin default (stdio: "ignore")
 * when no stdin content is needed.
 */
export async function spawnCollectWithTransport(
  options: SpawnCollectTransportOptions,
): Promise<SpawnResult> {
  const {
    file,
    args,
    promptArgIndices,
    cwd,
    timeoutMs,
    idleTimeoutMs,
    killGraceMs,
    maxBuffer,
    maxStderrBuffer,
    env,
    signal,
    onOutput,
    supportsStdinFallback,
    tempfileFlag,
    reshapeArgsForTempfile,
    logger: decisionLogger,
    logLabel,
  } = options;

  // When env is undefined, `spawnCollect` lets the child inherit the full
  // parent `process.env`. The kernel charges those bytes against ARG_MAX, so
  // the size estimate must count them too — otherwise we undercount and skip a
  // fallback that was actually needed. Estimate against the env we will spawn.
  const estimationEnv = env ?? process.env;

  const decision = decidePromptTransport(
    args,
    promptArgIndices,
    estimationEnv,
    supportsStdinFallback,
    tempfileFlag,
    reshapeArgsForTempfile,
  );

  if (decisionLogger) {
    let level: "debug" | "info" | "warn";
    if (decision.transportReason === "under_limit") {
      level = "debug";
    } else if (decision.transportReason === "oversized_no_fallback") {
      level = "warn";
    } else {
      level = "info";
    }
    decisionLogger[level](
      {
        transport: decision.transport,
        transportReason: decision.transportReason,
        totalBytes: decision.totalBytes,
        maxArgBytes: maxArgByteLength(args),
        limitBytes: DEFAULT_ARGV_TOTAL_LIMIT,
        maxArgLimitBytes: MAX_SINGLE_ARG_BYTES,
        useFlagPairStdin: false,
        logLabel,
      },
      `spawnCollectWithTransport: ${decision.transport} transport (${Math.round(decision.totalBytes / 1024)} KB of ${Math.round(DEFAULT_ARGV_TOTAL_LIMIT / 1024)} KB threshold)`,
    );
  }

  let tempFileInfo: TempPromptFile | undefined;

  try {
    if (decision.transport === "tempfile") {
      tempFileInfo = await writeTempPromptFile(decision.stdinPayload!);
      const fileArgs = reshapeArgsForTempfile
        ? reshapeArgsForTempfile(decision.stdinPayload!, decision.args, tempFileInfo!.filePath)
        : decision.args.map(
            (a) => (a === TEMP_FILE_PATH_PLACEHOLDER ? tempFileInfo!.filePath : a),
          );
      return await spawnCollect(file, fileArgs, buildOptions({
        cwd, timeoutMs, maxBuffer,
        ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
        ...(killGraceMs !== undefined ? { killGraceMs } : {}),
        ...(maxStderrBuffer !== undefined ? { maxStderrBuffer } : {}),
        ...(env !== undefined ? { env } : {}),
        ...(signal !== undefined ? { signal } : {}),
        ...(onOutput !== undefined ? { onOutput } : {}),
      }));
    }

    return await spawnCollect(file, decision.args, buildOptions({
      cwd, timeoutMs, maxBuffer,
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      ...(killGraceMs !== undefined ? { killGraceMs } : {}),
      ...(maxStderrBuffer !== undefined ? { maxStderrBuffer } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(signal !== undefined ? { signal } : {}),
      ...(onOutput !== undefined ? { onOutput } : {}),
      ...(decision.stdinPayload !== undefined ? { stdin: decision.stdinPayload } : {}),
    }));
  } finally {
    if (tempFileInfo) {
      await cleanupTempPromptFile(tempFileInfo.tempDir);
    }
  }
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
}

export interface SpawnOutputSnapshot {
  stdout: string;
  stderr: string;
}

const DEFAULT_STDERR_MAX = 64 * 1024; // 64 KB
export const DEFAULT_TERMINATION_GRACE_MS = 5_000;

export type SpawnTimeoutReason = "idle" | "absolute";
export interface SpawnLastOutput {
  stream: "stdout" | "stderr";
  text: string;
}

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    child.kill(signal);
    return;
  }

  if (process.platform === "win32") {
    const taskkill = spawn(
      "taskkill",
      ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
      { stdio: "ignore", windowsHide: true }
    );
    taskkill.on("error", () => { child.kill(signal); });
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * Spawns a child process, collects stdout/stderr, and resolves/rejects on close.
 * stdin is set to "ignore" to prevent CLIs from blocking on interactive input.
 *
 * stdout is hard-limited to maxBuffer bytes — EMSGSIZE is thrown if exceeded.
 * stderr is soft-limited to maxStderrBuffer bytes (default 64 KB) — when exceeded,
 * the head is discarded and only the tail (most recent bytes) is kept. The process
 * is never killed due to stderr volume alone. When stderr was truncated, the
 * returned string is prefixed with "[stderr truncated]\n".
 */
export function spawnCollect(
  file: string,
  args: string[],
  options: {
    cwd: string;
    /** Absolute upper bound, regardless of output activity. */
    timeoutMs: number;
    /** Kill a process that has produced no stdout or stderr for this long. */
    idleTimeoutMs?: number;
    maxBuffer: number;
    maxStderrBuffer?: number;
    /** Opt in to force-killing the child process tree if it has not closed after SIGTERM. */
    killGraceMs?: number;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
    /** Called after stdout or stderr changes, with the output collected so far. */
    onOutput?: (snapshot: SpawnOutputSnapshot) => void;
    /** Abort the child process when the owning request is cancelled. */
    signal?: AbortSignal;
  }
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(Object.assign(new Error("Process cancelled before it started"), { code: "ABORT_ERR", killed: false }));
      return;
    }
    const forceTreeTermination = options.killGraceMs !== undefined;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      detached: forceTreeTermination && process.platform !== "win32",
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"] as const,
    });

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => { child.stdin?.destroy(); });
      child.stdin.write(options.stdin);
      child.stdin.end();
    }

    let stdout = "";
    let stderr = "";
    let timeoutReason: SpawnTimeoutReason | undefined;
    let bufferOverflow = false;
    let stderrTruncated = false;
    let outputCallbackError: Error | undefined;
    let aborted = false;
    let lastOutput: SpawnLastOutput | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const effectiveStderrMax = options.maxStderrBuffer ?? DEFAULT_STDERR_MAX;
    const killGraceMs = options.killGraceMs === undefined
      ? undefined
      : Math.max(0, options.killGraceMs);

    const requestTermination = (): void => {
      if (killGraceMs === undefined) {
        child.kill("SIGTERM");
        return;
      }
      signalChildTree(child, "SIGTERM");
      if (forceKillTimer) return;
      forceKillTimer = setTimeout(() => {
        signalChildTree(child, "SIGKILL");
      }, killGraceMs);
    };

    const absoluteTimer = setTimeout(() => {
      if (timeoutReason) return;
      timeoutReason = "absolute";
      requestTermination();
    }, options.timeoutMs);

    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdleTimer = () => {
      if (options.idleTimeoutMs === undefined) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (timeoutReason) return;
        timeoutReason = "idle";
        requestTermination();
      }, options.idleTimeoutMs);
    };
    resetIdleTimer();

    const clearTimers = () => {
      clearTimeout(absoluteTimer);
      if (idleTimer) clearTimeout(idleTimer);
      options.signal?.removeEventListener("abort", abortChild);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    const abortChild = (): void => {
      if (aborted) return;
      aborted = true;
      requestTermination();
    };
    options.signal?.addEventListener("abort", abortChild, { once: true });
    if (options.signal?.aborted) {
      abortChild();
    }

    const notifyOutput = (): void => {
      if (!options.onOutput || outputCallbackError) return;
      try {
        options.onOutput({ stdout, stderr });
      } catch (reason) {
        outputCallbackError = reason instanceof Error
          ? reason
          : new Error("spawnCollect onOutput callback failed", { cause: reason });
        requestTermination();
      }
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      if (bufferOverflow || timeoutReason || outputCallbackError) return;
      resetIdleTimer();
      const text = chunk.toString();
      lastOutput = { stream: "stdout", text };
      stdout += text;
      notifyOutput();
      if (outputCallbackError) return;
      if (stdout.length > options.maxBuffer) {
        bufferOverflow = true;
        requestTermination();
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      if (bufferOverflow || timeoutReason || outputCallbackError) return;
      resetIdleTimer();
      const text = chunk.toString();
      lastOutput = { stream: "stderr", text };
      const combined = stderr + text;
      if (combined.length > effectiveStderrMax) {
        stderrTruncated = true;
        stderr = combined.slice(combined.length - effectiveStderrMax);
      } else {
        stderr = combined;
      }
      notifyOutput();
    });

    child.on("error", (err) => {
      clearTimers();
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimers();
      const finalStderr = stderrTruncated ? `[stderr truncated]\n${stderr}` : stderr;

      if (outputCallbackError) {
        reject(outputCallbackError);
        return;
      }
      if (aborted) {
        reject(Object.assign(new Error("Process cancelled by user request"), {
          code: "ABORT_ERR", killed: true, signal, stdout, stderr: finalStderr,
        }));
        return;
      }
      if (bufferOverflow) {
        reject(Object.assign(new Error(`Process output exceeded maxBuffer (${options.maxBuffer} bytes)`), {
          code: "EMSGSIZE", killed: true, signal, stdout, stderr: finalStderr, lastOutput,
        }));
        return;
      }
      if (timeoutReason) {
        const timeoutMessage = timeoutReason === "idle"
          ? `Process produced no stdout or stderr for ${options.idleTimeoutMs}ms`
          : `Process timed out after ${options.timeoutMs}ms`;
        if (code !== null) {
          reject(Object.assign(new Error(`Process exited with code ${String(code)} after timeout: ${timeoutMessage}`), {
            code: "ETIMEDOUT", timeoutReason, killed: false, signal, stdout, stderr: finalStderr, lastOutput,
          }));
          return;
        }
        reject(Object.assign(new Error(timeoutMessage), {
          code: "ETIMEDOUT", timeoutReason, killed: true, signal, stdout, stderr: finalStderr, lastOutput,
        }));
        return;
      }
      if (code !== 0) {
        reject(Object.assign(new Error(`Process exited with code ${String(code)}`), {
          killed: false, signal, stdout, stderr: finalStderr, lastOutput,
        }));
        return;
      }
      resolve({ stdout, stderr: finalStderr });
    });
  });
}
