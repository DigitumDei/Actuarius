import { DiscordjsErrorCodes } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

vi.mock("../src/utils/spawnCollect.js");

vi.mock("../src/services/requestWorktreeService.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/requestWorktreeService.js")>(
    "../src/services/requestWorktreeService.js"
  );

  return {
    ...actual,
    deleteRequestBranch: vi.fn()
  };
});

vi.mock("../src/services/gitWorkspaceService.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/gitWorkspaceService.js")>(
    "../src/services/gitWorkspaceService.js"
  );

  return {
    ...actual,
    ensureRepoCheckedOutToMaster: vi.fn(),
    listBranches: vi.fn(),
    cleanupDeletedRemoteBranches: vi.fn()
  };
});

vi.mock("../src/services/githubService.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/githubService.js")>(
    "../src/services/githubService.js"
  );

  return {
    ...actual,
    listOpenIssues: vi.fn(),
    viewIssueDetail: vi.fn()
  };
});

vi.mock("../src/services/claudeExecutionService.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/claudeExecutionService.js")>(
    "../src/services/claudeExecutionService.js"
  );

  return {
    ...actual,
    runClaudeRequest: vi.fn()
  };
});

vi.mock("../src/services/adversarialReviewService.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/adversarialReviewService.js")>(
    "../src/services/adversarialReviewService.js"
  );

  return {
    ...actual,
    runAdversarialReview: vi.fn()
  };
});

const { deleteRequestBranch } = await import("../src/services/requestWorktreeService.js");
const { ensureRepoCheckedOutToMaster, listBranches, cleanupDeletedRemoteBranches } = await import("../src/services/gitWorkspaceService.js");
const { spawnCollect } = await import("../src/utils/spawnCollect.js");
const { listOpenIssues, viewIssueDetail } = await import("../src/services/githubService.js");
const { runClaudeRequest } = await import("../src/services/claudeExecutionService.js");
const { runAdversarialReview } = await import("../src/services/adversarialReviewService.js");
const { ActuariusBot } = await import("../src/discord/bot.js");

const logger = pino({ level: "silent" });

function createBot(dbOverrides: Record<string, unknown> = {}): ActuariusBot {
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
    askExecutionTimeoutMs: 1000,
    enableCodexExecution: false,
    enableGeminiExecution: false
  } as const;

  const db = {
    createRequest: vi.fn(),
    getGuildModelConfig: vi.fn(),
    getGuildReviewConfig: vi.fn(),
    getModelHistory: vi.fn().mockReturnValue([]),
    getLatestRequestWithWorkspaceByThreadId: vi.fn(),
    getRequestByThreadId: vi.fn(),
    getRepoByFullName: vi.fn(),
    getRepoByChannelId: vi.fn(),
    listReposByGuild: vi.fn(),
    setGuildReviewConfig: vi.fn(),
    updateRequestWorkspace: vi.fn(),
    upsertGuild: vi.fn(),
    ...dbOverrides
  };

  return new ActuariusBot(config, logger, db as never);
}

