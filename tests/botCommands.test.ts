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

const { deleteRequestBranch } = await import("../src/services/requestWorktreeService.js");
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
    getRequestByThreadId: vi.fn(),
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
});
