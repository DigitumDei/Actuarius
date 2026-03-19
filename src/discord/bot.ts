import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ComponentType,
  DiscordjsErrorCodes,
  GatewayIntentBits,
  PermissionFlagsBits,
  type AnyThreadChannel,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildTextBasedChannel,
  type Message
} from "discord.js";
import type pino from "pino";
import type { AppConfig } from "../config.js";
import { AppDatabase } from "../db/database.js";
import type { AiProvider, RepoRow } from "../db/types.js";
import { commandBuilders } from "./commands.js";
import { buildHelpText } from "./messageTemplates.js";
import { buildRepoChannelName, buildThreadName } from "./naming.js";
import { getGitHubCommandEnvironment } from "../services/githubAuthService.js";
import {
  GitHubIssueLookupError,
  GitHubRepoLookupError,
  listOpenIssues,
  lookupRepo,
  parseRepoReference,
  viewIssueDetail,
  type GitHubIssueDetail,
  type GitHubIssueSummary
} from "../services/githubService.js";
import {
  GitWorkspaceError,
  cleanupDeletedRemoteBranches,
  ensureRepoCheckedOutToMaster,
  listBranches
} from "../services/gitWorkspaceService.js";
import { ClaudeExecutionError, runClaudeRequest } from "../services/claudeExecutionService.js";
import { CodexExecutionError, runCodexRequest } from "../services/codexExecutionService.js";
import { GeminiExecutionError, runGeminiRequest } from "../services/geminiExecutionService.js";
import { RequestExecutionQueue } from "../services/requestExecutionQueue.js";
import { createRequestWorktree, deleteRequestBranch, RequestWorktreeError } from "../services/requestWorktreeService.js";

const DISCORD_MESSAGE_LIMIT = 2_000;

const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini"
};

function clipForDiscord(input: string, maxLength: number): string {
  const text = input.trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 15).trimEnd()}\n...(truncated)`;
}

function splitIntoDiscordMessages(text: string, providerLabel: string = "Claude"): string[] {
  const HEADER = `**${providerLabel} execution completed**\n\n`;
  const CODE_OPEN = "```text\n";
  const CODE_CLOSE = "\n```";
  const CODE_OVERHEAD = CODE_OPEN.length + CODE_CLOSE.length;

  const firstContentMax = DISCORD_MESSAGE_LIMIT - HEADER.length - CODE_OVERHEAD;
  const contentMax = DISCORD_MESSAGE_LIMIT - CODE_OVERHEAD;

  const trimmed = text.trim();
  const chunks: string[] = [];
  let remaining = trimmed;
  let isFirst = true;

  while (remaining.length > 0) {
    const max = isFirst ? firstContentMax : contentMax;
    let chunk: string;

    if (remaining.length <= max) {
      chunk = remaining;
      remaining = "";
    } else {
      const splitAt = remaining.lastIndexOf("\n", max);
      if (splitAt > 0) {
        chunk = remaining.slice(0, splitAt);
        remaining = remaining.slice(splitAt + 1);
      } else {
        chunk = remaining.slice(0, max);
        remaining = remaining.slice(max);
      }
    }

    const prefix = isFirst ? HEADER : "";
    chunks.push(`${prefix}${CODE_OPEN}${chunk}${CODE_CLOSE}`);
    isFirst = false;
  }

  return chunks.length > 0 ? chunks : [`${HEADER}${CODE_OPEN}(no output)${CODE_CLOSE}`];
}

function fitDiscordMessage(lines: string[], truncationNotice: string): string {
  const normalizedLines = lines.map((line) => line.trimEnd());
  const emptyMessage = truncationNotice.length <= DISCORD_MESSAGE_LIMIT ? truncationNotice : truncationNotice.slice(0, DISCORD_MESSAGE_LIMIT);

  let message = "";
  for (const line of normalizedLines) {
    const nextMessage = message ? `${message}\n${line}` : line;
    if (nextMessage.length > DISCORD_MESSAGE_LIMIT) {
      if (!message) {
        return emptyMessage;
      }

      const reserved = DISCORD_MESSAGE_LIMIT - truncationNotice.length - 1;
      const trimmed = reserved > 0 ? message.slice(0, reserved).trimEnd() : "";
      return trimmed ? `${trimmed}\n${truncationNotice}` : emptyMessage;
    }
    message = nextMessage;
  }

  return message || emptyMessage;
}

function splitPlainTextForDiscord(text: string, header?: string): string[] {
  const trimmedBody = text.trim();
  const normalizedHeader = header?.trim();
  const firstChunkLimit = DISCORD_MESSAGE_LIMIT - (normalizedHeader ? normalizedHeader.length + 2 : 0);
  const laterChunkLimit = DISCORD_MESSAGE_LIMIT;
  const chunks: string[] = [];

  if (!trimmedBody) {
    return [normalizedHeader ?? "(no content)"];
  }

  let remaining = trimmedBody;
  let isFirst = true;
  while (remaining.length > 0) {
    const maxLength = isFirst ? firstChunkLimit : laterChunkLimit;
    let splitAt: number;
    if (remaining.length <= maxLength) {
      splitAt = remaining.length;
    } else {
      splitAt = remaining.lastIndexOf("\n", maxLength);
      if (splitAt <= 0) {
        splitAt = remaining.lastIndexOf(" ", maxLength);
      }
      if (splitAt <= 0) {
        splitAt = maxLength;
      }
    }

    const chunkBody = remaining.slice(0, splitAt).trim();
    remaining = remaining.slice(splitAt).trimStart();

    if (isFirst && normalizedHeader) {
      chunks.push(chunkBody ? `${normalizedHeader}\n\n${chunkBody}` : normalizedHeader);
    } else {
      chunks.push(chunkBody);
    }
    isFirst = false;
  }

  return chunks;
}

function formatIssueListReply(fullName: string, issues: GitHubIssueSummary[]): string {
  if (issues.length === 0) {
    return `No open issues found for \`${fullName}\`.`;
  }

  return [
    `Open issues for \`${fullName}\`:`,
    ...issues.map((issue) => `- #${issue.number} ${issue.title}`)
  ].join("\n");
}

function formatIssueDetail(issue: GitHubIssueDetail): string {
  const lines = [
    `#${issue.number} ${issue.title}`,
    `State: ${issue.state}`,
    `Author: ${issue.authorLogin ?? "unknown"}`,
    `Labels: ${issue.labels.length > 0 ? issue.labels.join(", ") : "(none)"}`,
    `Assignees: ${issue.assignees.length > 0 ? issue.assignees.join(", ") : "(none)"}`,
    `Created: ${issue.createdAt ?? "unknown"}`,
    `Updated: ${issue.updatedAt ?? "unknown"}`,
    `URL: ${issue.url}`,
    "",
    issue.body.trim() || "(no description)"
  ];

  return lines.join("\n");
}