function createInteraction(overrides: Record<string, unknown> = {}) {
  return {
    guild: { id: "guild-1", name: "Guild" },
    guildId: "guild-1",
    id: "interaction-1",
    channelId: "thread-1",
    channel: { isThread: () => true, parentId: "channel-1", send: vi.fn().mockResolvedValue(undefined) },
    user: { id: "user-1" },
    memberPermissions: { has: vi.fn().mockReturnValue(false) },
    options: {
      getString: vi.fn().mockReturnValue(null),
      getInteger: vi.fn().mockReturnValue(null)
    },
    reply: vi.fn().mockResolvedValue(undefined),
    fetchReply: vi.fn(),
    editReply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe("ActuariusBot delete command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects when invoked outside a thread", async () => {
    const bot = createBot();
    const interaction = createInteraction({
      channel: { isThread: () => false }
    });

    await (bot as any).handleDelete(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Run `/delete` from within the request thread you want to clean up.",
      ephemeral: true
    });
  });

  it("rejects when no request record exists", async () => {
    const getRequestByThreadId = vi.fn().mockReturnValue(undefined);
    const bot = createBot({ getRequestByThreadId });
    const interaction = createInteraction();

    await (bot as any).handleDelete(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "No request record was found for this thread.",
      ephemeral: true
    });
  });

  it("rejects while a request is still running", async () => {
    const bot = createBot({
      getRequestByThreadId: vi.fn().mockReturnValue({
        id: 35,
        channel_id: "channel-1",
        thread_id: "thread-1",
        user_id: "user-1",
        status: "running",
        branch_name: "ask/35-123",
        worktree_path: "/tmp/worktree"
      })
    });
    const interaction = createInteraction();

    await (bot as any).handleDelete(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "This request is still running. Wait for it to finish before deleting the branch.",
      ephemeral: true
    });
  });

  it("rejects delete while an install is actively using the worktree", async () => {
    const bot = createBot({
      getRequestByThreadId: vi.fn().mockReturnValue({
        id: 35,
        channel_id: "channel-1",
        thread_id: "thread-1",
        user_id: "user-1",
        status: "install_running",
        branch_name: "ask/35-123",
        worktree_path: "/tmp/worktree"
      })
    });
    const interaction = createInteraction();

    await (bot as any).handleDelete(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "This request is still running. Wait for it to finish before deleting the branch.",
      ephemeral: true
    });
  });

  it("rejects users without ownership or manage server permission", async () => {
    const bot = createBot({
      getRequestByThreadId: vi.fn().mockReturnValue({
        id: 35,
        channel_id: "channel-1",
        thread_id: "thread-1",
        user_id: "owner-1",
        status: "succeeded",
        branch_name: "ask/35-123",
        worktree_path: "/tmp/worktree"
      })
    });
    const interaction = createInteraction({
      user: { id: "other-user" }
    });

    await (bot as any).handleDelete(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Only the original requester or a user with `Manage Server` can delete this branch.",
      ephemeral: true
    });
  });

  it("deletes the tracked branch after confirmation", async () => {
    const updateRequestWorkspace = vi.fn();
    const bot = createBot({
      getRequestByThreadId: vi.fn().mockReturnValue({
        id: 35,
        channel_id: "channel-1",
        thread_id: "thread-1",
        user_id: "user-1",
        status: "succeeded",
        branch_name: "ask/35-123",
        worktree_path: "/tmp/worktree"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world"
      }),
      updateRequestWorkspace
    });

    const confirmation = {
      customId: "delete-confirm:35:user-1",
      user: { id: "user-1" },
      update: vi.fn().mockResolvedValue(undefined)
    };
    const interaction = createInteraction({
      fetchReply: vi.fn().mockResolvedValue({
        awaitMessageComponent: vi.fn().mockResolvedValue(confirmation)
      })
    });

    await (bot as any).handleDelete(interaction);

    expect(deleteRequestBranch).toHaveBeenCalledWith(
      "/data/repos",
      {
        owner: "octocat",
        repo: "hello-world",
        fullName: "octocat/hello-world"
      },
      {
        branchName: "ask/35-123",
        worktreePath: "/tmp/worktree"
      }
    );
    expect(updateRequestWorkspace).toHaveBeenCalledWith(35, null, null);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Deleted branch `ask/35-123` and cleared the tracked worktree for this thread.",
      components: []
    });
  });

  it("shows the timeout message when confirmation expires", async () => {
    const bot = createBot({
      getRequestByThreadId: vi.fn().mockReturnValue({
        id: 35,
        channel_id: "channel-1",
        thread_id: "thread-1",
        user_id: "user-1",
        status: "succeeded",
        branch_name: "ask/35-123",
        worktree_path: "/tmp/worktree"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world"
      })
    });

    const timeoutError = new Error("collector ended");
    Object.assign(timeoutError, { code: DiscordjsErrorCodes.InteractionCollectorError });

    const interaction = createInteraction({
      fetchReply: vi.fn().mockResolvedValue({
        awaitMessageComponent: vi.fn().mockRejectedValue(timeoutError)
      })
    });

    await (bot as any).handleDelete(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Branch deletion timed out without confirmation.",
      components: []
    });
  });
});

