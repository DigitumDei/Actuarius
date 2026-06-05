import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";

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
  const systemTmp = tmpdir();
  const resolved = join(systemTmp, basename(tempDir));
  if (
    resolved !== tempDir ||
    !basename(tempDir).startsWith(TEMP_DIR_PREFIX)
  ) {
    return;
  }
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore — best-effort cleanup
  }
}

// ── Prompt transport primitives ──────────────────────────────────────────

/** How a prompt is delivered to a spawned process. */
export type PromptTransport = "argv" | "stdin" | "tempfile";

export interface PromptTransportDecision {
  /** The chosen transport method. */
  transport: PromptTransport;
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

  const totalBytes = estimateSpawnPayloadBytes(args, env);

  if (totalBytes <= DEFAULT_ARGV_TOTAL_LIMIT) {
    return { transport: "argv", args, totalBytes };
  }

  // If no prompt indices are provided, we can't extract anything to move.
  if (promptArgIndices.length === 0) {
    return { transport: "argv", args, totalBytes };
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
    return { transport: "stdin", args: adjustedArgs, stdinPayload: promptText, totalBytes };
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
    };
  }

  // No fallback available — keep argv (caller should log warning)
  return { transport: "argv", args, totalBytes };
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
  /** Hard limit for stdout in bytes. */
  maxBuffer: number;
  /** Soft limit for stderr in bytes (default 64 KB). */
  maxStderrBuffer?: number;
  /** Environment variables for the child process. */
  env?: NodeJS.ProcessEnv;
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
}

/**
 * Build a spawnCollect options object, only including optional fields that are
 * actually defined so the type system doesn't see explicit `undefined` values.
 */
function buildOptions(base: {
  cwd: string;
  timeoutMs: number;
  maxBuffer: number;
  maxStderrBuffer?: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}) {
  const opts: Parameters<typeof spawnCollect>[2] = {
    cwd: base.cwd,
    timeoutMs: base.timeoutMs,
    maxBuffer: base.maxBuffer,
  };
  if (base.maxStderrBuffer !== undefined) opts.maxStderrBuffer = base.maxStderrBuffer;
  if (base.env !== undefined) opts.env = base.env;
  if (base.stdin !== undefined) opts.stdin = base.stdin;
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
    maxBuffer,
    maxStderrBuffer,
    env,
    supportsStdinFallback,
    tempfileFlag,
    reshapeArgsForTempfile,
  } = options;

  const decision = decidePromptTransport(
    args,
    promptArgIndices,
    env,
    supportsStdinFallback,
    tempfileFlag,
    reshapeArgsForTempfile,
  );

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
        ...(maxStderrBuffer !== undefined ? { maxStderrBuffer } : {}),
        ...(env !== undefined ? { env } : {}),
      }));
    }

    return await spawnCollect(file, decision.args, buildOptions({
      cwd, timeoutMs, maxBuffer,
      ...(maxStderrBuffer !== undefined ? { maxStderrBuffer } : {}),
      ...(env !== undefined ? { env } : {}),
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

const DEFAULT_STDERR_MAX = 64 * 1024; // 64 KB

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
  options: { cwd: string; timeoutMs: number; maxBuffer: number; maxStderrBuffer?: number; env?: NodeJS.ProcessEnv; stdin?: string }
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"] as const,
    });

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => { child.stdin?.destroy(); });
      child.stdin.write(options.stdin);
      child.stdin.end();
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let bufferOverflow = false;
    let stderrTruncated = false;

    const effectiveStderrMax = options.maxStderrBuffer ?? DEFAULT_STDERR_MAX;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      if (bufferOverflow || timedOut) return;
      stdout += chunk.toString();
      if (stdout.length > options.maxBuffer) {
        bufferOverflow = true;
        child.kill("SIGTERM");
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      if (bufferOverflow) return;
      const combined = stderr + chunk.toString();
      if (combined.length > effectiveStderrMax) {
        stderrTruncated = true;
        stderr = combined.slice(combined.length - effectiveStderrMax);
      } else {
        stderr = combined;
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const finalStderr = stderrTruncated ? `[stderr truncated]\n${stderr}` : stderr;

      if (bufferOverflow) {
        reject(Object.assign(new Error(`Process output exceeded maxBuffer (${options.maxBuffer} bytes)`), {
          code: "EMSGSIZE", killed: true, signal, stdout, stderr: finalStderr,
        }));
        return;
      }
      if (timedOut) {
        if (code !== null) {
          reject(Object.assign(new Error(`Process exited with code ${String(code)}`), {
            killed: false, signal, stdout, stderr: finalStderr,
          }));
          return;
        }
        reject(Object.assign(new Error(`Process timed out after ${options.timeoutMs}ms`), {
          code: "ETIMEDOUT", killed: true, signal, stdout, stderr: finalStderr,
        }));
        return;
      }
      if (code !== 0) {
        reject(Object.assign(new Error(`Process exited with code ${String(code)}`), {
          killed: false, signal, stdout, stderr: finalStderr,
        }));
        return;
      }
      resolve({ stdout, stderr: finalStderr });
    });
  });
}
