import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:fs/promises", async (importActual) => ({
  ...await importActual<typeof import("node:fs/promises")>(),
  readFile: vi.fn(),
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

const {
  DEFAULT_TERMINATION_GRACE_MS,
  spawnCollect,
  spawnCollectWithTransport
} = await import("../src/utils/spawnCollect.js");
const { readFile } = await import("node:fs/promises");
const mockSpawnCollect = vi.mocked(spawnCollect);
const mockSpawnCollectWithTransport = vi.mocked(spawnCollectWithTransport);
const mockReadFile = vi.mocked(readFile);

const {
  authenticateOpenAIOpencode,
  OpencodeExecutionError,
  parseOpenAIOpencodeAuthChallenge,
  parseOpencodeJsonEvents,
  runOpencodeAgentRequest,
  runOpencodeRequest,
  OPENCODE_TEMPFILE_DIRECTIVE
} = await import("../src/services/opencodeExecutionService.js");

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

describe("authenticateOpenAIOpencode", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockReadFile.mockResolvedValue(JSON.stringify({
      openai: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: 1_800_000_000_000
      }
    }) as never);
  });

  it("parses the OpenAI device URL and code from ANSI output", () => {
    expect(parseOpenAIOpencodeAuthChallenge(
      "\u001b[34mGo to: https://auth.openai.com/codex/device\u001b[0m\nEnter code: ABCD-EFGH"
    )).toEqual({
      url: "https://auth.openai.com/codex/device",
      code: "ABCD-EFGH"
    });
  });

  it("runs OpenCode's headless ChatGPT subscription flow and streams the challenge", async () => {
    mockSpawnCollect.mockImplementationOnce(async (_file, _args, options) => {
      options.onOutput?.({
        stdout: "Go to: https://auth.openai.com/codex/device\n",
        stderr: "Enter code: WXYZ-1234\n"
      });
      return { stdout: "Authorization complete", stderr: "" };
    });
    const onChallenge = vi.fn();

    await authenticateOpenAIOpencode({ cwd: "/app", timeoutMs: 1234, onChallenge });

    expect(mockSpawnCollect).toHaveBeenCalledWith(
      "opencode",
      ["providers", "login", "--provider", "OpenAI", "--method", "ChatGPT Pro/Plus (headless)"],
      expect.objectContaining({
        cwd: "/app",
        timeoutMs: 1234,
        killGraceMs: DEFAULT_TERMINATION_GRACE_MS,
        maxBuffer: 4 * 1024 * 1024,
        onOutput: expect.any(Function)
      })
    );
    expect(onChallenge).toHaveBeenCalledOnce();
    expect(onChallenge).toHaveBeenCalledWith({
      url: "https://auth.openai.com/codex/device",
      code: "WXYZ-1234"
    });
  });

  it("fails when OpenCode exits without emitting a device challenge", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "Authorization complete", stderr: "" });

    await expect(authenticateOpenAIOpencode({ cwd: "/app", onChallenge: vi.fn() }))
      .rejects.toThrow("without providing an OpenAI device authorization challenge");
  });

  it("fails when OpenCode reports a failed authorization despite exiting normally", async () => {
    mockSpawnCollect.mockImplementationOnce(async (_file, _args, options) => {
      options.onOutput?.({
        stdout: "Go to: https://auth.openai.com/codex/device\nEnter code: ABCD-EFGH\n",
        stderr: ""
      });
      return { stdout: "Failed to authorize\nDone", stderr: "" };
    });

    await expect(authenticateOpenAIOpencode({ cwd: "/app", onChallenge: vi.fn() }))
      .rejects.toThrow("failed to authorize the OpenAI subscription");
  });

  it("fails when OpenCode does not persist a valid OpenAI OAuth credential", async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({
      openai: { type: "oauth", access: "", refresh: "refresh-token", expires: 1_800_000_000_000 }
    }) as never);
    mockSpawnCollect.mockImplementationOnce(async (_file, _args, options) => {
      options.onOutput?.({
        stdout: "Go to: https://auth.openai.com/codex/device\nEnter code: ABCD-EFGH\n",
        stderr: ""
      });
      return { stdout: "Login successful\nDone", stderr: "" };
    });

    await expect(authenticateOpenAIOpencode({ cwd: "/app", onChallenge: vi.fn() }))
      .rejects.toThrow("without saving a valid OpenAI OAuth credential");
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

  it("uses the supervised build agent with nested agents denied", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runOpencodeRequest({
      prompt: "my prompt",
      cwd: "/tmp",
      timeoutMs: 5000,
      role: "implementation"
    }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "opencode",
        args: ["run", "--dir", "/tmp", "my prompt", "--agent", "build"],
        cwd: "/tmp",
        timeoutMs: 5000,
        killGraceMs: DEFAULT_TERMINATION_GRACE_MS,
        maxBuffer: 4 * 1024 * 1024,
      })
    );
    const call = mockSpawnCollectWithTransport.mock.calls[0]![0];
    expect(call.args).not.toContain("--dangerously-skip-permissions");
    const config = JSON.parse(call.env!.OPENCODE_CONFIG_CONTENT!) as any;
    expect(config.agent.build.permission).toMatchObject({
      "*": "allow",
      question: "deny",
      external_directory: "deny",
      task: "deny"
    });
    expect(config.agent.build.permission.bash).toMatchObject({
      "*": "allow",
      "git push*": "deny",
      "git reset --hard*": "deny",
      "gh pr*": "deny"
    });
  });

  it("keeps role-less requests on the legacy unrestricted build profile and preserves env", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    const env = {
      PATH: "/scoped/bin",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        agent: {
          custom: {
            mode: "primary"
          }
        }
      })
    };

    await runOpencodeRequest({
      prompt: "my prompt",
      cwd: "/tmp",
      timeoutMs: 5000,
      env
    }, logger);

    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "run",
          "--dir",
          "/tmp",
          "my prompt",
          "--agent",
          "build",
          "--dangerously-skip-permissions"
        ],
        env
      })
    );
  });

  it("appends --model flag when model is provided", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, model: "o4-mini" }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "opencode",
        args: [
          "run",
          "--dir",
          "/tmp",
          "hello",
          "--agent",
          "build",
          "--dangerously-skip-permissions",
          "--model",
          "o4-mini"
        ],
        cwd: "/tmp",
      })
    );
  });

  it("passes scoped env vars to the opencode CLI without rewriting them", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    const env = { PATH: "/scoped/bin" };
    await runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, env }, logger);
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "opencode",
        env,
      })
    );
  });

  it("uses a read-only planner agent without auto-approval", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runOpencodeRequest({
      prompt: "plan",
      cwd: "/tmp",
      timeoutMs: 5000,
      role: "planner",
      env: { PATH: "/scoped/bin", DEEPSEEK_API_KEY: "test-key" }
    }, logger);

    const call = mockSpawnCollectWithTransport.mock.calls[0]![0];
    expect(call.args).toEqual(["run", "--dir", "/tmp", "plan", "--agent", "actuarius-planner"]);
    expect(call.args).not.toContain("--dangerously-skip-permissions");
    const config = JSON.parse(call.env!.OPENCODE_CONFIG_CONTENT!) as any;
    expect(config.agent["actuarius-planner"].permission).toMatchObject({
      "*": "deny",
      read: "allow"
    });
  });

  it("uses a tool-free verifier agent without auto-approval", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "APPROVED", stderr: "" });
    await runOpencodeRequest({
      prompt: "verify supplied diff",
      cwd: "/tmp",
      timeoutMs: 5000,
      role: "verification",
      env: { DEEPSEEK_API_KEY: "test-key" }
    }, logger);

    const call = mockSpawnCollectWithTransport.mock.calls[0]![0];
    expect(call.args).toEqual(["run", "--dir", "/tmp", "verify supplied diff", "--agent", "actuarius-verification"]);
    expect(JSON.parse(call.env!.OPENCODE_CONFIG_CONTENT!).agent["actuarius-verification"].permission).toEqual({ "*": "deny" });
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

  it("reshapeArgsForTempfile inserts --file before the implementation agent flag", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    const { reshapeArgsForTempfile } = mockSpawnCollectWithTransport.mock.calls[0]![0] as { reshapeArgsForTempfile: (promptText: string, adjustedArgs: string[], tempFilePath: string) => string[] };

    const adjusted = ["run", "--dir", "/work", "--agent", "build", "--model", "o4-mini"];
    const result = reshapeArgsForTempfile("big prompt", adjusted, "/tmp/prompt.txt");
    expect(result).toEqual([
      "run", OPENCODE_TEMPFILE_DIRECTIVE, "--dir", "/work",
      "--file", "/tmp/prompt.txt",
      "--agent", "build",
      "--model", "o4-mini",
    ]);
  });

  it("reshapeArgsForTempfile inserts --file before a restricted role flag", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
    await runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    const { reshapeArgsForTempfile } = mockSpawnCollectWithTransport.mock.calls[0]![0] as { reshapeArgsForTempfile: (promptText: string, adjustedArgs: string[], tempFilePath: string) => string[] };

    const adjusted = ["run", "--dir", "/work", "--agent", "actuarius-planner", "--model", "o4-mini"];
    const result = reshapeArgsForTempfile("big prompt", adjusted, "/tmp/prompt.txt");
    expect(result).toEqual([
      "run", OPENCODE_TEMPFILE_DIRECTIVE, "--dir", "/work",
      "--file", "/tmp/prompt.txt",
      "--agent", "actuarius-planner", "--model", "o4-mini",
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

  it("returns FAILED (not NOT_AUTHENTICATED) when stderr contains an auth-like phrase on process error", async () => {
    // opencode is an agentic CLI: its own subprocesses (gh, git, build tools) can
    // write "not authenticated"-style text to stderr for reasons unrelated to
    // opencode's own credentials. There is no post-exec auth-pattern check
    // anymore (only the pre-flight hasOpencodeAuth()/DEEPSEEK_API_KEY check
    // above gates NOT_AUTHENTICATED), so this now surfaces as a generic failure.
    const err = Object.assign(
      new Error("not authenticated"),
      { stderr: "not authenticated: set an Auth method", stdout: "" },
    );
    mockSpawnCollectWithTransport.mockRejectedValueOnce(err);
    await expect(runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "FAILED",
      name: "OpencodeExecutionError",
    });
  });

  it("does not treat an auth-like phrase on stdout or stderr as NOT_AUTHENTICATED when the run produced real output", async () => {
    // opencode's stdout is task output and stderr can carry subprocess noise
    // (e.g. a nested gh/git auth error); neither should be misread as opencode
    // itself being unauthenticated when the run otherwise produced output.
    mockSpawnCollectWithTransport.mockResolvedValueOnce({
      stdout: "task complete: API key not found in third-party log line",
      stderr: "gh: authentication required"
    });
    const result = await runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger);
    expect(result.text).toBe("task complete: API key not found in third-party log line");
  });

  it("throws EMPTY_OUTPUT with the stderr tail as diagnostic detail when stdout is blank", async () => {
    // This is the exact false-positive scenario from #156/#157: stdout empty,
    // stderr contains auth-sounding text from a subprocess. Previously this was
    // misreported as NOT_AUTHENTICATED; now it's an honest EMPTY_OUTPUT with the
    // stderr surfaced so the operator can see what actually happened.
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "", stderr: "API key not found. Use /opencode-auth to set one." });
    await expect(runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "EMPTY_OUTPUT",
      name: "OpencodeExecutionError",
      message: expect.stringContaining("API key not found. Use /opencode-auth to set one."),
    });
  });

  it("strips trailing \\r from CRLF stderr lines in the EMPTY_OUTPUT diagnostic detail", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({ stdout: "", stderr: "line one\r\nline two\r\n" });
    await expect(runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "EMPTY_OUTPUT",
      name: "OpencodeExecutionError",
      message: expect.stringContaining("line one\nline two"),
    });
  });

  it("throws TIMEOUT when process times out (ETIMEDOUT)", async () => {
    const err = Object.assign(new Error("timed out"), {
      code: "ETIMEDOUT",
      timeoutReason: "absolute",
      killed: true,
      signal: "SIGTERM"
    });
    mockSpawnCollectWithTransport.mockRejectedValueOnce(err);
    await expect(runOpencodeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000 }, logger)).rejects.toMatchObject({
      code: "TIMEOUT",
      name: "OpencodeExecutionError",
      timeoutKind: "total",
      timeoutMs: 5000,
      message: "OpenCode exceeded the total execution timeout of 5000ms."
    });
  });

  it("preserves the idle timeout kind and its actual expired budget", async () => {
    const latestActivity = JSON.stringify({
      type: "tool_use",
      part: {
        tool: "task",
        state: {
          status: "running",
          input: {
            subagent_type: "actuarius-implement-oc",
            description: "Finish validation"
          }
        }
      }
    });
    const err = Object.assign(new Error("Process produced no stdout or stderr for 900ms"), {
      code: "ETIMEDOUT",
      timeoutReason: "idle",
      killed: true,
      signal: "SIGTERM",
      stdout: [
        JSON.stringify({ type: "step_start", sessionID: "ses-idle" }),
        latestActivity
      ].join("\n"),
      stderr: "older startup warning",
      lastOutput: {
        stream: "stdout",
        text: `_type":"actuarius-implement-oc"}}}`
      }
    });
    mockSpawnCollectWithTransport.mockRejectedValueOnce(err);

    await expect(runOpencodeRequest({
      prompt: "hello",
      cwd: "/tmp",
      timeoutMs: 5000,
      idleTimeoutMs: 900
    }, logger)).rejects.toMatchObject({
      code: "TIMEOUT",
      timeoutKind: "idle",
      timeoutMs: 900,
      providerSessionId: "ses-idle",
      lastActivity: "tool_use tool=task status=running subagent=actuarius-implement-oc description=Finish validation",
      message: "OpenCode produced no output for 900ms."
    });
  });

  it("does not classify an output-buffer overflow as a timeout in diagnostics", async () => {
    const logError = vi.fn();
    const diagnosticLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: logError
    } as unknown as typeof logger;
    const err = Object.assign(new Error("stdout exceeded maxBuffer"), {
      code: "EMSGSIZE",
      killed: true,
      signal: "SIGTERM",
      stdout: "partial output",
      stderr: ""
    });
    mockSpawnCollectWithTransport.mockRejectedValueOnce(err);

    await expect(runOpencodeRequest({
      prompt: "hello",
      cwd: "/tmp",
      timeoutMs: 5000
    }, diagnosticLogger)).rejects.toMatchObject({
      code: "FAILED",
      message: "OpenCode output exceeded the buffer limit."
    });

    expect(logError).toHaveBeenCalledOnce();
    const loggedDetails = logError.mock.calls[0]![0] as Record<string, unknown>;
    expect(loggedDetails.timeoutKind).toBeUndefined();
    expect(loggedDetails.timeoutMs).toBeUndefined();
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
    const adjustedArgs = ["run", "--dir", "/work", "--agent", "build"];
    const reshaped = reshapeFn(promptText, adjustedArgs, "/tmp/actuarius-prompt-xxx/prompt.txt");
    expect(reshaped).not.toContain(promptText);
    expect(reshaped).toContain("--file");
    expect(reshaped).toContain("/tmp/actuarius-prompt-xxx/prompt.txt");
  });
});

