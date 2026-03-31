import { describe, expect, it, vi, beforeEach } from "vitest";
import pino from "pino";

vi.mock("../src/utils/spawnCollect.js");

const { spawnCollect } = await import("../src/utils/spawnCollect.js");
const mockSpawnCollect = vi.mocked(spawnCollect);

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
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "  codex output\n", stderr: "" });
    const result = await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(result.text).toBe("codex output");
  });

  it("passes exec subcommand, positional prompt, and --dangerously-bypass-approvals-and-sandbox", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runCodexRequest({ prompt: "my prompt", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(mockSpawnCollect).toHaveBeenCalledWith(
      "codex",
      ["exec", "my prompt", "--dangerously-bypass-approvals-and-sandbox"],
      expect.any(Object)
    );
  });

  it("appends --model flag when model is provided", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, model: "o4-mini" }, logger);
    expect(mockSpawnCollect).toHaveBeenCalledWith(
      "codex",
      ["exec", "hello", "--dangerously-bypass-approvals-and-sandbox", "--model", "o4-mini"],
      expect.any(Object)
    );
  });

  it("passes a scoped environment through to the subprocess", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, env: { PATH: "/scoped/bin" } }, logger);
    expect(mockSpawnCollect).toHaveBeenCalledWith(
      "codex",
      ["exec", "hello", "--dangerously-bypass-approvals-and-sandbox"],
      expect.objectContaining({
        env: { PATH: "/scoped/bin" }
      })
    );
  });

  it("throws CODEX_UNAVAILABLE when binary is not found (ENOENT)", async () => {
    const err = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    mockSpawnCollect.mockRejectedValueOnce(err);
    await expect(runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "CODEX_UNAVAILABLE",
      name: "CodexExecutionError",
    });
  });

  it("throws TIMEOUT when process times out (ETIMEDOUT)", async () => {
    const err = Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true, signal: "SIGTERM" });
    mockSpawnCollect.mockRejectedValueOnce(err);
    await expect(runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "TIMEOUT",
      name: "CodexExecutionError",
    });
  });

  it("throws FAILED when process exits non-zero", async () => {
    const err = Object.assign(new Error("Process exited with code 1"), { killed: false, signal: null });
    mockSpawnCollect.mockRejectedValueOnce(err);
    await expect(runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "FAILED",
      name: "CodexExecutionError",
    });
  });

  it("throws EMPTY_OUTPUT when stdout is blank", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "  \n  ", stderr: "" });
    await expect(runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "EMPTY_OUTPUT",
      name: "CodexExecutionError",
    });
  });
});
