import { spawn } from "node:child_process";

export interface SpawnResult {
  stdout: string;
  stderr: string;
}

/**
 * Spawns a child process, collects stdout/stderr, and resolves/rejects on close.
 * stdin is set to "ignore" to prevent CLIs from blocking on interactive input.
 */
export function spawnCollect(
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxBuffer: number }
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(Object.assign(new Error(`Process timed out after ${options.timeoutMs}ms`), {
          code: "ETIMEDOUT", killed: true, signal, stdout, stderr,
        }));
        return;
      }
      if (code !== 0) {
        reject(Object.assign(new Error(`Process exited with code ${String(code)}`), {
          killed: false, signal, stdout, stderr,
        }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
