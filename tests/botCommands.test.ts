import { ChannelType, DiscordjsErrorCodes } from "discord.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

vi.mock("../src/utils/spawnCollect.js");

vi.mock("../src/services/requestWorktreeService.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/requestWorktreeService.js")>(
    "../src/services/requestWorktreeService.js"
  );

  return {
    ...actual,
    createRequestWorktree: vi.fn(),
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

vi.mock("../src/services/pullRequestService.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/pullRequestService.js")>(
    "../src/services/pullRequestService.js"
  );

  return {
    ...actual,
    createDraftPullRequest: vi.fn()
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

vi.mock("../src/services/opencodeExecutionService.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/opencodeExecutionService.js")>(
    "../src/services/opencodeExecutionService.js"
  );

  return {
    ...actual,
    hasOpencodeAuth: vi.fn().mockResolvedValue(false)
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

vi.mock("../src/services/iterativeTaskLoopService.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/iterativeTaskLoopService.js")>(
    "../src/services/iterativeTaskLoopService.js"
  );

  return {
    ...actual,
    runIterativeTaskLoop: vi.fn()
  };
});

const { createRequestWorktree, deleteRequestBranch } = await import("../src/services/requestWorktreeService.js");
const {
  autoCommitDirtyWorktree,
  detectDefaultBranch,
  ensureRepoCheckedOutToMaster,
  getDiffSinceRef,
  getHeadSha,
  getReviewDiff,
  hasUncommittedChanges,
  hasUncommittedChangesExcluding,
  listBranches,
  cleanupDeletedRemoteBranches,
  pushBranch
} = await import("../src/services/gitWorkspaceService.js");
const { spawnCollect } = await import("../src/utils/spawnCollect.js");
const { listOpenIssues, viewIssueDetail } = await import("../src/services/githubService.js");
const { runClaudeRequest } = await import("../src/services/claudeExecutionService.js");
const { runAdversarialReview } = await import("../src/services/adversarialReviewService.js");
const { runIterativeTaskLoop } = await import("../src/services/iterativeTaskLoopService.js");
const { createDraftPullRequest } = await import("../src/services/pullRequestService.js");
const { ActuariusBot } = await import("../src/discord/bot.js");

const logger = pino({ level: "silent" });

function createBot(dbOverrides: Record<string, unknown> = {}, memPalace: unknown = null): ActuariusBot {
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
    iterativeVerificationTimeoutMs: 300,
    reviewConcurrency: 1,
    installStepTimeoutMs: 1000,
    aptInstallHelperPath: undefined,
    enableCodexExecution: false,
    enableGeminiExecution: false,
    enableOpencodeExecution: false,
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
    getGuildReviewConfig: vi.fn(),
    getModelHistory: vi.fn().mockReturnValue([]),
    getReviewerSlots: vi.fn().mockReturnValue([]),
    getLatestRequestWithWorkspaceByThreadId: vi.fn(),
    getRequestByThreadId: vi.fn(),
    getRepoByFullName: vi.fn(),
    getRepoByChannelId: vi.fn(),
    listSuccessfulInstallRequestsForScope: vi.fn().mockReturnValue([]),
    listReposByGuild: vi.fn(),
    setGuildReviewConfig: vi.fn(),
    updateRequestWorkspace: vi.fn(),
    upsertGuild: vi.fn(),
    ...dbOverrides
  };

  return new ActuariusBot(config, logger, db as never, memPalace as never);
}