describe("ActuariusBot thread follow-ups", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reuses the latest non-null workspace for follow-up messages", async () => {
    const createRequest = vi.fn().mockReturnValue({ id: 77 });
    const bot = createBot({
      createRequest,
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 35,
        repo_id: 1,
        channel_id: "channel-1",
        thread_id: "thread-1",
        user_id: "user-1",
        prompt: "existing",
        status: "succeeded",
        worktree_path: "/tmp",
        branch_name: "ask/35-123"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1,
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world",
        channel_id: "channel-1"
      })
    });

    const enqueue = vi.fn();
    (bot as any).requestQueue.enqueue = enqueue;

    await (bot as any).handleThreadMessage({
      author: { bot: false, id: "user-1" },
      guildId: "guild-1",
      guild: { id: "guild-1" },
      channelId: "thread-1",
      channel: { isThread: () => true, parentId: "channel-1" },
      content: "follow-up prompt",
      reply: vi.fn().mockResolvedValue(undefined)
    });

    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        prompt: "follow-up prompt",
        status: "queued"
      })
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("ActuariusBot branches command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("truncates oversized branch listings before editing the reply", async () => {
    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(listBranches).mockResolvedValue({
      local: Array.from({ length: 180 }, (_, index) => `local-branch-${index.toString().padStart(3, "0")}`),
      remote: Array.from({ length: 180 }, (_, index) => `remote-branch-${index.toString().padStart(3, "0")}`)
    });

    const interaction = createInteraction({
      channel: { isThread: () => false },
      options: { getString: vi.fn().mockReturnValue(null) },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined)
    });
    const bot = createBot({
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1,
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world",
        channel_id: "channel-1"
      })
    });

    await (bot as any).handleBranches(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.any(String));
    const content = vi.mocked(interaction.editReply).mock.calls[0]?.[0];
    expect(typeof content).toBe("string");
    expect((content as string).length).toBeLessThanOrEqual(2_000);
    expect(content).toContain("...(truncated to fit Discord's 2000 character limit)");
  });
});

