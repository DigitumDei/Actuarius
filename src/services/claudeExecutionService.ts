import type { Logger } from "pino";
import { runProviderRequest } from "../utils/runProviderRequest.js";

export interface ClaudeExecutionInput {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  model?: string;
  env?: NodeJS.ProcessEnv;
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

export function makeClaudeTransformOutput(): (stdout: string) => string {
  return (stdout: string): string => {
    try {
      const parsed = JSON.parse(stdout) as unknown;
      const extracted = extractTextFromClaudeJson(parsed);
      if (extracted !== null) {
        return extracted;
      }
    } catch {
      // Not JSON — fall through to raw stdout
    }
    return stdout;
  };
}

export async function runClaudeRequest(input: ClaudeExecutionInput, logger: Logger): Promise<ClaudeExecutionResult> {
  const text = await runProviderRequest(
    input,
    {
      binary: "claude",
      extraArgs: ["--output-format", "json", "--permission-mode", "bypassPermissions"],
      supportsStdinFallback: true,
      logLabel: "Claude",
      makeError: (code, message) => new ClaudeExecutionError(code as ClaudeExecutionError["code"], message),
      unavailableCode: "CLAUDE_UNAVAILABLE",
      timeoutCode: "TIMEOUT",
      failedCode: "FAILED",
      emptyOutputCode: "EMPTY_OUTPUT",
      transformOutput: makeClaudeTransformOutput(),
    },
    logger
  );
  return { text };
}
