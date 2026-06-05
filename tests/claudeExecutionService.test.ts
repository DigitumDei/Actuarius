import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

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
const { ClaudeExecutionError, extractTextFromClaudeJson, makeClaudeTransformOutput, runClaudeRequest } = await import("../src/services/claudeExecutionService.js");

const logger = pino({ level: "silent" });

describe("ClaudeExecutionError", () => {
  it("constructs with CLAUDE_UNAVAILABLE code", () => {
    const error = new ClaudeExecutionError("CLAUDE_UNAVAILABLE", "not found");
    expect(error.code).toBe("CLAUDE_UNAVAILABLE");
    expect(error.message).toBe("not found");
    expect(error.name).toBe("ClaudeExecutionError");
    expect(error).toBeInstanceOf(Error);
  });

  it("constructs with TIMEOUT code", () => {
    const error = new ClaudeExecutionError("TIMEOUT", "timed out");
    expect(error.code).toBe("TIMEOUT");
  });

  it("constructs with FAILED code", () => {
    const error = new ClaudeExecutionError("FAILED", "failed");
    expect(error.code).toBe("FAILED");
  });

  it("constructs with EMPTY_OUTPUT code", () => {
    const error = new ClaudeExecutionError("EMPTY_OUTPUT", "empty");
    expect(error.code).toBe("EMPTY_OUTPUT");
  });
});

describe("extractTextFromClaudeJson", () => {
  it("extracts direct result field", () => {
    expect(extractTextFromClaudeJson({ result: "done" })).toBe("done");
  });

  it("extracts direct output field", () => {
    expect(extractTextFromClaudeJson({ output: "hello" })).toBe("hello");
  });

  it("extracts direct text field", () => {
    expect(extractTextFromClaudeJson({ text: "direct" })).toBe("direct");
  });

  it("extracts text blocks from content array", () => {
    const value = extractTextFromClaudeJson({
      content: [{ text: "line1" }, { type: "tool" }, { text: "line2" }]
    });
    expect(value).toBe("line1\nline2");
  });

  it("returns null for unsupported payload", () => {
    expect(extractTextFromClaudeJson({})).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(extractTextFromClaudeJson(null)).toBeNull();
    expect(extractTextFromClaudeJson("string")).toBeNull();
  });
});

describe("makeClaudeTransformOutput", () => {
  const transform = makeClaudeTransformOutput();

  it("extracts text from valid JSON with result field", () => {
    expect(transform('{"result":"hello world"}')).toBe("hello world");
  });

  it("extracts text from JSON with content array", () => {
    const output = transform(JSON.stringify({ content: [{ text: "line1" }, { text: "line2" }] }));
    expect(output).toBe("line1\nline2");
  });

  it("passes through non-JSON stdout as-is", () => {
    expect(transform("plain text output")).toBe("plain text output");
  });

  it("passes through malformed JSON as-is", () => {
    expect(transform("{invalid json}")).toBe("{invalid json}");
  });

  it("returns empty string for JSON with no extractable text", () => {
    expect(transform('{}')).toBe("");
  });
});

describe("runClaudeRequest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns trimmed text extracted from JSON stdout on success", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: '{"result":"claude output"}', stderr: "" });
    const result = await runClaudeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(result.text).toBe("claude output");
  });

  it("passes -p prompt flag, --output-format json, and --permission-mode bypassPermissions", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: '{"result":"ok"}', stderr: "" });
    await runClaudeRequest({ prompt: "my prompt", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "claude",
        args: ["-p", "my prompt", "--output-format", "json", "--permission-mode", "bypassPermissions"],
        cwd: "/tmp",
        promptArgIndices: [0, 1],
      })
    );
  });

  it("appends --model flag when model is provided", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: '{"result":"ok"}', stderr: "" });
    await runClaudeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, model: "o4-mini" }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "claude",
        args: ["-p", "hello", "--output-format", "json", "--permission-mode", "bypassPermissions", "--model", "o4-mini"],
        cwd: "/tmp",
      })
    );
  });

  it("passes scoped env vars to the Claude CLI", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: '{"result":"ok"}', stderr: "" });

    await runClaudeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, env: { PATH: "/scoped/bin" } }, logger);

    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "claude",
        env: { PATH: "/scoped/bin" }
      })
    );
  });

  it("uses transformOutput to extract text from JSON and falls back to raw stdout for non-JSON", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "plain text result", stderr: "" });
    const result = await runClaudeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(result.text).toBe("plain text result");
  });

  it("throws CLAUDE_UNAVAILABLE when binary is not found (ENOENT)", async () => {
    const err = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    mockSpawnCollectWithTransport.mockRejectedValueOnce(err);
    await expect(runClaudeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "CLAUDE_UNAVAILABLE",
      name: "ClaudeExecutionError",
    });
  });

  it("throws TIMEOUT when process times out (ETIMEDOUT)", async () => {
    const err = Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true, signal: "SIGTERM" });
    mockSpawnCollectWithTransport.mockRejectedValueOnce(err);
    await expect(runClaudeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "TIMEOUT",
      name: "ClaudeExecutionError",
    });
  });

  it("throws FAILED when process exits non-zero", async () => {
    const err = Object.assign(new Error("Process exited with code 1"), { killed: false, signal: null });
    mockSpawnCollectWithTransport.mockRejectedValueOnce(err);
    await expect(runClaudeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "FAILED",
      name: "ClaudeExecutionError",
    });
  });

  it("throws EMPTY_OUTPUT when stdout is blank after transformOutput", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "  \n  ", stderr: "" });
    await expect(runClaudeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "EMPTY_OUTPUT",
      name: "ClaudeExecutionError",
    });
  });

  it("throws EMPTY_OUTPUT when JSON response has no extractable text", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "{}", stderr: "" });
    await expect(runClaudeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "EMPTY_OUTPUT",
      name: "ClaudeExecutionError",
    });
  });
});