describe("ActuariusBot issues command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects when invoked outside a mapped repo channel", async () => {
    vi.mocked(spawnCollect).mockResolvedValue({ stdout: "token", stderr: "" });
    const interaction = createInteraction({
      channelId: "general-1",
      channel: { isThread: () => false }
    });
    const bot = createBot({
      getRepoByChannelId: vi.fn().mockReturnValue(undefined)
    });

    await (bot as any).handleIssues(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "This channel (or its parent thread channel) is not mapped to a repository. Run `/connect-repo` first.",
      ephemeral: true
    });
  });

  it("rejects when GitHub CLI auth is unavailable", async () => {
    vi.mocked(spawnCollect).mockRejectedValue(new Error("not authenticated"));
    const interaction = createInteraction({
      channelId: "channel-1",
      channel: { isThread: () => false }
    });
    const bot = createBot({
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1,
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world",
        channel_id: "channel-1"
      })
    });

    await (bot as any).handleIssues(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content:
        "GitHub CLI is not authenticated. Configure GitHub App credentials or `GH_TOKEN`, or run `gh auth login` on the host before using /issues.",
      ephemeral: true
    });
  });

  it("returns an issue title list in default mode", async () => {
    vi.mocked(spawnCollect).mockResolvedValue({ stdout: "token", stderr: "" });
    vi.mocked(listOpenIssues).mockResolvedValue([
      {
        number: 49,
        title: "Add /issues command",
        url: "https://example.com/49",
        state: "OPEN",
        body: "Issue body",
        labels: ["enhancement"],
        authorLogin: "bot",
        createdAt: "2026-03-12T05:24:53Z",
        updatedAt: "2026-03-12T05:24:53Z"
      }
    ]);

    const interaction = createInteraction({
      channelId: "channel-1",
      channel: { isThread: () => false }
    });
    const bot = createBot({
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1,
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world",
        channel_id: "channel-1"
      })
    });

    await (bot as any).handleIssues(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith("Open issues for `octocat/hello-world`:\n- #49 Add /issues command");
  });

  it("returns issue detail for detail mode", async () => {
    vi.mocked(spawnCollect).mockResolvedValue({ stdout: "token", stderr: "" });
    vi.mocked(viewIssueDetail).mockResolvedValue({
      number: 49,
      title: "Add /issues command",
      url: "https://example.com/49",
      state: "OPEN",
      body: "Detailed issue body",
      labels: ["enhancement"],
      authorLogin: "bot",
      assignees: ["maintainer"],
      createdAt: "2026-03-12T05:24:53Z",
      updatedAt: "2026-03-13T05:24:53Z"
    });

    const interaction = createInteraction({
      channelId: "channel-1",
      channel: { isThread: () => false },
      options: {
        getString: vi.fn().mockImplementation((name: string) => (name === "mode" ? "detail" : null)),
        getInteger: vi.fn().mockImplementation((name: string) => (name === "issue" ? 49 : null))
      }
    });
    const bot = createBot({
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1,
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world",
        channel_id: "channel-1"
      })
    });

    await (bot as any).handleIssues(interaction);

    expect(viewIssueDetail).toHaveBeenCalledWith("octocat/hello-world", 49);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("#49 Add /issues command"));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("Detailed issue body"));
  });

  it("uses the configured provider to summarize open issues", async () => {
    vi.mocked(spawnCollect).mockResolvedValue({ stdout: "token", stderr: "" });
    vi.mocked(listOpenIssues).mockResolvedValue([
      {
        number: 49,
        title: "Add /issues command",
        url: "https://example.com/49",
        state: "OPEN",
        body: "Issue body",
        labels: ["enhancement"],
        authorLogin: "bot",
        createdAt: "2026-03-12T05:24:53Z",
        updatedAt: "2026-03-12T05:24:53Z"
      }
    ]);
    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(runClaudeRequest).mockResolvedValue({ text: "- #49 Add /issues command: Adds issue listing support." });

    const interaction = createInteraction({
      channelId: "channel-1",
      channel: { isThread: () => false },
      options: {
        getString: vi.fn().mockImplementation((name: string) => (name === "mode" ? "summary" : null)),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        provider: "claude",
        model: "claude-opus",
        updated_at: "2026-03-18T00:00:00Z"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1,
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world",
        channel_id: "channel-1"
      })
    });

    await (bot as any).handleIssues(interaction);

    expect(ensureRepoCheckedOutToMaster).toHaveBeenCalledWith("/data/repos", {
      owner: "octocat",
      repo: "hello-world",
      fullName: "octocat/hello-world"
    });
    expect(runClaudeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/repo",
        model: "claude-opus"
      }),
      expect.anything()
    );
    expect(interaction.editReply).toHaveBeenCalledWith("Issue summaries\n\n- #49 Add /issues command: Adds issue listing support.");
  });
});

