import { ChannelType, DiscordjsErrorCodes } from "discord.js";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
const { ensureRepoCheckedOutToMaster, getDiffSinceRef, listBranches, cleanupDeletedRemoteBranches } = await import("../src/services/gitWorkspaceService.js");
const { spawnCollect } = await import("../src/utils/spawnCollect.js");
const { listOpenIssues, viewIssueDetail } = await import("../src/services/githubService.js");
const { runClaudeRequest } = await import("../src/services/claudeExecutionService.js");
const { runAdversarialReview } = await import("../src/services/adversarialReviewService.js");
const { runIterativeTaskLoop } = await import("../src/services/iterativeTaskLoopService.js");
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

  return new ActuariusBot(config, logger, db as never);
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
    expect(enqueue).toHaveBeenCalledWith("guild-1", expect.any(Function));

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

describe("ActuariusBot plan runner", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("deletes the request worktree when plan execution fails after creation", async () => {
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
    (bot as any).installService.buildExecutionEnvironment = vi.fn().mockReturnValue({
      packages: [],
      env: {}
    });
    (bot as any).runProviderText = vi.fn().mockRejectedValue(new Error("planner failed"));

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
      implementer: { provider: "claude" }
    });

    expect(updateRequestStatus).toHaveBeenCalledWith(91, "failed");
    expect(deleteRequestBranch).toHaveBeenCalledWith(
      "/data/repos",
      {
        owner: "octocat",
        repo: "hello-world",
        fullName: "octocat/hello-world"
      },
      {
        branchName: "ask/91-123",
        worktreePath: "/tmp/worktree-plan"
      }
    );
    expect(updateRequestWorkspace).toHaveBeenNthCalledWith(1, 91, "/tmp/worktree-plan", "ask/91-123");
    expect(updateRequestWorkspace).toHaveBeenNthCalledWith(2, 91, null, null);
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Plan request failed during planning"));
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
    (bot as any).installService.buildExecutionEnvironment = vi.fn().mockReturnValue({
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
    (bot as any).installService.buildExecutionEnvironment = vi.fn().mockReturnValue({
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
    (bot as any).installService.buildExecutionEnvironment = vi.fn().mockReturnValue({
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
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Could not parse iterative plan as JSON"));
    expect(updateRequestStatus).toHaveBeenCalledWith(94, "succeeded");
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
    (bot as any).installService.buildExecutionEnvironment = vi.fn().mockReturnValue({
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

  it("planner/implementer errors mark failed and clean up worktree", async () => {
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
    (bot as any).installService.buildExecutionEnvironment = vi.fn().mockReturnValue({
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
    expect(deleteRequestBranch).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.stringContaining("Plan request failed during planning"));
  });
});