function createInteraction(overrides: Record<string, unknown> = {}) {
  return {
    guild: { id: "guild-1", name: "Guild" },
    guildId: "guild-1",
    id: "interaction-1",
    channelId: "thread-1",
    channel: {
      isThread: () => true,
      isTextBased: () => true,
      isDMBased: () => false,
      parentId: "channel-1",
      send: vi.fn().mockResolvedValue(undefined)
    },
    user: { id: "user-1" },
    memberPermissions: { has: vi.fn().mockReturnValue(false) },
    options: {
      getString: vi.fn().mockReturnValue(null),
      getInteger: vi.fn().mockReturnValue(null),
      getBoolean: vi.fn().mockReturnValue(null)
    },
    reply: vi.fn().mockResolvedValue(undefined),
    fetchReply: vi.fn(),
    editReply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe("ActuariusBot ask command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates the request thread with attachment summaries and queues attachments for execution", async () => {
    const thread = {
      id: "thread-ask-1",
      send: vi.fn().mockResolvedValue(undefined)
    };
    const seedMessage = {
      startThread: vi.fn().mockResolvedValue(thread)
    };
    const repoChannel = {
      type: ChannelType.GuildText,
      send: vi.fn().mockResolvedValue(seedMessage)
    };
    const createRequest = vi.fn().mockReturnValue({ id: 104 });
    const bot = createBot({
      createRequest,
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1,
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world",
        channel_id: "channel-1"
      }),
      getGuildModelConfig: vi.fn().mockReturnValue(undefined)
    });
    const enqueue = vi.fn();
    (bot as any).requestQueue.enqueue = enqueue;
    const runQueuedRequest = vi.spyOn(bot as any, "runQueuedRequest").mockResolvedValue(undefined);

    const attachment = {
      id: "att-1",
      name: "debug.log",
      url: "https://cdn.discord.com/attachments/debug.log",
      size: 4096,
      contentType: "text/plain"
    };
    const interaction = createInteraction({
      user: { id: "user-1", tag: "user#0001" },
      channelId: "channel-1",
      channel: { isThread: () => false },
      guild: {
        id: "guild-1",
        name: "Guild",
        channels: { fetch: vi.fn().mockResolvedValue(repoChannel) }
      },
      options: {
        getString: vi.fn().mockImplementation((name: string) => (name === "prompt" ? "Review this log" : null)),
        getInteger: vi.fn().mockReturnValue(null),
        getAttachment: vi.fn().mockImplementation((name: string) => (name === "attachment1" ? attachment : null))
      },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined)
    });

    await (bot as any).handleAsk(interaction);

    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining("**Attachments**"));
    expect(thread.send).toHaveBeenCalledWith(expect.stringContaining("- debug.log (4.0 KiB, text/plain)"));
    expect(createRequest).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-ask-1",
      prompt: "Review this log",
      status: "queued"
    }));
    expect(enqueue).toHaveBeenCalledWith("guild-1", expect.any(Function), "thread-ask-1");

    await enqueue.mock.calls[0]![1]();
    expect(runQueuedRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 104,
      threadId: "thread-ask-1",
      prompt: "Review this log",
      attachments: [attachment]
    }));
  });
});

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
      reply: vi.fn().mockResolvedValue(undefined),
      attachments: { size: 0, values: () => [] }
    });

    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        prompt: "follow-up prompt",
        status: "queued"
      })
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith("guild-1", expect.any(Function), "thread-1");
  });

  it("rejects follow-up messages while another request in the thread is active", async () => {
    const createRequest = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const bot = createBot({
      createRequest,
      getRequestByThreadId: vi.fn().mockReturnValue({ id: 99, status: "running" })
    });
    const enqueue = vi.fn();
    (bot as any).requestQueue.enqueue = enqueue;

    await (bot as any).handleThreadMessage({
      author: { bot: false, id: "user-1" },
      guildId: "guild-1",
      guild: { id: "guild-1" },
      channelId: "thread-1",
      channel: { isThread: () => true, parentId: "channel-1" },
      content: "race this revision",
      reply,
      attachments: { size: 0, values: () => [] }
    });

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("already queued or running"));
    expect(createRequest).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("replies when the latest failed request has no workspace to continue", async () => {
    const createRequest = vi.fn();
    const reply = vi.fn().mockResolvedValue(undefined);
    const bot = createBot({
      createRequest,
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue(undefined),
      getRequestByThreadId: vi.fn().mockReturnValue({
        id: 872,
        repo_id: 1,
        channel_id: "channel-1",
        thread_id: "thread-1",
        user_id: "user-1",
        prompt: "failed plan",
        status: "failed",
        worktree_path: null,
        branch_name: null
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
      content: "can you continue?",
      reply,
      attachments: { size: 0, values: () => [] }
    });

    expect(reply).toHaveBeenCalledWith(expect.stringContaining("no tracked worktree"));
    expect(createRequest).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enqueues a request for attachment-only follow-up messages with fallback prompt", async () => {
    const createRequest = vi.fn().mockReturnValue({ id: 88 });
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
      content: "",
      reply: vi.fn().mockResolvedValue(undefined),
      attachments: {
        size: 1,
        values: () => [{
          id: "att-1",
          name: "debug.log",
          url: "https://cdn.discord.com/attachments/debug.log",
          size: 4096,
          contentType: "text/plain"
        }]
      }
    });

    expect(createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        prompt: "Please inspect the attached file(s).",
        status: "queued"
      })
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("rejects follow-up with unsupported attachment type", async () => {
    const createRequest = vi.fn().mockReturnValue({ id: 99 });
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

    const reply = vi.fn().mockResolvedValue(undefined);
    await (bot as any).handleThreadMessage({
      author: { bot: false, id: "user-1" },
      guildId: "guild-1",
      guild: { id: "guild-1" },
      channelId: "thread-1",
      channel: { isThread: () => true, parentId: "channel-1" },
      content: "check this file",
      reply,
      attachments: {
        size: 1,
        values: () => [{
          id: "att-bad",
          name: "archive.zip",
          url: "https://cdn.discord.com/attachments/archive.zip",
          size: 4096,
          contentType: "application/zip"
        }]
      }
    });

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("is not supported")
    );
    expect(createRequest).not.toHaveBeenCalled();
  });

  it("appends attachment-only fallback prompts to existing thread history", async () => {
    const bot = createBot();
    (bot as any).client.user = { id: "bot-1" };
    const messages = new Map([
      ["1", {
        createdTimestamp: 1,
        author: { id: "bot-1" },
        content: "Request by <@user-1>\n\n**Prompt**\nInitial request"
      }],
      ["2", {
        createdTimestamp: 2,
        author: { id: "bot-1" },
        content: "**Claude execution completed**\n\n```text\nInitial answer\n```"
      }],
    ]);

    const prompt = await (bot as any).buildThreadPromptWithHistory(
      { messages: { fetch: vi.fn().mockResolvedValue(messages) } },
      "Please inspect the attached file(s)."
    );

    expect(prompt).toContain("[User]: Initial request");
    expect(prompt).toContain("[Assistant]: Initial answer");
    expect(prompt).toContain("[User]: Please inspect the attached file(s).");
  });

  it("does not double-append a text follow-up already present in thread history", async () => {
    const bot = createBot();
    (bot as any).client.user = { id: "bot-1" };
    const messages = new Map([
      ["1", {
        createdTimestamp: 1,
        author: { id: "user-1" },
        content: "follow-up prompt"
      }],
    ]);

    const prompt = await (bot as any).buildThreadPromptWithHistory(
      { messages: { fetch: vi.fn().mockResolvedValue(messages) } },
      "follow-up prompt"
    );

    expect(prompt.match(/\[User\]: follow-up prompt/g)).toHaveLength(1);
  });

  it("preserves attachment-only follow-ups in later thread history", async () => {
    const bot = createBot();
    (bot as any).client.user = { id: "bot-1" };
    const messages = new Map([
      ["1", {
        createdTimestamp: 1,
        author: { id: "bot-1" },
        content: "Request by <@user-1>\n\n**Prompt**\nInitial request"
      }],
      ["2", {
        createdTimestamp: 2,
        author: { id: "user-1" },
        content: "",
        attachments: {
          size: 1,
          values: () => [{
            id: "att-1",
            name: "debug.log",
            url: "https://cdn.discord.com/attachments/debug.log",
            size: 4096,
            contentType: "text/plain"
          }]
        }
      }],
      ["3", {
        createdTimestamp: 3,
        author: { id: "bot-1" },
        content: "**Claude execution completed**\n\n```text\nI inspected the log.\n```"
      }]
    ]);

    const prompt = await (bot as any).buildThreadPromptWithHistory(
      { messages: { fetch: vi.fn().mockResolvedValue(messages) } },
      "What did it show?"
    );

    expect(prompt).toContain("[User]: Please inspect the attached file(s).\n\n**Attachments**\n- debug.log (4.0 KiB, text/plain)");
    expect(prompt).toContain("[Assistant]: I inspected the log.");
    expect(prompt).toContain("[User]: What did it show?");
  });

  it("preserves text follow-up attachment summaries without appending the current prompt twice", async () => {
    const bot = createBot();
    (bot as any).client.user = { id: "bot-1" };
    const messages = new Map([
      ["1", {
        createdTimestamp: 1,
        author: { id: "user-1" },
        content: "check this log",
        attachments: {
          size: 1,
          values: () => [{
            id: "att-1",
            name: "debug.log",
            url: "https://cdn.discord.com/attachments/debug.log",
            size: 4096,
            contentType: "text/plain"
          }]
        }
      }]
    ]);

    const prompt = await (bot as any).buildThreadPromptWithHistory(
      { messages: { fetch: vi.fn().mockResolvedValue(messages) } },
      "check this log"
    );

    expect(prompt).toContain("[User]: check this log\n\n**Attachments**\n- debug.log (4.0 KiB, text/plain)");
    expect(prompt.match(/\[User\]: check this log/g)).toHaveLength(1);
  });

  it("passes slash request attachments through to the queued prompt and excludes saved files from git", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "actuarius-queued-worktree-"));
    const gitDir = join(worktreePath, ".git");
    await mkdir(join(gitDir, "info"), { recursive: true });
    await writeFile(join(gitDir, "info", "exclude"), "");

    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(createRequestWorktree).mockResolvedValue({
      path: worktreePath,
      branchName: "ask/101-123"
    });
    vi.mocked(runClaudeRequest).mockResolvedValue({ text: "done" });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode("attachment contents").buffer,
    } as Response);

    const sent: string[] = [];
    const thread = {
      isThread: () => true,
      send: vi.fn().mockImplementation(async (content: string) => {
        sent.push(content);
      }),
      messages: { fetch: vi.fn().mockResolvedValue(new Map()) }
    };
    const bot = createBot({
      updateRequestStatus: vi.fn(),
      updateRequestWorkspace: vi.fn()
    });
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue(thread);

    await (bot as any).runQueuedRequest({
      requestId: 101,
      threadId: "thread-1",
      repoId: 1,
      repo: {
        owner: "octocat",
        repo: "hello-world",
        fullName: "octocat/hello-world"
      },
      prompt: "Review the attachment",
      provider: "claude",
      attachments: [{
        id: "att-1",
        name: "debug.log",
        url: "https://cdn.discord.com/attachments/debug.log",
        size: 128,
        contentType: "text/plain"
      }]
    });

    expect(runClaudeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: worktreePath,
        prompt: expect.stringContaining("Review the attachment")
      }),
      expect.anything()
    );
    const prompt = vi.mocked(runClaudeRequest).mock.calls[0]![0].prompt;
    expect(prompt).toContain("## Attachments");
    expect(prompt).toContain("File: debug.log");
    expect(prompt).toContain("attachment contents");
    expect(await readFile(join(gitDir, "info", "exclude"), "utf-8")).toBe(".actuarius/\n");
    expect(sent).toContain("Claude execution started.");
    expect(sent.some((message) => message.includes("done"))).toBe(true);
  });

  it("exercises real buildMinimalExecutionEnvironment in queued ask path — auth vars, bin PATH, no arbitrary env", async () => {
    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(createRequestWorktree).mockResolvedValue({
      path: "/tmp/worktree-queued",
      branchName: "ask/111-123"
    });

    const savedEnv: Record<string, string | undefined> = {
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      XAI_API_KEY: process.env.XAI_API_KEY,
      GH_TOKEN: process.env.GH_TOKEN,
      GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED,
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      NON_ESSENTIAL_VAR: process.env.NON_ESSENTIAL_VAR
    };

    try {
      process.env.DEEPSEEK_API_KEY = "sk-deep-test";
      process.env.XAI_API_KEY = "xai-test";
      process.env.GH_TOKEN = "gh-test";
      process.env.GH_PROMPT_DISABLED = "1";
      process.env.HOME = "/home/user";
      process.env.PATH = "/usr/bin:/bin";
      process.env.NON_ESSENTIAL_VAR = "should-not-appear";

      const installRecords = [
        {
          id: 1,
          guild_id: "guild-1",
          repo_id: 1,
          request_id: null,
          thread_id: "thread-1",
          package_id: "npm-prettier",
          package_version: "3",
          scope: "request",
          status: "succeeded" as const,
          requested_by_user_id: "user-1",
          approved_by_user_id: "admin-1",
          install_root: "/data/tool-installs/request/thread-1/npm-prettier",
          bin_path: "/data/tool-installs/request/thread-1/npm-prettier/bin",
          env_json: "{}",
          logs: null,
          error_message: null,
          created_at: "2026-03-31T00:00:00.000Z",
          updated_at: "2026-03-31T00:00:00.000Z",
          completed_at: "2026-03-31T00:00:00.000Z"
        }
      ];

      const thread = {
        isThread: () => true,
        send: vi.fn().mockResolvedValue(undefined),
        messages: { fetch: vi.fn().mockResolvedValue(new Map()) }
      };
      const bot = createBot({
        updateRequestStatus: vi.fn(),
        updateRequestWorkspace: vi.fn(),
        listSuccessfulInstallRequestsForScope: vi.fn().mockReturnValue(installRecords)
      });
      (bot as any).installService.pathExists = () => true;
      (bot as any).client.channels.fetch = vi.fn().mockResolvedValue(thread);
      (bot as any).runProviderText = vi.fn().mockResolvedValue("queued response");

      await (bot as any).runQueuedRequest({
        requestId: 111,
        threadId: "thread-1",
        repoId: 1,
        repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
        prompt: "Do the thing",
        provider: "claude"
      });

      const runCalls = vi.mocked(bot.runProviderText as any).mock.calls;
      expect(runCalls).toHaveLength(1);
      const env = runCalls[0]![0].env;

      expect(env.DEEPSEEK_API_KEY).toBe("sk-deep-test");
      expect(env.XAI_API_KEY).toBe("xai-test");
      expect(env.GH_TOKEN).toBe("gh-test");
      expect(env.GH_PROMPT_DISABLED).toBe("1");
      expect(env.HOME).toBe("/home/user");

      const pathParts = env.PATH!.split(":");
      expect(pathParts[0]).toBe("/data/tool-installs/request/thread-1/npm-prettier/bin");
      expect(env.PATH).toContain("/usr/bin");

      expect(env.NON_ESSENTIAL_VAR).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("exercises real buildMinimalExecutionEnvironment in follow-up queued path with existingWorktreePath", async () => {
    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(createRequestWorktree).mockResolvedValue({
      path: "/tmp/worktree-queued",
      branchName: "ask/111-123"
    });

    const savedEnv: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GH_TOKEN: process.env.GH_TOKEN,
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      NON_ESSENTIAL_VAR: process.env.NON_ESSENTIAL_VAR
    };

    try {
      process.env.ANTHROPIC_API_KEY = "sk-ant-followup";
      process.env.GEMINI_API_KEY = "gemini-followup";
      process.env.GH_TOKEN = "gh-followup";
      process.env.HOME = "/home/followup";
      process.env.PATH = "/usr/local/bin:/usr/bin";
      process.env.NON_ESSENTIAL_VAR = "should-not-appear";

      const installRecords = [
        {
          id: 2,
          guild_id: "guild-1",
          repo_id: 1,
          request_id: null,
          thread_id: "thread-followup",
          package_id: "java-temurin",
          package_version: "21",
          scope: "request",
          status: "succeeded" as const,
          requested_by_user_id: "user-1",
          approved_by_user_id: "admin-1",
          install_root: "/data/tool-installs/request/thread-followup/java-temurin",
          bin_path: "/data/tool-installs/request/thread-followup/java-temurin/bin",
          env_json: "{}",
          logs: null,
          error_message: null,
          created_at: "2026-03-31T00:00:00.000Z",
          updated_at: "2026-03-31T00:00:00.000Z",
          completed_at: "2026-03-31T00:00:00.000Z"
        }
      ];

      const messages = new Map([
        ["1", {
          createdTimestamp: 1000,
          author: { id: "user-1" },
          content: "previous message"
        }],
        ["2", {
          createdTimestamp: 2000,
          author: { id: "bot-1" },
          content: "previous response"
        }]
      ]);

      const thread = {
        isThread: () => true,
        send: vi.fn().mockResolvedValue(undefined),
        messages: { fetch: vi.fn().mockResolvedValue(messages) }
      };
      const bot = createBot({
        updateRequestStatus: vi.fn(),
        updateRequestWorkspace: vi.fn(),
        listSuccessfulInstallRequestsForScope: vi.fn().mockReturnValue(installRecords)
      });
      (bot as any).installService.pathExists = () => true;
      (bot as any).client.user = { id: "bot-1" };
      (bot as any).client.channels.fetch = vi.fn().mockResolvedValue(thread);
      (bot as any).runProviderText = vi.fn().mockResolvedValue("follow-up response");

      await (bot as any).runQueuedRequest({
        requestId: 112,
        threadId: "thread-followup",
        repoId: 1,
        repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
        prompt: "follow-up prompt",
        provider: "claude",
        existingWorktreePath: "/tmp/worktree-existing",
        existingBranchName: "ask/111-123"
      });

      const runCalls = vi.mocked(bot.runProviderText as any).mock.calls;
      expect(runCalls).toHaveLength(1);
      const env = runCalls[0]![0].env;

      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-followup");
      expect(env.GEMINI_API_KEY).toBe("gemini-followup");
      expect(env.GH_TOKEN).toBe("gh-followup");
      expect(env.HOME).toBe("/home/followup");

      const pathParts = env.PATH!.split(":");
      expect(pathParts[0]).toBe("/data/tool-installs/request/thread-followup/java-temurin/bin");
      expect(env.PATH).toContain("/usr/local/bin");

      expect(env.NON_ESSENTIAL_VAR).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
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

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "GitHub CLI is not authenticated. Configure GitHub App credentials or `GH_TOKEN`, or run `gh auth login` on the host before using /issues."
    );
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

    const runners = (bot as any).buildReviewRunners({ guildId: "guild-1", repoId: 1 });

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

  it("selects summarizer as first slot differing from slot 1 when slots 1 and 2 are identical", () => {
    const bot = createBot({
      getReviewerSlots: vi.fn().mockReturnValue([
        { slot_index: 1, provider: "claude", model: null },
        { slot_index: 2, provider: "claude", model: null },
        { slot_index: 3, provider: "gemini", model: "gemini-2.5-pro" }
      ])
    });

    const runners = (bot as any).buildReviewRunners({ guildId: "guild-1", repoId: 1 });

    expect(runners.reviewers).toHaveLength(3);
    expect(runners.analyzer.provider).toBe("claude");
    expect(runners.judge.provider).toBe("claude");
    expect(runners.summarizer.provider).toBe("gemini");
    expect(runners.summarizer.model).toBe("gemini-2.5-pro");
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

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Only the original requester or a user with `Manage Server` can run `/review` for this branch."
    );
    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(runAdversarialReview).not.toHaveBeenCalled();
  });

  it("rejects review while an install is actively using the worktree", async () => {
    const bot = createBot({
      getRequestByThreadId: vi.fn().mockReturnValue({
        id: 41,
        status: "install_running"
      }),
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: "/tmp/worktree-review",
        branch_name: "ask/41-123",
        status: "install_running"
      })
    });
    (bot as any).config.enableCodexExecution = true;
    (bot as any).config.enableGeminiExecution = true;
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) }
    });
    await (bot as any).handleReview(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "The latest request in this thread is still queued or running. Wait for it to finish before reviewing."
    );
    expect(runAdversarialReview).not.toHaveBeenCalled();
  });

  it("passes review progress into the review service and maps events to Discord messages", async () => {
    vi.mocked(autoCommitDirtyWorktree).mockResolvedValue(false);
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
    (bot as any).config.enableCodexExecution = true;
    vi.spyOn((bot as any), "buildReviewRunners").mockReturnValue({
      analyzer: { provider: "claude", model: "claude-opus", label: "Claude", run: vi.fn() },
      reviewers: [
        { provider: "claude", model: "claude-opus", label: "Claude", run: vi.fn() },
        { provider: "codex", model: "o4-mini", label: "Codex", run: vi.fn() }
      ],
      judge: { provider: "claude", model: "claude-opus", label: "Claude", run: vi.fn() },
      summarizer: { provider: "codex", model: "o4-mini", label: "Codex", run: vi.fn() }
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      channel: { isThread: () => true, parentId: "channel-1", send, messages: { fetch: vi.fn().mockResolvedValue(new Map()) } }
    });

    await (bot as any).handleReview(interaction);

    expect(autoCommitDirtyWorktree).toHaveBeenCalledWith("/tmp");
    expect(runAdversarialReview).toHaveBeenCalledWith(expect.objectContaining({
      maxConsensusRounds: 4,
      onProgress: expect.any(Function)
    }));
    send.mockClear();
    const reviewInput = vi.mocked(runAdversarialReview).mock.calls[0]![0];
    await reviewInput.onProgress?.({ type: "analyzer-start" });
    await reviewInput.onProgress?.({ type: "analyzer-complete" });
    await reviewInput.onProgress?.({ type: "round-start", round: 1, maxRounds: 4 });
    await reviewInput.onProgress?.({ type: "round-complete", round: 1, maxRounds: 4, consensusReached: false });
    await reviewInput.onProgress?.({ type: "round-complete", round: 2, maxRounds: 4, consensusReached: true });
    await reviewInput.onProgress?.({ type: "summarizer-start" });

    expect(send).toHaveBeenCalledTimes(6);
    expect(send).toHaveBeenNthCalledWith(1, "Analyzing change intent…");
    expect(send).toHaveBeenNthCalledWith(2, "Analysis complete.");
    expect(send).toHaveBeenNthCalledWith(3, "Round 1/4: reviewing…");
    expect(send).toHaveBeenNthCalledWith(4, "Round 1/4 complete.");
    expect(send).toHaveBeenNthCalledWith(5, "Round 2/4: consensus reached.");
    expect(send).toHaveBeenNthCalledWith(6, "Synthesizing final verdict…");
  });

  it("keeps a completed review successful when the deferred interaction token has expired", async () => {
    vi.mocked(autoCommitDirtyWorktree).mockResolvedValue(false);
    vi.mocked(runAdversarialReview).mockResolvedValue({
      reviewRunId: 14,
      diffHeadSha: "expired-token-sha",
      reviewersSucceeded: 2,
      reviewersAttempted: 2,
      artifactPath: "docs/reviews/41/review.md",
      summary: {
        executiveSummary: "Review completed after the interaction token expired.",
        blockingIssues: [],
        nonBlockingIssues: [],
        missingTests: [],
        outstandingConcerns: [],
        verdict: "ready_for_pr"
      }
    });
    const bot = createBot({
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: "/tmp",
        branch_name: "ask/41-123",
        status: "succeeded"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1, owner: "octocat", repo: "hello-world", full_name: "octocat/hello-world", channel_id: "channel-1"
      }),
      getGuildModelConfig: vi.fn().mockReturnValue({ provider: "claude", model: null, updated_at: "2026-03-18T00:00:00Z" })
    });
    (bot as any).config.enableCodexExecution = true;
    vi.spyOn((bot as any), "buildReviewRunners").mockReturnValue({
      analyzer: { provider: "claude", label: "Claude", run: vi.fn() },
      reviewers: [
        { provider: "claude", label: "Claude", run: vi.fn() },
        { provider: "codex", label: "Codex", run: vi.fn() }
      ],
      judge: { provider: "claude", label: "Claude", run: vi.fn() },
      summarizer: { provider: "codex", label: "Codex", run: vi.fn() }
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      editReply: vi.fn().mockRejectedValue(new Error("DiscordAPIError[50027]: Invalid Webhook Token")),
      channel: { isThread: () => true, parentId: "channel-1", send, messages: { fetch: vi.fn().mockResolvedValue(new Map()) } }
    });

    await expect((bot as any).handleReview(interaction)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Review run: #14"));
    expect(send).not.toHaveBeenCalledWith(expect.stringContaining("Adversarial review failed"));
  });

  it("does not auto-commit review artifacts when running /review a second time on the same worktree", async () => {
    vi.mocked(autoCommitDirtyWorktree).mockResolvedValue(false);
    vi.mocked(runAdversarialReview).mockResolvedValue({
      reviewRunId: 13,
      diffHeadSha: "def456",
      reviewersSucceeded: 2,
      reviewersAttempted: 2,
      artifactPath: "docs/reviews/41/review.md",
      summary: {
        executiveSummary: "No new issues.",
        blockingIssues: [],
        nonBlockingIssues: [],
        missingTests: [],
        outstandingConcerns: [],
        verdict: "ready_for_pr"
      }
    });

    const bot = createBot({
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: "/tmp",
        branch_name: "ask/41-123",
        status: "succeeded"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1, owner: "octocat", repo: "hello-world", full_name: "octocat/hello-world", channel_id: "channel-1"
      }),
      getGuildReviewConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1", rounds: 4, updated_by_user_id: "admin-1", updated_at: "2026-03-24T00:00:00Z"
      }),
      getGuildModelConfig: vi.fn().mockReturnValue({
        provider: "claude", model: "claude-opus", updated_at: "2026-03-18T00:00:00Z"
      })
    });
    (bot as any).config.enableCodexExecution = true;
    (bot as any).config.enableGeminiExecution = true;
    vi.spyOn((bot as any), "buildReviewRunners").mockReturnValue({
      analyzer: { provider: "claude", model: "claude-opus", label: "Claude", run: vi.fn() },
      reviewers: [
        { provider: "claude", model: "claude-opus", label: "Claude", run: vi.fn() },
        { provider: "codex", model: "o4-mini", label: "Codex", run: vi.fn() }
      ],
      judge: { provider: "claude", model: "claude-opus", label: "Claude", run: vi.fn() },
      summarizer: { provider: "codex", model: "o4-mini", label: "Codex", run: vi.fn() }
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      channel: {
        isThread: () => true,
        parentId: "channel-1",
        send,
        messages: { fetch: vi.fn().mockResolvedValue(new Map()) }
      }
    });

    await (bot as any).handleReview(interaction);

    expect(autoCommitDirtyWorktree).toHaveBeenCalledWith("/tmp");
    expect(send).not.toHaveBeenCalledWith("Uncommitted changes in the worktree were auto-committed for review.");
    expect(runAdversarialReview).toHaveBeenCalledWith(expect.objectContaining({
      maxConsensusRounds: 4,
      onProgress: expect.any(Function)
    }));
  });

  it("rejects review when fewer than 2 reviewer slots are configured", async () => {
    const bot = createBot({
      getReviewerSlots: vi.fn().mockReturnValue([
        { guild_id: "guild-1", slot_index: 1, provider: "claude", model: null, updated_by_user_id: "user-1", created_at: "", updated_at: "" }
      ]),
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41, user_id: "user-1", worktree_path: "/tmp", branch_name: "ask/41-123", status: "succeeded"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1, owner: "octocat", repo: "hello-world", full_name: "octocat/hello-world", channel_id: "channel-1"
      })
    });
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) }
    });
    await (bot as any).handleReview(interaction);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "**Insufficient reviewers configured** — at least 2 reviewer slots are required for `/review`. Use `/model-select reviewer-1` and `/model-select reviewer-2` to set them up."
    );
    expect(runAdversarialReview).not.toHaveBeenCalled();
  });

  it("rejects review when a slot provider is not enabled", async () => {
    const bot = createBot({
      getReviewerSlots: vi.fn().mockReturnValue([
        { guild_id: "guild-1", slot_index: 1, provider: "claude", model: null, updated_by_user_id: "user-1", created_at: "", updated_at: "" },
        { guild_id: "guild-1", slot_index: 2, provider: "codex", model: null, updated_by_user_id: "user-1", created_at: "", updated_at: "" }
      ]),
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41, user_id: "user-1", worktree_path: "/tmp", branch_name: "ask/41-123", status: "succeeded"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1, owner: "octocat", repo: "hello-world", full_name: "octocat/hello-world", channel_id: "channel-1"
      })
    });
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) }
    });
    await (bot as any).handleReview(interaction);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "**Provider unavailable** — slot 2 uses `codex` which is not available. Codex execution is not enabled on this instance (`ENABLE_CODEX_EXECUTION` is not set). Choose a different provider or ask the instance administrator to enable it."
    );
    expect(runAdversarialReview).not.toHaveBeenCalled();
  });

  it("rejects review when a role override provider is not enabled (slot mode)", async () => {
    const bot = createBot({
      getReviewerSlots: vi.fn().mockReturnValue([
        { guild_id: "guild-1", slot_index: 1, provider: "claude", model: null, updated_by_user_id: "user-1", created_at: "", updated_at: "" },
        { guild_id: "guild-1", slot_index: 2, provider: "codex", model: null, updated_by_user_id: "user-1", created_at: "", updated_at: "" }
      ]),
      getGuildReviewConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1", rounds: 2, analyzer_provider: "gemini", updated_by_user_id: "admin-1", updated_at: "2026-03-24T00:00:00Z"
      }),
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41, user_id: "user-1", worktree_path: "/tmp", branch_name: "ask/41-123", status: "succeeded"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1, owner: "octocat", repo: "hello-world", full_name: "octocat/hello-world", channel_id: "channel-1"
      })
    });
    (bot as any).config.enableCodexExecution = true;
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) }
    });
    await (bot as any).handleReview(interaction);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "**Provider unavailable** — the `analyzer` role override uses `gemini` which is not available. Gemini execution is not enabled on this instance (`ENABLE_GEMINI_EXECUTION` is not set). Choose a different provider or ask the instance administrator to enable it."
    );
    expect(runAdversarialReview).not.toHaveBeenCalled();
  });

  it("rejects review when fewer than 2 providers are enabled in legacy mode", async () => {
    const bot = createBot({
      getReviewerSlots: vi.fn().mockReturnValue([]),
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41, user_id: "user-1", worktree_path: "/tmp", branch_name: "ask/41-123", status: "succeeded"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1, owner: "octocat", repo: "hello-world", full_name: "octocat/hello-world", channel_id: "channel-1"
      }),
      getGuildModelConfig: vi.fn().mockReturnValue({ provider: "claude", model: null, updated_at: "2026-03-18T00:00:00Z" })
    });
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) }
    });
    await (bot as any).handleReview(interaction);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "**Insufficient reviewers configured** — at least 2 available AI providers are required for `/review`. Use `/model-select` to configure a second provider or ask the server administrator to enable or configure additional providers."
    );
    expect(runAdversarialReview).not.toHaveBeenCalled();
  });

  it("sends clear auto-commit failure message when git workspace errors on auto-commit", async () => {
    const { GitWorkspaceError } = await import("../src/services/gitWorkspaceService.js");
    vi.mocked(autoCommitDirtyWorktree).mockRejectedValue(
      new GitWorkspaceError("AUTO_COMMIT_FAILED", "could not commit")
    );
    const bot = createBot({
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41, user_id: "user-1", worktree_path: "/tmp", branch_name: "ask/41-123", status: "succeeded"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1, owner: "octocat", repo: "hello-world", full_name: "octocat/hello-world", channel_id: "channel-1"
      }),
      getGuildReviewConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1", rounds: 2, updated_by_user_id: "admin-1", updated_at: "2026-03-24T00:00:00Z"
      }),
      getGuildModelConfig: vi.fn().mockReturnValue({ provider: "claude", model: "claude-opus", updated_at: "2026-03-18T00:00:00Z" })
    });
    (bot as any).config.enableCodexExecution = true;
    const send = vi.fn().mockResolvedValue(undefined);
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      channel: { isThread: () => true, parentId: "channel-1", send, messages: { fetch: vi.fn().mockResolvedValue(new Map()) } }
    });
    await (bot as any).handleReview(interaction);
    expect(send).toHaveBeenCalledWith(expect.stringContaining("**Auto-commit failed**"));
    expect(send).toHaveBeenCalledWith(expect.stringContaining("stash changes manually"));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("could not be auto-committed"));
    expect(runAdversarialReview).not.toHaveBeenCalled();
  });

  it("sends clear git-unavailable message when git is not installed", async () => {
    const { GitWorkspaceError } = await import("../src/services/gitWorkspaceService.js");
    vi.mocked(autoCommitDirtyWorktree).mockRejectedValue(
      new GitWorkspaceError("GIT_UNAVAILABLE", "git not found")
    );
    const bot = createBot({
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41, user_id: "user-1", worktree_path: "/tmp", branch_name: "ask/41-123", status: "succeeded"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1, owner: "octocat", repo: "hello-world", full_name: "octocat/hello-world", channel_id: "channel-1"
      }),
      getGuildReviewConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1", rounds: 2, updated_by_user_id: "admin-1", updated_at: "2026-03-24T00:00:00Z"
      }),
      getGuildModelConfig: vi.fn().mockReturnValue({ provider: "claude", model: "claude-opus", updated_at: "2026-03-18T00:00:00Z" })
    });
    (bot as any).config.enableCodexExecution = true;
    const send = vi.fn().mockResolvedValue(undefined);
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      channel: { isThread: () => true, parentId: "channel-1", send, messages: { fetch: vi.fn().mockResolvedValue(new Map()) } }
    });
    await (bot as any).handleReview(interaction);
    expect(send).toHaveBeenCalledWith(expect.stringContaining("**Auto-commit failed**"));
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Git is not available"));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("Git is not available"));
    expect(runAdversarialReview).not.toHaveBeenCalled();
  });

  it("rejects review when Gemini slot provider lacks GEMINI_API_KEY (stale config)", async () => {
    const bot = createBot({
      getReviewerSlots: vi.fn().mockReturnValue([
        { guild_id: "guild-1", slot_index: 1, provider: "claude", model: null, updated_by_user_id: "user-1", created_at: "", updated_at: "" },
        { guild_id: "guild-1", slot_index: 2, provider: "gemini", model: null, updated_by_user_id: "user-1", created_at: "", updated_at: "" }
      ]),
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41, user_id: "user-1", worktree_path: "/tmp", branch_name: "ask/41-123", status: "succeeded"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1, owner: "octocat", repo: "hello-world", full_name: "octocat/hello-world", channel_id: "channel-1"
      })
    });
    (bot as any).config.enableGeminiExecution = true;
    (bot as any).config.enableCodexExecution = true;
    (bot as any).config.geminiApiKey = undefined;
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) }
    });
    await (bot as any).handleReview(interaction);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "**Provider unavailable** — slot 2 uses `gemini` which is not available. Gemini execution requires `GEMINI_API_KEY` on this instance. Choose a different provider or ask the instance administrator to configure it."
    );
    expect(runAdversarialReview).not.toHaveBeenCalled();
  });

  it("rejects review when OpenCode slot provider lacks credentials (stale config)", async () => {
    const bot = createBot({
      getReviewerSlots: vi.fn().mockReturnValue([
        { guild_id: "guild-1", slot_index: 1, provider: "claude", model: null, updated_by_user_id: "user-1", created_at: "", updated_at: "" },
        { guild_id: "guild-1", slot_index: 2, provider: "opencode", model: null, updated_by_user_id: "user-1", created_at: "", updated_at: "" }
      ]),
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41, user_id: "user-1", worktree_path: "/tmp", branch_name: "ask/41-123", status: "succeeded"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1, owner: "octocat", repo: "hello-world", full_name: "octocat/hello-world", channel_id: "channel-1"
      })
    });
    (bot as any).config.enableOpencodeExecution = true;
    (bot as any).config.enableCodexExecution = true;
    const hasOpencodeAuthMock = (await import("../src/services/opencodeExecutionService.js")).hasOpencodeAuth as ReturnType<typeof vi.fn>;
    hasOpencodeAuthMock.mockResolvedValue(false);
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) }
    });
    await (bot as any).handleReview(interaction);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "**Provider unavailable** — slot 2 uses `opencode` which is not available. OpenCode execution requires an API key. Use `/opencode-auth` to configure keys (e.g. `deepseek`, `openai`, `anthropic`), or set `DEEPSEEK_API_KEY` on the instance."
    );
    expect(runAdversarialReview).not.toHaveBeenCalled();
  });

  it("rejects review when Gemini is the only legacy provider and GEMINI_API_KEY is missing (stale config)", async () => {
    const bot = createBot({
      getReviewerSlots: vi.fn().mockReturnValue([]),
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41, user_id: "user-1", worktree_path: "/tmp", branch_name: "ask/41-123", status: "succeeded"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1, owner: "octocat", repo: "hello-world", full_name: "octocat/hello-world", channel_id: "channel-1"
      }),
      getGuildModelConfig: vi.fn().mockReturnValue({ provider: "gemini", model: null, updated_at: "2026-03-18T00:00:00Z" })
    });
    (bot as any).config.enableGeminiExecution = true;
    (bot as any).config.geminiApiKey = undefined;
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) }
    });
    await (bot as any).handleReview(interaction);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "**Provider unavailable** — saved default provider `gemini` is not available. Gemini execution requires `GEMINI_API_KEY` on this instance. Choose a different provider or ask the instance administrator to configure it."
    );
    expect(runAdversarialReview).not.toHaveBeenCalled();
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

  it("requires exactly one install source", async () => {
    const bot = createBot();
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "package") return "npm-prettier";
          if (name === "apt-package") return "libssl-dev";
          if (name === "scope") return "repo";
          return null;
        }),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleInstall(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Specify exactly one of `package` or `apt-package`.",
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
    const send = vi.fn().mockResolvedValue(undefined);
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
      channel: {
        isThread: () => true,
        isTextBased: () => true,
        isDMBased: () => false,
        parentId: "channel-1",
        send
      },
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "package") return "npm-prettier";
          if (name === "apt-package") return null;
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
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Installing `npm-prettier` in `request` scope. I'll post here when it's done.",
      ephemeral: true
    });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "<@user-1> Installed `npm-prettier@3` in `request` scope.\nInstall request: #55\nPATH prefix: `/data/tool-installs/request/thread-1/npm-prettier/bin`"
      )
    );
  });

  it("accepts apt-package installs", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const bot = createBot({
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 1,
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world",
        channel_id: "channel-1"
      })
    });
    const createApprovedInstallRequest = vi.fn().mockReturnValue({
      id: 77,
      package_id: "apt:libssl-dev",
      package_version: "libssl-dev",
      bin_path: null
    });
    const runInstall = vi.fn().mockResolvedValue({
      id: 77,
      package_id: "apt:libssl-dev",
      package_version: "libssl-dev",
      bin_path: null
    });
    (bot as any).installService = {
      createApprovedInstallRequest,
      runInstall
    };
    const interaction = createInteraction({
      channel: {
        isThread: () => false,
        isTextBased: () => true,
        isDMBased: () => false,
        parentId: "channel-1",
        send
      },
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "package") return null;
          if (name === "apt-package") return "libssl-dev";
          if (name === "scope") return "repo";
          return null;
        }),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleInstall(interaction);

    expect(createApprovedInstallRequest).toHaveBeenCalledWith({
      guildId: "guild-1",
      repoId: 1,
      requestId: null,
      threadId: null,
      packageId: "apt:libssl-dev",
      scope: "repo",
      requestedByUserId: "user-1",
      approvedByUserId: "user-1"
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Installing APT package `libssl-dev` in `repo` scope. I'll post here when it's done.",
      ephemeral: true
    });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "<@user-1> Installed APT package `libssl-dev` in `repo` scope.\nInstall request: #77\nPATH prefix: (none)"
      )
    );
  });
});

