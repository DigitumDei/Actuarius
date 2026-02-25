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
    // stdin: "ignore" prevents Claude from waiting on interactive input
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

export interface ClaudeExecutionInput {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  model?: string;
}

export interface ClaudeExecutionResult {
  text: string;
}

export class ClaudeExecutionError extends Error {
  public readonly code: "CLAUDE_UNAVAILABLE" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT";

  public constructor(code: "CLAUDE_UNAVAILABLE" | "TIMEOUT" | "FAILED" | "EMPTY_OUTPUT", message: string) {
    super(message);
    this.name = "ClaudeExecutionError";
    this.code = code;
  }
}

export function extractTextFromClaudeJson(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as {
    result?: unknown;
    output?: unknown;
    text?: unknown;
    content?: unknown;
  };

  const direct = [candidate.result, candidate.output, candidate.text].find((value) => typeof value === "string");
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  if (Array.isArray(candidate.content)) {
    const lines: string[] = [];
    for (const item of candidate.content) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const textValue = (item as { text?: unknown }).text;
      if (typeof textValue === "string" && textValue.trim()) {
        lines.push(textValue.trim());
      }
    }

    const combined = lines.join("\n").trim();
    return combined || null;
  }

  return null;
}

export async function runClaudeRequest(input: ClaudeExecutionInput, logger: Logger): Promise<ClaudeExecutionResult> {
  // --add-dir omitted: cwd is already set to the worktree root
  const args = ["-p", input.prompt, "--output-format", "json", "--permission-mode", "bypassPermissions"];
  if (input.model) {
    args.push("--model", input.model);
  }

  logger.debug({ args, cwd: input.cwd, timeoutMs: input.timeoutMs }, "Claude subprocess args");

  try {
    const { stdout, stderr } = await spawnCollect("claude", args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });

    if (stderr) {
      logger.debug({ stderr }, "Claude subprocess stderr");
    }
    logger.debug({ stdoutLength: stdout.length }, "Claude subprocess exited cleanly");

    let text: string | null = null;
    try {
      const parsed = JSON.parse(stdout) as unknown;
      text = extractTextFromClaudeJson(parsed);
    } catch {
      text = stdout.trim() || null;
    }

    if (!text) {
      throw new ClaudeExecutionError("EMPTY_OUTPUT", "Claude returned empty output.");
    }

    return { text };
  } catch (error) {
    if (error instanceof ClaudeExecutionError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Claude execution failed.";
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
    }, "Claude subprocess failed");

    if (nodeError.code === "ENOENT") {
      throw new ClaudeExecutionError("CLAUDE_UNAVAILABLE", "Claude CLI is not installed or not available in PATH.");
    }

    if (
      nodeError.code === "ETIMEDOUT" ||
      (nodeError.killed === true && nodeError.signal === "SIGTERM") ||
      message.toLowerCase().includes("timed out")
    ) {
      throw new ClaudeExecutionError("TIMEOUT", `Claude execution timed out after ${input.timeoutMs}ms.`);
    }

    throw new ClaudeExecutionError("FAILED", message);
  }
}
