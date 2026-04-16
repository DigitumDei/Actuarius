import { spawn } from "node:child_process";

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
  options: { cwd: string; timeoutMs: number; maxBuffer: number; maxStderrBuffer?: number; env?: NodeJS.ProcessEnv }
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });

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
      if (bufferOverflow || timedOut) return;
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
