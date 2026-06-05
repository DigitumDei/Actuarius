import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

// Mock only the process-spawning functions; keep the real (pure) byte-math
// helpers like exceedsArgvLimits/estimateSpawnPayloadBytes and the size
// constants so the transport decision runs for real.
vi.mock("../src/utils/spawnCollect.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/utils/spawnCollect.js")>();
  return {
    ...actual,
    spawnCollect: vi.fn(),
    spawnCollectWithTransport: vi.fn(),
  };
});

const { spawnCollectWithTransport } = await import("../src/utils/spawnCollect.js");
const mockSpawnCollectWithTransport = vi.mocked(spawnCollectWithTransport);

const { OpencodeExecutionError, runOpencodeRequest, OPENCODE_TEMPFILE_DIRECTIVE } = await import("../src/services/opencodeExecutionService.js");

const logger = pino({ level: "silent" });

describe("OpencodeExecutionError", () => {
  it("constructs with OPENCODE_UNAVAILABLE code", () => {
    const error = new OpencodeExecutionError("OPENCODE_UNAVAILABLE", "not found");
    expect(error.code).toBe("OPENCODE_UNAVAILABLE");
    expect(error.message).toBe("not found");
    expect(error.name).toBe("OpencodeExecutionError");
    expect(error).toBeInstanceOf(Error);
  });

  it("constructs with OPENCODE_DISABLED code", () => {
    const error = new OpencodeExecutionError("OPENCODE_DISABLED", "disabled");
    expect(error.code).toBe("OPENCODE_DISABLED");
  });

  it("constructs with NOT_AUTHENTICATED code", () => {
    const error = new OpencodeExecutionError("NOT_AUTHENTICATED", "no auth");
    expect(error.code).toBe("NOT_AUTHENTICATED");
  });

  it("constructs with TIMEOUT code", () => {
    const error = new OpencodeExecutionError("TIMEOUT", "timed out");
    expect(error.code).toBe("TIMEOUT");
  });

  it("constructs with FAILED code", () => {
    const error = new OpencodeExecutionError("FAILED", "failed");
    expect(error.code).toBe("FAILED");
  });

  it("constructs with EMPTY_OUTPUT code", () => {
    const error = new OpencodeExecutionError("EMPTY_OUTPUT", "empty");
    expect(error.code).toBe("EMPTY_OUTPUT");
  });
});

