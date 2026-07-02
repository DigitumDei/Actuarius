import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import pino from "pino";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const logger = pino({ level: "silent" });

const { GeminiExecutionError, runGeminiRequest } = await import("../src/services/geminiExecutionService.js");
const { spawn } = await import("node:child_process");
const { DEFAULT_ARGV_TOTAL_LIMIT } = await import("../src/utils/spawnCollect.js");

const mockSpawn = vi.mocked(spawn);

function createMockChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
}): EventEmitter {
  const stdoutEE = new EventEmitter() as EventEmitter & { destroy?: () => void };
  stdoutEE.destroy = () => {};
  const stderrEE = new EventEmitter() as EventEmitter & { destroy?: () => void };
  stderrEE.destroy = () => {};
  const stdinEE = new EventEmitter() as EventEmitter & {
    write?: ReturnType<typeof vi.fn>;
    end?: ReturnType<typeof vi.fn>;
    destroy?: () => void;
  };
  stdinEE.write = vi.fn();
  stdinEE.end = vi.fn();
  stdinEE.destroy = () => {};

  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { destroy?: () => void };
    stderr: EventEmitter & { destroy?: () => void };
    stdin: EventEmitter & { write?: ReturnType<typeof vi.fn>; end?: ReturnType<typeof vi.fn>; destroy?: () => void };
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = stdoutEE;
  child.stderr = stderrEE;
  child.stdin = stdinEE;
  child.pid = 99999;
  child.kill = vi.fn();

  setTimeout(() => {
    if (opts.error) {
      child.emit("error", opts.error);
      return;
    }
    if (opts.stdout) {
      stdoutEE.emit("data", Buffer.from(opts.stdout));
    }
    if (opts.stderr) {
      stderrEE.emit("data", Buffer.from(opts.stderr));
    }
    child.emit("close", opts.exitCode ?? 0, null);
  }, 5);

  return child;
}

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

  it("constructs with NOT_AUTHENTICATED code", () => {
    const error = new GeminiExecutionError("NOT_AUTHENTICATED", "not authenticated");
    expect(error.code).toBe("NOT_AUTHENTICATED");
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

describe("runGeminiRequest — integration (real transport)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GEMINI_API_KEY", "test-key");
  });

  it("fails before spawning when GEMINI_API_KEY is not set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    await expect(runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "NOT_AUTHENTICATED",
      name: "GeminiExecutionError",
      message: "Gemini requires `GEMINI_API_KEY` to be set for API-key-based authentication."
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("uses argv transport for a small prompt (prompt stays in args, stdin not written)", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "gemini result", exitCode: 0 }),
    );

    const result = await runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);

    expect(result.text).toBe("gemini result");

    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("gemini");
    expect(args).toEqual(["-p", "hello", "--yolo"]);

    const stdinWrite = mockSpawn.mock.results[0]?.value?.stdin?.write;
    expect(stdinWrite).not.toHaveBeenCalled();
  });

  it("uses stdin transport for an oversized prompt (-p stays with empty value, prompt written to stdin)", async () => {
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "gemini result", exitCode: 0 }),
    );

    const result = await runGeminiRequest({ prompt: hugePrompt, cwd: "/tmp", timeoutMs: 5000 }, logger);

    expect(result.text).toBe("gemini result");

    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("gemini");
    expect(args).toEqual(["-p", "", "--yolo"]);

    const stdinWrite = mockSpawn.mock.results[0]?.value?.stdin?.write;
    expect(stdinWrite).toHaveBeenCalled();
    const writtenText = stdinWrite.mock.calls[0]?.[0];
    expect(typeof writtenText).toBe("string");
    expect(writtenText).toBe(hugePrompt);
  });

  it("preserves --model flag in correct position for oversized prompt with stdin transport", async () => {
    const hugePrompt = "y".repeat(DEFAULT_ARGV_TOTAL_LIMIT);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );

    await runGeminiRequest({ prompt: hugePrompt, cwd: "/tmp", timeoutMs: 5000, model: "gemini-2.5-pro" }, logger);

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(["-p", "", "--yolo", "--model", "gemini-2.5-pro"]);

    const stdinWrite = mockSpawn.mock.results[0]?.value?.stdin?.write;
    expect(stdinWrite).toHaveBeenCalled();
  });

  it("uses argv transport for small prompt with --model", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );

    await runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, model: "gemini-2.5-pro" }, logger);

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(["-p", "hello", "--yolo", "--model", "gemini-2.5-pro"]);
  });

  it("passes a scoped environment through to the subprocess", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );

    await runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, env: { PATH: "/scoped/bin" } }, logger);

    const [, args, opts] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(["-p", "hello", "--yolo"]);
    expect(opts).toMatchObject({ env: { PATH: "/scoped/bin" } });
  });

  it("throws GEMINI_UNAVAILABLE when binary is not found (ENOENT)", async () => {
    const err = Object.assign(new Error("spawn gemini ENOENT"), { code: "ENOENT" });
    mockSpawn.mockImplementation(() => { throw err; });

    await expect(runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "GEMINI_UNAVAILABLE",
      name: "GeminiExecutionError",
    });
  });

  it("throws TIMEOUT when process times out", async () => {
    const err = Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true, signal: "SIGTERM" });
    mockSpawn.mockImplementation(() => { throw err; });

    await expect(runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "TIMEOUT",
      name: "GeminiExecutionError",
    });
  });

  it("throws NOT_AUTHENTICATED when stderr contains auth prompt", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stderr: "set an Auth method to continue", exitCode: 1 }),
    );

    await expect(runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "NOT_AUTHENTICATED",
      name: "GeminiExecutionError",
    });
  });

  it("throws FAILED with buffer limit message on EMSGSIZE (not TIMEOUT)", async () => {
    const err = Object.assign(new Error("Process output exceeded maxBuffer"), {
      code: "EMSGSIZE", killed: true, signal: "SIGTERM",
      stdout: "a".repeat(500) + "\npartial output content\n",
      stderr: ""
    });
    mockSpawn.mockImplementation(() => { throw err; });

    await expect(runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "FAILED",
      name: "GeminiExecutionError",
    });
    await expect(runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toHaveProperty(
      "message",
      expect.stringMatching(/buffer limit/i)
    );
  });

  it("throws TIMEOUT (not NOT_AUTHENTICATED) when SIGTERM-killed process has auth-pattern stderr", async () => {
    const err = Object.assign(new Error("timed out"), {
      code: "ETIMEDOUT", killed: true, signal: "SIGTERM",
      stdout: "",
      stderr: "Enter the authorization code: something"
    });
    mockSpawn.mockImplementation(() => { throw err; });

    await expect(runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "TIMEOUT",
      name: "GeminiExecutionError",
    });
  });

  it("throws FAILED when process exits non-zero without auth pattern", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stderr: "something broke", exitCode: 1 }),
    );

    await expect(runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "FAILED",
      name: "GeminiExecutionError",
    });
  });

  it("throws EMPTY_OUTPUT when stdout is blank", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "  \n  ", exitCode: 0 }),
    );

    await expect(runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "EMPTY_OUTPUT",
      name: "GeminiExecutionError",
    });
  });
});