describe("ActuariusBot model-select command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("shows role provider CLI default when role provider differs from the default provider without a role model", async () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        planner_provider: "gemini",
        planner_model: null,
        implementer_provider: null,
        implementer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      })
    });
    const interaction = createInteraction();

    await (bot as any).handleModelCurrent(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("Planner role: **Gemini**, model: `none (CLI default)`."),
      ephemeral: true
    });
  });

  it("shows legacy fallback review mode when no slots or overrides are configured", async () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        planner_provider: null,
        planner_model: null,
        implementer_provider: null,
        implementer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      })
    });
    const interaction = createInteraction();

    await (bot as any).handleModelCurrent(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Review mode:** Using all enabled providers (legacy fallback)."),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Analyzer**: falls back to first available reviewer in default ordering"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Judge**: falls back to first available reviewer in default ordering"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Summarizer**: falls back to second available reviewer in default ordering"),
      ephemeral: true
    });
  });

  it("shows legacy fallback review mode when review_config has only rounds set", async () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        planner_provider: null,
        planner_model: null,
        implementer_provider: null,
        implementer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      }),
      getGuildReviewConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        rounds: 3,
        analyzer_provider: null,
        analyzer_model: null,
        judge_provider: null,
        judge_model: null,
        summarizer_provider: null,
        summarizer_model: null,
        updated_at: "2026-05-30T00:00:00.000Z"
      })
    });
    const interaction = createInteraction();

    await (bot as any).handleModelCurrent(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Review mode:** Using all enabled providers (legacy fallback)."),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Analyzer**: falls back to first available reviewer in default ordering"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Judge**: falls back to first available reviewer in default ordering"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Summarizer**: falls back to second available reviewer in default ordering"),
      ephemeral: true
    });
  });

  it("shows reviewer slots and fallback role assignments when slots are configured without overrides", async () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        planner_provider: null,
        planner_model: null,
        implementer_provider: null,
        implementer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      }),
      getReviewerSlots: vi.fn().mockReturnValue([
        { slot_index: 1, provider: "claude", model: null },
        { slot_index: 2, provider: "gemini", model: "gemini-2.5-pro" }
      ])
    });
    (bot as any).config = {
      ...(bot as any).config,
      enableGeminiExecution: true
    };
    const interaction = createInteraction();

    await (bot as any).handleModelCurrent(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("Slot **1**: **Claude**, model: CLI default model"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("Slot **2**: **Gemini**, model: `gemini-2.5-pro`"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Analyzer**: falls back to **Slot 1** (**Claude**)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Judge**: falls back to **Slot 1** (**Claude**)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Summarizer**: falls back to **Slot 2** (**Gemini**)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Review mode:** Using explicit reviewer slots."),
      ephemeral: true
    });
  });

  it("shows guild_review_config overrides as set via /model-select", async () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        planner_provider: null,
        planner_model: null,
        implementer_provider: null,
        implementer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      }),
      getGuildReviewConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        rounds: 2,
        analyzer_provider: "gemini",
        analyzer_model: null,
        judge_provider: null,
        judge_model: null,
        summarizer_provider: "codex",
        summarizer_model: "codex-preview-0503",
        updated_at: "2026-05-30T00:00:00.000Z"
      })
    });
    (bot as any).config = {
      ...(bot as any).config,
      enableGeminiExecution: true,
      enableCodexExecution: true
    };
    const interaction = createInteraction();

    await (bot as any).handleModelCurrent(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Analyzer**: **Gemini**, model: CLI default model (set via `/model-select`)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Summarizer**: **Codex**, model: `codex-preview-0503` (set via `/model-select`)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Review mode:** Using role overrides with provider ordering."),
      ephemeral: true
    });
  });

  it("shows guild_model_config overrides as legacy", async () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        planner_provider: null,
        planner_model: null,
        implementer_provider: null,
        implementer_model: null,
        analyzer_provider: "gemini",
        analyzer_model: null,
        judge_provider: "codex",
        judge_model: "codex-preview-0503",
        summarizer_provider: null,
        summarizer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      })
    });
    (bot as any).config = {
      ...(bot as any).config,
      enableGeminiExecution: true,
      enableCodexExecution: true
    };
    const interaction = createInteraction();

    await (bot as any).handleModelCurrent(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Analyzer**: **Gemini**, model: CLI default model (legacy override)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Judge**: **Codex**, model: `codex-preview-0503` (legacy override)"),
      ephemeral: true
    });
  });

  it("hides legacy overrides when slots are active and falls back to slot references instead", async () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        planner_provider: null,
        planner_model: null,
        implementer_provider: null,
        implementer_model: null,
        analyzer_provider: "gemini",
        analyzer_model: null,
        judge_provider: "codex",
        judge_model: "codex-preview-0503",
        summarizer_provider: null,
        summarizer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      }),
      getReviewerSlots: vi.fn().mockReturnValue([
        { slot_index: 1, provider: "claude", model: null },
        { slot_index: 2, provider: "gemini", model: "gemini-2.5-pro" }
      ])
    });
    const interaction = createInteraction();

    await (bot as any).handleModelCurrent(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Analyzer**: falls back to **Slot 1** (**Claude**)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Judge**: falls back to **Slot 1** (**Claude**)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Summarizer**: falls back to **Slot 2** (**Gemini**)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Review mode:** Using explicit reviewer slots."),
      ephemeral: true
    });
    expect(interaction.reply).not.toHaveBeenCalledWith({
      content: expect.stringContaining("legacy override"),
      ephemeral: true
    });
  });

  it("does not reuse the default model for a role-specific different provider", async () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        planner_provider: "gemini",
        planner_model: null,
        implementer_provider: null,
        implementer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      })
    });
    (bot as any).config = {
      ...(bot as any).config,
      enableGeminiExecution: true,
      geminiApiKey: "key"
    };

    const roles = await (bot as any).resolvePlanRoleModels("guild-1");

    expect(roles.planner).toEqual({ provider: "gemini" });
    expect(roles.implementer).toEqual({ provider: "claude", model: "claude-sonnet-4-6" });
  });

  it("shows review-only configuration when no guild_model_config exists", async () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue(undefined),
      getReviewerSlots: vi.fn().mockReturnValue([
        { slot_index: 1, provider: "claude", model: null },
        { slot_index: 2, provider: "gemini", model: "gemini-2.5-pro" }
      ]),
      getGuildReviewConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        rounds: 2,
        analyzer_provider: "gemini",
        analyzer_model: null,
        judge_provider: null,
        judge_model: null,
        summarizer_provider: null,
        summarizer_model: null,
        updated_at: "2026-05-30T00:00:00.000Z"
      })
    });
    (bot as any).config = {
      ...(bot as any).config,
      enableGeminiExecution: true
    };
    const interaction = createInteraction();

    await (bot as any).handleModelCurrent(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("No AI provider configured. Defaulting to **Claude**"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("Slot **1**: **Claude**"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("Slot **2**: **Gemini**, model: `gemini-2.5-pro`"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Analyzer**: **Gemini**, model: CLI default model (set via `/model-select`)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Review mode:** Using explicit reviewer slots."),
      ephemeral: true
    });
  });

  it("shows summarizer falling back to slot 1 when explicit slots are identical", async () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        planner_provider: null,
        planner_model: null,
        implementer_provider: null,
        implementer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      }),
      getReviewerSlots: vi.fn().mockReturnValue([
        { slot_index: 1, provider: "claude", model: null },
        { slot_index: 2, provider: "claude", model: null }
      ])
    });
    const interaction = createInteraction();

    await (bot as any).handleModelCurrent(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Summarizer**: falls back to **Slot 1** (**Claude**)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Analyzer**: falls back to **Slot 1** (**Claude**)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Judge**: falls back to **Slot 1** (**Claude**)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Review mode:** Using explicit reviewer slots."),
      ephemeral: true
    });
  });

  it("shows summarizer falling back to first differing slot when slots 1 and 2 are identical but slot 3 differs", async () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        planner_provider: null,
        planner_model: null,
        implementer_provider: null,
        implementer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      }),
      getReviewerSlots: vi.fn().mockReturnValue([
        { slot_index: 1, provider: "claude", model: null },
        { slot_index: 2, provider: "claude", model: null },
        { slot_index: 3, provider: "gemini", model: "gemini-2.5-pro" }
      ])
    });
    const interaction = createInteraction();

    await (bot as any).handleModelCurrent(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Analyzer**: falls back to **Slot 1** (**Claude**)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Judge**: falls back to **Slot 1** (**Claude**)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Summarizer**: falls back to **Slot 3** (**Gemini**)"),
      ephemeral: true
    });
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
        }),
        getBoolean: vi.fn().mockReturnValue(null)
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

  it("clears a reviewer slot via clear flag", async () => {
    const clearReviewerSlot = vi.fn();
    const upsertGuild = vi.fn();
    const bot = createBot({ clearReviewerSlot, upsertGuild });
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "provider") return null;
          if (name === "model") return null;
          if (name === "role") return "reviewer-2";
          return null;
        }),
        getBoolean: vi.fn((name: string) => name === "clear" ? true : null),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleModelSelect(interaction);

    expect(clearReviewerSlot).toHaveBeenCalledWith("guild-1", 2);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Reviewer slot **2** cleared.",
      ephemeral: true
    });
  });

  it("clears a reviewer role override via clear flag", async () => {
    const clearGuildReviewRoleConfig = vi.fn();
    const clearGuildModelConfigReviewRole = vi.fn();
    const upsertGuild = vi.fn();
    const bot = createBot({ clearGuildReviewRoleConfig, clearGuildModelConfigReviewRole, upsertGuild });
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "provider") return null;
          if (name === "model") return null;
          if (name === "role") return "reviewer-judge";
          return null;
        }),
        getBoolean: vi.fn((name: string) => name === "clear" ? true : null),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleModelSelect(interaction);

    expect(clearGuildReviewRoleConfig).toHaveBeenCalledWith("guild-1", "judge", "user-1");
    expect(clearGuildModelConfigReviewRole).toHaveBeenCalledWith("guild-1", "judge", "user-1");
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Reviewer **judge** role override cleared.",
      ephemeral: true
    });
  });

  it("rejects clear=true with default role", async () => {
    const setGuildModelConfig = vi.fn();
    const upsertGuild = vi.fn();
    const bot = createBot({ setGuildModelConfig, upsertGuild });
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "provider") return null;
          if (name === "model") return null;
          if (name === "role") return "default";
          return null;
        }),
        getBoolean: vi.fn((name: string) => name === "clear" ? true : null),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleModelSelect(interaction);

    expect(setGuildModelConfig).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "`clear` is only supported for reviewer roles (`reviewer-1`–`reviewer-4`, `reviewer-analyzer`, `reviewer-judge`, `reviewer-summarizer`). Use `/model-select provider:... role:default` without `clear` to change the default provider.",
      ephemeral: true
    });
  });

  it("shows ⚠️ unavailable when a slot uses Gemini enabled without API key", async () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        planner_provider: null,
        planner_model: null,
        implementer_provider: null,
        implementer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      }),
      getReviewerSlots: vi.fn().mockReturnValue([
        { slot_index: 1, provider: "claude", model: null },
        { slot_index: 2, provider: "gemini", model: "gemini-2.5-pro" }
      ])
    });
    (bot as any).config = {
      ...(bot as any).config,
      enableGeminiExecution: true,
      geminiApiKey: undefined
    };

    const interaction = createInteraction();
    await (bot as any).handleModelCurrent(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("Slot **2**: **Gemini**, model: `gemini-2.5-pro` ⚠️ *unavailable*"),
      ephemeral: true
    });
  });

  it("shows ⚠️ unavailable when a review_config override uses Gemini enabled without API key", async () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        planner_provider: null,
        planner_model: null,
        implementer_provider: null,
        implementer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      }),
      getGuildReviewConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        rounds: 2,
        analyzer_provider: "gemini",
        analyzer_model: null,
        judge_provider: null,
        judge_model: null,
        summarizer_provider: null,
        summarizer_model: null,
        updated_at: "2026-05-30T00:00:00.000Z"
      })
    });
    (bot as any).config = {
      ...(bot as any).config,
      enableGeminiExecution: true,
      geminiApiKey: undefined
    };

    const interaction = createInteraction();
    await (bot as any).handleModelCurrent(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Analyzer**: **Gemini**, model: CLI default model (set via `/model-select`) ⚠️ *unavailable*"),
      ephemeral: true
    });
  });

  it("shows ⚠️ unavailable when a disabled provider is in a slot", async () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        planner_provider: null,
        planner_model: null,
        implementer_provider: null,
        implementer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      }),
      getReviewerSlots: vi.fn().mockReturnValue([
        { slot_index: 1, provider: "claude", model: null },
        { slot_index: 2, provider: "codex", model: "o4-mini" }
      ])
    });
    (bot as any).config = {
      ...(bot as any).config,
      enableCodexExecution: false
    };

    const interaction = createInteraction();
    await (bot as any).handleModelCurrent(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("Slot **2**: **Codex**, model: `o4-mini` ⚠️ *unavailable*"),
      ephemeral: true
    });
  });

  it("non-slot buildReviewRunners uses guild_review_config overrides", () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        planner_provider: null,
        planner_model: null,
        implementer_provider: null,
        implementer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      }),
      getGuildReviewConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        rounds: 2,
        analyzer_provider: "gemini",
        analyzer_model: "gemini-2.0-flash",
        judge_provider: null,
        judge_model: null,
        summarizer_provider: null,
        summarizer_model: null,
        updated_at: "2026-05-30T00:00:00.000Z"
      }),
      getModelHistory: vi.fn().mockReturnValue([])
    });
    (bot as any).config.enableGeminiExecution = true;
    (bot as any).config.enableCodexExecution = true;

    const runners = (bot as any).buildReviewRunners({ guildId: "guild-1", repoId: 1 });

    expect(runners.analyzer.provider).toBe("gemini");
    expect(runners.analyzer.model).toBe("gemini-2.0-flash");
    expect(runners.judge.provider).toBe("claude");
    expect(runners.summarizer.provider).toBe("codex");
  });

  it("clear:true clears both guild_review_config and guild_model_config overrides", async () => {
    const clearGuildReviewRoleConfig = vi.fn();
    const clearGuildModelConfigReviewRole = vi.fn();
    const upsertGuild = vi.fn();
    const bot = createBot({
      clearGuildReviewRoleConfig,
      clearGuildModelConfigReviewRole,
      upsertGuild,
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        analyzer_provider: "gemini",
        analyzer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      })
    });
    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn((name: string) => {
          if (name === "provider") return null;
          if (name === "model") return null;
          if (name === "role") return "reviewer-analyzer";
          return null;
        }),
        getBoolean: vi.fn((name: string) => name === "clear" ? true : null),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleModelSelect(interaction);

    expect(clearGuildReviewRoleConfig).toHaveBeenCalledWith("guild-1", "analyzer", "user-1");
    expect(clearGuildModelConfigReviewRole).toHaveBeenCalledWith("guild-1", "analyzer", "user-1");
  });

  it("shows legacy overrides when no slots are configured", async () => {
    const bot = createBot({
      getGuildModelConfig: vi.fn().mockReturnValue({
        guild_id: "guild-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        planner_provider: null,
        planner_model: null,
        implementer_provider: null,
        implementer_model: null,
        analyzer_provider: "gemini",
        analyzer_model: null,
        judge_provider: "codex",
        judge_model: "codex-preview-0503",
        summarizer_provider: null,
        summarizer_model: null,
        updated_at: "2026-05-29T00:00:00.000Z"
      })
    });
    (bot as any).config = {
      ...(bot as any).config,
      enableGeminiExecution: true,
      enableCodexExecution: true
    };

    const interaction = createInteraction();
    await (bot as any).handleModelCurrent(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Analyzer**: **Gemini**, model: CLI default model (legacy override)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Judge**: **Codex**, model: `codex-preview-0503` (legacy override)"),
      ephemeral: true
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("**Review mode:** Using role overrides with provider ordering."),
      ephemeral: true
    });
  });
});