describe("ActuariusBot cleanup command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("cleans a single repo resolved from the current repo channel after confirmation", async () => {
    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(cleanupDeletedRemoteBranches).mockResolvedValue({
      deleted: ["feature/old"],
      removedWorktrees: ["/tmp/worktree-1"],
      skippedDirtyWorktrees: [{ branchName: "feature/stale", path: "/tmp/worktree-2" }]
    });

    const confirmation = {
      customId: "cleanup-confirm:interaction-1:user-1",
      user: { id: "user-1" },
      update: vi.fn().mockResolvedValue(undefined)
    };
    const interaction = createInteraction({
      channelId: "channel-1",
      channel: { isThread: () => false },
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: { getString: vi.fn().mockReturnValue(null) },
      fetchReply: vi.fn().mockResolvedValue({
        awaitMessageComponent: vi.fn().mockResolvedValue(confirmation)
      }),
      editReply: vi.fn().mockResolvedValue(undefined)
    });
    const bot = createBot({
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1,
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world",
        channel_id: "channel-1"
      }),
      listReposByGuild: vi.fn().mockReturnValue([])
    });

    await (bot as any).handleCleanup(interaction);

    expect(cleanupDeletedRemoteBranches).toHaveBeenCalledWith("/tmp/repo");
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        "Cleanup completed.",
        "",
        "`octocat/hello-world`",
        "- deleted `feature/old`",
        "- removed worktree `/tmp/worktree-1`",
        "- skipped dirty worktree `/tmp/worktree-2` for `feature/stale`"
      ].join("\n"),
      components: []
    });
  });

  it("cleans all connected repos when invoked outside a mapped repo channel", async () => {
    vi.mocked(ensureRepoCheckedOutToMaster)
      .mockResolvedValueOnce({ localPath: "/tmp/repo-1" })
      .mockResolvedValueOnce({ localPath: "/tmp/repo-2" });
    vi.mocked(cleanupDeletedRemoteBranches)
      .mockResolvedValueOnce({
        deleted: ["feature/old"],
        removedWorktrees: ["/tmp/worktree-1"],
        skippedDirtyWorktrees: []
      })
      .mockResolvedValueOnce({
        deleted: [],
        removedWorktrees: [],
        skippedDirtyWorktrees: []
      });

    const confirmation = {
      customId: "cleanup-confirm:interaction-1:user-1",
      user: { id: "user-1" },
      update: vi.fn().mockResolvedValue(undefined)
    };
    const interaction = createInteraction({
      channelId: "general-1",
      channel: { isThread: () => false },
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: { getString: vi.fn().mockReturnValue(null) },
      fetchReply: vi.fn().mockResolvedValue({
        awaitMessageComponent: vi.fn().mockResolvedValue(confirmation)
      }),
      editReply: vi.fn().mockResolvedValue(undefined)
    });
    const bot = createBot({
      getRepoByChannelId: vi.fn().mockReturnValue(undefined),
      listReposByGuild: vi.fn().mockReturnValue([
        {
          id: 1,
          owner: "octocat",
          repo: "hello-world",
          full_name: "octocat/hello-world",
          channel_id: "channel-1"
        },
        {
          id: 2,
          owner: "digitumdei",
          repo: "actuarius",
          full_name: "digitumdei/actuarius",
          channel_id: "channel-2"
        }
      ])
    });

    await (bot as any).handleCleanup(interaction);

    expect(cleanupDeletedRemoteBranches).toHaveBeenNthCalledWith(1, "/tmp/repo-1");
    expect(cleanupDeletedRemoteBranches).toHaveBeenNthCalledWith(2, "/tmp/repo-2");
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: [
        "Cleanup completed.",
        "",
        "`octocat/hello-world`",
        "- deleted `feature/old`",
        "- removed worktree `/tmp/worktree-1`",
        "",
        "`digitumdei/actuarius`",
        "- no deleted origin branches were found locally"
      ].join("\n"),
      components: []
    });
  });
});

describe("ActuariusBot review runner selection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("uses model history for non-preferred review providers", () => {
    const getModelHistory = vi.fn().mockImplementation((provider: string) => {
      switch (provider) {
        case "claude":
          return ["claude-sonnet-4"];
        case "gemini":
          return ["gemini-2.5-pro"];
        default:
          return [];
      }
    });
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        provider: "codex",
        model: "o4-mini",
        updated_at: "2026-03-18T00:00:00Z"
      }),
      getModelHistory
    });
    (bot as any).config.enableCodexExecution = true;
    (bot as any).config.enableGeminiExecution = true;

    const runners = (bot as any).buildReviewRunners("guild-1");

    expect(runners.reviewers).toHaveLength(3);
    expect(runners.reviewers.map((runner: { provider: string; model?: string }) => ({
      provider: runner.provider,
      model: runner.model
    }))).toEqual([
      { provider: "codex", model: "o4-mini" },
      { provider: "claude", model: "claude-sonnet-4" },
      { provider: "gemini", model: "gemini-2.5-pro" }
    ]);
    expect(getModelHistory).toHaveBeenCalledWith("claude");
    expect(getModelHistory).toHaveBeenCalledWith("gemini");
    expect(getModelHistory).not.toHaveBeenCalledWith("codex");
    expect(runners.judge.provider).toBe("codex");
    expect(runners.judge.model).toBe("o4-mini");
    expect(runners.summarizer.provider).toBe("claude");
    expect(runners.summarizer.model).toBe("claude-sonnet-4");
  });
});