function formatBranchesReply(fullName: string, branches: { local: string[]; remote: string[] }): string {
  const sectionLines = (label: string, values: string[]): string[] =>
    values.length > 0 ? [`**${label}**`, ...values.map((branch) => `- \`${branch}\``)] : [`**${label}**`, "(no branches found)"];

  return fitDiscordMessage(
    [
      `Branches for \`${fullName}\`:`,
      "",
      ...sectionLines("Local", branches.local),
      "",
      ...sectionLines("Origin", branches.remote)
    ],
    "...(truncated to fit Discord's 2000 character limit)"
  );
}

function formatCleanupReply(
  results: Array<{
    fullName: string;
    deleted: string[];
    removedWorktrees: string[];
    skippedDirtyWorktrees: Array<{ branchName: string; path: string }>;
  }>
): string {
  const lines: string[] = ["Cleanup completed."];

  for (const result of results) {
    lines.push("");
    lines.push(`\`${result.fullName}\``);
    if (
      result.deleted.length === 0
      && result.removedWorktrees.length === 0
      && result.skippedDirtyWorktrees.length === 0
    ) {
      lines.push("- no deleted origin branches were found locally");
      continue;
    }

    lines.push(...result.deleted.map((branch) => `- deleted \`${branch}\``));
    lines.push(...result.removedWorktrees.map((worktreePath) => `- removed worktree \`${worktreePath}\``));
    lines.push(
      ...result.skippedDirtyWorktrees.map(
        (entry) => `- skipped dirty worktree \`${entry.path}\` for \`${entry.branchName}\``
      )
    );
  }

  return fitDiscordMessage(lines, "...(truncated to fit Discord's 2000 character limit)");
}

function parseThreadEntry(
  content: string,
  isBot: boolean
): { role: "user" | "assistant"; text: string } | null {
  if (isBot) {
    // Initial request summary: "Request by @...\n\n**Prompt**\n<text>"
    const promptMatch = /^Request by .+\n\n\*\*Prompt\*\*\n([\s\S]+)/u.exec(content);
    if (promptMatch?.[1]) {
      return { role: "user", text: promptMatch[1].trim() };
    }
    // AI response in code block: "**{Provider} execution completed**\n\n```text\n<text>\n```"
    const codeBlockMatch = /^\*\*[A-Za-z]+ execution completed\*\*\n\n```text\n([\s\S]*?)\n```/u.exec(content);
    if (codeBlockMatch?.[1]) {
      return { role: "assistant", text: codeBlockMatch[1].trim() };
    }
    // AI response without code block (long response, stripped wrapper)
    const altMatch = /^\*\*[A-Za-z]+ execution completed\*\*\n\n([\s\S]+)/u.exec(content);
    if (altMatch?.[1]) {
      return { role: "assistant", text: altMatch[1].trim() };
    }
    // Continuation chunk from a split response: just a ```text...``` block
    const continuationMatch = /^```text\n([\s\S]*?)\n```$/u.exec(content);
    if (continuationMatch?.[1]) {
      return { role: "assistant", text: continuationMatch[1].trim() };
    }
    // Other bot messages are noise ("... execution started.", warnings, etc.)
    return null;
  }
  const text = content.trim();
  return text ? { role: "user", text } : null;
}

interface PendingGeminiAuth {
  child: ChildProcess;
  timeoutHandle: NodeJS.Timeout;
}

export class ActuariusBot {
  private readonly client: Client;
  private readonly config: AppConfig;
  private readonly logger: pino.Logger;
  private readonly db: AppDatabase;
  private readonly requestQueue: RequestExecutionQueue;
  private readonly pendingGeminiAuth = new Map<string, PendingGeminiAuth>();

  public constructor(config: AppConfig, logger: pino.Logger, db: AppDatabase) {
    this.config = config;
    this.logger = logger;
    this.db = db;
    this.requestQueue = new RequestExecutionQueue(
      this.config.askConcurrencyPerGuild,
      ({ guildId, error }) => {
        this.logger.error({ guildId, error }, "Queued request task failed with uncaught error");
      },
      ({ guildId, event, running, pending }) => {
        this.logger.debug({ guildId, event, running, pending }, "Request queue state changed");
      }
    );
    this.client = new Client({
      // MessageContent is a privileged intent — must be enabled in the Discord Developer Portal
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    });
  }

  public async start(): Promise<void> {
    this.bindEvents();
    await this.client.login(this.config.discordToken);
  }

  public async stop(): Promise<void> {
    await this.client.destroy();
  }

