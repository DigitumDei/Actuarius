import { spawn } from "node:child_process";
import type { Logger } from "pino";

interface SpawnResult {
  stdout: string;
  stderr: string;
}

function spawnCollect(
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxBuffer: number }
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // stdin: "ignore" prevents Codex from waiting on interactive input
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

export interface CodexExecutionInput {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  model?: string;
}

export interface CodexExecutionResult {
  text: string;
}

export class CodexExecutionError extends Error {
  public readonly code: "CODEX_UNAVAILABLE" | "CODEX_DISABLED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT";

  public constructor(code: "CODEX_UNAVAILABLE" | "CODEX_DISABLED" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT", message: string) {
    super(message);
    this.name = "CodexExecutionError";
    this.code = code;
  }
}

export async function runCodexRequest(input: CodexExecutionInput, logger: Logger): Promise<CodexExecutionResult> {
  const args = ["-p", input.prompt, "--approval-mode", "full-auto"];
  if (input.model) {
    args.push("--model", input.model);
  }

  logger.debug({ args, cwd: input.cwd, timeoutMs: input.timeoutMs }, "Codex subprocess args");

  try {
    const { stdout, stderr } = await spawnCollect("codex", args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });

    if (stderr) {
      logger.debug({ stderr }, "Codex subprocess stderr");
    }
    logger.debug({ stdoutLength: stdout.length }, "Codex subprocess exited cleanly");

    const text = stdout.trim() || null;
    if (!text) {
      throw new CodexExecutionError("EMPTY_OUTPUT", "Codex returned empty output.");
    }

    return { text };
  } catch (error) {
    if (error instanceof CodexExecutionError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Codex execution failed.";
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
    }, "Codex subprocess failed");

    if (nodeError.code === "ENOENT") {
      throw new CodexExecutionError("CODEX_UNAVAILABLE", "Codex CLI is not installed or not available in PATH.");
    }

    if (
      nodeError.code === "ETIMEDOUT" ||
      (nodeError.killed === true && nodeError.signal === "SIGTERM") ||
      message.toLowerCase().includes("timed out")
    ) {
      throw new CodexExecutionError("TIMEOUT", `Codex execution timed out after ${input.timeoutMs}ms.`);
    }

    throw new CodexExecutionError("FAILED", message);
  }
}
