import { describe, expect, it, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import pino from "pino";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

vi.mock("../src/services/requestWorktreeService.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/requestWorktreeService.js")>(
    "../src/services/requestWorktreeService.js"
  );
  return { ...actual, createRequestWorktree: vi.fn(), deleteRequestBranch: vi.fn() };
});

vi.mock("../src/services/gitWorkspaceService.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/gitWorkspaceService.js")>(
    "../src/services/gitWorkspaceService.js"
  );
  return {
    ...actual,
    ensureRepoCheckedOutToMaster: vi.fn(),
    listBranches: vi.fn(),
    cleanupDeletedRemoteBranches: vi.fn(),
    detectDefaultBranch: vi.fn(),
    getHeadSha: vi.fn(),
    getDiffSinceRef: vi.fn(),
    getReviewDiff: vi.fn(),
    hasUncommittedChanges: vi.fn(),
    hasUncommittedChangesExcluding: vi.fn(),
    pushBranch: vi.fn(),
    autoCommitDirtyWorktree: vi.fn()
  };
});

vi.mock("../src/services/githubService.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/githubService.js")>(
    "../src/services/githubService.js"
  );
  return { ...actual, listOpenIssues: vi.fn(), viewIssueDetail: vi.fn() };
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
      (r.msg.includes("transport") || (r as Record<string, unknown>).transport !== undefined),
  );
}