describe("ActuariusBot pr command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function createPrDb(worktreePath: string, overrides: Record<string, unknown> = {}) {
    return {
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 719,
        user_id: "user-1",
        status: "succeeded",
        worktree_path: worktreePath,
        branch_name: "ask/719-123",
        prompt: "Implement issue 127"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 5,
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world",
        channel_id: "channel-1"
      }),
      getLatestCompletedReviewRunForBranch: vi.fn().mockReturnValue({
        id: 12,
        final_verdict: "ready_for_pr",
        diff_head: "reviewed-sha",
        artifact_path: "docs/reviews/review.md"
      }),
      ...overrides
    };
  }

  it("blocks PR creation when a newer request is active without a workspace yet", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "actuarius-pr-active-"));
    const bot = createBot(createPrDb(worktreePath, {
      getRequestByThreadId: vi.fn().mockReturnValue({
        id: 720,
        status: "queued",
        worktree_path: null,
        branch_name: null
      })
    }));
    const interaction = createInteraction();

    await (bot as any).handlePr(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "The latest request in this thread is still queued or running. Wait for it to finish before opening a PR.",
      ephemeral: true
    });
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(pushBranch).not.toHaveBeenCalled();
  });

  it("blocks PR creation while another operation owns the thread resource", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "actuarius-pr-resource-busy-"));
    const bot = createBot(createPrDb(worktreePath));
    vi.spyOn((bot as any).requestQueue, "hasResourceWork").mockReturnValue(true);
    const interaction = createInteraction();

    await (bot as any).handlePr(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Another operation in this thread is already queued or running. Wait for it to finish before opening a PR."
    );
    expect(pushBranch).not.toHaveBeenCalled();
    expect(createDraftPullRequest).not.toHaveBeenCalled();
  });

  it("blocks PR creation when the worktree has uncommitted changes excluding review artifacts", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "actuarius-pr-dirty-"));
    const bot = createBot(createPrDb(worktreePath));
    vi.mocked(hasUncommittedChangesExcluding).mockResolvedValue(true);

    const interaction = createInteraction();

    await (bot as any).handlePr(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("worktree has uncommitted changes"));
    expect(pushBranch).not.toHaveBeenCalled();
    expect(createDraftPullRequest).not.toHaveBeenCalled();
  });

  it("pushes and opens a draft PR when the reviewed worktree is clean", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "actuarius-pr-clean-"));
    const channelSend = vi.fn().mockResolvedValue(undefined);
    const bot = createBot(createPrDb(worktreePath));
    vi.mocked(hasUncommittedChangesExcluding).mockResolvedValue(false);
    vi.mocked(getHeadSha).mockResolvedValue("reviewed-sha");
    vi.mocked(detectDefaultBranch).mockResolvedValue({ branchName: "main", remoteRef: "origin/main" });
    vi.mocked(pushBranch).mockResolvedValue(undefined);
    vi.mocked(createDraftPullRequest).mockResolvedValue("https://github.com/octocat/hello-world/pull/1");

    const interaction = createInteraction({
      channel: {
        isThread: () => true,
        isTextBased: () => true,
        isDMBased: () => false,
        parentId: "channel-1",
        url: "https://discord.test/thread-1",
        send: channelSend
      }
    });

    await (bot as any).handlePr(interaction);

    expect(hasUncommittedChangesExcluding).toHaveBeenCalledWith(worktreePath, ["docs/reviews/"]);
    expect(getHeadSha).toHaveBeenCalledWith(worktreePath, "ask/719-123");
    expect(pushBranch).toHaveBeenCalledWith(worktreePath, "ask/719-123");
    expect(createDraftPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath,
      head: "ask/719-123",
      base: "main",
      title: "Implement issue 127"
    }));
    expect(channelSend).toHaveBeenCalledWith(expect.stringContaining("Draft PR opened"));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("Draft PR opened for `octocat/hello-world`"));
  });

  it("opens a draft PR even when docs/reviews/ artifacts exist from a previous /review", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "actuarius-pr-artifacts-"));
    const channelSend = vi.fn().mockResolvedValue(undefined);
    const bot = createBot(createPrDb(worktreePath));
    vi.mocked(hasUncommittedChangesExcluding).mockResolvedValue(false);
    vi.mocked(hasUncommittedChanges).mockResolvedValue(true);
    vi.mocked(getHeadSha).mockResolvedValue("reviewed-sha");
    vi.mocked(detectDefaultBranch).mockResolvedValue({ branchName: "main", remoteRef: "origin/main" });
    vi.mocked(pushBranch).mockResolvedValue(undefined);
    vi.mocked(createDraftPullRequest).mockResolvedValue("https://github.com/octocat/hello-world/pull/1");

    const interaction = createInteraction({
      channel: {
        isThread: () => true,
        isTextBased: () => true,
        isDMBased: () => false,
        parentId: "channel-1",
        url: "https://discord.test/thread-1",
        send: channelSend
      }
    });

    await (bot as any).handlePr(interaction);

    expect(hasUncommittedChangesExcluding).toHaveBeenCalledWith(worktreePath, ["docs/reviews/"]);
    expect(hasUncommittedChanges).not.toHaveBeenCalled();
    expect(getHeadSha).toHaveBeenCalledWith(worktreePath, "ask/719-123");
    expect(pushBranch).toHaveBeenCalledWith(worktreePath, "ask/719-123");
    expect(createDraftPullRequest).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath,
      head: "ask/719-123",
      base: "main",
      title: "Implement issue 127"
    }));
    expect(channelSend).toHaveBeenCalledWith(expect.stringContaining("Draft PR opened"));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("Draft PR opened for `octocat/hello-world`"));
  });
});

