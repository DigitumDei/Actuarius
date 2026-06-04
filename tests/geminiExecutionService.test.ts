import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

vi.mock("../src/utils/spawnCollect.js");

const { spawnCollectWithTransport } = await import("../src/utils/spawnCollect.js");
const mockSpawnCollectWithTransport = vi.mocked(spawnCollectWithTransport);

const { GeminiExecutionError, runGeminiRequest } = await import("../src/services/geminiExecutionService.js");

const logger = pino({ level: "silent" });

describe("GeminiExecutionError", () => {
  it("constructs with GEMINI_UNAVAILABLE code", () => {
    const error = new GeminiExecutionError("GEMINI_UNAVAILABLE", "not found");
    expect(error.code).toBe("GEMINI_UNAVAILABLE");
    expect(error.message).toBe("not found");
    expect(error.name).toBe("GeminiExecutionError");
    expect(error).toBeInstanceOf(Error);
  });

  it("constructs with GEMINI_DISABLED code", () => {
    const error = new GeminiExecutionError("GEMINI_DISABLED", "disabled");
    expect(error.code).toBe("GEMINI_DISABLED");
    expect(error.message).toBe("disabled");
  });

  it("constructs with TIMEOUT code", () => {
    const error = new GeminiExecutionError("TIMEOUT", "timed out");
    expect(error.code).toBe("TIMEOUT");
  });

  it("constructs with FAILED code", () => {
    const error = new GeminiExecutionError("FAILED", "failed");
    expect(error.code).toBe("FAILED");
  });

  it("constructs with EMPTY_OUTPUT code", () => {
    const error = new GeminiExecutionError("EMPTY_OUTPUT", "empty");
    expect(error.code).toBe("EMPTY_OUTPUT");
  });
});

describe("runGeminiRequest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it("fails before spawning when GEMINI_API_KEY is not set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    await expect(runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "NOT_AUTHENTICATED",
      name: "GeminiExecutionError",
      message: "Gemini requires `GEMINI_API_KEY` to be set for API-key-based authentication."
    });
    expect(mockSpawnCollectWithTransport).not.toHaveBeenCalled();
  });

  it("passes the prompt to the Gemini CLI when GEMINI_API_KEY is set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });

    await runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);

    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "gemini",
        args: ["-p", "hello", "--yolo"],
        cwd: "/tmp",
      })
    );
  });

  it("passes scoped env vars to the Gemini CLI", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });

    await runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, env: { PATH: "/scoped/bin" } }, logger);

    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "gemini",
        args: ["-p", "hello", "--yolo"],
        env: { PATH: "/scoped/bin" },
      })
    );
  });
});