describe("ActuariusBot review-rounds command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the default round limit when no guild config is set", async () => {
    const bot = createBot({
      getGuildReviewConfig: vi.fn().mockReturnValue(undefined)
    });
    const interaction = createInteraction({
      options: {
        getString: vi.fn().mockReturnValue(null),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleReviewRounds(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Current adversarial review round limit: `2` (default).",
      ephemeral: true
    });
  });

  it("requires manage server permission to change the round limit", async () => {
    const setGuildReviewConfig = vi.fn();
    const bot = createBot({ setGuildReviewConfig });
    const interaction = createInteraction({
      options: {
        getString: vi.fn().mockReturnValue(null),
        getInteger: vi.fn().mockReturnValue(4)
      }
    });

    await (bot as any).handleReviewRounds(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "You need the `Manage Server` permission to change the adversarial review round limit.",
      ephemeral: true
    });
    expect(setGuildReviewConfig).not.toHaveBeenCalled();
  });

  it("stores the round limit when an admin sets it", async () => {
    const upsertGuild = vi.fn();
    const setGuildReviewConfig = vi.fn();
    const bot = createBot({ upsertGuild, setGuildReviewConfig });
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn().mockReturnValue(null),
        getInteger: vi.fn().mockReturnValue(4)
      }
    });

    await (bot as any).handleReviewRounds(interaction);

    expect(upsertGuild).toHaveBeenCalledWith("guild-1", "Guild");
    expect(setGuildReviewConfig).toHaveBeenCalledWith("guild-1", 4, "user-1");
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Adversarial review round limit set to `4`. Future `/review` runs in this server will use this value.",
      ephemeral: true
    });
  });
});

describe("ActuariusBot review command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects users without ownership or manage server permission", async () => {
    const bot = createBot({
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "owner-1",
        worktree_path: "/tmp/worktree-review",
        branch_name: "ask/41-123",
        status: "succeeded"
      })
    });
    const interaction = createInteraction();

    await (bot as any).handleReview(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Only the original requester or a user with `Manage Server` can run `/review` for this branch.",
      ephemeral: true
    });
    expect(runAdversarialReview).not.toHaveBeenCalled();
  });

  it("rejects review while an install is actively using the worktree", async () => {
    const bot = createBot({
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: "/tmp/worktree-review",
        branch_name: "ask/41-123",
        status: "install_running"
      })
    });
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) }
    });

    await (bot as any).handleReview(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "The latest request in this thread is still queued or running. Wait for it to finish before reviewing.",
      ephemeral: true
    });
    expect(runAdversarialReview).not.toHaveBeenCalled();
  });

  it("passes the configured review round limit into the review service", async () => {
    vi.mocked(runAdversarialReview).mockResolvedValue({
      reviewRunId: 12,
      diffHeadSha: "abc123",
      reviewersSucceeded: 2,
      reviewersAttempted: 2,
      artifactPath: "docs/reviews/41/review.md",
      summary: {
        executiveSummary: "Consensus reached.",
        blockingIssues: [],
        nonBlockingIssues: [],
        missingTests: [],
        outstandingConcerns: [],
        verdict: "ready_for_pr"
      }
    });

    const bot = createBot({
      getGuildReviewConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        rounds: 4,
        updated_by_user_id: "admin-1",
        updated_at: "2026-03-24T00:00:00Z"
      }),
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: "/tmp",
        branch_name: "ask/41-123",
        status: "succeeded"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1,
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world",
        channel_id: "channel-1"
      }),
      getGuildModelConfig: vi.fn().mockReturnValue({
        provider: "claude",
        model: "claude-opus",
        updated_at: "2026-03-18T00:00:00Z"
      })
    });
    vi.spyOn((bot as any), "buildReviewRunners").mockReturnValue({
      analyzer: { provider: "claude", model: "claude-opus", label: "Claude", run: vi.fn() },
      reviewers: [
        { provider: "claude", model: "claude-opus", label: "Claude", run: vi.fn() },
        { provider: "codex", model: "o4-mini", label: "Codex", run: vi.fn() }
      ],
      judge: { provider: "claude", model: "claude-opus", label: "Claude", run: vi.fn() },
      summarizer: { provider: "codex", model: "o4-mini", label: "Codex", run: vi.fn() }
    });
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      channel: { isThread: () => true, parentId: "channel-1", send: vi.fn().mockResolvedValue(undefined), messages: { fetch: vi.fn().mockResolvedValue(new Map()) } }
    });

    await (bot as any).handleReview(interaction);

    expect(runAdversarialReview).toHaveBeenCalledWith(expect.objectContaining({
      maxConsensusRounds: 4
    }));
  });
});

