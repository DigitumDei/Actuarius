import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const logger = pino({ level: "silent" });

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

describe("runOpencodeRequest — integration (real transport)", () => {
  let runOpencodeRequest: typeof import("../src/services/opencodeExecutionService.js").runOpencodeRequest;
  let mockSpawn: ReturnType<typeof vi.mocked>;
  let DEFAULT_ARGV_TOTAL_LIMIT: number;

  beforeAll(async () => {
    const { runOpencodeRequest: ror } = await import("../src/services/opencodeExecutionService.js");
    runOpencodeRequest = ror;
    const { spawn } = await import("node:child_process");
    mockSpawn = vi.mocked(spawn);
    const { DEFAULT_ARGV_TOTAL_LIMIT: limit } = await import("../src/utils/spawnCollect.js");
    DEFAULT_ARGV_TOTAL_LIMIT = limit;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEEPSEEK_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("uses --file tempfile transport for oversized prompts (prompt removed from argv)", async () => {
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "opencode result", exitCode: 0 }),
    );

    const result = await runOpencodeRequest({
      prompt: hugePrompt,
      cwd: "/tmp",
      timeoutMs: 5000,
    }, logger);

    expect(result.text).toBe("opencode result");

    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("opencode");
    expect(args).not.toContain(hugePrompt);
    expect(args).toContain("--file");

    const fileFlagIdx = args!.indexOf("--file");
    const tempFilePath = args![fileFlagIdx + 1]!;
    expect(tempFilePath).toMatch(/prompt\.txt$/);

    const tempDir = tempFilePath.replace(/\/prompt\.txt$/, "");
    expect(existsSync(tempDir)).toBe(false);
  });

  it("cleans up temp directory on subprocess failure", async () => {
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);
    let capturedArgs: string[] = [];

    mockSpawn.mockImplementation((_file: string, args: string[]) => {
      capturedArgs = args;
      return createMockChild({ exitCode: 1 });
    });

    await expect(runOpencodeRequest({
      prompt: hugePrompt,
      cwd: "/tmp",
      timeoutMs: 5000,
    }, logger)).rejects.toThrow();

    const fileFlagIdx = capturedArgs.indexOf("--file");
    expect(fileFlagIdx).not.toBe(-1);
    const tempFilePath = capturedArgs[fileFlagIdx + 1]!;
    const tempDir = tempFilePath.replace("/prompt.txt", "");

    expect(existsSync(tempDir)).toBe(false);
  });

  it("uses argv transport for small prompts (no --file, no stdin)", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "normal output", exitCode: 0 }),
    );

    const result = await runOpencodeRequest({
      prompt: "hello",
      cwd: "/tmp",
      timeoutMs: 5000,
    }, logger);

    expect(result.text).toBe("normal output");

    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("opencode");
    expect(args).toEqual(["run", "--dir", "/tmp", "hello", "--dangerously-skip-permissions"]);
    expect(args).not.toContain("--file");
  });

  it("uses argv transport with --model for small prompts", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );

    await runOpencodeRequest({
      prompt: "hello",
      cwd: "/tmp",
      timeoutMs: 5000,
      model: "o4-mini",
    }, logger);

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(["run", "--dir", "/tmp", "hello", "--dangerously-skip-permissions", "--model", "o4-mini"]);
    expect(args).not.toContain("--file");
  });

  it("preserves --dangerously-skip-permissions in tempfile transport", async () => {
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );

    await runOpencodeRequest({
      prompt: hugePrompt,
      cwd: "/work",
      timeoutMs: 5000,
    }, logger);

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toContain("--dangerously-skip-permissions");
    const skipIdx = args!.indexOf("--dangerously-skip-permissions");
    const fileIdx = args!.indexOf("--file");
    expect(fileIdx).toBeLessThan(skipIdx);
  });
});
