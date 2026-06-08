import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import pino from "pino";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

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

function createLogCapture(): {
  writer: Writable;
  records: Record<string, unknown>[];
} {
  const records: Record<string, unknown>[] = [];
  const writer = new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      const lines = chunk.toString().trim().split("\n");
      for (const line of lines) {
        try {
          records.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // skip non-JSON lines
        }
      }
      callback();
    },
  });
  return { writer, records };
}

function filterTransportLogs(
  records: Record<string, unknown>[],
): Record<string, unknown>[] {
  return records.filter(
    (r) =>
      typeof r.msg === "string" &&
      (r.msg.includes("transport") || r.msg.includes("oversized") || r.msg.includes("stdin")),
  );
}

describe("Transport behavior acceptance", () => {
  let mockSpawn: ReturnType<typeof vi.mocked>;
  let DEFAULT_ARGV_TOTAL_LIMIT: number;
  let runGeminiRequest: typeof import("../src/services/geminiExecutionService.js").runGeminiRequest;
  let runOpencodeRequest: typeof import("../src/services/opencodeExecutionService.js").runOpencodeRequest;
  let runCodexRequest: typeof import("../src/services/codexExecutionService.js").runCodexRequest;
  let runClaudeRequest: typeof import("../src/services/claudeExecutionService.js").runClaudeRequest;

  beforeAll(async () => {
    const { spawn } = await import("node:child_process");
    mockSpawn = vi.mocked(spawn);
    const { DEFAULT_ARGV_TOTAL_LIMIT: limit } = await import("../src/utils/spawnCollect.js");
    DEFAULT_ARGV_TOTAL_LIMIT = limit;
    const geminiMod = await import("../src/services/geminiExecutionService.js");
    runGeminiRequest = geminiMod.runGeminiRequest;
    const opencodeMod = await import("../src/services/opencodeExecutionService.js");
    runOpencodeRequest = opencodeMod.runOpencodeRequest;
    const codexMod = await import("../src/services/codexExecutionService.js");
    runCodexRequest = codexMod.runCodexRequest;
    const claudeMod = await import("../src/services/claudeExecutionService.js");
    runClaudeRequest = claudeMod.runClaudeRequest;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    process.env.DEEPSEEK_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.DEEPSEEK_API_KEY;
  });

  // ── Gemini: flag-pair stdin fallback ──────────────────────────────────

  it("Gemini small prompt uses argv transport and logs no transport warning", async () => {
    const { writer, records } = createLogCapture();
    const logger = pino(writer);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "gemini output", exitCode: 0 }),
    );

    await runGeminiRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);

    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("gemini");
    expect(args).toEqual(["-p", "hello", "--yolo"]);

    const stdinWrite = mockSpawn.mock.results[0]?.value?.stdin?.write;
    expect(stdinWrite).not.toHaveBeenCalled();

    const transportLogs = filterTransportLogs(records);
    expect(transportLogs).toHaveLength(0);
  });

  it("Gemini oversized prompt uses -p '' + stdin fallback with structured log", async () => {
    const { writer, records } = createLogCapture();
    const logger = pino(writer);
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "gemini result", exitCode: 0 }),
    );

    await runGeminiRequest({ prompt: hugePrompt, cwd: "/tmp", timeoutMs: 5000 }, logger);

    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("gemini");
    expect(args).toEqual(["-p", "", "--yolo"]);

    const stdinWrite = mockSpawn.mock.results[0]?.value?.stdin?.write;
    expect(stdinWrite).toHaveBeenCalled();
    expect(stdinWrite.mock.calls[0]?.[0]).toBe(hugePrompt);

    const transportLog = records.find(
      (r) => (r as Record<string, unknown>).transportReason === "oversized_flag_pair_stdin",
    );
    expect(transportLog).toBeDefined();
    expect(transportLog).toMatchObject({
      transport: "stdin",
      transportReason: "oversized_flag_pair_stdin",
      useFlagPairStdin: true,
      logLabel: "Gemini",
      totalBytes: expect.any(Number),
      limitBytes: DEFAULT_ARGV_TOTAL_LIMIT,
    });
    expect(typeof (transportLog as Record<string, unknown>).stdinLength).toBe("number");
  });

  it("Gemini oversized prompt preserves --model in correct position with -p '' + stdin", async () => {
    const { writer, records } = createLogCapture();
    const logger = pino(writer);
    const hugePrompt = "y".repeat(DEFAULT_ARGV_TOTAL_LIMIT);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );

    await runGeminiRequest({ prompt: hugePrompt, cwd: "/tmp", timeoutMs: 5000, model: "gemini-2.5-pro" }, logger);

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(["-p", "", "--yolo", "--model", "gemini-2.5-pro"]);

    const transportLog = records.find(
      (r) => (r as Record<string, unknown>).transportReason === "oversized_flag_pair_stdin",
    );
    expect(transportLog).toBeDefined();
    expect(transportLog).toMatchObject({ logLabel: "Gemini" });
  });

  // ── OpenCode: tempfile transport ──────────────────────────────────────

  it("OpenCode small prompt uses argv transport and passes real logger", async () => {
    const { writer, records } = createLogCapture();
    const logger = pino({ level: "debug" }, writer);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "opencode output", exitCode: 0 }),
    );

    await runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);

    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("opencode");
    expect(args).toEqual(["run", "--dir", "/tmp", "hello", "--dangerously-skip-permissions"]);
    expect(args).not.toContain("--file");

    const transportLog = records.find(
      (r) => (r as Record<string, unknown>).transport === "argv",
    );
    expect(transportLog).toBeDefined();
    expect(transportLog).toMatchObject({
      transport: "argv",
      transportReason: "under_limit",
      logLabel: "OpenCode",
      totalBytes: expect.any(Number),
      limitBytes: DEFAULT_ARGV_TOTAL_LIMIT,
    });
  });

  it("OpenCode oversized prompt uses --file tempfile transport with structured log", async () => {
    const { writer, records } = createLogCapture();
    const logger = pino(writer);
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "opencode result", exitCode: 0 }),
    );

    await runOpencodeRequest({ prompt: hugePrompt, cwd: "/tmp", timeoutMs: 5000 }, logger);

    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("opencode");
    expect(args).not.toContain(hugePrompt);
    expect(args).toContain("--file");

    const fileFlagIdx = args!.indexOf("--file");
    const tempFilePath = args![fileFlagIdx + 1]!;
    expect(tempFilePath).toMatch(/prompt\.txt$/);

    const transportLog = records.find(
      (r) => (r as Record<string, unknown>).transportReason === "oversized_tempfile_fallback",
    );
    expect(transportLog).toBeDefined();
    expect(transportLog).toMatchObject({
      transport: "tempfile",
      transportReason: "oversized_tempfile_fallback",
      useFlagPairStdin: false,
      logLabel: "OpenCode",
      totalBytes: expect.any(Number),
      limitBytes: DEFAULT_ARGV_TOTAL_LIMIT,
    });
  });

  it("OpenCode oversized prompt preserves --dangerously-skip-permissions and --model with --file", async () => {
    const { writer, records } = createLogCapture();
    const logger = pino(writer);
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );

    await runOpencodeRequest({
      prompt: hugePrompt,
      cwd: "/work",
      timeoutMs: 5000,
      model: "o4-mini",
    }, logger);

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--model");
    expect(args).toContain("o4-mini");
    expect(args).toContain("--file");

    const skipIdx = args!.indexOf("--dangerously-skip-permissions");
    const fileIdx = args!.indexOf("--file");
    expect(fileIdx).toBeLessThan(skipIdx);

    const transportLog = records.find(
      (r) => (r as Record<string, unknown>).transportReason === "oversized_tempfile_fallback",
    );
    expect(transportLog).toBeDefined();
    expect(transportLog).toMatchObject({ logLabel: "OpenCode" });
  });

  // ── Codex: stdin transport ────────────────────────────────────────────

  it("Codex small prompt uses argv transport", async () => {
    const { writer, records } = createLogCapture();
    const logger = pino({ level: "debug" }, writer);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "codex output", exitCode: 0 }),
    );

    await runCodexRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);

    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("codex");
    expect(args).toEqual(["exec", "hello", "--dangerously-bypass-approvals-and-sandbox"]);

    const transportLog = records.find(
      (r) => (r as Record<string, unknown>).transport === "argv",
    );
    expect(transportLog).toBeDefined();
    expect(transportLog).toMatchObject({
      transport: "argv",
      transportReason: "under_limit",
      logLabel: "Codex",
    });
  });

  it("Codex oversized prompt uses stdin transport with structured log", async () => {
    const { writer, records } = createLogCapture();
    const logger = pino(writer);
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "codex result", exitCode: 0 }),
    );

    await runCodexRequest({ prompt: hugePrompt, cwd: "/tmp", timeoutMs: 5000 }, logger);

    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("codex");
    expect(args).not.toContain(hugePrompt);
    expect(args).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox"]);

    const stdinWrite = mockSpawn.mock.results[0]?.value?.stdin?.write;
    expect(stdinWrite).toHaveBeenCalled();
    expect(stdinWrite.mock.calls[0]?.[0]).toBe(hugePrompt);

    const transportLog = records.find(
      (r) => (r as Record<string, unknown>).transportReason === "oversized_stdin_fallback",
    );
    expect(transportLog).toBeDefined();
    expect(transportLog).toMatchObject({
      transport: "stdin",
      transportReason: "oversized_stdin_fallback",
      useFlagPairStdin: false,
      logLabel: "Codex",
      totalBytes: expect.any(Number),
      limitBytes: DEFAULT_ARGV_TOTAL_LIMIT,
    });
  });

  // ── Claude: positional prompt with argv ───────────────────────────────

  it("Claude small prompt uses argv transport with structured log", async () => {
    const { writer, records } = createLogCapture();
    const logger = pino({ level: "debug" }, writer);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: '{"result":"claude output"}', exitCode: 0 }),
    );

    await runClaudeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);

    const [file, args] = mockSpawn.mock.calls[0]!;
    expect(file).toBe("claude");
    expect(args).toEqual(["-p", "hello", "--output-format", "json", "--permission-mode", "bypassPermissions"]);

    const transportLog = records.find(
      (r) => (r as Record<string, unknown>).transport === "argv",
    );
    expect(transportLog).toBeDefined();
    expect(transportLog).toMatchObject({
      transport: "argv",
      transportReason: "under_limit",
      logLabel: "Claude",
    });
  });

  // ── Oversized no-fallback warning ─────────────────────────────────────

  it("spawnCollectWithTransport emits warn-level log when oversized with no fallback", async () => {
    const { writer, records } = createLogCapture();
    const logger = pino(writer);
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);
    const { spawnCollectWithTransport } = await import("../src/utils/spawnCollect.js");

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "survived", exitCode: 0 }),
    );

    await spawnCollectWithTransport({
      file: "node",
      args: ["-e", `process.stdout.write("survived");`, hugePrompt],
      promptArgIndices: [2],
      cwd: "/tmp",
      timeoutMs: 5000,
      maxBuffer: 1024 * 1024,
      supportsStdinFallback: false,
      logger,
      logLabel: "NoFallbackProvider",
    });

    const warnLog = records.find(
      (r) => r.level === pino.levels.values.warn,
    ) as Record<string, unknown> | undefined;
    expect(warnLog).toBeDefined();
    expect(warnLog).toMatchObject({
      transport: "argv",
      transportReason: "oversized_no_fallback",
      logLabel: "NoFallbackProvider",
      totalBytes: expect.any(Number),
      limitBytes: DEFAULT_ARGV_TOTAL_LIMIT,
    });
    expect(typeof warnLog.msg).toBe("string");
    expect((warnLog.msg as string).includes("transport")).toBe(true);
  });

  // ── Observability: log levels by transport reason ────────────────────

  it("logs at debug level for under_limit transport", async () => {
    const { writer, records } = createLogCapture();
    const logger = pino({ level: "debug" }, writer);
    const { spawnCollectWithTransport } = await import("../src/utils/spawnCollect.js");

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );

    await spawnCollectWithTransport({
      file: "node",
      args: ["-e", `process.stdout.write("ok");`],
      promptArgIndices: [],
      cwd: "/tmp",
      timeoutMs: 5000,
      maxBuffer: 1024,
      logger,
      logLabel: "DebugTest",
    });

    const debugLog = records.find(
      (r) => r.level === pino.levels.values.debug,
    ) as Record<string, unknown> | undefined;
    expect(debugLog).toBeDefined();
    expect(debugLog).toMatchObject({
      transport: "argv",
      transportReason: "under_limit",
      logLabel: "DebugTest",
    });
  });

  it("logs at info level for oversized stdin/tempfile fallback", async () => {
    const { writer, records } = createLogCapture();
    const logger = pino(writer);
    const { spawnCollectWithTransport } = await import("../src/utils/spawnCollect.js");
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );

    await spawnCollectWithTransport({
      file: "node",
      args: ["-e", `process.stdout.write("ok");`, hugePrompt],
      promptArgIndices: [2],
      cwd: "/tmp",
      timeoutMs: 5000,
      maxBuffer: 4 * 1024 * 1024,
      logger,
      logLabel: "InfoTest",
    });

    const infoLog = records.find(
      (r) => r.level === pino.levels.values.info,
    ) as Record<string, unknown> | undefined;
    expect(infoLog).toBeDefined();
    expect(infoLog).toMatchObject({
      transport: "stdin",
      transportReason: "oversized_stdin_fallback",
      logLabel: "InfoTest",
    });
  });

  it("includes structured fields (totalBytes, limitBytes) in every transport log", async () => {
    const { writer, records } = createLogCapture();
    const logger = pino(writer);
    const { spawnCollectWithTransport } = await import("../src/utils/spawnCollect.js");
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );

    await spawnCollectWithTransport({
      file: "node",
      args: ["-e", `process.stdout.write("ok");`, hugePrompt],
      promptArgIndices: [2],
      cwd: "/tmp",
      timeoutMs: 5000,
      maxBuffer: 4 * 1024 * 1024,
      supportsStdinFallback: false,
      tempfileFlag: ["--prompt-file", "/tmp/actuarius-prompt-test/prompt.txt"],
      logger,
      logLabel: "StructuredTest",
    });

    const tempfileLog = records.find(
      (r) => (r as Record<string, unknown>).transportReason === "oversized_tempfile_fallback",
    ) as Record<string, unknown> | undefined;
    expect(tempfileLog).toBeDefined();
    expect(tempfileLog).toMatchObject({
      transport: "tempfile",
      transportReason: "oversized_tempfile_fallback",
      logLabel: "StructuredTest",
      useFlagPairStdin: false,
    });
    expect(typeof (tempfileLog as Record<string, unknown>).totalBytes).toBe("number");
    expect(typeof (tempfileLog as Record<string, unknown>).limitBytes).toBe("number");
  });
});
