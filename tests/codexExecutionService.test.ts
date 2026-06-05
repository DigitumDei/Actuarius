import { describe, expect, it, vi, beforeEach } from "vitest";
import pino from "pino";

vi.mock("../src/utils/spawnCollect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/spawnCollect.js")>();
  return {
    ...actual,
    spawnCollectWithTransport: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "" }),
  };
});

const { spawnCollectWithTransport } = await import("../src/utils/spawnCollect.js");
const mockSpawnCollectWithTransport = vi.mocked(spawnCollectWithTransport);

const { decidePromptTransport, DEFAULT_ARGV_TOTAL_LIMIT } = await import("../src/utils/spawnCollect.js");

const { CodexExecutionError, runCodexRequest } = await import("../src/services/codexExecutionService.js");

const logger = pino({ level: "silent" });

describe("CodexExecutionError", () => {
  it("constructs with CODEX_UNAVAILABLE code", () => {
    const error = new CodexExecutionError("CODEX_UNAVAILABLE", "not found");
    expect(error.code).toBe("CODEX_UNAVAILABLE");
    expect(error.message).toBe("not found");
    expect(error.name).toBe("CodexExecutionError");
    expect(error).toBeInstanceOf(Error);
  });

  it("constructs with CODEX_DISABLED code", () => {
    const error = new CodexExecutionError("CODEX_DISABLED", "disabled");
    expect(error.code).toBe("CODEX_DISABLED");
    expect(error.message).toBe("disabled");
  });

  it("constructs with TIMEOUT code", () => {
    const error = new CodexExecutionError("TIMEOUT", "timed out");
    expect(error.code).toBe("TIMEOUT");
  });

  it("constructs with FAILED code", () => {
    const error = new CodexExecutionError("FAILED", "failed");
    expect(error.code).toBe("FAILED");
  });

  it("constructs with EMPTY_OUTPUT code", () => {
    const error = new CodexExecutionError("EMPTY_OUTPUT", "empty");
    expect(error.code).toBe("EMPTY_OUTPUT");
  });
});

describe("runCodexRequest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns trimmed text from stdout on success", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "  codex output\n", stderr: "" });
    const result = await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(result.text).toBe("codex output");
  });

  it("passes exec subcommand, positional prompt, and --dangerously-bypass-approvals-and-sandbox", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runCodexRequest({ prompt: "my prompt", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "codex",
        args: ["exec", "my prompt", "--dangerously-bypass-approvals-and-sandbox"],
        cwd: "/tmp",
      })
    );
  });

  it("appends --model flag when model is provided", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, model: "o4-mini" }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "codex",
        args: ["exec", "hello", "--dangerously-bypass-approvals-and-sandbox", "--model", "o4-mini"],
        cwd: "/tmp",
      })
    );
  });

  it("passes a scoped environment through to the subprocess", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, env: { PATH: "/scoped/bin" } }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "codex",
        args: ["exec", "hello", "--dangerously-bypass-approvals-and-sandbox"],
        env: { PATH: "/scoped/bin" },
      })
    );
  });

  it("passes supportsStdinFallback true and promptArgIndices [1] for fallback", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        supportsStdinFallback: true,
        promptArgIndices: [1],
      })
    );
  });

  it("throws CODEX_UNAVAILABLE when binary is not found (ENOENT)", async () => {
    const err = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    mockSpawnCollectWithTransport.mockRejectedValueOnce(err);
    await expect(runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "CODEX_UNAVAILABLE",
      name: "CodexExecutionError",
    });
  });

  it("throws TIMEOUT when process times out (ETIMEDOUT)", async () => {
    const err = Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true, signal: "SIGTERM" });
    mockSpawnCollectWithTransport.mockRejectedValueOnce(err);
    await expect(runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "TIMEOUT",
      name: "CodexExecutionError",
    });
  });

  it("throws FAILED when process exits non-zero", async () => {
    const err = Object.assign(new Error("Process exited with code 1"), { killed: false, signal: null });
    mockSpawnCollectWithTransport.mockRejectedValueOnce(err);
    await expect(runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "FAILED",
      name: "CodexExecutionError",
    });
  });

  it("throws EMPTY_OUTPUT when stdout is blank", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "  \n  ", stderr: "" });
    await expect(runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "EMPTY_OUTPUT",
      name: "CodexExecutionError",
    });
  });
});

describe("codex prompt transport decision", () => {
  it("uses argv transport for a small prompt (prompt stays in args)", () => {
    const args = ["exec", "hello", "--dangerously-bypass-approvals-and-sandbox"];
    const decision = decidePromptTransport(args, [1]);
    expect(decision.transport).toBe("argv");
    expect(decision.args).toBe(args);
    expect(decision.stdinPayload).toBeUndefined();
  });

  it("uses stdin transport for an oversized prompt (prompt removed from args)", () => {
    const bigPrompt = "x".repeat(2_000_000);
    const args = ["exec", bigPrompt, "--dangerously-bypass-approvals-and-sandbox"];
    const decision = decidePromptTransport(args, [1]);
    expect(decision.transport).toBe("stdin");
    expect(decision.args).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox"]);
    expect(decision.args).not.toContain(bigPrompt);
    expect(decision.stdinPayload).toBe(bigPrompt);
  });

  it("preserves --model flag in correct position for oversized prompt with stdin", () => {
    const bigPrompt = "y".repeat(2_000_000);
    const args = ["exec", bigPrompt, "--dangerously-bypass-approvals-and-sandbox", "--model", "o4-mini"];
    const decision = decidePromptTransport(args, [1]);
    expect(decision.transport).toBe("stdin");
    expect(decision.args).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "o4-mini",
    ]);
    expect(decision.args).not.toContain(bigPrompt);
    expect(decision.stdinPayload).toBe(bigPrompt);
  });

  it("uses argv transport for a small prompt with --model (normal argv path)", () => {
    const args = ["exec", "hello", "--dangerously-bypass-approvals-and-sandbox", "--model", "o4-mini"];
    const decision = decidePromptTransport(args, [1]);
    expect(decision.transport).toBe("argv");
    expect(decision.args).toBe(args);
    expect(decision.stdinPayload).toBeUndefined();
  });

  it("reports totalBytes exceeding the limit for oversized prompts", () => {
    const bigPrompt = "z".repeat(2_000_000);
    const args = ["exec", bigPrompt];
    const decision = decidePromptTransport(args, [1]);
    expect(decision.totalBytes).toBeGreaterThan(DEFAULT_ARGV_TOTAL_LIMIT);
  });

  it("reports totalBytes within the limit for small prompts", () => {
    const args = ["exec", "hello", "--dangerously-bypass-approvals-and-sandbox"];
    const decision = decidePromptTransport(args, [1]);
    expect(decision.totalBytes).toBeLessThanOrEqual(DEFAULT_ARGV_TOTAL_LIMIT);
  });
});