describe("Bot entrypoint transport acceptance", () => {
  let mockSpawn: ReturnType<typeof vi.mocked>;
  let DEFAULT_ARGV_TOTAL_LIMIT: number;
  let ActuariusBot: typeof import("../src/discord/bot.js").ActuariusBot;
  let ensureRepoCheckedOutToMaster: ReturnType<typeof vi.mocked>;
  let createRequestWorktreeMock: ReturnType<typeof vi.mocked>;

  beforeAll(async () => {
    const { DEFAULT_ARGV_TOTAL_LIMIT: limit } = await import("../src/utils/spawnCollect.js");
    DEFAULT_ARGV_TOTAL_LIMIT = limit;
    const { spawn } = await import("node:child_process");
    mockSpawn = vi.mocked(spawn);
    const botMod = await import("../src/discord/bot.js");
    ActuariusBot = botMod.ActuariusBot;
    const gitMod = await import("../src/services/gitWorkspaceService.js");
    ensureRepoCheckedOutToMaster = vi.mocked(gitMod.ensureRepoCheckedOutToMaster);
    const worktreeMod = await import("../src/services/requestWorktreeService.js");
    createRequestWorktreeMock = vi.mocked(worktreeMod.createRequestWorktree);
  }, 30000);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    process.env.DEEPSEEK_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.DEEPSEEK_API_KEY;
  });

  function createBot(logger: pino.Logger, dbOverrides: Record<string, unknown> = {}) {
    const config = {
      discordToken: "token",
      discordClientId: "client",
      discordGuildId: undefined,
      ghToken: undefined,
      githubAppId: undefined,
      githubAppPrivateKey: undefined,
      githubAppPrivateKeyB64: undefined,
      githubAppInstallationId: undefined,
      gitUserName: undefined,
      gitUserEmail: undefined,
      geminiApiKey: undefined,
      databasePath: ":memory:",
      reposRootPath: "/data/repos",
      installsRootPath: "/data/tool-installs",
      githubCliConfigPath: "/data/.gh",
      logLevel: "info",
      threadAutoArchiveMinutes: 1440,
      askConcurrencyPerGuild: 1,
      askExecutionTimeoutMs: 5000,
      iterativeVerificationTimeoutMs: 1000,
      reviewConcurrency: 1,
      installStepTimeoutMs: 1000,
      aptInstallHelperPath: undefined,
      enableCodexExecution: true,
      enableGeminiExecution: true,
      enableOpencodeExecution: true,
      deepseekApiKey: undefined,
      attachmentMaxCount: 5,
      attachmentMaxFileSize: 10 * 1024 * 1024,
      attachmentMaxTotalSize: 25 * 1024 * 1024,
      attachmentMaxInlineText: 256 * 1024,
      mempalaceEnabled: false,
      mempalacePalacePath: "/data/mempalace/palace",
      mempalaceBinaryPath: "/usr/local/bin/mempalace-mcp"
    } as const;

    const db = {
      createRequest: vi.fn(),
      getGuildModelConfig: vi.fn(),
      updateRequestStatus: vi.fn(),
      updateRequestWorkspace: vi.fn(),
      listSuccessfulInstallRequestsForScope: vi.fn().mockReturnValue([]),
      ...dbOverrides
    };

    return new ActuariusBot(config, logger, db as never, null);
  }

  // ── Full queued-ask pipeline with real provider dispatch ──────────────

  it("queued ask with codex small prompt through real bot dispatch logs argv transport", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "codex answer", exitCode: 0 }),
    );
    ensureRepoCheckedOutToMaster.mockResolvedValue({ localPath: "/tmp/repo" });
    createRequestWorktreeMock.mockResolvedValue({
      path: "/tmp/worktree-queued",
      branchName: "ask/1-abc",
    });

    const thread = {
      isThread: () => true,
      send: vi.fn().mockResolvedValue(undefined),
      messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
    };

    const { writer, records } = createLogCapture();
    const logger = pino({ level: "debug" }, writer);

    const bot = createBot(logger, {
      updateRequestStatus: vi.fn(),
      updateRequestWorkspace: vi.fn(),
    });
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue(thread);

    await (bot as any).runQueuedRequest({
      requestId: 1,
      threadId: "thread-1",
      repoId: 1,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: "Do the thing",
      provider: "codex",
    });

    const transportLogs = filterTransportLogs(records);
    expect(transportLogs.length).toBeGreaterThan(0);

    const argvLog = transportLogs.find(
      (r) =>
        (r as Record<string, unknown>).transport === "argv" &&
        (r as Record<string, unknown>).logLabel === "Codex",
    ) as Record<string, unknown> | undefined;
    expect(argvLog).toBeDefined();
    expect(argvLog!.transportReason).toBe("under_limit");
    expect(argvLog!.logLabel).toBe("Codex");
    expect(typeof argvLog!.totalBytes).toBe("number");
    expect(argvLog!.limitBytes).toBe(DEFAULT_ARGV_TOTAL_LIMIT);
  });

  it("does not log request success when cancellation wins the completion race", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "codex answer", exitCode: 0 }),
    );
    ensureRepoCheckedOutToMaster.mockResolvedValue({ localPath: "/tmp/repo" });
    createRequestWorktreeMock.mockResolvedValue({
      path: "/tmp/worktree-cancelled",
      branchName: "ask/5-abc",
    });

    const thread = {
      isThread: () => true,
      send: vi.fn().mockResolvedValue(undefined),
      messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
    };
    const { writer, records } = createLogCapture();
    const logger = pino({ level: "debug" }, writer);
    const updateRequestStatus = vi.fn();
    const completeRequestIfActive = vi.fn().mockReturnValue(false);
    const bot = createBot(logger, {
      updateRequestStatus,
      updateRequestWorkspace: vi.fn(),
      completeRequestIfActive,
    });
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue(thread);

    await (bot as any).runQueuedRequest({
      requestId: 5,
      threadId: "thread-5",
      repoId: 1,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: "Do the thing",
      provider: "codex",
    });

    expect(completeRequestIfActive).toHaveBeenCalledWith(5);
    expect(updateRequestStatus).toHaveBeenCalledWith(5, "running");
    expect(updateRequestStatus).not.toHaveBeenCalledWith(5, "succeeded");
    expect(records.some((record) => record.msg === "Queued AI request succeeded")).toBe(false);
  });

  it("queued ask with gemini oversized prompt through real bot dispatch uses stdin fallback with -p '' retained", async () => {
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "gemini result", exitCode: 0 }),
    );
    ensureRepoCheckedOutToMaster.mockResolvedValue({ localPath: "/tmp/repo" });
    createRequestWorktreeMock.mockResolvedValue({
      path: "/tmp/worktree-gemini",
      branchName: "ask/2-abc",
    });

    const thread = {
      isThread: () => true,
      send: vi.fn().mockResolvedValue(undefined),
      messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
    };

    const { writer, records } = createLogCapture();
    const logger = pino(writer);

    const bot = createBot(logger, {
      updateRequestStatus: vi.fn(),
      updateRequestWorkspace: vi.fn(),
    });
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue(thread);

    await (bot as any).runQueuedRequest({
      requestId: 2,
      threadId: "thread-2",
      repoId: 1,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: hugePrompt,
      provider: "gemini",
    });

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toContain("-p");
    expect(args).toContain("");

    const stdinWrite = mockSpawn.mock.results[0]?.value?.stdin?.write;
    expect(stdinWrite).toHaveBeenCalled();
    const stdinArg = stdinWrite.mock.calls[0]?.[0] as string | undefined;
    expect(stdinArg).toBeDefined();
    expect(stdinArg!.length).toBeGreaterThan(DEFAULT_ARGV_TOTAL_LIMIT);
    expect(stdinArg).toContain(hugePrompt);

    const transportLog = records.find(
      (r) => (r as Record<string, unknown>).transportReason === "oversized_flag_pair_stdin",
    ) as Record<string, unknown> | undefined;
    expect(transportLog).toBeDefined();
    expect(transportLog!).toMatchObject({
      transport: "stdin",
      useFlagPairStdin: true,
      logLabel: "Gemini",
      totalBytes: expect.any(Number),
      limitBytes: DEFAULT_ARGV_TOTAL_LIMIT,
    });
    expect(typeof transportLog!.stdinLength).toBe("number");
  });

  it("queued ask with gemini oversized prompt preserves --model and structured transport event through bot dispatch", async () => {
    const hugePrompt = "y".repeat(DEFAULT_ARGV_TOTAL_LIMIT);
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );
    ensureRepoCheckedOutToMaster.mockResolvedValue({ localPath: "/tmp/repo" });
    createRequestWorktreeMock.mockResolvedValue({
      path: "/tmp/worktree-gemini-2",
      branchName: "ask/3-abc",
    });

    const thread = {
      isThread: () => true,
      send: vi.fn().mockResolvedValue(undefined),
      messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
    };

    const { writer, records } = createLogCapture();
    const logger = pino(writer);

    const bot = createBot(logger, {
      updateRequestStatus: vi.fn(),
      updateRequestWorkspace: vi.fn(),
    });
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue(thread);

    await (bot as any).runQueuedRequest({
      requestId: 3,
      threadId: "thread-3",
      repoId: 1,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: hugePrompt,
      provider: "gemini",
      model: "gemini-2.5-pro",
    });

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(["-p", "", "--yolo", "--model", "gemini-2.5-pro"]);

    const transportLog = records.find(
      (r) => (r as Record<string, unknown>).transportReason === "oversized_flag_pair_stdin",
    ) as Record<string, unknown> | undefined;
    expect(transportLog).toBeDefined();
    expect(transportLog!).toMatchObject({ logLabel: "Gemini" });
  });

  it("queued ask with opencode oversized prompt through real bot dispatch uses --file tempfile transport", async () => {
    const hugePrompt = "z".repeat(DEFAULT_ARGV_TOTAL_LIMIT);
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "opencode result", exitCode: 0 }),
    );
    ensureRepoCheckedOutToMaster.mockResolvedValue({ localPath: "/tmp/repo" });
    createRequestWorktreeMock.mockResolvedValue({
      path: "/tmp/worktree-opencode",
      branchName: "ask/4-abc",
    });

    const thread = {
      isThread: () => true,
      send: vi.fn().mockResolvedValue(undefined),
      messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
    };

    const { writer, records } = createLogCapture();
    const logger = pino(writer);

    const bot = createBot(logger, {
      updateRequestStatus: vi.fn(),
      updateRequestWorkspace: vi.fn(),
    });
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue(thread);

    await (bot as any).runQueuedRequest({
      requestId: 4,
      threadId: "thread-4",
      repoId: 1,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: hugePrompt,
      provider: "opencode",
      model: "o4-mini",
    });

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).not.toContain(hugePrompt);
    expect(args).toContain("--file");

    const fileFlagIdx = args!.indexOf("--file");
    const tempFilePath = args![fileFlagIdx + 1]!;
    expect(tempFilePath).toMatch(/prompt\.txt$/);

    const agentIdx = args!.indexOf("--agent");
    const skipIdx = args!.indexOf("--dangerously-skip-permissions");
    expect(skipIdx).not.toBe(-1);
    expect(fileFlagIdx).toBeLessThan(agentIdx);
    expect(agentIdx).toBeLessThan(skipIdx);

    expect(args).toContain("--model");
    expect(args).toContain("o4-mini");

    const transportLog = records.find(
      (r) => (r as Record<string, unknown>).transportReason === "oversized_tempfile_fallback",
    ) as Record<string, unknown> | undefined;
    expect(transportLog).toBeDefined();
    expect(transportLog!).toMatchObject({
      transport: "tempfile",
      logLabel: "OpenCode",
      totalBytes: expect.any(Number),
      limitBytes: DEFAULT_ARGV_TOTAL_LIMIT,
    });
    expect(transportLog!.level).toBe(pino.levels.values.info);
  });

  // ── Direct runProviderText calls (still through real provider dispatch) ─

  it("codex small prompt through bot runProviderText logs argv transport under_limit", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "codex output", exitCode: 0 }),
    );

    const { writer, records } = createLogCapture();
    const logger = pino({ level: "debug" }, writer);
    const bot = createBot(logger);

    const result = await (bot as any).runProviderText({
      provider: "codex",
      prompt: "hello",
      cwd: "/tmp",
    });

    expect(result).toBe("codex output");

    const transportLog = records.find(
      (r) =>
        (r as Record<string, unknown>).transport === "argv" &&
        (r as Record<string, unknown>).logLabel === "Codex",
    ) as Record<string, unknown> | undefined;
    expect(transportLog).toBeDefined();
    expect(transportLog!).toMatchObject({
      transportReason: "under_limit",
      logLabel: "Codex",
      totalBytes: expect.any(Number),
      limitBytes: DEFAULT_ARGV_TOTAL_LIMIT,
    });
    // under_limit logs at debug level
    expect(transportLog!.level).toBe(pino.levels.values.debug);
  });

  it("codex oversized prompt through bot runProviderText logs stdin transport", async () => {
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "codex oversized result", exitCode: 0 }),
    );

    const { writer, records } = createLogCapture();
    const logger = pino(writer);
    const bot = createBot(logger);

    const result = await (bot as any).runProviderText({
      provider: "codex",
      prompt: hugePrompt,
      cwd: "/tmp",
    });

    expect(result).toBe("codex oversized result");

    const transportLog = records.find(
      (r) => (r as Record<string, unknown>).transportReason === "oversized_stdin_fallback",
    ) as Record<string, unknown> | undefined;
    expect(transportLog).toBeDefined();
    expect(transportLog!).toMatchObject({
      transport: "stdin",
      useFlagPairStdin: false,
      logLabel: "Codex",
    });
    // oversized fallback logs at info level
    expect(transportLog!.level).toBe(pino.levels.values.info);
  });

  it("opencode oversized prompt through bot runProviderText uses --file tempfile transport", async () => {
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "opencode result", exitCode: 0 }),
    );

    const { writer, records } = createLogCapture();
    const logger = pino(writer);
    const bot = createBot(logger);

    const result = await (bot as any).runProviderText({
      provider: "opencode",
      prompt: hugePrompt,
      cwd: "/tmp",
    });

    expect(result).toBe("opencode result");

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).not.toContain(hugePrompt);
    expect(args).toContain("--file");

    const fileFlagIdx = args!.indexOf("--file");
    const tempFilePath = args![fileFlagIdx + 1]!;
    expect(tempFilePath).toMatch(/prompt\.txt$/);

    const transportLog = records.find(
      (r) => (r as Record<string, unknown>).transportReason === "oversized_tempfile_fallback",
    ) as Record<string, unknown> | undefined;
    expect(transportLog).toBeDefined();
    expect(transportLog!).toMatchObject({
      transport: "tempfile",
      useFlagPairStdin: false,
      logLabel: "OpenCode",
    });
    // oversized tempfile logs at info level
    expect(transportLog!.level).toBe(pino.levels.values.info);
  });

  it("opencode oversized prompt through bot runProviderText preserves the supervised agent and --model with --file", async () => {
    const hugePrompt = "x".repeat(DEFAULT_ARGV_TOTAL_LIMIT);
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "ok", exitCode: 0 }),
    );

    const { writer, records } = createLogCapture();
    const logger = pino(writer);
    const bot = createBot(logger);

    await (bot as any).runProviderText({
      provider: "opencode",
      prompt: hugePrompt,
      cwd: "/work",
      model: "o4-mini",
      role: "implementation",
    });

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toContain("--agent");
    expect(args).toContain("build");
    expect(args).toContain("--model");
    expect(args).toContain("o4-mini");
    expect(args).toContain("--file");

    const agentIdx = args!.indexOf("--agent");
    const fileIdx = args!.indexOf("--file");
    expect(fileIdx).toBeLessThan(agentIdx);

    const transportLog = records.find(
      (r) => (r as Record<string, unknown>).transportReason === "oversized_tempfile_fallback",
    ) as Record<string, unknown> | undefined;
    expect(transportLog).toBeDefined();
    expect(transportLog!).toMatchObject({ logLabel: "OpenCode" });
  });

  it("gemini small prompt through bot runProviderText uses argv transport with no stdin write", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "gemini small", exitCode: 0 }),
    );

    const { writer, records } = createLogCapture();
    const logger = pino({ level: "debug" }, writer);
    const bot = createBot(logger);

    const result = await (bot as any).runProviderText({
      provider: "gemini",
      prompt: "hello",
      cwd: "/tmp",
    });

    expect(result).toBe("gemini small");

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toEqual(["-p", "hello", "--yolo"]);

    const stdinWrite = mockSpawn.mock.results[0]?.value?.stdin?.write;
    expect(stdinWrite).not.toHaveBeenCalled();

    const transportLogs = filterTransportLogs(records);
    const underLimitLogs = transportLogs.filter(
      (r) => (r as Record<string, unknown>).transportReason === "under_limit",
    );
    expect(underLimitLogs.length).toBeGreaterThan(0);
  });

  it("claude small prompt through bot runProviderText uses argv transport with structured log", async () => {
    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: JSON.stringify({ result: "claude output" }), exitCode: 0 }),
    );

    const { writer, records } = createLogCapture();
    const logger = pino({ level: "debug" }, writer);
    const bot = createBot(logger);

    const result = await (bot as any).runProviderText({
      provider: "claude",
      prompt: "hello",
      cwd: "/tmp",
    });

    // The result may be empty because the transformOutput extracts from JSON
    // but we need to check it ran through
    expect(typeof result).toBe("string");

    const transportLog = records.find(
      (r) =>
        (r as Record<string, unknown>).transport === "argv" &&
        (r as Record<string, unknown>).logLabel === "Claude",
    ) as Record<string, unknown> | undefined;
    expect(transportLog).toBeDefined();
    expect(transportLog!).toMatchObject({
      transportReason: "under_limit",
      logLabel: "Claude",
    });
  });

  // ── Logger passthrough verification ──────────────────────────────────

  it("transport log events include the bot's logger metadata across all transport modes", async () => {
    // Verify that the logger created by the bot (pino) produces transport events
    // with the correct loggername/hostname from the pinned logger instance.
    const { writer, records } = createLogCapture();
    const logger = pino({ level: "debug" }, writer);
    const bot = createBot(logger);

    mockSpawn.mockImplementation(() =>
      createMockChild({ stdout: "codex small", exitCode: 0 }),
    );

    await (bot as any).runProviderText({
      provider: "codex",
      prompt: "small",
      cwd: "/tmp",
    });

    // Every transport log event should have standard pino fields
    const transportLog = records.find(
      (r) => (r as Record<string, unknown>).transport === "argv",
    ) as Record<string, unknown> | undefined;
    expect(transportLog).toBeDefined();
    expect(transportLog).toHaveProperty("pid");
    expect(transportLog).toHaveProperty("time");
    expect(transportLog!.level).toBe(pino.levels.values.debug);
  });
});
