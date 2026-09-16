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

// Keep the settings-file fixup off the test runner's real $HOME.
vi.mock("../src/services/antigravityCli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/antigravityCli.js")>();
  return {
    ...actual,
    ensureAntigravityApiKeyConfig: vi.fn().mockResolvedValue(undefined),
    prefersAntigravityAccountAuth: vi.fn().mockResolvedValue(false),
  };
});

const logger = pino({ level: "silent" });

const { GeminiExecutionError, runGeminiRequest } = await import("../src/services/geminiExecutionService.js");
const { ensureAntigravityApiKeyConfig, prefersAntigravityAccountAuth } = await import("../src/services/antigravityCli.js");
const { spawn } = await import("node:child_process");
const { DEFAULT_ARGV_TOTAL_LIMIT } = await import("../src/utils/spawnCollect.js");

const mockSpawn = vi.mocked(spawn);
const mockEnsureApiKeyConfig = vi.mocked(ensureAntigravityApiKeyConfig);
const mockPrefersAccountAuth = vi.mocked(prefersAntigravityAccountAuth);

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
    mockPrefersAccountAuth.mockResolvedValue(false);
    vi.stubEnv("GEMINI_API_KEY", "test-key");
  });

  it("runs agy with signed-in account auth without requiring GEMINI_API_KEY", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "account auth result", exitCode: 0 }),
    );

    const result = await runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);

    expect(result.text).toBe("account auth result");
    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("agy");
    expect(args).toEqual(["-p", "hello", "--dangerously-skip-permissions", "--print-timeout", "5s"]);
    expect(mockEnsureApiKeyConfig).toHaveBeenCalledWith(logger, expect.anything(), false);
  });

  it("merges the API-key settings marker when GEMINI_API_KEY is present", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "key result", exitCode: 0 }),
    );

    await runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);

    expect(mockEnsureApiKeyConfig).toHaveBeenCalledTimes(1);
  });

  it("keeps a completed account login ahead of an injected API key", async () => {
    mockPrefersAccountAuth.mockResolvedValueOnce(true);
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "account result", exitCode: 0 }),
    );

    await runGeminiRequest({
      prompt: "hello",
      cwd: "/tmp",
      timeoutMs: 5000,
      env: { HOME: "/data/home/appuser", GEMINI_API_KEY: "deployed-key", PATH: "/bin" }
    }, logger);

    expect(mockEnsureApiKeyConfig).toHaveBeenCalledWith(logger, "/data/home/appuser", false);
    const spawnOptions = mockSpawn.mock.calls[0]?.[2];
    expect(spawnOptions?.env?.GEMINI_API_KEY).toBeUndefined();
  });

  it("decides API-key auth from the child environment, not just process.env", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "scoped result", exitCode: 0 }),
    );

    await runGeminiRequest(
      { prompt: "hello", cwd: "/tmp", timeoutMs: 5000, env: { PATH: "/scoped/bin" } },
      logger
    );

    // process.env has a key but the scoped child env does not, so the marker
    // must not be written (agy would otherwise refuse to start).
    expect(mockEnsureApiKeyConfig).toHaveBeenCalledWith(logger, expect.any(String), false);
  });

  it("uses argv transport for a small prompt (prompt stays in args, stdin not written)", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "agy result", exitCode: 0 }),
    );

    const result = await runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);

    expect(result.text).toBe("agy result");

    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("agy");
    expect(args).toEqual(["-p", "hello", "--dangerously-skip-permissions", "--print-timeout", "5s"]);

    const stdinWrite = mockSpawn.mock.results[0]?.value?.stdin?.write;
    expect(stdinWrite).not.toHaveBeenCalled();
  });

  it("preserves plain text that happens to contain an NDJSON-shaped result line", async () => {
    const text = 'Example output:\n{"event":"result","result":{"status":"ERROR","response":"example only"}}\n';
    mockSpawn.mockImplementation(() => createMockChild({ stdout: text, exitCode: 0 }));

    await expect(runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger))
      .resolves.toEqual({ text: text.trim() });
  });

  it("uses stream-json stdin transport for an oversized prompt (prompt sent as a user event)", async () => {
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: [
        '{"event":"init","conversation_id":"055a398f-db14-4c5f-abbb-1bf03f8120a7","init":{"cwd":"/tmp"}}',
        '{"event":"result","result":{"conversation_id":"055a398f-db14-4c5f-abbb-1bf03f8120a7","status":"SUCCESS","response":"agy result\\n","num_turns":1}}'
      ].join("\n"), exitCode: 0 }),
    );

    const result = await runGeminiRequest({ prompt: hugePrompt, cwd: "/tmp", timeoutMs: 5000 }, logger);

    expect(result.text).toBe("agy result");

    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("agy");
    expect(args).toEqual([
      "--input-format", "stream-json", "--output-format", "stream-json",
      "--dangerously-skip-permissions", "--print-timeout", "5s"
    ]);

    const stdinWrite = mockSpawn.mock.results[0]?.value?.stdin?.write;
    expect(stdinWrite).toHaveBeenCalled();
    const written = stdinWrite.mock.calls[0]?.[0] as string;
    expect(typeof written).toBe("string");
    const message = JSON.parse(written) as { event: string; message: { content: string } };
    expect(message.event).toBe("user");
    expect(message.message.content).toBe(hugePrompt);
  });

  it("throws FAILED when a clean-exit stream reports a non-SUCCESS terminal status", async () => {
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);

    mockSpawn.mockImplementation(() =>
      createMockChild({
        stdout: '{"event":"result","result":{"conversation_id":"abc","status":"ERROR","response":"","error":"invalid model selection"}}\n',
        exitCode: 0,
      }),
    );

    await expect(runGeminiRequest({ prompt: hugePrompt, cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "FAILED",
      name: "GeminiExecutionError",
      message: expect.stringContaining("status ERROR"),
    });
  });

  it.each(["WAITING", "RUNNING"]) ("rejects a %s terminal stream status", async (status) => {
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);
    mockSpawn.mockImplementation(() => createMockChild({
      stdout: `{"event":"result","result":{"status":"${status}","response":""}}\n`,
      exitCode: 0,
    }));

    await expect(runGeminiRequest({ prompt: hugePrompt, cwd: "/tmp", timeoutMs: 5000 }, logger))
      .rejects.toMatchObject({ code: "FAILED", message: expect.stringContaining(`status ${status}`) });
  });

  it("rejects a structured stream without a terminal result", async () => {
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);
    mockSpawn.mockImplementation(() => createMockChild({
      stdout: '{"event":"init","conversation_id":"abc"}\n',
      exitCode: 0,
    }));

    await expect(runGeminiRequest({ prompt: hugePrompt, cwd: "/tmp", timeoutMs: 5000 }, logger))
      .rejects.toMatchObject({ code: "FAILED", message: expect.stringContaining("MISSING_RESULT") });
  });

  it("treats an empty SUCCESS response as empty output", async () => {
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);
    mockSpawn.mockImplementation(() => createMockChild({
      stdout: '{"event":"result","result":{"status":"SUCCESS","response":""}}\n',
      exitCode: 0,
    }));

    await expect(runGeminiRequest({ prompt: hugePrompt, cwd: "/tmp", timeoutMs: 5000 }, logger))
      .rejects.toMatchObject({ code: "EMPTY_OUTPUT" });
  });

  it("classifies a SUCCESS response with a non-string response as FAILED", async () => {
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);
    mockSpawn.mockImplementation(() => createMockChild({
      stdout: '{"event":"result","result":{"status":"SUCCESS","response":42}}\n',
      exitCode: 0,
    }));

    await expect(runGeminiRequest({ prompt: hugePrompt, cwd: "/tmp", timeoutMs: 5000 }, logger))
      .rejects.toMatchObject({
        code: "FAILED",
        name: "GeminiExecutionError",
        message: expect.stringContaining("terminal result response is missing or not a string"),
      });
  });

  it("preserves --model flag in correct position for oversized prompt with stdin transport", async () => {
    const hugePrompt = "y".repeat(DEFAULT_ARGV_TOTAL_LIMIT);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: '{"event":"result","result":{"conversation_id":"abc","status":"SUCCESS","response":"ok\\n","num_turns":1}}\n', exitCode: 0 }),
    );

    await runGeminiRequest({ prompt: hugePrompt, cwd: "/tmp", timeoutMs: 5000, model: "gemini-2.5-pro" }, logger);

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual([
      "--input-format", "stream-json", "--output-format", "stream-json",
      "--dangerously-skip-permissions", "--print-timeout", "5s", "--model", "gemini-2.5-pro"
    ]);

    const stdinWrite = mockSpawn.mock.results[0]?.value?.stdin?.write;
    expect(stdinWrite).toHaveBeenCalled();
  });

  it("uses argv transport for small prompt with --model", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );

    await runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, model: "gemini-2.5-pro" }, logger);

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(["-p", "hello", "--dangerously-skip-permissions", "--print-timeout", "5s", "--model", "gemini-2.5-pro"]);
  });

  it("passes a scoped environment through to the subprocess", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );

    await runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, env: { PATH: "/scoped/bin" } }, logger);

    const [, args, opts] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(["-p", "hello", "--dangerously-skip-permissions", "--print-timeout", "5s"]);
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

  it("includes the terminal result status in timeout activity", async () => {
    const err = Object.assign(new Error("timed out"), {
      code: "ETIMEDOUT", killed: true, signal: "SIGTERM",
      stdout: '{"event":"result","result":{"status":"WAITING"}}\n',
      stderr: "",
      lastOutput: { stream: "stdout" },
    });
    mockSpawn.mockImplementation(() => { throw err; });

    await expect(runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger))
      .rejects.toMatchObject({ code: "TIMEOUT", lastActivity: "result status=WAITING" });
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

  it("throws FAILED (not NOT_AUTHENTICATED or TIMEOUT) on EMSGSIZE with auth-pattern stderr", async () => {
    const err = Object.assign(new Error("Process output exceeded maxBuffer"), {
      code: "EMSGSIZE", killed: true, signal: "SIGTERM",
      stdout: "a".repeat(500) + "\npartial output",
      stderr: "set an Auth method to continue"
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
