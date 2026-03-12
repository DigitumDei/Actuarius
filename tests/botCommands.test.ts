import { DiscordjsErrorCodes } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

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
    listBranches: vi.fn()
  };
});

const { deleteRequestBranch } = await import("../src/services/requestWorktreeService.js");
const { ensureRepoCheckedOutToMaster, listBranches } = await import("../src/services/gitWorkspaceService.js");
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
    databasePath: ":memory:",
    reposRootPath: "/data/repos",
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
    getLatestRequestWithWorkspaceByThreadId: vi.fn(),
    getRequestByThreadId: vi.fn(),
    getRepoByFullName: vi.fn(),
    getRepoByChannelId: vi.fn(),
    updateRequestWorkspace: vi.fn(),
    ...dbOverrides
  };

  return new ActuariusBot(config, logger, db as never);
}

function createInteraction(overrides: Record<string, unknown> = {}) {
  return {
    guild: { id: "guild-1", name: "Guild" },
    guildId: "guild-1",
    channelId: "thread-1",
    channel: { isThread: () => true },
    user: { id: "user-1" },
    memberPermissions: { has: vi.fn().mockReturnValue(false) },
    reply: vi.fn().mockResolvedValue(undefined),
    fetchReply: vi.fn(),
    editReply: vi.fn().mockResolvedValue(undefined),
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
        worktree_path: "/tmp/worktree",
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
      content: "follow-up prompt"
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
