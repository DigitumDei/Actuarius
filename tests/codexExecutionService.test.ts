import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
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

const { CodexExecutionError, runCodexRequest } = await import("../src/services/codexExecutionService.js");
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

describe("runCodexRequest — integration (real transport)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses argv transport for a small prompt (prompt stays in args, stdin not written)", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "codex result", exitCode: 0 }),
    );

    const result = await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);

    expect(result.text).toBe("codex result");

    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("codex");
    expect(args).toEqual(["exec", "hello", "--dangerously-bypass-approvals-and-sandbox"]);

    const stdinWrite = mockSpawn.mock.results[0]?.value?.stdin?.write;
    expect(stdinWrite).not.toHaveBeenCalled();
  });

  it("uses stdin transport for an oversized prompt (prompt removed from args, written to stdin)", async () => {
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "codex result", exitCode: 0 }),
    );

    const result = await runCodexRequest({ prompt: hugePrompt, cwd: "/tmp", timeoutMs: 5000 }, logger);

    expect(result.text).toBe("codex result");

    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("codex");
    expect(args).not.toContain(hugePrompt);
    expect(args).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox"]);

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

    await runCodexRequest({ prompt: hugePrompt, cwd: "/tmp", timeoutMs: 5000, model: "o4-mini" }, logger);

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox", "--model", "o4-mini"]);
    expect(args).not.toContain(hugePrompt);

    const stdinWrite = mockSpawn.mock.results[0]?.value?.stdin?.write;
    expect(stdinWrite).toHaveBeenCalled();
  });

  it("uses argv transport for small prompt with --model", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );

    await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, model: "o4-mini" }, logger);

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(["exec", "hello", "--dangerously-bypass-approvals-and-sandbox", "--model", "o4-mini"]);
  });

  it("passes a scoped environment through to the subprocess", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );

    await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, env: { PATH: "/scoped/bin" } }, logger);

    const [, args, opts] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(["exec", "hello", "--dangerously-bypass-approvals-and-sandbox"]);
    expect(opts).toMatchObject({ env: { PATH: "/scoped/bin" } });
  });

  it("throws CODEX_UNAVAILABLE when binary is not found (ENOENT)", async () => {
    const err = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    mockSpawn.mockImplementation(() => { throw err; });

    await expect(runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "CODEX_UNAVAILABLE",
      name: "CodexExecutionError",
    });
  });

  it("throws TIMEOUT when process times out", async () => {
    const err = Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true, signal: "SIGTERM", stdout: "partial output", stderr: "error details" });
    mockSpawn.mockImplementation(() => { throw err; });

    await expect(runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "TIMEOUT",
      name: "CodexExecutionError",
    });
  });

  it("propagates partialStdout and partialStderr through timeout error", async () => {
    const err = Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true, signal: "SIGTERM", stdout: "partial agent output", stderr: "last error lines" });
    mockSpawn.mockImplementation(() => { throw err; });

    let caught: unknown;
    try {
      await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(CodexExecutionError);
    const codexErr = caught as CodexExecutionError;
    expect(codexErr.code).toBe("TIMEOUT");
    expect(codexErr.partialStdout).toBe("partial agent output");
    expect(codexErr.partialStderr).toBe("last error lines");
  });

  it("throws FAILED when process exits non-zero", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stderr: "something broke", exitCode: 1 }),
    );

    await expect(runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "FAILED",
      name: "CodexExecutionError",
    });
  });

  it("throws EMPTY_OUTPUT when stdout is blank", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "  \n  ", exitCode: 0 }),
    );

    await expect(runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "EMPTY_OUTPUT",
      name: "CodexExecutionError",
    });
  });
});
