import { describe, expect, it, vi, beforeEach } from "vitest";
import pino from "pino";

vi.mock("../src/utils/spawnCollect.js");

const { spawnCollectWithTransport } = await import("../src/utils/spawnCollect.js");
const mockSpawnCollectWithTransport = vi.mocked(spawnCollectWithTransport);

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

  it("passes supportsStdinFallback true for oversized prompt fallback", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        supportsStdinFallback: true,
      })
    );
  });

  it("passes promptArgIndices as [1] for positional prompt after exec prefix", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        promptArgIndices: [1],
      })
    );
  });

  it("does not include prompt text in args when promptArgIndices would strip it for fallback", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    const callArgs = mockSpawnCollectWithTransport.mock.calls[0]![0];
    expect(callArgs.args).toContain("hello");
    expect(callArgs.promptArgIndices).toEqual([1]);
  });

  it("still passes model flag after prompt when stdin fallback strips the positional prompt", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, model: "o4-mini" }, logger);
    const callArgs = mockSpawnCollectWithTransport.mock.calls[0]![0];
    expect(callArgs.args).toEqual([
      "exec", "hello",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model", "o4-mini",
    ]);
    expect(callArgs.promptArgIndices).toEqual([1]);
  });
});