describe("ActuariusBot install command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects users without manage server permission", async () => {
    const bot = createBot();
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(false) }
    });

    await (bot as any).handleInstall(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "You need the `Manage Server` permission to install tools.",
      ephemeral: true
    });
  });

  it("rejects invalid install scopes", async () => {
    const bot = createBot();
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "package") return "npm-prettier";
          if (name === "scope") return "invalid-scope";
          return null;
        }),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleInstall(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Invalid install scope.",
      ephemeral: true
    });
  });

  it("rejects request-scoped installs outside a thread", async () => {
    const bot = createBot({
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1,
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world",
        channel_id: "channel-1"
      })
    });
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      channel: { isThread: () => false },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "package") return "npm-prettier";
          if (name === "scope") return "request";
          return null;
        }),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleInstall(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Request-scoped installs must be run inside the request thread that should receive the tool.",
      ephemeral: true
    });
  });

  it("creates and runs the install when the request is valid", async () => {
    const bot = createBot({
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        worktree_path: "/tmp/worktree-review"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1,
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world",
        channel_id: "channel-1"
      })
    });
    const createApprovedInstallRequest = vi.fn().mockReturnValue({
      id: 55,
      package_id: "npm-prettier"
    });
    const runInstall = vi.fn().mockResolvedValue({
      id: 55,
      package_id: "npm-prettier",
      package_version: "3",
      bin_path: "/data/tool-installs/request/thread-1/npm-prettier/bin"
    });
    (bot as any).installService = {
      createApprovedInstallRequest,
      runInstall
    };
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "package") return "npm-prettier";
          if (name === "scope") return "request";
          return null;
        }),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleInstall(interaction);

    expect(createApprovedInstallRequest).toHaveBeenCalledWith({
      guildId: "guild-1",
      repoId: 1,
      requestId: 41,
      threadId: "thread-1",
      packageId: "npm-prettier",
      scope: "request",
      requestedByUserId: "user-1",
      approvedByUserId: "user-1"
    });
    expect(runInstall).toHaveBeenCalledWith(55);
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Installed `npm-prettier@3` in `request` scope.\nInstall request: #55\nPATH prefix: `/data/tool-installs/request/thread-1/npm-prettier/bin`"
    );
  });
});

describe("ActuariusBot model-select command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects Gemini when GEMINI_API_KEY is whitespace only", async () => {
    const bot = createBot({
      setGuildModelConfig: vi.fn(),
      addModelToHistory: vi.fn()
    });
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "provider") {
            return "gemini";
          }

          if (name === "model") {
            return null;
          }

          return null;
        })
      }
    });

    (bot as any).config = {
      ...(bot as any).config,
      enableGeminiExecution: true,
      geminiApiKey: "   "
    };

    await (bot as any).handleModelSelect(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Gemini execution requires `GEMINI_API_KEY` on this instance. Choose a different provider or ask the instance administrator to configure it.",
      ephemeral: true
    });
  });
});