describe("ActuariusBot plan command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("defaults /plan to iterative execution when the option is omitted", async () => {
    const createRequest = vi.fn().mockReturnValue({ id: 120 });
    const bot = createBot({
      createRequest,
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 5,
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world",
        channel_id: "channel-1"
      })
    });
    const enqueue = vi.fn();
    const runPlanRequest = vi.fn().mockResolvedValue(undefined);
    (bot as any).requestQueue.enqueue = enqueue;
    (bot as any).runPlanRequest = runPlanRequest;

    const thread = {
      id: "thread-plan-1",
      send: vi.fn().mockResolvedValue(undefined)
    };
    const seedMessage = {
      startThread: vi.fn().mockResolvedValue(thread)
    };
    const repoChannel = {
      type: ChannelType.GuildText,
      send: vi.fn().mockResolvedValue(seedMessage)
    };
    const interaction = createInteraction({
      channelId: "channel-1",
      channel: { isThread: () => false },
      user: { id: "user-1", tag: "user#0001" },
      guild: {
        id: "guild-1",
        name: "Guild",
        channels: { fetch: vi.fn().mockResolvedValue(repoChannel) }
      },
      options: {
        getString: vi.fn().mockReturnValue("Do the thing"),
        getBoolean: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handlePlan(interaction);
    await enqueue.mock.calls[0]![1]();

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("(iterative)"));
    expect(runPlanRequest).toHaveBeenCalledWith(expect.objectContaining({ iterative: true }));
  });
});