describe("runOpencodeRequest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DEEPSEEK_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("returns trimmed text from stdout on success", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "  opencode output\n", stderr: "" });
    const result = await runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(result.text).toBe("opencode output");
  });

  it("passes run subcommand, positional prompt, --dir, and --dangerously-skip-permissions", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runOpencodeRequest({ prompt: "my prompt", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "opencode",
        args: ["run", "--dir", "/tmp", "my prompt", "--dangerously-skip-permissions"],
        cwd: "/tmp",
        timeoutMs: 5000,
        maxBuffer: 4 * 1024 * 1024,
      })
    );
  });

  it("appends --model flag when model is provided", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, model: "o4-mini" }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "opencode",
        args: ["run", "--dir", "/tmp", "hello", "--dangerously-skip-permissions", "--model", "o4-mini"],
        cwd: "/tmp",
      })
    );
  });

  it("passes scoped env vars to the opencode CLI", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, env: { PATH: "/scoped/bin" } }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "opencode",
        env: { PATH: "/scoped/bin" },
      })
    );
  });

  it("passes supportsStdinFallback false for tempfile transport", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        supportsStdinFallback: false,
      })
    );
  });

  it("passes reshapeArgsForTempfile callback for oversized prompt fallback", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        reshapeArgsForTempfile: expect.any(Function),
      })
    );
  });

  it("reshapeArgsForTempfile inserts --file before --dangerously-skip-permissions", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    const { reshapeArgsForTempfile } = mockSpawnCollectWithTransport.mock.calls[0]![0] as { reshapeArgsForTempfile: (promptText: string, adjustedArgs: string[], tempFilePath: string) => string[] };

    const adjusted = ["run", "--dir", "/work", "--dangerously-skip-permissions", "--model", "o4-mini"];
    const result = reshapeArgsForTempfile("big prompt", adjusted, "/tmp/prompt.txt");
    expect(result).toEqual([
      "run", OPENCODE_TEMPFILE_DIRECTIVE, "--dir", "/work",
      "--file", "/tmp/prompt.txt",
      "--dangerously-skip-permissions",
      "--model", "o4-mini",
    ]);
  });

  it("reshapeArgsForTempfile appends --file and path when --dangerously-skip-permissions is absent", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    const { reshapeArgsForTempfile } = mockSpawnCollectWithTransport.mock.calls[0]![0] as { reshapeArgsForTempfile: (promptText: string, adjustedArgs: string[], tempFilePath: string) => string[] };

    const adjusted = ["run", "--dir", "/work", "--model", "o4-mini"];
    const result = reshapeArgsForTempfile("big prompt", adjusted, "/tmp/prompt.txt");
    expect(result).toEqual([
      "run", OPENCODE_TEMPFILE_DIRECTIVE, "--dir", "/work", "--model", "o4-mini",
      "--file", "/tmp/prompt.txt",
    ]);
  });

  it("throws NOT_AUTHENTICATED when no auth is configured", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    await expect(runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "NOT_AUTHENTICATED",
      name: "OpencodeExecutionError",
    });
  });

  it("throws OPENCODE_UNAVAILABLE when binary is not found (ENOENT)", async () => {
    const err = Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
    mockSpawnCollectWithTransport.mockRejectedValueOnce(err);
    await expect(runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "OPENCODE_UNAVAILABLE",
      name: "OpencodeExecutionError",
    });
  });

  it("throws NOT_AUTHENTICATED when auth failure pattern matches on process error", async () => {
    const err = Object.assign(
      new Error("not authenticated"),
      { stderr: "not authenticated: set an Auth method", stdout: "" },
    );
    mockSpawnCollectWithTransport.mockRejectedValueOnce(err);
    await expect(runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "NOT_AUTHENTICATED",
      name: "OpencodeExecutionError",
    });
  });

  it("throws NOT_AUTHENTICATED when auth failure pattern matches on clean exit stdout", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "API key not found. Use /opencode-auth to set one.", stderr: "" });
    await expect(runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "NOT_AUTHENTICATED",
      name: "OpencodeExecutionError",
    });
  });

  it("throws TIMEOUT when process times out (ETIMEDOUT)", async () => {
    const err = Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true, signal: "SIGTERM" });
    mockSpawnCollectWithTransport.mockRejectedValueOnce(err);
    await expect(runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "TIMEOUT",
      name: "OpencodeExecutionError",
    });
  });

  it("throws FAILED when process exits non-zero", async () => {
    const err = Object.assign(new Error("Process exited with code 1"), { killed: false, signal: null });
    mockSpawnCollectWithTransport.mockRejectedValueOnce(err);
    await expect(runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "FAILED",
      name: "OpencodeExecutionError",
    });
  });

  it("throws EMPTY_OUTPUT when stdout is blank", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "  \n  ", stderr: "" });
    await expect(runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "EMPTY_OUTPUT",
      name: "OpencodeExecutionError",
    });
  });

  it("prompt is not in argv when tempfile transport is used (reshape callback removes it)", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runOpencodeRequest({ prompt: "my prompt", cwd: "/tmp", timeoutMs: 5000 }, logger);
    const callArgs = mockSpawnCollectWithTransport.mock.calls[0]![0];
    const reshapeFn = callArgs.reshapeArgsForTempfile as (promptText: string, adjustedArgs: string[], tempFilePath: string) => string[];
    const promptText = "some oversized prompt that would not fit in argv";
    const adjustedArgs = ["run", "--dir", "/work", "--dangerously-skip-permissions"];
    const reshaped = reshapeFn(promptText, adjustedArgs, "/tmp/actuarius-prompt-xxx/prompt.txt");
    expect(reshaped).not.toContain(promptText);
    expect(reshaped).toContain("--file");
    expect(reshaped).toContain("/tmp/actuarius-prompt-xxx/prompt.txt");
  });
});