describe("managed OpenCode agent execution", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DEEPSEEK_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("parses final text and only completed task subagents from JSONL events", () => {
    const output = [
      "not-json diagnostic noise",
      JSON.stringify({ type: "text", part: { text: " First section " } }),
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "task",
          state: {
            status: "running",
            input: { subagent_type: "still-running" }
          }
        }
      }),
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "task",
          state: {
            status: "completed",
            input: { subagent_type: "actuarius-implement-oc" }
          }
        }
      }),
      JSON.stringify({ type: "text", part: { text: "Second section" } })
    ].join("\n");

    expect(parseOpencodeJsonEvents(output)).toEqual({
      text: "First section\n\nSecond section",
      completedSubagents: ["actuarius-implement-oc"],
      completedTasks: [{
        id: expect.stringMatching(/^fallback-[0-9a-f]{16}$/u),
        subagent: "actuarius-implement-oc"
      }],
      sessionId: null,
      diagnostics: ["not-json diagnostic noise"]
    });
  });

  it("keeps fallback task IDs stable across replayed segments while separating different work", () => {
    const completedTask = (input: Record<string, unknown>) => JSON.stringify({
      type: "tool_use",
      part: {
        tool: "task",
        state: {
          status: "completed",
          input
        }
      }
    });
    const first = parseOpencodeJsonEvents(completedTask({
      subagent_type: "actuarius-implement-oc",
      description: " Finish   validation ",
      prompt: "Run the TEST suite",
      command: "npm test"
    })).completedTasks[0]!;
    const replay = parseOpencodeJsonEvents([
      JSON.stringify({ type: "step_start" }),
      completedTask({
        subagent_type: "ACTUARIUS-IMPLEMENT-OC",
        description: "finish validation",
        prompt: " run the test suite ",
        command: "NPM   TEST"
      })
    ].join("\n")).completedTasks[0]!;
    const different = parseOpencodeJsonEvents(completedTask({
      subagent_type: "actuarius-implement-oc",
      description: "Fix remaining lint errors",
      prompt: "Run the test suite",
      command: "npm test"
    })).completedTasks[0]!;

    expect(first.id).toMatch(/^fallback-[0-9a-f]{16}$/u);
    expect(replay.id).toBe(first.id);
    expect(different.id).not.toBe(first.id);
  });

  it("runs one managed primary-agent CLI call and returns its parsed final text", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({
      stdout: [
        JSON.stringify({
          type: "tool_use",
          sessionID: "session-1",
          part: {
            id: "task-1",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "actuarius-implement-oc" }
            }
          }
        }),
        JSON.stringify({ type: "text", part: { text: "Implementation verified." } })
      ].join("\n"),
      stderr: ""
    });

    const result = await runOpencodeAgentRequest({
      prompt: "Plan and implement this request",
      cwd: "/worktree",
      timeoutMs: 12_345,
      env: { DEEPSEEK_API_KEY: "test-key", OPENCODE_CONFIG_DIR: "/snapshot" },
      agent: "actuarius-plan-oc",
      requiredSubagent: "actuarius-implement-oc"
    }, logger);

    expect(result).toEqual({
      text: "Implementation verified.",
      completedSubagents: ["actuarius-implement-oc"],
      completedTasks: [{ id: "task-1", subagent: "actuarius-implement-oc" }],
      sessionId: "session-1"
    });
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledOnce();
    expect(mockSpawnCollectWithTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "opencode",
        args: [
          "run",
          "--dir",
          "/worktree",
          "Plan and implement this request",
          "--agent",
          "actuarius-plan-oc",
          "--format",
          "json"
        ],
        cwd: "/worktree",
        timeoutMs: 12_345,
        killGraceMs: DEFAULT_TERMINATION_GRACE_MS,
        env: { DEEPSEEK_API_KEY: "test-key", OPENCODE_CONFIG_DIR: "/snapshot" }
      })
    );

    const args = mockSpawnCollectWithTransport.mock.calls[0]![0].args;
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--auto");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("continues a specific managed OpenCode session", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({
      stdout: [
        JSON.stringify({
          type: "tool_use",
          sessionID: "session-1",
          part: {
            id: "task-2",
            tool: "task",
            state: {
              status: "completed",
              input: {
                subagent_type: "actuarius-implement-oc",
                description: "Finish validation"
              }
            }
          }
        }),
        JSON.stringify({ type: "text", sessionID: "session-1", part: { text: "Done." } })
      ].join("\n"),
      stderr: ""
    });

    await expect(runOpencodeAgentRequest({
      prompt: "Continue from checkpoint",
      cwd: "/worktree",
      timeoutMs: 12_345,
      agent: "actuarius-plan-oc",
      sessionId: "session-1"
    }, logger)).resolves.toMatchObject({
      text: "Done.",
      sessionId: "session-1",
      completedTasks: [{
        id: "task-2",
        subagent: "actuarius-implement-oc",
        description: "Finish validation"
      }]
    });

    expect(mockSpawnCollectWithTransport.mock.calls[0]![0].args).toContain("--session");
    expect(mockSpawnCollectWithTransport.mock.calls[0]![0].args).toContain("session-1");
  });

  it("fails when the required implementation subagent has no completed task event", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({
      stdout: [
        JSON.stringify({
          type: "tool_use",
          part: {
            tool: "task",
            state: {
              status: "error",
              input: { subagent_type: "actuarius-implement-oc" }
            }
          }
        }),
        JSON.stringify({ type: "text", part: { text: "I described the implementation." } })
      ].join("\n"),
      stderr: ""
    });

    await expect(runOpencodeAgentRequest({
      prompt: "Plan and implement this request",
      cwd: "/worktree",
      timeoutMs: 12_345,
      agent: "actuarius-plan-oc",
      requiredSubagent: "actuarius-implement-oc"
    }, logger)).rejects.toMatchObject({
      name: "OpencodeExecutionError",
      code: "FAILED",
      message: expect.stringContaining("did not complete")
    });
  });

  it("fails closed when OpenCode emits a non-JSON agent fallback diagnostic", async () => {
    mockSpawnCollectWithTransport.mockResolvedValueOnce({
      stdout: [
        "! agent \"actuarius-plan-oc\" not found. Falling back to default agent",
        JSON.stringify({
          type: "tool_use",
          part: {
            id: "task-1",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: "actuarius-implement-oc" }
            }
          }
        }),
        JSON.stringify({ type: "text", part: { text: "Fallback agent completed the work." } })
      ].join("\n"),
      stderr: ""
    });

    await expect(runOpencodeAgentRequest({
      prompt: "Plan and implement this request",
      cwd: "/worktree",
      timeoutMs: 12_345,
      agent: "actuarius-plan-oc",
      requiredSubagent: "actuarius-implement-oc"
    }, logger)).rejects.toMatchObject({
      name: "OpencodeExecutionError",
      code: "FAILED",
      message: expect.stringContaining("could not be verified")
    });
  });

  it("accepts multiple completed implementation tasks for planner-directed follow-up work", async () => {
    const completedTask = (id: string) => JSON.stringify({
      type: "tool_use",
      part: {
        id,
        tool: "task",
        state: {
          status: "completed",
          input: { subagent_type: "actuarius-implement-oc" }
        }
      }
    });
    mockSpawnCollectWithTransport.mockResolvedValueOnce({
      stdout: [
        completedTask("task-1"),
        completedTask("task-2"),
        JSON.stringify({ type: "text", part: { text: "Two implementations completed." } })
      ].join("\n"),
      stderr: ""
    });

    await expect(runOpencodeAgentRequest({
      prompt: "Plan and implement this request",
      cwd: "/worktree",
      timeoutMs: 12_345,
      agent: "actuarius-plan-oc",
      requiredSubagent: "actuarius-implement-oc"
    }, logger)).resolves.toEqual({
      text: "Two implementations completed.",
      completedSubagents: ["actuarius-implement-oc", "actuarius-implement-oc"],
      completedTasks: [
        { id: "task-1", subagent: "actuarius-implement-oc" },
        { id: "task-2", subagent: "actuarius-implement-oc" }
      ],
      sessionId: null
    });
  });
});
