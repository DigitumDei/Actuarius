import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

vi.mock("../src/utils/spawnCollect.js");

const { spawnCollect } = await import("../src/utils/spawnCollect.js");
const mockSpawnCollect = vi.mocked(spawnCollect);

const { OpencodeExecutionError, runOpencodeRequest } = await import("../src/services/opencodeExecutionService.js");

const logger = pino({ level: "silent" });

describe("runOpencodeRequest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Bypass the pre-spawn auth check by providing an API key.
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
  });

  it("returns result text on clean exit", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "task completed", stderr: "" });
    const result = await runOpencodeRequest({ prompt: "do something", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(result.text).toBe("task completed");
  });

  it("does NOT throw NOT_AUTHENTICATED when auth failure text appears only in stdout (subprocess output, not OpenCode's own error)", async () => {
    // OpenCode ran `gemini` as part of a task; gemini printed "not authenticated" which
    // ended up in OpenCode's stdout. With authCheckOnlyStderr=true this must not be flagged.
    mockSpawnCollect.mockResolvedValueOnce({
      stdout: "I ran gemini and got: not authenticated\nset an Auth method in gemini config",
      stderr: "",
    });
    const result = await runOpencodeRequest({ prompt: "investigate gemini", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(result.text).toContain("not authenticated");
  });

  it("throws NOT_AUTHENTICATED when auth failure pattern appears in stderr", async () => {
    // OpenCode itself emitted the auth error to stderr — this is a real failure.
    mockSpawnCollect.mockResolvedValueOnce({
      stdout: "some partial output",
      stderr: "Error: set an Auth method for opencode",
    });
    await expect(
      runOpencodeRequest({ prompt: "do something", cwd: "/tmp", timeoutMs: 5000 }, logger)
    ).rejects.toMatchObject({ code: "NOT_AUTHENTICATED", name: "OpencodeExecutionError" });
  });

  it("does NOT throw NOT_AUTHENTICATED on non-zero exit when auth failure text appears only in stdout", async () => {
    // A subprocess OpenCode ran printed auth-failure text to its stdout, which ended up in
    // OpenCode's stdout. The process then exited non-zero (e.g. subprocess returned error).
    // With authCheckOnlyStderr=true, stdout must be excluded from the auth pattern check
    // in the catch block as well as the clean-exit path.
    mockSpawnCollect.mockRejectedValueOnce(
      Object.assign(new Error("Process exited with code 1"), {
        killed: false,
        stdout: "I ran gemini and got: not authenticated",
        stderr: "some other error from opencode",
      })
    );
    await expect(
      runOpencodeRequest({ prompt: "do something", cwd: "/tmp", timeoutMs: 5000 }, logger)
    ).rejects.not.toMatchObject({ code: "NOT_AUTHENTICATED" });
  });

  it("throws OPENCODE_UNAVAILABLE when binary is not found", async () => {
    mockSpawnCollect.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await expect(
      runOpencodeRequest({ prompt: "do something", cwd: "/tmp", timeoutMs: 5000 }, logger)
    ).rejects.toMatchObject({ code: "OPENCODE_UNAVAILABLE", name: "OpencodeExecutionError" });
  });

  it("throws TIMEOUT when execution times out", async () => {
    mockSpawnCollect.mockRejectedValueOnce(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
    await expect(
      runOpencodeRequest({ prompt: "do something", cwd: "/tmp", timeoutMs: 5000 }, logger)
    ).rejects.toMatchObject({ code: "TIMEOUT", name: "OpencodeExecutionError" });
  });
});