  private bindEvents(): void {
    this.client.on("ready", async () => {
      const guildCount = this.client.guilds.cache.size;
      this.logger.info({ guildCount, user: this.client.user?.tag }, "Discord bot connected");
      if (guildCount === 0) {
        this.logger.info("No guild memberships found. Waiting to be invited.");
      }

      for (const guild of this.client.guilds.cache.values()) {
        this.db.upsertGuild(guild.id, guild.name);
      }
    });

    this.client.on("guildCreate", async (guild) => {
      this.db.upsertGuild(guild.id, guild.name);
      await this.sendGuildWelcome(guild);
    });

    this.client.on("guildDelete", (guild) => {
      this.db.removeGuild(guild.id);
      this.logger.info({ guildId: guild.id }, "Removed guild from local state");
    });

    this.client.on("messageCreate", async (message) => {
      try {
        await this.handleThreadMessage(message);
      } catch (error) {
        this.logger.error({ error }, "Thread message handler failed");
      }
    });

    this.client.on("interactionCreate", async (interaction) => {
      if (interaction.isAutocomplete()) {
        try {
          await this.handleAutocomplete(interaction);
        } catch (error) {
          this.logger.error({ error }, "Autocomplete handler failed");
        }
        return;
      }

      if (!interaction.isChatInputCommand()) {
        return;
      }

      try {
        await this.handleCommand(interaction);
      } catch (error) {
        this.logger.error({ error }, "Command handler failed");
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: "Unexpected error. Please try again.", ephemeral: true });
          } else {
            await interaction.reply({ content: "Unexpected error. Please try again.", ephemeral: true });
          }
        } catch (responseError) {
          this.logger.error({ error: responseError }, "Failed to send command error response");
        }
      }
    });
  }

  private async sendGuildWelcome(guild: Guild): Promise<void> {
    try {
      const me = guild.members.me ?? (await guild.members.fetchMe());
      const firstTextChannel = guild.channels.cache
        .filter((channel): channel is GuildBasedChannel => channel.type === ChannelType.GuildText)
        .find((channel) => channel.permissionsFor(me).has(PermissionFlagsBits.SendMessages));

      const targetChannel = guild.systemChannel && guild.systemChannel.permissionsFor(me).has(PermissionFlagsBits.SendMessages)
        ? guild.systemChannel
        : firstTextChannel;

      if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
        this.logger.warn({ guildId: guild.id }, "No writable text channel found for welcome message");
        return;
      }

      await targetChannel.send(buildHelpText());
    } catch (error) {
      this.logger.warn({ guildId: guild.id, error }, "Failed to send guild welcome message");
    }
  }

  private async handleThreadMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.guildId || !message.guild) return;
    if (!message.channel.isThread()) return;

    const parentId = message.channel.parentId;
    if (!parentId) return;

    const latestRequest = this.db.getLatestRequestWithWorkspaceByThreadId(message.channelId);
    const existingWorktreePath = latestRequest?.worktree_path;
    if (!existingWorktreePath) return;

    if (!existsSync(existingWorktreePath)) {
      await message.reply("The worktree for this thread no longer exists (the bot may have been restarted or migrated). Use `/ask` to start a new request.");
      return;
    }

    const repo = this.db.getRepoByChannelId(message.guildId, parentId);
    if (!repo) return;

    const prompt = message.content.trim();
    if (!prompt) return;

    const modelConfig = this.db.getGuildModelConfig(message.guildId);
    const provider: AiProvider = modelConfig?.provider ?? "claude";
    const model = modelConfig?.model;

    const request = this.db.createRequest({
      guildId: message.guildId,
      repoId: repo.id,
      channelId: repo.channel_id,
      threadId: message.channelId,
      userId: message.author.id,
      prompt,
      status: "queued"
    });

    this.requestQueue.enqueue(message.guildId, async () => {
      await this.runQueuedRequest({
        requestId: request.id,
        threadId: message.channelId,
        repo: { owner: repo.owner, repo: repo.repo, fullName: repo.full_name },
        prompt,
        provider,
        ...(model ? { model } : {}),
        existingWorktreePath,
        ...(latestRequest.branch_name ? { existingBranchName: latestRequest.branch_name } : {})
      });
    });
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    switch (interaction.commandName) {
      case "help":
        await interaction.reply({ content: buildHelpText(), ephemeral: true });
        return;
      case "connect-repo":
        await this.handleConnectRepo(interaction);
        return;
      case "sync-repo":
        await this.handleSyncRepo(interaction);
        return;
      case "branches":
        await this.handleBranches(interaction);
        return;
      case "cleanup":
        await this.handleCleanup(interaction);
        return;
      case "repos":
        await this.handleRepos(interaction);
        return;
      case "issues":
        await this.handleIssues(interaction);
        return;
      case "ask":
        await this.handleAsk(interaction);
        return;
      case "bug":
        await this.handleIssueCreate(interaction, "bug");
        return;
      case "issue":
        await this.handleIssueCreate(interaction, "issue");
        return;
      case "model-select":
        await this.handleModelSelect(interaction);
        return;
      case "model-current":
        await this.handleModelCurrent(interaction);
        return;
      case "gemini-auth":
        await this.handleGeminiAuth(interaction);
        return;
      case "gemini-auth-complete":
        await this.handleGeminiAuthComplete(interaction);
        return;
      case "codex-auth":
        await this.handleCodexAuth(interaction);
        return;
      case "delete":
        await this.handleDelete(interaction);
        return;
      default:
        await interaction.reply({ content: "Unknown command.", ephemeral: true });
    }
  }

  private resolveRepoFromInteraction(interaction: ChatInputCommandInteraction): RepoRow | null {
    if (!interaction.guildId) {
      return null;
    }

    const rawRepo = interaction.options.getString("repo");
    const resolvedChannelId =
      interaction.channel && interaction.channel.isThread() ? interaction.channel.parentId : interaction.channelId;

    if (rawRepo) {
      const parsedReference = parseRepoReference(rawRepo);
      if (!parsedReference) {
        return null;
      }

      return this.db.getRepoByFullName(interaction.guildId, parsedReference.fullName) ?? null;
    }

    if (!resolvedChannelId) {
      return null;
    }

    return this.db.getRepoByChannelId(interaction.guildId, resolvedChannelId) ?? null;
  }

  private async handleConnectRepo(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to connect a repository.",
        ephemeral: true
      });
      return;
    }

    const rawRepo = interaction.options.getString("repo", true);
    const parsedReference = parseRepoReference(rawRepo);
    if (!parsedReference) {
      await interaction.reply({
        content: "Invalid repo format. Use `owner/name` or `https://github.com/owner/name`.",
        ephemeral: true
      });
      return;
    }

    this.db.upsertGuild(interaction.guild.id, interaction.guild.name);

    const existing = this.db.getRepoByFullName(interaction.guildId, parsedReference.fullName);
    if (existing) {
      await interaction.reply({
        content: `Repo \`${existing.full_name}\` is already connected to <#${existing.channel_id}>.`,
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const lookup = await lookupRepo(parsedReference);
      const checkout = await ensureRepoCheckedOutToMaster(this.config.reposRootPath, lookup);

      const channelName = buildRepoChannelName(
        lookup.owner,
        lookup.repo,
        new Set(interaction.guild.channels.cache.map((channel) => channel.name))
      );

      const createdChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        reason: `Repository connected by ${interaction.user.tag}: ${lookup.fullName}`
      });

      const inserted = this.db.createRepo({
        guildId: interaction.guildId,
        owner: lookup.owner,
        repo: lookup.repo,
        fullName: lookup.fullName,
        visibility: lookup.visibility,
        channelId: createdChannel.id,
        linkedByUserId: interaction.user.id
      });

      await interaction.editReply(
        [
          `Connected \`${inserted.full_name}\` to <#${inserted.channel_id}>.`,
          `Checked out \`master\` at \`${checkout.localPath}\`.`,
          "Use `/ask prompt:<text>` in that channel."
        ].join("\n")
      );
    } catch (error) {
      if (error instanceof GitHubRepoLookupError) {
        if (error.code === "NOT_FOUND") {
          await interaction.editReply("Repository not found. Check the owner/name and ensure the configured GitHub identity has access.");
          return;
        }

        if (error.code === "GH_UNAVAILABLE") {
          await interaction.editReply("GitHub CLI is unavailable in this container.");
          return;
        }

        await interaction.editReply(`GitHub lookup failed: ${error.message}`);
        return;
      }

      if (error instanceof GitWorkspaceError) {
        if (error.code === "MASTER_BRANCH_MISSING") {
          await interaction.editReply(
            "Repo connected to GitHub lookup, but neither `master` nor `main` was found on origin to source local `master`."
          );
          return;
        }

        await interaction.editReply(`Git checkout failed: ${error.message}`);
        return;
      }

      this.logger.error({ error }, "connect-repo failed");
      await interaction.editReply("Failed to connect repository due to an unexpected error.");
    }
  }

  private async handleRepos(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    const repos = this.db.listReposByGuild(interaction.guildId);
    if (repos.length === 0) {
      await interaction.reply({ content: "No connected repositories in this server yet.", ephemeral: true });
      return;
    }

    const lines = repos.map((repo) => `- \`${repo.full_name}\` -> <#${repo.channel_id}> (${repo.visibility.toLowerCase()})`);
    await interaction.reply({
      content: ["Connected repositories:", ...lines].join("\n"),
      ephemeral: true
    });
  }

  private async handleIssues(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    const resolvedChannelId =
      interaction.channel && interaction.channel.isThread() ? interaction.channel.parentId : interaction.channelId;

    if (!resolvedChannelId) {
      await interaction.reply({
        content: "Could not resolve a parent channel for this thread.",
        ephemeral: true
      });
      return;
    }

    const repo = this.db.getRepoByChannelId(interaction.guildId, resolvedChannelId);
    if (!repo) {
      await interaction.reply({
        content: "This channel (or its parent thread channel) is not mapped to a repository. Run `/connect-repo` first.",
        ephemeral: true
      });
      return;
    }

    if (!(await this.ensureGitHubCliAccess(interaction, ["/issues"]))) {
      return;
    }

    const mode = interaction.options.getString("mode") ?? "list";
    const issueNumber = interaction.options.getInteger("issue");

    if (mode === "detail" && (!issueNumber || issueNumber <= 0)) {
      await interaction.reply({
        content: "Detail mode requires a positive `issue` number.",
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      if (mode === "detail") {
        const detail = await viewIssueDetail(repo.full_name, issueNumber!);
        await this.sendDeferredInteractionChunks(interaction, splitPlainTextForDiscord(formatIssueDetail(detail), "Issue detail"));
        return;
      }

      const issues = await listOpenIssues(repo.full_name);
      if (mode === "summary") {
        const checkout = await ensureRepoCheckedOutToMaster(this.config.reposRootPath, {
          owner: repo.owner,
          repo: repo.repo,
          fullName: repo.full_name
        });
        const summaryText = await this.summarizeIssues({
          repoFullName: repo.full_name,
          issues,
          cwd: checkout.localPath,
          guildId: interaction.guildId
        });
        await this.sendDeferredInteractionChunks(interaction, splitPlainTextForDiscord(summaryText, "Issue summaries"));
        return;
      }

      await this.sendDeferredInteractionChunks(interaction, splitPlainTextForDiscord(formatIssueListReply(repo.full_name, issues)));
    } catch (error) {
      if (error instanceof GitHubIssueLookupError) {
        if (error.code === "NOT_FOUND") {
          await interaction.editReply("Issue not found. Check the issue number and repository mapping.");
          return;
        }

        if (error.code === "GH_UNAVAILABLE") {
          await interaction.editReply("GitHub CLI is unavailable in this container.");
          return;
        }

        await interaction.editReply(`GitHub issue lookup failed: ${error.message}`);
        return;
      }

      if (error instanceof GitWorkspaceError) {
        if (error.code === "MASTER_BRANCH_MISSING") {
          await interaction.editReply(
            "Connected repo found, but neither `master` nor `main` was found on origin to source local `master`."
          );
          return;
        }

        await interaction.editReply(`Git checkout failed: ${error.message}`);
        return;
      }

      this.logger.error({ error, command: "issues", repo: repo.full_name, mode }, "issues failed");
      const message = this.describeExecutionError(error);
      await interaction.editReply(`Failed to read issues: ${message}`);
    }
  }

  private async handleSyncRepo(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to sync a repository checkout.",
        ephemeral: true
      });
      return;
    }

    const repo = this.resolveRepoFromInteraction(interaction);

    if (!repo) {
      await interaction.reply({
        content:
          "No connected repo could be resolved. Provide `repo:<owner/name>` or run this in a mapped repo channel/thread.",
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const checkout = await ensureRepoCheckedOutToMaster(this.config.reposRootPath, {
        owner: repo.owner,
        repo: repo.repo,
        fullName: repo.full_name
      });

      await interaction.editReply(
        [`Synced \`${repo.full_name}\`.`, `Checked out \`master\` at \`${checkout.localPath}\`.`].join("\n")
      );
    } catch (error) {
      if (error instanceof GitWorkspaceError) {
        if (error.code === "MASTER_BRANCH_MISSING") {
          await interaction.editReply(
            "Connected repo found, but neither `master` nor `main` was found on origin to source local `master`."
          );
          return;
        }

        await interaction.editReply(`Git checkout failed: ${error.message}`);
        return;
      }

      this.logger.error({ error }, "sync-repo failed");
      await interaction.editReply("Failed to sync repository due to an unexpected error.");
    }
  }

  private async handleBranches(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    const repo = this.resolveRepoFromInteraction(interaction);
    if (!repo) {
      await interaction.reply({
        content:
          "No connected repo could be resolved. Provide `repo:<owner/name>` or run this in a mapped repo channel/thread.",
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const repoPath = ensureRepoCheckedOutToMaster(this.config.reposRootPath, {
        owner: repo.owner,
        repo: repo.repo,
        fullName: repo.full_name
      }).then((checkout) => checkout.localPath);
      const branches = await listBranches(await repoPath);

      await interaction.editReply(formatBranchesReply(repo.full_name, branches));
    } catch (error) {
      if (error instanceof GitWorkspaceError) {
        if (error.code === "MASTER_BRANCH_MISSING") {
          await interaction.editReply(
            "Connected repo found, but neither `master` nor `main` was found on origin to source local `master`."
          );
          return;
        }

        await interaction.editReply(`Git branch lookup failed: ${error.message}`);
        return;
      }

      this.logger.error({ error }, "branches failed");
      await interaction.editReply("Failed to list repository branches due to an unexpected error.");
    }
  }

  private async handleCleanup(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to run repository cleanup.",
        ephemeral: true
      });
      return;
    }

    const repo = this.resolveRepoFromInteraction(interaction);
    const repos = repo ? [repo] : this.db.listReposByGuild(interaction.guildId);

    if (repos.length === 0) {
      await interaction.reply({
        content:
          "No connected repo could be resolved. Provide `repo:<owner/name>`, run this in a mapped repo channel/thread, or connect repos first.",
        ephemeral: true
      });
      return;
    }

    const confirmId = `cleanup-confirm:${interaction.id}:${interaction.user.id}`;
    const cancelId = `cleanup-cancel:${interaction.id}:${interaction.user.id}`;
    const scopeDescription = repo ? `clean up \`${repo.full_name}\`` : `clean up all ${repos.length} connected repos in this server`;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel("Confirm").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(cancelId).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      content: `Confirm cleanup: ${scopeDescription}? This deletes local branches whose origin branches are gone.`,
      components: [row],
      ephemeral: true
    });

    try {
      const reply = await interaction.fetchReply();
      const confirmation = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: 30_000,
        filter: (buttonInteraction) =>
          buttonInteraction.user.id === interaction.user.id
          && (buttonInteraction.customId === confirmId || buttonInteraction.customId === cancelId)
      });

      if (confirmation.customId === cancelId) {
        await confirmation.update({ content: "Cleanup cancelled.", components: [] });
        return;
      }

      await confirmation.update({
        content: `Running cleanup for ${repo ? `\`${repo.full_name}\`` : "all connected repos"}...`,
        components: []
      });

      const results: Array<{
        fullName: string;
        deleted: string[];
        removedWorktrees: string[];
        skippedDirtyWorktrees: Array<{ branchName: string; path: string }>;
      }> = [];
      for (const repoEntry of repos) {
        const checkout = await ensureRepoCheckedOutToMaster(this.config.reposRootPath, {
          owner: repoEntry.owner,
          repo: repoEntry.repo,
          fullName: repoEntry.full_name
        });
        const cleanup = await cleanupDeletedRemoteBranches(checkout.localPath);
        results.push({
          fullName: repoEntry.full_name,
          deleted: cleanup.deleted,
          removedWorktrees: cleanup.removedWorktrees,
          skippedDirtyWorktrees: cleanup.skippedDirtyWorktrees
        });
      }

      await interaction.editReply({
        content: formatCleanupReply(results),
        components: []
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === DiscordjsErrorCodes.InteractionCollectorError) {
        await interaction.editReply({ content: "Cleanup timed out without confirmation.", components: [] });
        return;
      }

      if (error instanceof GitWorkspaceError) {
        if (error.code === "MASTER_BRANCH_MISSING") {
          await interaction.editReply({
            content: "Cleanup failed because a connected repo has neither `origin/master` nor `origin/main` available.",
            components: []
          });
          return;
        }

        await interaction.editReply({ content: `Cleanup failed: ${error.message}`, components: [] });
        return;
      }

      this.logger.error({ error }, "cleanup failed");
      await interaction.editReply({
        content: "Failed to clean repositories due to an unexpected error.",
        components: []
      });
    }
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (interaction.commandName !== "model-select") {
      return;
    }

    const focused = interaction.options.getFocused(true);
    if (focused.name !== "model") {
      return;
    }

    const provider = interaction.options.getString("provider");
    if (!provider || !(provider in AI_PROVIDER_LABELS)) {
      await interaction.respond([]);
      return;
    }

    const history = this.db.getModelHistory(provider as AiProvider);
    const typed = focused.value.toLowerCase();
    const filtered = typed
      ? history.filter((m) => m.toLowerCase().includes(typed))
      : history;

    await interaction.respond(
      filtered.map((model) => ({ name: model, value: model }))
    );
  }

  private async handleModelSelect(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to change the AI provider or model.",
        ephemeral: true
      });
      return;
    }

    const rawProvider = interaction.options.getString("provider", true);
    const rawModel = interaction.options.getString("model");
    const model = rawModel?.trim() || null;

    // Defense-in-depth: Discord already constrains the value via addChoices, but we
    // validate here in case of direct API calls that bypass the UI constraint.
    if (!Object.keys(AI_PROVIDER_LABELS).includes(rawProvider)) {
      await interaction.reply({
        content: `Invalid provider. Choose from: \`${Object.keys(AI_PROVIDER_LABELS).join("`, `")}\`.`,
        ephemeral: true
      });
      return;
    }

    const provider = rawProvider as AiProvider;

    if (provider === "codex" && !this.config.enableCodexExecution) {
      await interaction.reply({
        content: "Codex execution is not enabled on this instance (`ENABLE_CODEX_EXECUTION` is not set). Choose a different provider or ask the instance administrator to enable it.",
        ephemeral: true
      });
      return;
    }

    if (provider === "gemini" && !this.config.enableGeminiExecution) {
      await interaction.reply({
        content: "Gemini execution is not enabled on this instance (`ENABLE_GEMINI_EXECUTION` is not set). Choose a different provider or ask the instance administrator to enable it.",
        ephemeral: true
      });
      return;
    }

    this.db.upsertGuild(interaction.guild.id, interaction.guild.name);
    this.db.setGuildModelConfig(interaction.guildId, provider, model, interaction.user.id);

    if (model) {
      this.db.addModelToHistory(provider, model);
    }

    const modelDisplay = model ? `model \`${model}\`` : "CLI default model";
    await interaction.reply({
      content: `AI provider set to **${AI_PROVIDER_LABELS[provider]}** with ${modelDisplay}. All future \`/ask\`, \`/bug\`, and \`/issue\` requests will use this configuration.`,
      ephemeral: true
    });
  }

  private async handleModelCurrent(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    const config = this.db.getGuildModelConfig(interaction.guildId);
    if (!config) {
      await interaction.reply({
        content: "No AI provider configured. Defaulting to **Claude** (no model override). Use `/model-select` to configure.",
        ephemeral: true
      });
      return;
    }

    const ts = new Date(config.updated_at).getTime();
    const timeStr = Number.isNaN(ts) ? config.updated_at : `<t:${Math.floor(ts / 1000)}:R>`;
    const modelStr = config.model || "none (CLI default)";
    await interaction.reply({
      content: `Current AI provider: **${AI_PROVIDER_LABELS[config.provider]}**, model: \`${modelStr}\` (set ${timeStr}).`,
      ephemeral: true
    });
  }

  private async handleGeminiAuth(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to configure Gemini auth.",
        ephemeral: true
      });
      return;
    }

    if (!this.config.enableGeminiExecution) {
      await interaction.reply({
        content: "Gemini execution is not enabled on this instance. Set `ENABLE_GEMINI_EXECUTION=true` to enable it.",
        ephemeral: true
      });
      return;
    }

    if (this.pendingGeminiAuth.has(interaction.guildId)) {
      await interaction.reply({
        content: "A Gemini auth flow is already in progress. Use `/gemini-auth-complete` or wait 5 minutes for it to expire.",
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;

    try {
      const url = await new Promise<string>((resolve, reject) => {
        const child = spawn("gemini", [], {
          stdio: ["pipe", "pipe", "pipe"]
        });

        let output = "";
        const urlRegex = /https:\/\/accounts\.google\.com\/[^\s\r\n\x1b]*/;

        const onData = (chunk: Buffer) => {
          const text = chunk.toString();
          this.logger.debug({ text, source: "gemini-auth" }, "Gemini auth output chunk");
          output += text;
          const match = urlRegex.exec(output);
          if (match && !this.pendingGeminiAuth.has(guildId)) {
            const timeoutHandle = setTimeout(() => {
              const pending = this.pendingGeminiAuth.get(guildId);
              if (pending) {
                pending.child.kill();
                this.pendingGeminiAuth.delete(guildId);
                this.logger.info({ guildId }, "Gemini auth flow timed out");
              }
            }, 5 * 60 * 1000);

            this.pendingGeminiAuth.set(guildId, { child, timeoutHandle });
            resolve(match[0]);
          }
        };

        child.stdout!.on("data", onData);
        child.stderr!.on("data", onData);

        child.on("error", reject);

        child.on("close", (code) => {
          if (!this.pendingGeminiAuth.has(guildId)) {
            reject(new Error(`gemini auth login exited with code ${String(code)} before URL was found`));
          }
        });

        setTimeout(() => {
          if (!this.pendingGeminiAuth.has(guildId)) {
            child.kill();
            reject(new Error("Timed out waiting for Gemini auth URL"));
          }
        }, 30_000);
      });

      await interaction.editReply(
        `Visit this URL to authorize Gemini:\n\n${url}\n\nThen run \`/gemini-auth-complete code:<paste code here>\`.`
      );
    } catch (error) {
      this.logger.error({ error, guildId }, "gemini-auth failed");
      await interaction.editReply(`Failed to start Gemini auth: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  private async handleGeminiAuthComplete(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to configure Gemini auth.",
        ephemeral: true
      });
      return;
    }

    const pending = this.pendingGeminiAuth.get(interaction.guildId);
    if (!pending) {
      await interaction.reply({
        content: "No pending Gemini auth flow. Run `/gemini-auth` first.",
        ephemeral: true
      });
      return;
    }

    const code = interaction.options.getString("code", true).trim();
    await interaction.deferReply({ ephemeral: true });

    const { child, timeoutHandle } = pending;
    this.pendingGeminiAuth.delete(interaction.guildId);
    clearTimeout(timeoutHandle);

    this.logger.info({
      guildId: interaction.guildId,
      exitCode: child.exitCode,
      killed: child.killed,
      pid: child.pid
    }, "gemini-auth-complete: child process state");

    if (child.exitCode !== null || child.killed) {
      await interaction.editReply("The Gemini auth session expired. Run `/gemini-auth` to start again.");
      return;
    }

    try {
      const success = await new Promise<boolean>((resolve, reject) => {
        let output = "";
        const checkSuccess = (text: string) => {
          output += text;
          if (/loaded cached credentials|credentials saved|authenticated/i.test(output)) {
            child.kill();
            resolve(true);
          }
        };

        child.stdout!.on("data", (chunk: Buffer) => checkSuccess(chunk.toString()));
        child.stderr!.on("data", (chunk: Buffer) => checkSuccess(chunk.toString()));
        child.on("close", () => {
          resolve(/loaded cached credentials|credentials saved|authenticated/i.test(output));
        });
        child.on("error", reject);
        child.stdin!.on("error", reject);
        child.stdin!.write(code + "\n");
        child.stdin!.end();
        setTimeout(() => {
          child.kill();
          reject(new Error("Timed out waiting for Gemini auth to complete"));
        }, 30_000);
      });

      if (success) {
        await interaction.editReply("Gemini auth complete. `/ask` requests will now use your Google account.");
      } else {
        await interaction.editReply("Gemini auth may have failed — no confirmation received. Try `/gemini-auth` again or run an `/ask` to test.");
      }
    } catch (error) {
      child.kill();
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error, guildId: interaction.guildId }, "gemini-auth-complete failed");
      await interaction.editReply(`Auth failed: ${message}`);
    }
  }

  private async handleCodexAuth(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to configure Codex auth.",
        ephemeral: true
      });
      return;
    }

    if (!this.config.enableCodexExecution) {
      await interaction.reply({
        content: "Codex execution is not enabled on this instance. Set `ENABLE_CODEX_EXECUTION=true` to enable it.",
        ephemeral: true
      });
      return;
    }

    const attachment = interaction.options.getAttachment("credentials", true);

    if (!attachment.name.endsWith(".json")) {
      await interaction.reply({ content: "Credentials file must be a `.json` file.", ephemeral: true });
      return;
    }

    if (attachment.size > 10_000) {
      await interaction.reply({ content: "Credentials file is too large. Expected a small JSON file.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        await interaction.editReply("Failed to download the attached file from Discord.");
        return;
      }

      const content = await response.text();

      // Basic validation that it's JSON
      JSON.parse(content);

      const credPath = join(homedir(), ".codex", "auth.json");
      mkdirSync(dirname(credPath), { recursive: true });
      writeFileSync(credPath, content, { mode: 0o600 });

      this.logger.info({ guildId: interaction.guildId, credPath }, "Codex credentials written");
      await interaction.editReply("Codex credentials saved. `/ask` requests with the Codex provider should now work.");
    } catch (error) {
      this.logger.error({ error, guildId: interaction.guildId }, "codex-auth failed");
      await interaction.editReply(`Failed to save Codex credentials: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  private async handleDelete(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.channel?.isThread()) {
      await interaction.reply({ content: "Run `/delete` from within the request thread you want to clean up.", ephemeral: true });
      return;
    }

    const request = this.db.getRequestByThreadId(interaction.channelId);
    if (!request) {
      await interaction.reply({ content: "No request record was found for this thread.", ephemeral: true });
      return;
    }

    const isOwner = request.user_id === interaction.user.id;
    const canManageGuild = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
    if (!isOwner && !canManageGuild) {
      await interaction.reply({
        content: "Only the original requester or a user with `Manage Server` can delete this branch.",
        ephemeral: true
      });
      return;
    }

    if (request.status === "queued" || request.status === "running") {
      await interaction.reply({ content: "This request is still running. Wait for it to finish before deleting the branch.", ephemeral: true });
      return;
    }

    if (!request.branch_name) {
      await interaction.reply({
        content: "No tracked worktree branch is stored for this thread. It may already be deleted or was created detached.",
        ephemeral: true
      });
      return;
    }

    const repo = this.db.getRepoByChannelId(interaction.guildId, request.channel_id);
    if (!repo) {
      await interaction.reply({ content: "The repository linked to this thread could not be resolved.", ephemeral: true });
      return;
    }

    const confirmId = `delete-confirm:${request.id}:${interaction.user.id}`;
    const cancelId = `delete-cancel:${request.id}:${interaction.user.id}`;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel("Confirm").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(cancelId).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      content: `Delete branch \`${request.branch_name}\` for this thread? This removes the worktree and cannot be undone.`,
      components: [row],
      ephemeral: true
    });

    try {
      const reply = await interaction.fetchReply();
      const confirmation = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: 30_000,
        filter: (buttonInteraction) =>
          buttonInteraction.user.id === interaction.user.id
          && (buttonInteraction.customId === confirmId || buttonInteraction.customId === cancelId)
      });

      if (confirmation.customId === cancelId) {
        await confirmation.update({ content: "Branch deletion cancelled.", components: [] });
        return;
      }

      await confirmation.update({ content: `Deleting branch \`${request.branch_name}\`...`, components: [] });

      await deleteRequestBranch(
        this.config.reposRootPath,
        {
          owner: repo.owner,
          repo: repo.repo,
          fullName: repo.full_name
        },
        {
          branchName: request.branch_name,
          worktreePath: request.worktree_path
        }
      );

      this.db.updateRequestWorkspace(request.id, null, null);

      await interaction.editReply({
        content: `Deleted branch \`${request.branch_name}\` and cleared the tracked worktree for this thread.`,
        components: []
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === DiscordjsErrorCodes.InteractionCollectorError) {
        await interaction.editReply({ content: "Branch deletion timed out without confirmation.", components: [] });
        return;
      }

      this.logger.error({ error, requestId: request.id }, "delete branch failed");
      await interaction.editReply({
        content: `Failed to delete branch \`${request.branch_name}\`: ${this.describeExecutionError(error)}`,
        components: []
      });
    }
  }

  private async handleAsk(interaction: ChatInputCommandInteraction): Promise<void> {
    await this.handleRepoCommand(interaction, { label: "request" });
  }

  private async handleRepoCommand(
    interaction: ChatInputCommandInteraction,
    options: {
      label: string;
      promptTransformer?: (prompt: string) => string;
      rawOutput?: boolean;
      detachWorktree?: boolean;
    }
  ): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    const prompt = interaction.options.getString("prompt", true).trim();

    if (!prompt) {
      await interaction.reply({ content: "Prompt cannot be empty.", ephemeral: true });
      return;
    }

    const resolvedChannelId =
      interaction.channel && interaction.channel.isThread() ? interaction.channel.parentId : interaction.channelId;

    if (!resolvedChannelId) {
      await interaction.reply({
        content: "Could not resolve a parent channel for this thread.",
        ephemeral: true
      });
      return;
    }

    const repo = this.db.getRepoByChannelId(interaction.guildId, resolvedChannelId);
    if (!repo) {
      await interaction.reply({
        content: "This channel (or its parent thread channel) is not mapped to a repository. Run `/connect-repo` first.",
        ephemeral: true
      });
      return;
    }

    const modelConfig = this.db.getGuildModelConfig(interaction.guildId);
    const provider: AiProvider = modelConfig?.provider ?? "claude";
    const model = modelConfig?.model;

    const channel = (await interaction.guild.channels.fetch(repo.channel_id)) as GuildTextBasedChannel | null;
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: "Mapped repo channel is unavailable or not a text channel.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const seedMessage = await channel.send({
      content: `New ${options.label} from <@${interaction.user.id}> for \`${repo.full_name}\``
    });

    const thread = await seedMessage.startThread({
      name: buildThreadName(prompt),
      autoArchiveDuration: this.config.threadAutoArchiveMinutes,
      reason: `${options.label} thread for ${repo.full_name} by ${interaction.user.tag}`
    });

    await thread.send(
      [
        `Request by <@${interaction.user.id}>`,
        "",
        `**Prompt**`,
        prompt
      ].join("\n")
    );

    const request = this.db.createRequest({
      guildId: interaction.guildId,
      repoId: repo.id,
      channelId: repo.channel_id,
      threadId: thread.id,
      userId: interaction.user.id,
      prompt,
      status: "queued"
    });

    this.requestQueue.enqueue(interaction.guildId, async () => {
      await this.runQueuedRequest({
        requestId: request.id,
        threadId: thread.id,
        repo: {
          owner: repo.owner,
          repo: repo.repo,
          fullName: repo.full_name
        },
        prompt,
        provider,
        ...(model ? { model } : {}),
        ...(options.promptTransformer ? { promptTransformer: options.promptTransformer } : {}),
        ...(options.rawOutput ? { rawOutput: true } : {}),
        ...(options.detachWorktree ? { detachWorktree: true } : {})
      });
    });

    await interaction.editReply(
      `Created ${options.label} thread <#${thread.id}>. Request queued for ${AI_PROVIDER_LABELS[provider]} execution.`
    );
  }

  private async handleIssueCreate(interaction: ChatInputCommandInteraction, type: "bug" | "issue"): Promise<void> {
    if (!(await this.ensureGitHubCliAccess(interaction, ["/bug", "/issue"]))) {
      return;
    }

    const defaultLabel = type === "bug" ? "bug" : "enhancement";
    const promptTransformer = (prompt: string): string =>
      `Analyze the codebase against the master branch to produce a structured GitHub issue report for the following request.
Request: ${prompt}

Create the issue directly using the GitHub CLI (\`gh issue create\`).
Make sure to include a clear title, a markdown formatted description (with reproduction steps if it's a bug), and the label "${defaultLabel}".
If it is a bug, also ensure the "bug" label is applied.
If the label does not exist on the repository, omit the --label flag rather than failing.
Output the result of the command or the link to the created issue.`;

    await this.handleRepoCommand(interaction, {
      label: type,
      promptTransformer,
      rawOutput: true,
      detachWorktree: true
    });
  }

  private async ensureGitHubCliAccess(interaction: ChatInputCommandInteraction, commands: string[]): Promise<boolean> {
    try {
      const { spawnCollect } = await import("../utils/spawnCollect.js");
      await spawnCollect("gh", ["auth", "token"], {
        cwd: process.cwd(),
        env: getGitHubCommandEnvironment(),
        timeoutMs: 10_000,
        maxBuffer: 4 * 1024
      });
      return true;
    } catch {
      await interaction.reply({
        content:
          `GitHub CLI is not authenticated. Configure GitHub App credentials or \`GH_TOKEN\`, or run \`gh auth login\` on the host before using ${commands.join(" or ")}.`,
        ephemeral: true
      });
      return false;
    }
  }

  private async sendDeferredInteractionChunks(interaction: ChatInputCommandInteraction, chunks: string[]): Promise<void> {
    const [firstChunk, ...remainingChunks] = chunks;
    await interaction.editReply(firstChunk ?? "(no content)");
    for (const chunk of remainingChunks) {
      await interaction.followUp({ content: chunk, ephemeral: true });
    }
  }

  private async summarizeIssues(input: {
    repoFullName: string;
    issues: GitHubIssueSummary[];
    cwd: string;
    guildId: string;
  }): Promise<string> {
    const modelConfig = this.db.getGuildModelConfig(input.guildId);
    const provider: AiProvider = modelConfig?.provider ?? "claude";
    const model = modelConfig?.model;
    const issuePayload = input.issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      labels: issue.labels,
      author: issue.authorLogin,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      body: issue.body
    }));
    const prompt =
      `Summarize the open GitHub issues for ${input.repoFullName}.\n`
      + "Return plain text only.\n"
      + "Format each issue as a single bullet in the form `- #<number> <title>: <short summary>`.\n"
      + "Keep each summary to one sentence and keep the total response concise.\n\n"
      + JSON.stringify(issuePayload, null, 2);

    const result = await this.runProviderText({
      provider,
      cwd: input.cwd,
      prompt,
      ...(model ? { model } : {})
    });

    return result;
  }

  private async runProviderText(input: {
    provider: AiProvider;
    prompt: string;
    cwd: string;
    model?: string;
  }): Promise<string> {
    const request = {
      prompt: input.prompt,
      cwd: input.cwd,
      timeoutMs: this.config.askExecutionTimeoutMs,
      ...(input.model ? { model: input.model } : {})
    };

    switch (input.provider) {
      case "codex": {
        if (!this.config.enableCodexExecution) {
          throw new CodexExecutionError(
            "CODEX_DISABLED",
            "The server's configured AI provider (Codex) is currently disabled. An admin can switch providers with `/model-select`."
          );
        }

        const result = await runCodexRequest(request, this.logger);
        return result.text;
      }
      case "gemini": {
        if (!this.config.enableGeminiExecution) {
          throw new GeminiExecutionError(
            "GEMINI_DISABLED",
            "The server's configured AI provider (Gemini) is currently disabled. An admin can switch providers with `/model-select`."
          );
        }

        const result = await runGeminiRequest(request, this.logger);
        return result.text;
      }
      case "claude":
      default: {
        const result = await runClaudeRequest(request, this.logger);
        return result.text;
      }
    }
  }

  private async runQueuedRequest(input: {
    requestId: number;
    threadId: string;
    repo: {
      owner: string;
      repo: string;
      fullName: string;
    };
    prompt: string;
    provider: AiProvider;
    model?: string;
    existingWorktreePath?: string;
    existingBranchName?: string;
    promptTransformer?: (prompt: string) => string;
    rawOutput?: boolean;
    detachWorktree?: boolean;
  }): Promise<void> {
    const startedAt = Date.now();
    const providerLabel = AI_PROVIDER_LABELS[input.provider];
    let worktreePath: string | null = null;
    let branchName: string | null = input.existingBranchName ?? null;
    let statusFinalized = false;
    let stage = "init";
    let threadChannel: Awaited<ReturnType<Client["channels"]["fetch"]>> | null = null;

    const markFailed = (): void => {
      if (statusFinalized) {
        return;
      }
      this.db.updateRequestStatus(input.requestId, "failed");
      statusFinalized = true;
    };

    try {
      this.db.updateRequestStatus(input.requestId, "running");
      this.logger.info(
        { requestId: input.requestId, threadId: input.threadId, repo: input.repo.fullName, provider: input.provider, model: input.model },
        "Queued request started"
      );

      stage = "fetch-thread";
      const channel = await this.client.channels.fetch(input.threadId);
      if (!channel || !channel.isThread()) {
        markFailed();
        this.logger.error({ requestId: input.requestId, threadId: input.threadId }, "Request thread no longer available");
        return;
      }

      threadChannel = channel;
      await threadChannel.send(`${providerLabel} execution started.`);

      if (input.existingWorktreePath) {
        worktreePath = input.existingWorktreePath;
        this.logger.info({ requestId: input.requestId, worktreePath, branchName }, "Reusing existing worktree for follow-up");
      } else {
        stage = "sync-repo";
        this.logger.info({ requestId: input.requestId, repo: input.repo.fullName }, "Syncing repository before AI execution");
        const checkout = await ensureRepoCheckedOutToMaster(this.config.reposRootPath, {
          owner: input.repo.owner,
          repo: input.repo.repo,
          fullName: input.repo.fullName
        });
        this.logger.info({ requestId: input.requestId, repo: input.repo.fullName }, "Repository sync complete");

        stage = "create-worktree";
        this.logger.info({ requestId: input.requestId, repo: input.repo.fullName }, "Creating request worktree");
        const worktree = await createRequestWorktree(
          this.config.reposRootPath,
          {
            owner: input.repo.owner,
            repo: input.repo.repo,
            fullName: input.repo.fullName
          },
          input.requestId,
          input.detachWorktree ? { detached: true } : undefined
        );
        worktreePath = worktree.path;
        branchName = worktree.branchName;
        this.logger.info(
          { requestId: input.requestId, branchName: worktree.branchName, worktreePath: worktree.path },
          "Request worktree created"
        );
      }

      this.db.updateRequestWorkspace(input.requestId, worktreePath, branchName);

      stage = "run-ai";
      let effectivePrompt = input.existingWorktreePath
        ? await this.buildThreadPromptWithHistory(channel, input.prompt)
        : input.prompt;
      if (input.promptTransformer && !input.existingWorktreePath) {
        effectivePrompt = input.promptTransformer(effectivePrompt);
      }
      this.logger.info(
        {
          requestId: input.requestId,
          worktreePath,
          timeoutMs: this.config.askExecutionTimeoutMs,
          promptLength: effectivePrompt.length,
          provider: input.provider,
          model: input.model
        },
        "Starting AI execution"
      );

      const resultText = await this.runProviderText({
        provider: input.provider,
        prompt: effectivePrompt,
        cwd: worktreePath,
        ...(input.model ? { model: input.model } : {})
      });

      this.logger.info(
        { requestId: input.requestId, outputLength: resultText.length, durationMs: Date.now() - startedAt, provider: input.provider },
        "AI execution finished"
      );

      if (input.rawOutput) {
        const header = `**${providerLabel} execution completed**`;
        const body = clipForDiscord(resultText, DISCORD_MESSAGE_LIMIT - header.length - 4);
        await channel.send(`${header}\n\n${body}`);
      } else {
        for (const chunk of splitIntoDiscordMessages(resultText, providerLabel)) {
          await channel.send(chunk);
        }
      }
      this.db.updateRequestStatus(input.requestId, "succeeded");
      statusFinalized = true;
      this.logger.info(
        { requestId: input.requestId, durationMs: Date.now() - startedAt, provider: input.provider },
        "Queued AI request succeeded"
      );
    } catch (error) {
      markFailed();
      const message = this.describeExecutionError(error);
      if (threadChannel && threadChannel.isThread()) {
        await threadChannel.send(`**${providerLabel} execution failed**\n\n${clipForDiscord(message, DISCORD_MESSAGE_LIMIT - 40)}`);
      }
      this.logger.error(
        { error, requestId: input.requestId, durationMs: Date.now() - startedAt, stage, provider: input.provider },
        "Queued AI request failed"
      );
    }
  }

  private describeExecutionError(error: unknown): string {
    if (error instanceof ClaudeExecutionError) {
      return error.message;
    }

    if (error instanceof CodexExecutionError) {
      return error.message;
    }

    if (error instanceof GeminiExecutionError) {
      return error.message;
    }

    if (error instanceof RequestWorktreeError) {
      return `Worktree operation failed: ${error.message}`;
    }

    if (error instanceof GitWorkspaceError) {
      return `Repository sync failed: ${error.message}`;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Unknown execution error.";
  }

  private async buildThreadPromptWithHistory(channel: AnyThreadChannel, newMessageContent: string): Promise<string> {
    const fetched = await channel.messages.fetch({ limit: 50 });
    const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const history: Array<{ role: "user" | "assistant"; text: string }> = [];
    for (const msg of sorted) {
      const isBot = msg.author.id === this.client.user?.id;
      const entry = parseThreadEntry(msg.content, isBot);
      if (!entry) continue;
      const prev = history[history.length - 1];
      if (prev && prev.role === "assistant" && entry.role === "assistant") {
        prev.text += "\n" + entry.text;
      } else {
        history.push(entry);
      }
    }

    if (history.length === 0) {
      return newMessageContent;
    }

    const lines = [
      "This is an ongoing code assistance session. The conversation history is below.",
      "Respond to the final [User] message.",
      ""
    ];
    for (const entry of history) {
      lines.push(`[${entry.role === "user" ? "User" : "Assistant"}]: ${entry.text}`);
      lines.push("");
    }
    return lines.join("\n").trim();
  }

  public getCommandNames(): string[] {
    return commandBuilders.map((command) => command.name);
  }
}