describe("ActuariusBot plan runner", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("preserves the request worktree when single-shot implementation fails after creation", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const updateRequestStatus = vi.fn();
    const updateRequestWorkspace = vi.fn();
    const bot = createBot({
      updateRequestStatus,
      updateRequestWorkspace
    });

    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(createRequestWorktree).mockResolvedValue({
      path: "/tmp/worktree-plan",
      branchName: "ask/91-123"
    });
    vi.mocked(deleteRequestBranch).mockResolvedValue(undefined);
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn()
      .mockResolvedValueOnce("plan text")
      .mockRejectedValueOnce(new Error("implementer failed"));

    await (bot as any).runPlanRequest({
      requestId: 91,
      threadId: "thread-1",
      repoId: 5,
      repo: {
        owner: "octocat",
        repo: "hello-world",
        fullName: "octocat/hello-world"
      },
      prompt: "Do the thing",
      planner: { provider: "claude" },
      implementer: { provider: "claude" },
      iterative: false
    });

    expect(updateRequestStatus).toHaveBeenCalledWith(91, "failed");
    expect(deleteRequestBranch).not.toHaveBeenCalled();
    expect(updateRequestWorkspace).toHaveBeenCalledTimes(1);
    expect(updateRequestWorkspace).toHaveBeenCalledWith(91, "/tmp/worktree-plan", "ask/91-123");
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Plan request failed during implementing"));
    expect(send).toHaveBeenCalledWith(expect.stringContaining("remains attached"));
  });

  it("does not mask the plan failure when the preserved worktree notice cannot be sent", async () => {
    const noticeError = new Error("thread archived");
    const send = vi.fn().mockImplementation(async (content: string) => {
      if (content.includes("remains attached")) {
        throw noticeError;
      }
    });
    const updateRequestStatus = vi.fn();
    const updateRequestWorkspace = vi.fn();
    const warn = vi.spyOn(logger, "warn");
    const bot = createBot({
      updateRequestStatus,
      updateRequestWorkspace
    });

    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(createRequestWorktree).mockResolvedValue({
      path: "/tmp/worktree-plan",
      branchName: "ask/95-123"
    });
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn()
      .mockResolvedValueOnce("plan text")
      .mockRejectedValueOnce(new Error("implementer failed"));

    await expect((bot as any).runPlanRequest({
      requestId: 95,
      threadId: "thread-1",
      repoId: 5,
      repo: {
        owner: "octocat",
        repo: "hello-world",
        fullName: "octocat/hello-world"
      },
      prompt: "Do the thing",
      planner: { provider: "claude" },
      implementer: { provider: "claude" },
      iterative: false
    })).resolves.toBeUndefined();

    expect(updateRequestStatus).toHaveBeenCalledWith(95, "failed");
    expect(updateRequestWorkspace).toHaveBeenCalledWith(95, "/tmp/worktree-plan", "ask/95-123");
    expect(warn).toHaveBeenCalledWith(
      {
        error: noticeError,
        requestId: 95,
        worktreePath: "/tmp/worktree-plan",
        branchName: "ask/95-123"
      },
      "Failed to send preserved worktree notice"
    );
    warn.mockRestore();
  });

  it("preserves worktree when iterative loop fails so /revise can continue", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const updateRequestStatus = vi.fn();
    const updateRequestWorkspace = vi.fn();
    const bot = createBot({ updateRequestStatus, updateRequestWorkspace });

    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(createRequestWorktree).mockResolvedValue({
      path: "/tmp/worktree-plan",
      branchName: "ask/94-123"
    });
    vi.mocked(runIterativeTaskLoop).mockRejectedValue(new Error("task 2 failed"));
    vi.mocked(deleteRequestBranch).mockResolvedValue(undefined);
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn().mockResolvedValueOnce(JSON.stringify({
      overview: "Test plan",
      tasks: [
        { title: "Task 1", description: "First task" },
        { title: "Task 2", description: "Second task" }
      ]
    }));

    await (bot as any).runPlanRequest({
      requestId: 94,
      threadId: "thread-1",
      repoId: 5,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: "Do iterative thing",
      planner: { provider: "claude" },
      implementer: { provider: "claude" },
      iterative: true
    });

    expect(updateRequestStatus).toHaveBeenCalledWith(94, "failed");
    expect(deleteRequestBranch).not.toHaveBeenCalled();
    expect(updateRequestWorkspace).toHaveBeenCalledTimes(1);
    expect(updateRequestWorkspace).toHaveBeenCalledWith(94, "/tmp/worktree-plan", "ask/94-123");
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Plan request failed during iterative-loop"));
  });

  it("iterative false uses existing single-shot implementation behavior", async () => {
    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(createRequestWorktree).mockResolvedValue({
      path: "/tmp/worktree-plan",
      branchName: "ask/92-123"
    });
    vi.mocked(runIterativeTaskLoop).mockResolvedValue({ taskResults: [] });
    const send = vi.fn().mockResolvedValue(undefined);
    const updateRequestStatus = vi.fn();
    const bot = createBot({ updateRequestStatus });
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn()
      .mockResolvedValueOnce("plan text output")
      .mockResolvedValueOnce("implementation output");

    await (bot as any).runPlanRequest({
      requestId: 92,
      threadId: "thread-1",
      repoId: 5,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: "Do the thing",
      planner: { provider: "claude" },
      implementer: { provider: "claude" },
      iterative: false
    });

    const runCalls = vi.mocked(bot.runProviderText as any).mock.calls;
    const planPrompt = runCalls[0]![0].prompt;
    expect(planPrompt).toContain("Produce a structured implementation plan");
    expect(planPrompt).not.toContain("iterative");
    expect(planPrompt).not.toContain("Return ONLY valid JSON");

    const implPrompt = runCalls[1]![0].prompt;
    expect(implPrompt).toContain("Implement the request using the approved plan below");

    expect(updateRequestStatus).toHaveBeenCalledWith(92, "succeeded");
    expect(runIterativeTaskLoop).not.toHaveBeenCalled();
  });

  it("iterative true parses JSON tasks and runs iterative loop", async () => {
    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(createRequestWorktree).mockResolvedValue({
      path: "/tmp/worktree-plan",
      branchName: "ask/93-123"
    });
    vi.mocked(runIterativeTaskLoop).mockResolvedValue({ taskResults: [] });
    const send = vi.fn().mockResolvedValue(undefined);
    const updateRequestStatus = vi.fn();
    const bot = createBot({ updateRequestStatus });
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        overview: "Test plan",
        tasks: [
          { title: "Task 1", description: "First task" },
          { title: "Task 2", description: "Second task" }
        ]
      }));

    await (bot as any).runPlanRequest({
      requestId: 93,
      threadId: "thread-1",
      repoId: 5,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: "Do iterative thing",
      planner: { provider: "claude" },
      implementer: { provider: "claude" },
      iterative: true
    });

    const runCalls = vi.mocked(bot.runProviderText as any).mock.calls;
    const planPrompt = runCalls[0]![0].prompt;
    expect(planPrompt).toContain("Produce a structured iterative implementation plan");
    expect(planPrompt).toContain("Do not edit files. Do not run the implementation");
    expect(planPrompt).toContain("Return ONLY valid JSON");

    expect(runIterativeTaskLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          { title: "Task 1", description: "First task" },
          { title: "Task 2", description: "Second task" }
        ],
        overview: "Test plan",
        originalPrompt: "Do iterative thing",
        repoFullName: "octocat/hello-world",
        worktreePath: "/tmp/worktree-plan"
      })
    );
    expect(updateRequestStatus).toHaveBeenCalledWith(93, "succeeded");
    expect(send).toHaveBeenCalledWith(expect.stringContaining("2 tasks"));
  });

  it("invalid JSON falls back to one task", async () => {
    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(createRequestWorktree).mockResolvedValue({
      path: "/tmp/worktree-plan",
      branchName: "ask/94-123"
    });
    vi.mocked(runIterativeTaskLoop).mockResolvedValue({ taskResults: [] });
    const send = vi.fn().mockResolvedValue(undefined);
    const updateRequestStatus = vi.fn();
    const bot = createBot({ updateRequestStatus });
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn()
      .mockResolvedValueOnce("This is not valid JSON at all");

    await (bot as any).runPlanRequest({
      requestId: 94,
      threadId: "thread-1",
      repoId: 5,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: "Do iterative thing",
      planner: { provider: "claude" },
      implementer: { provider: "claude" },
      iterative: true
    });

    expect(runIterativeTaskLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          { title: "Implement request", description: expect.stringContaining("not valid JSON") }
        ]
      })
    );
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Running iterative mode with one task"));
    expect(updateRequestStatus).toHaveBeenCalledWith(94, "succeeded");
  });

  it("caps invalid JSON fallback task descriptions", async () => {
    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(createRequestWorktree).mockResolvedValue({
      path: "/tmp/worktree-plan",
      branchName: "ask/99-123"
    });
    vi.mocked(runIterativeTaskLoop).mockResolvedValue({ taskResults: [] });
    const send = vi.fn().mockResolvedValue(undefined);
    const bot = createBot({ updateRequestStatus: vi.fn() });
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn()
      .mockResolvedValueOnce(`not json ${"x".repeat(9_000)}`);

    await (bot as any).runPlanRequest({
      requestId: 99,
      threadId: "thread-1",
      repoId: 5,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: "Do iterative thing",
      planner: { provider: "claude" },
      implementer: { provider: "claude" },
      iterative: true
    });

    const tasks = vi.mocked(runIterativeTaskLoop).mock.calls[0]![0].tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.description).toHaveLength(8_000);
    expect(tasks[0]!.description.endsWith("...")).toBe(true);
  });

  it("iterative completion reports max-tweak task outcomes", async () => {
    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(createRequestWorktree).mockResolvedValue({
      path: "/tmp/worktree-plan",
      branchName: "ask/97-123"
    });
    vi.mocked(runIterativeTaskLoop).mockResolvedValue({
      taskResults: [
        {
          title: "Task 1",
          description: "First task",
          implementerOutput: "impl 1",
          verificationOutput: "APPROVED",
          approved: true,
          tweakAttempts: 0,
          diff: "diff 1"
        },
        {
          title: "Task 2",
          description: "Second task",
          implementerOutput: "impl 2",
          verificationOutput: "NEEDS FIX",
          approved: false,
          tweakAttempts: 3,
          diff: "diff 2"
        }
      ]
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const updateRequestStatus = vi.fn();
    const bot = createBot({ updateRequestStatus });
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        overview: "Test plan",
        tasks: [
          { title: "Task 1", description: "First task" },
          { title: "Task 2", description: "Second task" }
        ]
      }));

    await (bot as any).runPlanRequest({
      requestId: 97,
      threadId: "thread-1",
      repoId: 5,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: "Do iterative thing",
      planner: { provider: "claude" },
      implementer: { provider: "claude" },
      iterative: true
    });

    expect(send).toHaveBeenCalledWith(expect.stringContaining("1/2 tasks approved, 1 reached max tweaks"));
  });

  it("stores iterative plan details in MemPalace", async () => {
    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(createRequestWorktree).mockResolvedValue({
      path: "/tmp/worktree-plan",
      branchName: "ask/98-123"
    });
    vi.mocked(runIterativeTaskLoop).mockResolvedValue({
      taskResults: [
        {
          title: "Task 1",
          description: "First task",
          implementerOutput: "impl output",
          verificationOutput: "APPROVED",
          approved: true,
          tweakAttempts: 0,
          diff: "diff output"
        }
      ]
    });
    const addDrawer = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const bot = createBot({ updateRequestStatus: vi.fn() }, { addDrawer });
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        overview: "Test overview",
        tasks: [{ title: "Task 1", description: "First task" }]
      }));

    await (bot as any).runPlanRequest({
      requestId: 98,
      threadId: "thread-1",
      repoId: 5,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: "Do iterative thing",
      planner: { provider: "claude" },
      implementer: { provider: "claude" },
      iterative: true
    });

    expect(addDrawer).toHaveBeenCalledWith(
      expect.stringContaining("## Task Results"),
      "wing_actuarius_agent",
      "requests"
    );
    expect(addDrawer.mock.calls[0]![0]).toContain("Test overview");
    expect(addDrawer.mock.calls[0]![0]).toContain("Task 1");
    expect(addDrawer.mock.calls[0]![0]).toContain("impl output");
  });

  it("exercises real buildMinimalExecutionEnvironment in plan path — auth vars, bin PATH, no arbitrary env", async () => {
    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(createRequestWorktree).mockResolvedValue({
      path: "/tmp/worktree-plan",
      branchName: "ask/96-123"
    });
    vi.mocked(runIterativeTaskLoop).mockResolvedValue({ taskResults: [] });

    const savedEnv: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      GH_TOKEN: process.env.GH_TOKEN,
      NON_ESSENTIAL_VAR: process.env.NON_ESSENTIAL_VAR
    };

    try {
      process.env.ANTHROPIC_API_KEY = "sk-ant-xxx";
      process.env.HOME = "/root";
      process.env.PATH = "/custom/bin:/usr/bin";
      process.env.GH_TOKEN = "gh-test";
      process.env.NON_ESSENTIAL_VAR = "should-not-appear";

      const installRecords = [
        {
          id: 10,
          guild_id: "guild-1",
          repo_id: 5,
          request_id: null,
          thread_id: "thread-1",
          package_id: "npm-prettier",
          package_version: "3",
          scope: "request",
          status: "succeeded" as const,
          requested_by_user_id: "user-1",
          approved_by_user_id: "admin-1",
          install_root: "/data/tool-installs/request/thread-1/npm-prettier",
          bin_path: "/data/tool-installs/request/thread-1/npm-prettier/bin",
          env_json: "{}",
          logs: null,
          error_message: null,
          created_at: "2026-03-31T00:00:00.000Z",
          updated_at: "2026-03-31T00:00:00.000Z",
          completed_at: "2026-03-31T00:00:00.000Z"
        }
      ];

      const send = vi.fn().mockResolvedValue(undefined);
      const bot = createBot({
        updateRequestStatus: vi.fn(),
        listSuccessfulInstallRequestsForScope: vi.fn().mockReturnValue(installRecords)
      });
      (bot as any).installService.pathExists = () => true;
      (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
        isThread: () => true,
        send
      });
      (bot as any).runProviderText = vi.fn()
        .mockResolvedValueOnce("plan text")
        .mockResolvedValueOnce("impl output");

      await (bot as any).runPlanRequest({
        requestId: 96,
        threadId: "thread-1",
        repoId: 5,
        repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
        prompt: "Do the thing",
        planner: { provider: "claude" },
        implementer: { provider: "claude" }
      });

      const runCalls = vi.mocked(bot.runProviderText as any).mock.calls;
      expect(runCalls).toHaveLength(2);
      for (const call of runCalls) {
        expect(call[0]).toHaveProperty("env");
        const env = call[0].env;
        expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
        expect(env.HOME).toBe("/root");
        expect(env.GH_TOKEN).toBe("gh-test");

        const pathParts = env.PATH!.split(":");
        expect(pathParts[0]).toBe("/data/tool-installs/request/thread-1/npm-prettier/bin");
        expect(env.PATH).toContain("/custom/bin");

        expect(env.NON_ESSENTIAL_VAR).toBeUndefined();
      }
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("more than 20 tasks truncates and warns", async () => {
    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(createRequestWorktree).mockResolvedValue({
      path: "/tmp/worktree-plan",
      branchName: "ask/95-123"
    });
    vi.mocked(runIterativeTaskLoop).mockResolvedValue({ taskResults: [] });
    const send = vi.fn().mockResolvedValue(undefined);
    const updateRequestStatus = vi.fn();
    const bot = createBot({ updateRequestStatus });
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    const manyTasks = Array.from({ length: 25 }, (_, i) => ({
      title: `Task ${i + 1}`,
      description: `Description ${i + 1}`
    }));
    (bot as any).runProviderText = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ overview: "Large plan", tasks: manyTasks }));

    await (bot as any).runPlanRequest({
      requestId: 95,
      threadId: "thread-1",
      repoId: 5,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: "Large iterative thing",
      planner: { provider: "claude" },
      implementer: { provider: "claude" },
      iterative: true
    });

    expect(runIterativeTaskLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: manyTasks.slice(0, 20)
      })
    );
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Warning: plan has more than 20 tasks"));
    expect(updateRequestStatus).toHaveBeenCalledWith(95, "succeeded");
  });

  it("preserves worktree when planner errors after worktree creation", async () => {
    vi.mocked(ensureRepoCheckedOutToMaster).mockResolvedValue({ localPath: "/tmp/repo" });
    vi.mocked(createRequestWorktree).mockResolvedValue({
      path: "/tmp/worktree-plan",
      branchName: "ask/96-123"
    });
    vi.mocked(deleteRequestBranch).mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const updateRequestStatus = vi.fn();
    const updateRequestWorkspace = vi.fn();
    const bot = createBot({ updateRequestStatus, updateRequestWorkspace });
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn().mockRejectedValue(new Error("planner failed"));

    await (bot as any).runPlanRequest({
      requestId: 96,
      threadId: "thread-1",
      repoId: 5,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: "Do iterative thing",
      planner: { provider: "claude" },
      implementer: { provider: "claude" },
      iterative: true
    });

    expect(updateRequestStatus).toHaveBeenCalledWith(96, "failed");
    expect(deleteRequestBranch).not.toHaveBeenCalled();
    expect(updateRequestWorkspace).toHaveBeenCalledTimes(1);
    expect(updateRequestWorkspace).toHaveBeenCalledWith(96, "/tmp/worktree-plan", "ask/96-123");
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Plan request failed during planning"));
    expect(send).toHaveBeenCalledWith(expect.stringContaining("remains attached"));
  });
});

describe("ActuariusBot revise command", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getReviewDiff).mockResolvedValue({
      baseBranch: "main",
      baseRef: "origin/main",
      headRef: "ask/41-123",
      headSha: "head-sha",
      changedFiles: [],
      diffText: "diff"
    });
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function createTempWorktree(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(path);
    return path;
  }

  function createReviseDb(overrides: Record<string, unknown> = {}) {
    return {
      createRequest: vi.fn().mockReturnValue({
        id: 42,
        guild_id: "guild-1",
        repo_id: 5,
        channel_id: "channel-1",
        thread_id: "thread-1",
        user_id: "user-1",
        prompt: "Original request prompt",
        status: "queued",
        worktree_path: null,
        branch_name: null,
        revision_of_request_id: 41,
        created_at: "2026-06-01T00:00:00.000Z"
      }),
      updateRequestWorkspace: vi.fn(),
      updateRequestStatus: vi.fn(),
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: "/tmp/worktree-revise",
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt",
        revision_of_request_id: null
      }),
      getRequestByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        status: "succeeded"
      }),
      getRepoByChannelId: vi.fn().mockReturnValue({
        id: 5,
        owner: "octocat",
        repo: "hello-world",
        full_name: "octocat/hello-world",
        channel_id: "channel-1"
      }),
      getRequestById: vi.fn().mockImplementation((requestId: number) => requestId === 41
        ? { id: 41, revision_of_request_id: null }
        : undefined),
      getLatestCompletedReviewRunForBranch: vi.fn().mockReturnValue(undefined),
      ...overrides
    };
  }

  it("rejects when invoked outside a thread", async () => {
    const bot = createBot(createReviseDb());
    const interaction = createInteraction({
      channel: { isThread: () => false }
    });

    await (bot as any).handleRevise(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "`/revise` must be run inside a request thread.",
      ephemeral: true
    });
  });

  it("rejects when no tracked worktree or branch exists", async () => {
    const bot = createBot({
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: null,
        branch_name: null,
        status: "succeeded"
      })
    });
    const interaction = createInteraction();

    await (bot as any).handleRevise(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "This thread does not have a tracked request branch. Run `/ask` or `/plan` first.",
      ephemeral: true
    });
  });

  it("rejects when request is still active", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-active-");
    const bot = createBot(createReviseDb({
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: worktreePath,
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt"
      }),
      getRequestByThreadId: vi.fn().mockReturnValue({
        id: 42,
        user_id: "user-1",
        worktree_path: worktreePath,
        branch_name: "ask/41-123",
        status: "queued"
      })
    }));
    const interaction = createInteraction();

    await (bot as any).handleRevise(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("still queued or running") }));
  });

  it("rejects when user is not owner or guild manager", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-owner-");
    const bot = createBot(createReviseDb({
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "different-user",
        worktree_path: worktreePath,
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt"
      }),
      getRequestByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "different-user",
        status: "succeeded"
      })
    }));
    const interaction = createInteraction({
      user: { id: "user-1" },
      memberPermissions: { has: vi.fn().mockReturnValue(false) }
    });

    await (bot as any).handleRevise(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Only the original requester") }));
  });

  it("rejects when tracked worktree path no longer exists", async () => {
    const staleWorktreePath = await createTempWorktree("actuarius-revise-missing-worktree-");
    await rm(staleWorktreePath, { recursive: true, force: true });
    const bot = createBot(createReviseDb({
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: staleWorktreePath,
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt"
      })
    }));
    const interaction = createInteraction();

    await (bot as any).handleRevise(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "The tracked worktree for this thread no longer exists. Start a new `/plan` request before revising.",
      ephemeral: true
    });
  });

  it("rejects before creating a request when the repo channel is missing", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-no-repo-");
    const createRequest = vi.fn();
    const bot = createBot(createReviseDb({
      createRequest,
      getRepoByChannelId: vi.fn().mockReturnValue(undefined),
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: worktreePath,
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt"
      })
    }));
    const interaction = createInteraction();

    await (bot as any).handleRevise(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "This thread is not attached to a connected repository channel. Run `/connect-repo` first.",
      ephemeral: true
    });
    expect(createRequest).not.toHaveBeenCalled();
  });

  it("creates a queued revision request before enqueuing work", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-queued-");
    const createRequest = vi.fn().mockReturnValue({
      id: 42,
      guild_id: "guild-1",
      repo_id: 5,
      channel_id: "channel-1",
      thread_id: "thread-1",
      user_id: "user-1",
      prompt: "Original request prompt",
      status: "queued",
      worktree_path: null,
      branch_name: null,
      revision_of_request_id: 41,
      created_at: "2026-06-01T00:00:00.000Z"
    });
    const updateRequestWorkspace = vi.fn();
    const bot = createBot(createReviseDb({
      createRequest,
      updateRequestWorkspace,
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: worktreePath,
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt"
      }),
      getRequestByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        status: "succeeded"
      })
    }));
    const enqueue = vi.fn();
    (bot as any).requestQueue.enqueue = enqueue;
    const interaction = createInteraction();

    await (bot as any).handleRevise(interaction);

    expect(createRequest).toHaveBeenCalledWith({
      guildId: "guild-1",
      repoId: 5,
      channelId: "channel-1",
      threadId: "thread-1",
      userId: "user-1",
      prompt: "Original request prompt",
      status: "queued",
      revisionOfRequestId: 41
    });
    expect(updateRequestWorkspace).toHaveBeenCalledWith(42, worktreePath, "ask/41-123");
    expect(createRequest.mock.invocationCallOrder[0]).toBeLessThan(enqueue.mock.invocationCallOrder[0]);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("Revision queued as request #42 for request #41"));
  });

  it("marks a revision request failed when workspace attachment fails during setup", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-setup-fail-");
    const updateRequestStatus = vi.fn();
    const bot = createBot(createReviseDb({
      updateRequestWorkspace: vi.fn().mockImplementation(() => {
        throw new Error("workspace write failed");
      }),
      updateRequestStatus,
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: worktreePath,
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt"
      }),
      getRequestByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        status: "succeeded"
      })
    }));
    const enqueue = vi.fn();
    (bot as any).requestQueue.enqueue = enqueue;
    const interaction = createInteraction();

    await (bot as any).handleRevise(interaction);

    expect(updateRequestStatus).toHaveBeenCalledWith(42, "failed");
    expect(enqueue).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("Revision setup failed"));
  });

  it("uses explicit findings in planner prompt when provided", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-findings-");
    vi.mocked(getReviewDiff).mockResolvedValue({
      baseBranch: "main",
      baseRef: "origin/main",
      headRef: "ask/41-123",
      headSha: "head-sha",
      changedFiles: [],
      diffText: "diff content"
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const updateRequestStatus = vi.fn();
    const getLatestCompletedReviewRunForBranch = vi.fn().mockReturnValue({
      id: 12,
      summary_markdown: "Review summary that should be ignored"
    });
    const bot = createBot(createReviseDb({
      updateRequestStatus,
      getLatestCompletedReviewRunForBranch,
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: worktreePath,
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt"
      })
    }));
    const enqueue = vi.fn();
    (bot as any).requestQueue.enqueue = enqueue;
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn().mockResolvedValue(JSON.stringify({
      overview: "Fix bugs",
      tasks: [{ title: "Fix bug 1", description: "Fix the first bug" }]
    }));
    vi.mocked(runIterativeTaskLoop).mockResolvedValue({ taskResults: [] });

    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn().mockImplementation((name: string) => {
          if (name === "findings") return "Explicit findings text";
          return null;
        }),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleRevise(interaction);

    await enqueue.mock.calls[0]![1]();

    const runCalls = vi.mocked(bot.runProviderText as any).mock.calls;
    const planPrompt = runCalls[0]![0].prompt;
    expect(planPrompt).toContain("Explicit findings text");
    expect(planPrompt).not.toContain("Latest review summary");
    expect(planPrompt).not.toContain("Review summary that should be ignored");
    expect(getLatestCompletedReviewRunForBranch).not.toHaveBeenCalled();
  });

  it("uses latest completed review summary when findings are omitted", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-review-");
    vi.mocked(getReviewDiff).mockResolvedValue({
      baseBranch: "main",
      baseRef: "origin/main",
      headRef: "ask/41-123",
      headSha: "head-sha",
      changedFiles: [],
      diffText: "diff content"
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const updateRequestStatus = vi.fn();
    const getLatestCompletedReviewRunForBranch = vi.fn().mockReturnValue({
      id: 12,
      summary_markdown: "Review summary markdown content"
    });
    const bot = createBot(createReviseDb({
      updateRequestStatus,
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: worktreePath,
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt"
      }),
      getLatestCompletedReviewRunForBranch
    }));
    const enqueue = vi.fn();
    (bot as any).requestQueue.enqueue = enqueue;
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn().mockResolvedValue(JSON.stringify({
      overview: "Fix bugs",
      tasks: [{ title: "Fix bug 1", description: "Fix the first bug" }]
    }));
    vi.mocked(runIterativeTaskLoop).mockResolvedValue({ taskResults: [] });

    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn().mockReturnValue(null),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleRevise(interaction);

    await enqueue.mock.calls[0]![1]();

    const runCalls = vi.mocked(bot.runProviderText as any).mock.calls;
    const planPrompt = runCalls[0]![0].prompt;
    expect(planPrompt).toContain("Review summary markdown content");
    expect(planPrompt).toContain("Latest review summary");
    expect(getLatestCompletedReviewRunForBranch).toHaveBeenCalledWith(41, "ask/41-123");
  });

  it("treats whitespace-only findings as omitted", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-whitespace-");
    const send = vi.fn().mockResolvedValue(undefined);
    const getLatestCompletedReviewRunForBranch = vi.fn().mockReturnValue({
      id: 12,
      summary_markdown: "Review summary for whitespace findings"
    });
    const bot = createBot(createReviseDb({
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: worktreePath,
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt"
      }),
      getLatestCompletedReviewRunForBranch
    }));
    const enqueue = vi.fn();
    (bot as any).requestQueue.enqueue = enqueue;
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn().mockResolvedValue(JSON.stringify({
      overview: "Fix bugs",
      tasks: [{ title: "Fix bug 1", description: "Fix the first bug" }]
    }));
    vi.mocked(runIterativeTaskLoop).mockResolvedValue({ taskResults: [] });

    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn().mockImplementation((name: string) => (name === "findings" ? "   \n\t" : null)),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleRevise(interaction);

    await enqueue.mock.calls[0]![1]();

    const runCalls = vi.mocked(bot.runProviderText as any).mock.calls;
    const planPrompt = runCalls[0]![0].prompt;
    expect(planPrompt).toContain("Review summary for whitespace findings");
    expect(planPrompt).toContain("Latest review summary");
    expect(planPrompt).not.toContain("Findings to address:");
  });

  it("walks revision ancestry to find the original review summary", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-chain-");
    const send = vi.fn().mockResolvedValue(undefined);
    const getLatestCompletedReviewRunForBranch = vi.fn().mockImplementation((requestId: number) => {
      if (requestId === 41) {
        return { id: 12, summary_markdown: "Original request review summary" };
      }
      return undefined;
    });
    const bot = createBot(createReviseDb({
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 42,
        user_id: "user-1",
        worktree_path: worktreePath,
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt",
        revision_of_request_id: 41
      }),
      getRequestById: vi.fn().mockImplementation((requestId: number) => {
        if (requestId === 42) return { id: 42, revision_of_request_id: 41 };
        if (requestId === 41) return { id: 41, revision_of_request_id: null };
        return undefined;
      }),
      getLatestCompletedReviewRunForBranch
    }));
    const enqueue = vi.fn();
    (bot as any).requestQueue.enqueue = enqueue;
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn().mockResolvedValue(JSON.stringify({
      overview: "Fix bugs",
      tasks: [{ title: "Fix bug 1", description: "Fix the first bug" }]
    }));
    vi.mocked(runIterativeTaskLoop).mockResolvedValue({ taskResults: [] });

    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn().mockReturnValue(null),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleRevise(interaction);

    await enqueue.mock.calls[0]![1]();

    const runCalls = vi.mocked(bot.runProviderText as any).mock.calls;
    expect(runCalls[0]![0].prompt).toContain("Original request review summary");
    expect(getLatestCompletedReviewRunForBranch).toHaveBeenNthCalledWith(1, 42, "ask/41-123");
    expect(getLatestCompletedReviewRunForBranch).toHaveBeenNthCalledWith(2, 41, "ask/41-123");
  });

  it("continues revision planning when no findings or review summary exist", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-no-summary-");
    const send = vi.fn().mockResolvedValue(undefined);
    const bot = createBot(createReviseDb({
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: worktreePath,
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt"
      }),
      getLatestCompletedReviewRunForBranch: vi.fn().mockReturnValue(undefined)
    }));
    const enqueue = vi.fn();
    (bot as any).requestQueue.enqueue = enqueue;
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn().mockResolvedValue(JSON.stringify({
      overview: "Fix bugs",
      tasks: [{ title: "Fix bug 1", description: "Fix the first bug" }]
    }));
    vi.mocked(runIterativeTaskLoop).mockResolvedValue({ taskResults: [] });

    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn().mockReturnValue(null),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleRevise(interaction);

    await enqueue.mock.calls[0]![1]();

    const runCalls = vi.mocked(bot.runProviderText as any).mock.calls;
    const planPrompt = runCalls[0]![0].prompt;
    expect(planPrompt).not.toContain("Latest review summary:");
    expect(planPrompt).not.toContain("Findings to address:");
    expect(runIterativeTaskLoop).toHaveBeenCalled();
  });

  it("calls runIterativeTaskLoop with parsed tasks on existing worktree", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-loop-");
    vi.mocked(getReviewDiff).mockResolvedValue({
      baseBranch: "main",
      baseRef: "origin/main",
      headRef: "ask/41-123",
      headSha: "head-sha",
      changedFiles: [],
      diffText: "my diff"
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const updateRequestStatus = vi.fn();
    const bot = createBot(createReviseDb({
      updateRequestStatus,
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: worktreePath,
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt"
      })
    }));
    const enqueue = vi.fn();
    (bot as any).requestQueue.enqueue = enqueue;
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn().mockResolvedValue(JSON.stringify({
      overview: "Revision plan",
      tasks: [
        { title: "Task 1", description: "First task" },
        { title: "Task 2", description: "Second task" }
      ]
    }));
    vi.mocked(runIterativeTaskLoop).mockResolvedValue({ taskResults: [] });

    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn().mockImplementation((name: string) => {
          if (name === "findings") return "finding text";
          return null;
        }),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleRevise(interaction);

    await enqueue.mock.calls[0]![1]();

    expect(runIterativeTaskLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          { title: "Task 1", description: "First task" },
          { title: "Task 2", description: "Second task" }
        ],
        overview: "Revision plan",
        originalPrompt: "Original request prompt",
        repoFullName: "octocat/hello-world",
        worktreePath
      })
    );
    expect(getReviewDiff).toHaveBeenCalledWith(worktreePath, { headRef: "ask/41-123", excludePaths: ["docs/reviews/**"] });
    expect(updateRequestStatus).toHaveBeenCalledWith(42, "succeeded");
  });

  it("JSON parse failure falls back to one task", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-parse-");
    vi.mocked(getReviewDiff).mockResolvedValue({
      baseBranch: "main",
      baseRef: "origin/main",
      headRef: "ask/41-123",
      headSha: "head-sha",
      changedFiles: [],
      diffText: "diff"
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const updateRequestStatus = vi.fn();
    const bot = createBot(createReviseDb({
      updateRequestStatus,
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: worktreePath,
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt"
      })
    }));
    const enqueue = vi.fn();
    (bot as any).requestQueue.enqueue = enqueue;
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn().mockResolvedValue("Not valid JSON at all");
    vi.mocked(runIterativeTaskLoop).mockResolvedValue({ taskResults: [] });

    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn().mockReturnValue(null),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleRevise(interaction);

    await enqueue.mock.calls[0]![1]();

    expect(runIterativeTaskLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          { title: "Implement request", description: expect.stringContaining("Not valid JSON") }
        ]
      })
    );
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Could not parse iterative plan as JSON"));
    expect(updateRequestStatus).toHaveBeenCalledWith(42, "succeeded");
  });

  it("failure does not call deleteRequestBranch", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-fail-");
    vi.mocked(getReviewDiff).mockResolvedValue({
      baseBranch: "main",
      baseRef: "origin/main",
      headRef: "ask/41-123",
      headSha: "head-sha",
      changedFiles: [],
      diffText: "diff"
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const updateRequestStatus = vi.fn();
    const bot = createBot(createReviseDb({
      updateRequestStatus,
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "user-1",
        worktree_path: worktreePath,
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt"
      })
    }));
    const enqueue = vi.fn();
    (bot as any).requestQueue.enqueue = enqueue;
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn().mockRejectedValue(new Error("planner failed"));

    const interaction = createInteraction({
      memberPermissions: { has: vi.fn().mockReturnValue(true) },
      options: {
        getString: vi.fn().mockReturnValue(null),
        getInteger: vi.fn().mockReturnValue(null)
      }
    });

    await (bot as any).handleRevise(interaction);

    await enqueue.mock.calls[0]![1]();

    expect(updateRequestStatus).toHaveBeenCalledWith(42, "failed");
    expect(deleteRequestBranch).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Revision failed during planning"));
  });

  it("empty planner output marks only the revision request failed", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-empty-plan-");
    const send = vi.fn().mockResolvedValue(undefined);
    const updateRequestStatus = vi.fn();
    const bot = createBot(createReviseDb({ updateRequestStatus }));
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send
    });
    (bot as any).installService.buildMinimalExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn().mockResolvedValue("   \n");

    await (bot as any).runReviseRequest({
      requestId: 42,
      sourceRequestId: 41,
      threadId: "thread-1",
      repoId: 5,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: "Original request prompt",
      worktreePath,
      branchName: "ask/41-123",
      planner: { provider: "claude" },
      implementer: { provider: "claude" },
      findings: "finding text"
    });

    expect(updateRequestStatus).toHaveBeenCalledWith(42, "failed");
    expect(updateRequestStatus).not.toHaveBeenCalledWith(41, expect.any(String));
    expect(send).toHaveBeenCalledWith("Planner produced no output; aborting revision.");
    expect(deleteRequestBranch).not.toHaveBeenCalled();
  });

  it("marks the revision failed when the thread is unavailable during execution", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-thread-missing-");
    const updateRequestStatus = vi.fn();
    const bot = createBot(createReviseDb({ updateRequestStatus }));
    (bot as any).client.channels.fetch = vi.fn().mockResolvedValue(null);

    await (bot as any).runReviseRequest({
      requestId: 42,
      sourceRequestId: 41,
      threadId: "thread-1",
      repoId: 5,
      repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
      prompt: "Original request prompt",
      worktreePath,
      branchName: "ask/41-123",
      planner: { provider: "claude" },
      implementer: { provider: "claude" },
      findings: "finding text"
    });

    expect(updateRequestStatus).toHaveBeenCalledWith(42, "running");
    expect(updateRequestStatus).toHaveBeenCalledWith(42, "failed");
    expect(getReviewDiff).not.toHaveBeenCalled();
  });

  it("preserves original owner when admin runs /revise", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-admin-owner-");
    const createRequest = vi.fn().mockReturnValue({
      id: 42,
      guild_id: "guild-1",
      repo_id: 5,
      channel_id: "channel-1",
      thread_id: "thread-1",
      user_id: "requester-1",
      prompt: "Original request prompt",
      status: "queued",
      worktree_path: null,
      branch_name: null,
      revision_of_request_id: 41,
      created_at: "2026-06-01T00:00:00.000Z"
    });
    const bot = createBot(createReviseDb({
      createRequest,
      getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "requester-1",
        worktree_path: worktreePath,
        branch_name: "ask/41-123",
        status: "succeeded",
        prompt: "Original request prompt"
      }),
      getRequestByThreadId: vi.fn().mockReturnValue({
        id: 41,
        user_id: "requester-1",
        status: "succeeded"
      })
    }));
    (bot as any).requestQueue.enqueue = vi.fn();

    const interaction = createInteraction({
      user: { id: "admin-user" },
      memberPermissions: { has: vi.fn().mockReturnValue(true) }
    });

    await (bot as any).handleRevise(interaction);

    expect(createRequest).toHaveBeenCalledWith(expect.objectContaining({
      userId: "requester-1"
    }));
  });

  it("exercises real buildMinimalExecutionEnvironment in revise path — auth vars, bin PATH, no arbitrary env", async () => {
    const worktreePath = await createTempWorktree("actuarius-revise-env-");
    vi.mocked(getReviewDiff).mockResolvedValue({
      baseBranch: "main",
      baseRef: "origin/main",
      headRef: "ask/41-123",
      headSha: "head-sha",
      changedFiles: [],
      diffText: "diff"
    });

    const savedEnv: Record<string, string | undefined> = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      GH_TOKEN: process.env.GH_TOKEN,
      NON_ESSENTIAL_VAR: process.env.NON_ESSENTIAL_VAR
    };

    try {
      process.env.OPENAI_API_KEY = "sk-openai-test";
      process.env.GEMINI_API_KEY = "gemini-test";
      process.env.HOME = "/home/user";
      process.env.PATH = "/usr/local/bin:/usr/bin";
      process.env.GH_TOKEN = "gh-test";
      process.env.NON_ESSENTIAL_VAR = "should-not-appear";

      const installRecords = [
        {
          id: 20,
          guild_id: "guild-1",
          repo_id: 5,
          request_id: null,
          thread_id: "thread-1",
          package_id: "npm-prettier",
          package_version: "3",
          scope: "request",
          status: "succeeded" as const,
          requested_by_user_id: "user-1",
          approved_by_user_id: "admin-1",
          install_root: "/data/tool-installs/request/thread-1/npm-prettier",
          bin_path: "/data/tool-installs/request/thread-1/npm-prettier/bin",
          env_json: "{}",
          logs: null,
          error_message: null,
          created_at: "2026-03-31T00:00:00.000Z",
          updated_at: "2026-03-31T00:00:00.000Z",
          completed_at: "2026-03-31T00:00:00.000Z"
        }
      ];

      const send = vi.fn().mockResolvedValue(undefined);
      const updateRequestStatus = vi.fn();
      const bot = createBot(createReviseDb({
        updateRequestStatus,
        getLatestRequestWithWorkspaceByThreadId: vi.fn().mockReturnValue({
          id: 41,
          user_id: "user-1",
          worktree_path: worktreePath,
          branch_name: "ask/41-123",
          status: "succeeded",
          prompt: "Original request prompt"
        }),
        listSuccessfulInstallRequestsForScope: vi.fn().mockReturnValue(installRecords)
      }));
      (bot as any).installService.pathExists = () => true;
      (bot as any).client.channels.fetch = vi.fn().mockResolvedValue({
        isThread: () => true,
        send
      });
      (bot as any).runProviderText = vi.fn().mockResolvedValue(JSON.stringify({
        overview: "Fix bugs",
        tasks: [{ title: "Fix bug 1", description: "Fix the first bug" }]
      }));
      vi.mocked(runIterativeTaskLoop).mockResolvedValue({ taskResults: [] });

      await (bot as any).runReviseRequest({
        requestId: 42,
        sourceRequestId: 41,
        threadId: "thread-1",
        repoId: 5,
        repo: { owner: "octocat", repo: "hello-world", fullName: "octocat/hello-world" },
        prompt: "Original request prompt",
        worktreePath,
        branchName: "ask/41-123",
        planner: { provider: "claude" },
        implementer: { provider: "claude" },
        findings: null
      });

      const runCalls = vi.mocked(bot.runProviderText as any).mock.calls;
      expect(runCalls.length).toBeGreaterThanOrEqual(1);
      for (const call of runCalls) {
        expect(call[0]).toHaveProperty("env");
        const env = call[0].env;
        expect(env.OPENAI_API_KEY).toBe("sk-openai-test");
        expect(env.GEMINI_API_KEY).toBe("gemini-test");
        expect(env.HOME).toBe("/home/user");
        expect(env.GH_TOKEN).toBe("gh-test");

        const pathParts = env.PATH!.split(":");
        expect(pathParts[0]).toBe("/data/tool-installs/request/thread-1/npm-prettier/bin");
        expect(env.PATH).toContain("/usr/local/bin");

        expect(env.NON_ESSENTIAL_VAR).toBeUndefined();
      }
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
