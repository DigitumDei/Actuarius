import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
import type { AiProvider, ReviewModelRole, RepoRow, RequestStatus } from "../db/types.js";
import { commandBuilders } from "./commands.js";
import { buildHelpText } from "./messageTemplates.js";
import { buildRepoChannelName, buildThreadName } from "./naming.js";
import { ensureGitHubCliAuthenticated, forceRefreshGitHubAuth, getGitHubCommandEnvironment } from "../services/githubAuthService.js";
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
  autoCommitAll,
  autoCommitDirtyWorktree,
  cleanupDeletedRemoteBranches,
  detectDefaultBranch,
  ensureRepoCheckedOutToMaster,
  getCommitsSinceBaseRef,
  getDefaultBranchBaseRef,
  getDiffSinceRef,
  getHeadSha,
  getReviewDiff,
  getShortStatus,
  getStagedDiffSummary,
  getUnstagedDiffSummary,
  hasUncommittedChanges,
  hasUncommittedChangesExcluding,
  listBranches,
  pushBranch
} from "../services/gitWorkspaceService.js";
import {
  AdversarialReviewError,
  runAdversarialReview,
  type ReviewModelRunner,
  type ReviewProgressEvent
} from "../services/adversarialReviewService.js";
import { ClaudeExecutionError, runClaudeRequest } from "../services/claudeExecutionService.js";
import { CodexExecutionError, runCodexRequest } from "../services/codexExecutionService.js";
import { GeminiExecutionError, runGeminiRequest } from "../services/geminiExecutionService.js";
import {
  authenticateOpenAIOpencode,
  OpencodeExecutionError,
  parseOpencodeJsonEvents,
  runOpencodeAgentRequest,
  runOpencodeRequest,
  hasOpencodeAuth,
  OPENCODE_AUTH_PATH,
  ALLOWED_OPENCODE_PROVIDERS,
  type CompletedOpencodeTask
} from "../services/opencodeExecutionService.js";
import {
  createOpencodePlanAgentSnapshot,
  OPENCODE_IMPLEMENT_OC_AGENT,
  OPENCODE_PLAN_OC_AGENT,
  OpencodePlanAgentConfigError,
  setOpencodePlanAgentModel,
  type OpencodePlanOcRole
} from "../services/opencodePlanAgentService.js";
import { RequestExecutionQueue } from "../services/requestExecutionQueue.js";
import { InstallService, InstallServiceError } from "../services/installService.js";
import { buildAptPackageId, getAptPackageSpec, isAptPackageId } from "../services/installerRegistry.js";
import { createRequestWorktree, deleteRequestBranch, RequestWorktreeError } from "../services/requestWorktreeService.js";
import { BOT_MEMORY_WING, MemPalaceClient } from "../services/memPalaceClient.js";
import { MemPalaceRemoteService, type RepoMemoryIdentity } from "../services/memPalaceRemoteService.js";
import { createDraftPullRequest, PullRequestServiceError } from "../services/pullRequestService.js";
import {
  AttachmentError,
  buildAttachmentSummary,
  processAttachments,
  validateAttachments,
  type PendingAttachment
} from "../services/attachmentService.js";
import {
  runIterativeTaskLoop,
  type IterativePlanTask,
  type IterativeTaskOutput
} from "../services/iterativeTaskLoopService.js";
import {
  buildIssueCreationPrompt,
  buildIssueSummaryPrompt,
  buildOpencodePlanWorkflowPrompt,
  buildPlanImplementationPrompt,
  buildPlanPrompt,
  buildRepositoryMemoryScopedPrompt,
  buildRepositoryScopedPrompt,
  buildRevisionPlanPrompt,
  buildThreadFollowUpPrompt
} from "../services/llmPromptBuilders.js";
import type { ProviderExecutionDiagnostics, ProviderTimeoutKind } from "../utils/runProviderRequest.js";

const DISCORD_MESSAGE_LIMIT = 2_000;
const PR_TITLE_LIMIT = 120;

const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode"
};

interface ResolvedModelRole {
  provider: AiProvider;
  model?: string;
  fallbackReason?: string;
}

const PROVIDER_NPM_PACKAGES: Record<string, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  gemini: "@google/gemini-cli",
  opencode: "opencode-ai"
};

const KNOWN_MODELS_BY_PROVIDER: Partial<Record<AiProvider, string[]>> = {
  claude: ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"],
  codex: ["o4-mini", "o4", "gpt-5.2"],
  gemini: ["gemini-2.5-pro", "gemini-2.0-flash"],
  opencode: [
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-chat",
    "deepseek/deepseek-reasoner",
    "openai/o4-mini",
    "openai/o4",
    "openai/gpt-5.2",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-opus-4-6",
    "google/gemini-2.5-pro",
    "google/gemini-2.0-flash"
  ]
};

function isActiveRequestStatus(status: RequestStatus): boolean {
  return status === "queued" || status === "running" || status === "install_approved" || status === "install_running";
}

export function escapeDiscordFence(input: string): string {
  return input.replace(/`{3,}/gu, (match) => {
    if (match.length === 3) return "`\u200B``";
    let result = "";
    for (let i = 0; i < match.length; i++) {
      result += "`";
      if (i < match.length - 1) {
        result += "\u200B";
      }
    }
    return result;
  });
}

function clipForDiscord(input: string, maxLength: number): string {
  const text = input.trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 15).trimEnd()}\n...(truncated)`;
}

export function clipTailForDiscord(input: string, maxLength: number): string {
  const text = input.trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `...(truncated)\n${text.slice(text.length - maxLength + 15).trimStart()}`;
}

function clipForPullRequestTitle(input: string): string {
  return input.replace(/\s+/gu, " ").trim().slice(0, PR_TITLE_LIMIT);
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

const MAX_TASKS = 20;
const ITERATIVE_TASK_TITLE_LIMIT = 120;
const ITERATIVE_TASK_DESCRIPTION_LIMIT = 8_000;
const ITERATIVE_OVERVIEW_LIMIT = 2_000;

export function stripMarkdownJsonFence(text: string): string {
  const trimmed = text.trim();
  const lines = trimmed.split(/\r?\n/u);
  const openingFenceIndex = lines.findIndex((line) => /^[\t ]*```(?:json)?[\t ]*$/iu.test(line));
  if (openingFenceIndex < 0) {
    return trimmed;
  }

  const closingFenceOffset = lines
    .slice(openingFenceIndex + 1)
    .findIndex((line) => /^[\t ]*```[\t ]*$/u.test(line));
  if (closingFenceOffset < 0) {
    return trimmed;
  }

  const closingFenceIndex = openingFenceIndex + closingFenceOffset + 1;
  return lines.slice(openingFenceIndex + 1, closingFenceIndex).join("\n").trim();
}

function truncateText(text: string, limit: number): string {
  const normalized = text.trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3).trimEnd()}...`;
}

function normalizeIterativePlan(parsed: unknown): { overview: string; tasks: IterativePlanTask[] } | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const candidate = parsed as { overview?: unknown; tasks?: unknown };
  if (typeof candidate.overview !== "string" || candidate.overview.trim().length === 0 || !Array.isArray(candidate.tasks) || candidate.tasks.length === 0) {
    return null;
  }
  const tasks = candidate.tasks.flatMap((task) => {
    if (!task || typeof task.title !== "string" || typeof task.description !== "string") {
      return [];
    }
    const title = truncateText(task.title.replace(/\s+/g, " "), ITERATIVE_TASK_TITLE_LIMIT);
    const description = truncateText(task.description, ITERATIVE_TASK_DESCRIPTION_LIMIT);
    if (!title || !description) {
      return [];
    }
    return [{ title, description }];
  });
  if (tasks.length === 0) return null;
  return { overview: truncateText(candidate.overview, ITERATIVE_OVERVIEW_LIMIT), tasks };
}

function parseIterativePlanCandidate(text: string): { overview: string; tasks: IterativePlanTask[] } | null {
  try {
    return normalizeIterativePlan(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function extractBalancedJsonObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index++) {
    const character = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
    } else if (character === "{") {
      depth++;
    } else if (character === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
      if (depth < 0) {
        return null;
      }
    }
  }

  return null;
}

export function parseIterativePlan(text: string): { overview: string; tasks: IterativePlanTask[] } | null {
  const trimmed = text.trim();
  const stripped = stripMarkdownJsonFence(trimmed);
  const directCandidates = stripped === trimmed ? [trimmed] : [trimmed, stripped];

  for (const candidate of directCandidates) {
    const parsed = parseIterativePlanCandidate(candidate);
    if (parsed) {
      return parsed;
    }
  }

  for (let startIndex = trimmed.indexOf("{"); startIndex >= 0; startIndex = trimmed.indexOf("{", startIndex + 1)) {
    const candidate = extractBalancedJsonObject(trimmed, startIndex);
    if (!candidate) {
      continue;
    }
    const parsed = parseIterativePlanCandidate(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

export function splitPlainTextForDiscord(text: string, header?: string): string[] {
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

      const prefix = remaining.slice(0, splitAt);
      let fenceCount = 0;
      let idx = 0;
      while (true) {
        const pos = prefix.indexOf("```", idx);
        if (pos === -1) break;
        fenceCount++;
        idx = pos + 3;
      }
      if (fenceCount % 2 === 1) {
        const fenceStart = prefix.lastIndexOf("```");
        const sectionStart = prefix.lastIndexOf("\n", fenceStart - 2);
        if (sectionStart > 0) {
          splitAt = sectionStart;
        } else if (fenceStart > 0) {
          splitAt = fenceStart;
        } else {
          // Fence opens at offset 0 and can't be closed in this chunk:
          // hard-split at maxLength, close the fence, and reopen in the next chunk.
          // Reserve 4 chars for the appended "\n```" closing fence so chunks never exceed DISCORD_MESSAGE_LIMIT.
          splitAt = maxLength - 4;
          const chunkBody = remaining.slice(0, splitAt) + "\n```";
          remaining = "```\n" + remaining.slice(splitAt).trimStart();
          if (isFirst && normalizedHeader) {
            chunks.push(`${normalizedHeader}\n\n${chunkBody}`);
          } else {
            chunks.push(chunkBody);
          }
          isFirst = false;
          continue;
        }
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
  isBot: boolean,
  attachments: PendingAttachment[] = []
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
  const text = formatUserThreadEntry(content, attachments);
  return text ? { role: "user", text } : null;
}

function pendingAttachmentsFromMessage(message: { attachments?: Pick<Message["attachments"], "size" | "values"> }): PendingAttachment[] {
  if (!message.attachments || message.attachments.size === 0) return [];

  return [...message.attachments.values()].map((attachment) => ({
    id: attachment.id,
    name: attachment.name ?? `attachment-${attachment.id}`,
    url: attachment.url,
    size: attachment.size,
    contentType: attachment.contentType,
  }));
}

function formatUserThreadEntry(content: string, attachments: PendingAttachment[]): string {
  const text = content.trim() || (attachments.length > 0 ? "Please inspect the attached file(s)." : "");
  if (!text) return "";
  if (attachments.length === 0) return text;
  return `${text}\n\n**Attachments**\n${buildAttachmentSummary(attachments)}`;
}

export class ActuariusBot {
  private readonly client: Client;
  private readonly config: AppConfig;
  private readonly logger: pino.Logger;
  private readonly db: AppDatabase;
  private readonly requestQueue: RequestExecutionQueue;
  private readonly installService: InstallService;
  private readonly memPalace: MemPalaceClient | null;
  private readonly memPalaceRemote: MemPalaceRemoteService | null;
  private opencodeOpenAIAuthInProgress = false;

  public constructor(
    config: AppConfig,
    logger: pino.Logger,
    db: AppDatabase,
    memPalace: MemPalaceClient | null = null,
    memPalaceRemote: MemPalaceRemoteService | null = null
  ) {
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
    this.installService = new InstallService(config, logger, db);
    this.memPalace = memPalace;
    this.memPalaceRemote = memPalaceRemote;
    this.client = new Client({
      // MessageContent is a privileged intent — must be enabled in the Discord Developer Portal
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
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

      if (this.memPalace) {
        this.memPalace.wakeUp(BOT_MEMORY_WING).then((ctx) => {
          this.logger.info({ contextLength: ctx.length }, "MemPalace wake-up complete");
        }).catch((err: unknown) => {
          this.logger.warn({ error: err }, "MemPalace wake-up failed");
        });
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

    if (this.requestQueue.hasResourceWork(message.guildId, message.channelId)) {
      await message.reply("Another operation in this thread is already queued or running. Wait for it to finish before sending a follow-up.");
      return;
    }

    const currentRequest = this.db.getRequestByThreadId(message.channelId);
    if (currentRequest && isActiveRequestStatus(currentRequest.status)) {
      await message.reply("Another request in this thread is already queued or running. Wait for it to finish before sending a follow-up.");
      return;
    }

    const latestRequest = this.db.getLatestRequestWithWorkspaceByThreadId(message.channelId);
    const existingWorktreePath = latestRequest?.worktree_path;
    if (!existingWorktreePath) {
      const latestThreadRequest = this.db.getRequestByThreadId(message.channelId);
      if (latestThreadRequest?.status === "failed" && !latestThreadRequest.worktree_path) {
        await message.reply("This request failed and no tracked worktree is available to continue. Start a new `/plan` request from the connected repo channel.");
      }
      return;
    }

    if (!existsSync(existingWorktreePath)) {
      await message.reply("The worktree for this thread no longer exists (the bot may have been restarted or migrated). Use `/ask` to start a new request.");
      return;
    }

    const repo = this.db.getRepoByChannelId(message.guildId, parentId);
    if (!repo) return;

    const prompt = message.content.trim();
    const discordAttachments = message.attachments.size > 0 ? [...message.attachments.values()] : [];

    if (!prompt && discordAttachments.length === 0) return;

    const pendingAttachments: PendingAttachment[] = discordAttachments.map((a) => ({
      id: a.id,
      name: a.name ?? `attachment-${a.id}`,
      url: a.url,
      size: a.size,
      contentType: a.contentType,
    }));

    if (pendingAttachments.length > 0) {
      const error = validateAttachments(pendingAttachments, {
        maxCount: this.config.attachmentMaxCount,
        maxFileSize: this.config.attachmentMaxFileSize,
        maxTotalSize: this.config.attachmentMaxTotalSize,
        maxInlineText: this.config.attachmentMaxInlineText,
      });
      if (error) {
        await message.reply(error);
        return;
      }
    }

    const effectivePrompt = prompt || "Please inspect the attached file(s).";

    const modelConfig = this.db.getGuildModelConfig(message.guildId);
    const provider: AiProvider = modelConfig?.provider ?? "claude";
    const model = modelConfig?.model;

    const request = this.db.createRequest({
      guildId: message.guildId,
      repoId: repo.id,
      channelId: repo.channel_id,
      threadId: message.channelId,
      userId: message.author.id,
      prompt: effectivePrompt,
      status: "queued"
    });

    this.requestQueue.enqueue(message.guildId, async () => {
      const followUpInput: {
        requestId: number;
        threadId: string;
        repoId: number;
        repo: { owner: string; repo: string; fullName: string };
        prompt: string;
        provider: AiProvider;
        model?: string;
        existingWorktreePath: string;
        existingBranchName?: string;
        attachments?: PendingAttachment[];
      } = {
        requestId: request.id,
        threadId: message.channelId,
        repoId: repo.id,
        repo: { owner: repo.owner, repo: repo.repo, fullName: repo.full_name },
        prompt: effectivePrompt,
        provider,
        existingWorktreePath,
      };
      if (model) followUpInput.model = model;
      if (latestRequest.branch_name) followUpInput.existingBranchName = latestRequest.branch_name;
      if (pendingAttachments.length > 0) followUpInput.attachments = pendingAttachments;
      await this.runQueuedRequest(followUpInput);
    }, message.channelId);
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
      case "plan":
        await this.handlePlan(interaction);
        return;
      case "plan-oc":
        await this.handlePlanOc(interaction);
        return;
      case "install":
        await this.handleInstall(interaction);
        return;
      case "uninstall":
        await this.handleUninstall(interaction);
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
      case "model-select-oc":
        await this.handleModelSelectOc(interaction);
        return;
      case "model-current":
        await this.handleModelCurrent(interaction);
        return;
      case "review-rounds":
        await this.handleReviewRounds(interaction);
        return;
      case "codex-auth":
        await this.handleCodexAuth(interaction);
        return;
      case "opencode-auth":
        await this.handleOpencodeAuth(interaction);
        return;
      case "auth-openai-opencode":
        await this.handleAuthOpenAIOpenCode(interaction);
        return;
      case "opencode-auth-remove":
        await this.handleOpencodeAuthRemove(interaction);
        return;
      case "gh-auth-refresh":
        await this.handleGhAuthRefresh(interaction);
        return;
      case "delete":
        await this.handleDelete(interaction);
        return;
      case "review":
        await this.handleReview(interaction);
        return;
      case "revise":
        await this.handleRevise(interaction);
        return;
      case "pr":
        await this.handlePr(interaction);
        return;
      case "update-clis":
        await this.handleUpdateClis(interaction);
        return;
      case "memory":
        await this.handleMemory(interaction);
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

  private toRepoMemoryIdentity(repo: RepoRow | { owner: string; repo: string; fullName: string }): RepoMemoryIdentity {
    if ("fullName" in repo) {
      return { owner: repo.owner, repo: repo.repo, fullName: repo.fullName };
    }
    return { owner: repo.owner, repo: repo.repo, fullName: repo.full_name };
  }

  private async prepareRepositoryMemory(
    repo: RepoRow | { owner: string; repo: string; fullName: string },
    checkoutPath: string,
    options: { queueMine?: boolean } = {}
  ): Promise<void> {
    if (!this.memPalaceRemote) return;
    const identity = this.toRepoMemoryIdentity(repo);
    try {
      await this.memPalaceRemote.registerRepository(identity, checkoutPath, options);
    } catch (error) {
      this.logger.warn({ error, repo: identity.fullName, checkoutPath }, "MemPalace remote repository registration failed");
    }
  }

  private async prepareWorktreeMemoryConfig(
    repo: RepoRow | { owner: string; repo: string; fullName: string },
    worktreePath: string
  ): Promise<string | null> {
    if (!this.memPalaceRemote) return null;
    const identity = this.toRepoMemoryIdentity(repo);
    try {
      return await this.memPalaceRemote.ensureWorktreeConfig(identity, worktreePath);
    } catch (error) {
      this.logger.warn({ error, repo: identity.fullName, worktreePath }, "MemPalace worktree config preparation failed");
      return null;
    }
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
      await this.prepareRepositoryMemory(lookup, checkout.localPath, { queueMine: true });

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

      if (this.memPalace) {
        this.memPalace.kgAdd(inserted.full_name, "connected_to_guild", interaction.guildId).catch((err: unknown) => {
          this.logger.warn({ error: err }, "MemPalace kgAdd failed for connect-repo");
        });
      }
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

    if (!(await this.ensureGitHubCliAccess(interaction, ["/issues"], true))) {
      return;
    }

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
        await this.prepareRepositoryMemory(repo, checkout.localPath, { queueMine: true });
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
      await this.prepareRepositoryMemory(repo, checkout.localPath, { queueMine: true });

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
    if (interaction.commandName !== "model-select" && interaction.commandName !== "model-select-oc") {
      return;
    }

    const focused = interaction.options.getFocused(true);
    if (focused.name !== "model") {
      return;
    }

    if (interaction.commandName === "model-select-oc") {
      const history = this.db.getModelHistory("opencode");
      const candidates = [...new Set([...history, ...(KNOWN_MODELS_BY_PROVIDER.opencode ?? [])])];
      const typed = focused.value.toLowerCase();
      const filtered = typed
        ? candidates.filter((model) => model.toLowerCase().includes(typed))
        : candidates;
      await interaction.respond(filtered.slice(0, 10).map((model) => ({ name: model, value: model })));
      return;
    }

    const provider = interaction.options.getString("provider");
    if (!provider || !(provider in AI_PROVIDER_LABELS)) {
      await interaction.respond([]);
      return;
    }

    const history = this.db.getModelHistory(provider as AiProvider);
    const candidates = [...new Set([...history, ...(KNOWN_MODELS_BY_PROVIDER[provider as AiProvider] ?? [])])];
    const typed = focused.value.toLowerCase();
    const filtered = typed
      ? candidates.filter((m) => m.toLowerCase().includes(typed))
      : candidates;

    await interaction.respond(
      filtered.slice(0, 10).map((model) => ({ name: model, value: model }))
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

    const rawProvider = interaction.options.getString("provider");
    const rawModel = interaction.options.getString("model");
    const rawRole = interaction.options.getString("role") ?? "default";
    const isClear = interaction.options.getBoolean("clear") ?? false;
    const model = rawModel?.trim() || null;

    if (!isClear && !rawProvider) {
      await interaction.reply({
        content: "`provider` is required when not clearing a role. Choose from: `claude`, `codex`, `gemini`, `opencode`.",
        ephemeral: true
      });
      return;
    }

    if (rawProvider && !Object.keys(AI_PROVIDER_LABELS).includes(rawProvider)) {
      await interaction.reply({
        content: `Invalid provider. Choose from: \`${Object.keys(AI_PROVIDER_LABELS).join("`, `")}\`.`,
        ephemeral: true
      });
      return;
    }

    const provider = rawProvider as AiProvider | null;
    const VALID_ROLES = [
      "default",
      "planner",
      "implementer",
      "reviewer-1",
      "reviewer-2",
      "reviewer-3",
      "reviewer-4",
      "reviewer-analyzer",
      "reviewer-judge",
      "reviewer-summarizer"
    ] as const;

    if (!(VALID_ROLES as readonly string[]).includes(rawRole)) {
      await interaction.reply({
        content: "Invalid model role. Choose from: `default`, `planner`, `implementer`, `reviewer-1`–`reviewer-4`, `reviewer-analyzer`, `reviewer-judge`, `reviewer-summarizer`.",
        ephemeral: true
      });
      return;
    }

    this.db.upsertGuild(interaction.guild.id, interaction.guild.name);

    // --- Reviewer slot roles (reviewer-1 through reviewer-4) ---
    const slotMatch = rawRole.match(/^reviewer-([1-4])$/);
    if (slotMatch) {
      const slotIndex = parseInt(slotMatch[1]!, 10);
      if (isClear) {
        this.db.clearReviewerSlot(interaction.guildId, slotIndex);
        await interaction.reply({
          content: `Reviewer slot **${slotIndex}** cleared.`,
          ephemeral: true
        });
        return;
      }

      if (!provider) {
        await interaction.reply({
          content: "`provider` is required when setting a reviewer slot.",
          ephemeral: true
        });
        return;
      }

      const providerUnavailableMessage = await this.getProviderUnavailableMessage(provider);
      if (providerUnavailableMessage) {
        await interaction.reply({ content: providerUnavailableMessage, ephemeral: true });
        return;
      }

      this.db.setReviewerSlot(interaction.guildId, slotIndex, provider, model, interaction.user.id);
      if (model) {
        this.db.addModelToHistory(provider, model);
      }

      const modelDisplay = model ? `model \`${model}\`` : "CLI default model";
      await interaction.reply({
        content: `Reviewer slot **${slotIndex}** set to **${AI_PROVIDER_LABELS[provider]}** with ${modelDisplay}.`,
        ephemeral: true
      });
      return;
    }

    // --- Review role overrides (reviewer-analyzer, reviewer-judge, reviewer-summarizer) ---
    const reviewRoleMatch = rawRole.match(/^reviewer-(analyzer|judge|summarizer)$/);
    if (reviewRoleMatch) {
      const reviewRole = reviewRoleMatch[1] as ReviewModelRole;
      if (isClear) {
        this.db.clearGuildReviewRoleConfig(interaction.guildId, reviewRole, interaction.user.id);
        this.db.clearGuildModelConfigReviewRole(interaction.guildId, reviewRole, interaction.user.id);
        await interaction.reply({
          content: `Reviewer **${reviewRole}** role override cleared.`,
          ephemeral: true
        });
        return;
      }

      if (!provider) {
        await interaction.reply({
          content: "`provider` is required when setting a reviewer role override.",
          ephemeral: true
        });
        return;
      }

      const providerUnavailableMessage = await this.getProviderUnavailableMessage(provider);
      if (providerUnavailableMessage) {
        await interaction.reply({ content: providerUnavailableMessage, ephemeral: true });
        return;
      }

      this.db.setGuildReviewRoleConfig(interaction.guildId, reviewRole, provider, model, interaction.user.id);
      if (model) {
        this.db.addModelToHistory(provider, model);
      }

      const modelDisplay = model ? `model \`${model}\`` : "CLI default model";
      const roleLabel = reviewRole.charAt(0).toUpperCase() + reviewRole.slice(1);
      await interaction.reply({
        content: `Reviewer **${roleLabel}** role override set to **${AI_PROVIDER_LABELS[provider]}** with ${modelDisplay}.`,
        ephemeral: true
      });
      return;
    }

    // --- Default / planner / implementer (existing flow) ---
    const role = rawRole as "default" | "planner" | "implementer";

    if (isClear) {
      await interaction.reply({
        content: "`clear` is only supported for reviewer roles (`reviewer-1`–`reviewer-4`, `reviewer-analyzer`, `reviewer-judge`, `reviewer-summarizer`). Use `/model-select provider:... role:default` without `clear` to change the default provider.",
        ephemeral: true
      });
      return;
    }

    if (!provider) {
      await interaction.reply({
        content: "`provider` is required. Choose from: `claude`, `codex`, `gemini`, `opencode`.",
        ephemeral: true
      });
      return;
    }

    const providerUnavailableMessage = await this.getProviderUnavailableMessage(provider);
    if (providerUnavailableMessage) {
      await interaction.reply({ content: providerUnavailableMessage, ephemeral: true });
      return;
    }

    if (role === "default") {
      this.db.setGuildModelConfig(interaction.guildId, provider, model, interaction.user.id);
    } else {
      this.db.setGuildRoleModelConfig(interaction.guildId, role, provider, model, interaction.user.id);
    }

    if (model) {
      this.db.addModelToHistory(provider, model);
    }

    const modelDisplay = model ? `model \`${model}\`` : "CLI default model";
    const roleDisplay = role === "default" ? "default AI provider" : `${role} provider`;
    const affectedCommands =
      role === "default" ? "future `/ask`, `/bug`, and `/issue` requests" : `future \`/plan\` ${role} stages`;
    await interaction.reply({
      content: `${roleDisplay} set to **${AI_PROVIDER_LABELS[provider]}** with ${modelDisplay}. This applies to ${affectedCommands}.`,
      ephemeral: true
    });
  }

  private async handleModelSelectOc(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to change the OpenCode-native agent models.",
        ephemeral: true
      });
      return;
    }

    const rawRole = interaction.options.getString("role", true);
    if (rawRole !== "planner" && rawRole !== "implementer") {
      await interaction.reply({
        content: "Invalid OpenCode-native role. Choose `planner` or `implementer`.",
        ephemeral: true
      });
      return;
    }

    const role = rawRole as OpencodePlanOcRole;
    const model = interaction.options.getString("model")?.trim() || null;
    const clear = interaction.options.getBoolean("clear") ?? false;
    if (clear && model) {
      await interaction.reply({
        content: "Choose either a `model` or `clear:true`, not both.",
        ephemeral: true
      });
      return;
    }
    if (!clear && !model) {
      await interaction.reply({
        content: "Provide a full OpenCode model ID in `provider/model-id` format, or use `clear:true`.",
        ephemeral: true
      });
      return;
    }

    try {
      const state = await setOpencodePlanAgentModel(role, clear ? null : model);
      this.db.upsertGuild(interaction.guild.id, interaction.guild.name);
      if (model) {
        this.db.addModelToHistory("opencode", model);
      }

      const plannerModel = state.models.planner ? `\`${state.models.planner}\`` : "OpenCode default";
      const implementerModel = state.models.implementer ? `\`${state.models.implementer}\`` : "inherit planner";
      const action = clear ? `Cleared the **${role}** model override.` : `Set the **${role}** model to \`${model}\`.`;
      await interaction.reply({
        content: `${action} Planner: ${plannerModel}; implementer: ${implementerModel}. This instance-wide setting applies to future \`/plan-oc\` requests.`,
        ephemeral: true
      });
    } catch (error) {
      if (error instanceof OpencodePlanAgentConfigError) {
        await interaction.reply({ content: error.message, ephemeral: true });
        return;
      }
      this.logger.error({ error, role }, "Failed to update OpenCode-native agent model");
      await interaction.reply({
        content: "Failed to update the OpenCode-native agent file due to an unexpected error.",
        ephemeral: true
      });
    }
  }

  private async getProviderUnavailableMessage(provider: AiProvider): Promise<string | null> {

    if (provider === "codex" && !this.config.enableCodexExecution) {
      return "Codex execution is not enabled on this instance (`ENABLE_CODEX_EXECUTION` is not set). Choose a different provider or ask the instance administrator to enable it.";
    }

    if (provider === "gemini" && !this.config.enableGeminiExecution) {
      return "Gemini execution is not enabled on this instance (`ENABLE_GEMINI_EXECUTION` is not set). Choose a different provider or ask the instance administrator to enable it.";
    }

    if (provider === "gemini" && !this.config.geminiApiKey?.trim()) {
      return "Gemini execution requires `GEMINI_API_KEY` on this instance. Choose a different provider or ask the instance administrator to configure it.";
    }

    if (provider === "opencode" && !this.config.enableOpencodeExecution) {
      return "OpenCode execution is not enabled on this instance (`ENABLE_OPENCODE_EXECUTION` is not set). Choose a different provider or ask the instance administrator to enable it.";
    }

    if (provider === "opencode" && !this.config.deepseekApiKey?.trim() && !(await hasOpencodeAuth())) {
      return "OpenCode execution requires credentials. Use `/auth-openai-opencode` for a ChatGPT Pro/Plus subscription, `/opencode-auth` for an API key, or set `DEEPSEEK_API_KEY` on the instance.";
    }

    return null;
  }

  private resolveReviewRoleOverride(
    guildId: string,
    role: ReviewModelRole,
  ): { provider: AiProvider | null; model: string | null; source: "review_config" | "legacy" | null } {
    const reviewConfig = this.db.getGuildReviewConfig(guildId);
    const modelConfig = this.db.getGuildModelConfig(guildId);

    const reviewProvider = reviewConfig?.[`${role}_provider` as keyof typeof reviewConfig] as AiProvider | null | undefined;
    if (reviewProvider) {
      return {
        provider: reviewProvider,
        model: (reviewConfig?.[`${role}_model` as keyof typeof reviewConfig] as string | null | undefined) ?? null,
        source: "review_config"
      };
    }

    const legacyProvider = (modelConfig as unknown as Record<string, unknown> | undefined)?.[`${role}_provider`] as AiProvider | null | undefined;
    if (legacyProvider) {
      return {
        provider: legacyProvider,
        model: ((modelConfig as unknown as Record<string, unknown> | undefined)?.[`${role}_model`] as string | null | undefined) ?? null,
        source: "legacy"
      };
    }

    return { provider: null, model: null, source: null };
  }

  private async handleModelCurrent(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    const config = this.db.getGuildModelConfig(interaction.guildId);

    const lines: string[] = [];

    if (config) {
      const ts = new Date(config.updated_at).getTime();
      const timeStr = Number.isNaN(ts) ? config.updated_at : `<t:${Math.floor(ts / 1000)}:R>`;
      const modelStr = config.model || "none (CLI default)";
      const plannerProvider = config.planner_provider ?? config.provider;
      const plannerModel = config.planner_model ?? (plannerProvider === config.provider ? config.model : null);
      const implementerProvider = config.implementer_provider ?? config.provider;
      const implementerModel = config.implementer_model ?? (implementerProvider === config.provider ? config.model : null);

      lines.push(
        `Current default AI provider: **${AI_PROVIDER_LABELS[config.provider]}**, model: \`${modelStr}\` (set ${timeStr}).`,
        `Planner role: **${AI_PROVIDER_LABELS[plannerProvider]}**, model: \`${plannerModel || "none (CLI default)"}\`.`,
        `Implementer role: **${AI_PROVIDER_LABELS[implementerProvider]}**, model: \`${implementerModel || "none (CLI default)"}\`.`
      );
    } else {
      lines.push(
        "No AI provider configured. Defaulting to **Claude** (no model override). Use `/model-select` to configure.",
        "Planner role: **Claude**, model: `none (CLI default)`.",
        "Implementer role: **Claude**, model: `none (CLI default)`."
      );
    }

    const reviewConfig = this.db.getGuildReviewConfig(interaction.guildId);
    const slots = this.db.getReviewerSlots(interaction.guildId);

    const providersToCheck = new Set<AiProvider>();
    for (const slot of slots) {
      providersToCheck.add(slot.provider);
    }
    const reviewRoleSpec: Array<{ key: ReviewModelRole; label: string }> = [
      { key: "analyzer", label: "Analyzer" },
      { key: "judge", label: "Judge" },
      { key: "summarizer", label: "Summarizer" }
    ];
    for (const { key } of reviewRoleSpec) {
      const resolved = this.resolveReviewRoleOverride(interaction.guildId, key);
      if (resolved.provider) providersToCheck.add(resolved.provider);
    }

    const providerUnavailable = new Map<AiProvider, boolean>();
    for (const provider of providersToCheck) {
      providerUnavailable.set(provider, await this.getProviderUnavailableMessage(provider) !== null);
    }

    const isProviderUnavailable = (p: AiProvider): boolean =>
      providerUnavailable.get(p) ?? !this.isProviderEnabled(p);

    if (slots.length > 0) {
      const slotLines = slots.map(
        (s) => {
          const modelDisplay = s.model ? `\`${s.model}\`` : "CLI default model";
          const disabledSuffix = isProviderUnavailable(s.provider) ? " ⚠️ *unavailable*" : "";
          return `  Slot **${s.slot_index}**: **${AI_PROVIDER_LABELS[s.provider]}**, model: ${modelDisplay}${disabledSuffix}`;
        }
      );
      lines.push(`Reviewer slots:\n${slotLines.join("\n")}`);
    }

    const roleLines: string[] = [];

    for (const { key, label } of reviewRoleSpec) {
      const resolved = this.resolveReviewRoleOverride(interaction.guildId, key);
      // Legacy guild_model_config overrides are intentionally suppressed when reviewer slots
      // are active. If slots are later deleted, those legacy overrides will reappear in both
      // display and runtime selection.
      const showOverride = resolved.provider && (resolved.source === "review_config" || slots.length === 0);

      if (showOverride) {
        const modelDisplay = resolved.model ? `\`${resolved.model}\`` : "CLI default model";
        const sourceLabel = resolved.source === "review_config" ? "set via `/model-select`" : "legacy override";
        const disabledSuffix = isProviderUnavailable(resolved.provider!) ? " ⚠️ *unavailable*" : "";
        roleLines.push(`  **${label}**: **${AI_PROVIDER_LABELS[resolved.provider!]}**, model: ${modelDisplay} (${sourceLabel})${disabledSuffix}`);
      } else if (slots.length > 0) {
        const fallbackSlot = key === "summarizer"
          ? (slots.find((s) => s.provider !== slots[0]!.provider || s.model !== slots[0]!.model) ?? slots[0]!)
          : slots[0]!;
        roleLines.push(`  **${label}**: falls back to **Slot ${fallbackSlot.slot_index}** (**${AI_PROVIDER_LABELS[fallbackSlot.provider]}**)`);
      } else {
        const fallbackDesc = key === "summarizer"
          ? "falls back to second available reviewer in default ordering"
          : "falls back to first available reviewer in default ordering";
        roleLines.push(`  **${label}**: ${fallbackDesc}`);
      }
    }

    if (roleLines.length > 0) {
      lines.push(`Review roles:\n${roleLines.join("\n")}`);
    }

    if (slots.length > 0) {
      lines.push(`**Review mode:** Using explicit reviewer slots.`);
    } else if (reviewConfig?.analyzer_provider || reviewConfig?.judge_provider || reviewConfig?.summarizer_provider || config?.analyzer_provider || config?.judge_provider || config?.summarizer_provider) {
      lines.push(`**Review mode:** Using role overrides with provider ordering.`);
    } else {
      lines.push(`**Review mode:** Using all enabled providers (legacy fallback).`);
    }

    await interaction.reply({
      content: lines.join("\n"),
      ephemeral: true
    });
  }

  private async handleReviewRounds(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    const requestedRounds = interaction.options.getInteger("rounds");
    if (requestedRounds === null) {
      const config = this.db.getGuildReviewConfig(interaction.guildId);
      const rounds = config?.rounds ?? 2;
      const ts = config ? new Date(config.updated_at).getTime() : Number.NaN;
      const timeStr = config ? (Number.isNaN(ts) ? config.updated_at : `<t:${Math.floor(ts / 1000)}:R>`) : null;
      await interaction.reply({
        content: config
          ? `Current adversarial review round limit: \`${rounds}\` (set ${timeStr}).`
          : "Current adversarial review round limit: `2` (default).",
        ephemeral: true
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to change the adversarial review round limit.",
        ephemeral: true
      });
      return;
    }

    this.db.upsertGuild(interaction.guild.id, interaction.guild.name);
    this.db.setGuildReviewConfig(interaction.guildId, requestedRounds, interaction.user.id);
    await interaction.reply({
      content: `Adversarial review round limit set to \`${requestedRounds}\`. Future \`/review\` runs in this server will use this value.`,
      ephemeral: true
    });
  }


  private async handleCodexAuth(interaction: ChatInputCommandInteraction): Promise<void> {
    await this.handleCredentialFileUpload(interaction, {
      enabledFlag: this.config.enableCodexExecution,
      disabledMessage: "Codex execution is not enabled on this instance. Set `ENABLE_CODEX_EXECUTION=true` to enable it.",
      permissionLabel: "Codex",
      credPath: join(homedir(), ".codex", "auth.json"),
      logLabel: "Codex credentials written",
      logCommand: "codex-auth",
      successMessage: "Codex credentials saved. `/ask` requests with the Codex provider should now work."
    });
  }

  private async handleOpencodeAuth(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to configure OpenCode API keys.",
        ephemeral: true
      });
      return;
    }

    if (!this.config.enableOpencodeExecution) {
      await interaction.reply({
        content: "OpenCode execution is not enabled on this instance. Set `ENABLE_OPENCODE_EXECUTION=true` to enable it.",
        ephemeral: true
      });
      return;
    }

    const rawProvider = interaction.options.getString("provider", true);
    const rawKey = interaction.options.getString("key", true);
    const apiKey = rawKey.trim();

    if (!apiKey) {
      await interaction.reply({ content: "API key cannot be empty.", ephemeral: true });
      return;
    }

    if (!ALLOWED_OPENCODE_PROVIDERS.includes(rawProvider as typeof ALLOWED_OPENCODE_PROVIDERS[number])) {
      await interaction.reply({
        content: `Invalid provider. Choose from: \`${ALLOWED_OPENCODE_PROVIDERS.join("`, `")}\`.`,
        ephemeral: true
      });
      return;
    }

    let authJson: Record<string, { type: string; key: string }> = {};

    if (existsSync(OPENCODE_AUTH_PATH)) {
      try {
        const raw = await readFile(OPENCODE_AUTH_PATH, "utf-8");
        authJson = JSON.parse(raw) as typeof authJson;
      } catch {
        // Start fresh if the file is malformed
      }
    }

    authJson[rawProvider] = { type: "api", key: apiKey };

    await mkdir(dirname(OPENCODE_AUTH_PATH), { recursive: true });
    await writeFile(OPENCODE_AUTH_PATH, JSON.stringify(authJson, null, 2) + "\n", { mode: 0o600 });

    this.logger.info({ guildId: interaction.guildId, provider: rawProvider }, "OpenCode auth key saved");

    await interaction.reply({
      content: `API key for **${rawProvider}** saved to OpenCode's auth.json. All \`/ask\` requests with the OpenCode provider can now use this key.`,
      ephemeral: true
    });
  }

  private async handleAuthOpenAIOpenCode(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to connect an OpenAI subscription to OpenCode.",
        ephemeral: true
      });
      return;
    }

    if (!this.config.enableOpencodeExecution) {
      await interaction.reply({
        content: "OpenCode execution is not enabled on this instance. Set `ENABLE_OPENCODE_EXECUTION=true` to enable it.",
        ephemeral: true
      });
      return;
    }

    if (this.opencodeOpenAIAuthInProgress) {
      await interaction.reply({
        content: "An OpenAI subscription authorization is already in progress. Complete it before starting another.",
        ephemeral: true
      });
      return;
    }

    this.opencodeOpenAIAuthInProgress = true;
    try {
      await interaction.deferReply({ ephemeral: true });
      await authenticateOpenAIOpencode({
        cwd: process.cwd(),
        onChallenge: ({ url, code }) => {
          void interaction.editReply({
            content: [
              "OpenCode is waiting for your OpenAI authorization.",
              "",
              `[Open the OpenAI device login](${url}) and enter code \`${code}\`.`,
              "",
              "This private response will update automatically when authorization completes."
            ].join("\n")
          }).catch((err) => {
            this.logger.warn({ err, guildId: interaction.guildId }, "Failed to show OpenCode OpenAI auth challenge");
          });
        }
      });

      this.logger.info({ guildId: interaction.guildId }, "OpenAI subscription connected to OpenCode");
      try {
        await interaction.editReply({
          content: "OpenAI ChatGPT Pro/Plus subscription connected to OpenCode. OpenAI models are now available to OpenCode requests."
        });
      } catch (replyErr) {
        this.logger.warn({ err: replyErr, guildId: interaction.guildId }, "Failed to send OpenAI auth success reply");
      }
    } catch (err) {
      const error = err as Error & { code?: string; stderr?: string };
      // spawnCollect errors can contain the device URL and one-time code in
      // stdout/stderr. Log only non-sensitive classification fields.
      this.logger.error({
        guildId: interaction.guildId,
        errorName: error.name,
        ...(error.code ? { errorCode: error.code } : {})
      }, "OpenCode OpenAI subscription auth failed");
      const diagnostic = (error.stderr?.trim() || error.message || "Unknown error")
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
        .slice(0, 1_400);
      const message = error.code === "ETIMEDOUT"
        ? "OpenAI authorization timed out. Run `/auth-openai-opencode` to try again."
        : `OpenAI authorization failed: ${diagnostic}`;
      try {
        await interaction.editReply({ content: message });
      } catch (replyErr) {
        this.logger.warn({ err: replyErr, guildId: interaction.guildId }, "Failed to send OpenAI auth failure reply");
      }
    } finally {
      this.opencodeOpenAIAuthInProgress = false;
    }
  }

  private async handleOpencodeAuthRemove(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to remove OpenCode credentials.",
        ephemeral: true
      });
      return;
    }

    const rawProvider = interaction.options.getString("provider", true);

    if (!ALLOWED_OPENCODE_PROVIDERS.includes(rawProvider as typeof ALLOWED_OPENCODE_PROVIDERS[number])) {
      await interaction.reply({
        content: `Invalid provider. Choose from: \`${ALLOWED_OPENCODE_PROVIDERS.join("`, `")}\`.`,
        ephemeral: true
      });
      return;
    }

    if (!existsSync(OPENCODE_AUTH_PATH)) {
      await interaction.reply({
        content: `No stored auth.json found. No credentials to remove.`,
        ephemeral: true
      });
      return;
    }

    let authJson: Record<string, unknown> = {};
    try {
      const raw = await readFile(OPENCODE_AUTH_PATH, "utf-8");
      authJson = JSON.parse(raw) as typeof authJson;
    } catch {
      await interaction.reply({
        content: "OpenCode auth.json is malformed. Delete it manually and re-configure keys.",
        ephemeral: true
      });
      return;
    }

    if (!(rawProvider in authJson)) {
      await interaction.reply({
        content: `No stored credential for **${rawProvider}**.`,
        ephemeral: true
      });
      return;
    }

    delete authJson[rawProvider];

    if (Object.keys(authJson).length === 0) {
      await unlink(OPENCODE_AUTH_PATH);
    } else {
      await writeFile(OPENCODE_AUTH_PATH, JSON.stringify(authJson, null, 2) + "\n", { mode: 0o600 });
    }

    this.logger.info({ guildId: interaction.guildId, provider: rawProvider }, "OpenCode auth key removed");

    await interaction.reply({
      content: `Credential for **${rawProvider}** has been removed from OpenCode's auth.json.`,
      ephemeral: true
    });
  }

  private async handleGhAuthRefresh(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to refresh GitHub authentication.",
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const login = await forceRefreshGitHubAuth();
      this.logger.info({ login }, "GitHub auth force-refreshed via /gh-auth-refresh");
      await interaction.editReply({ content: `GitHub authentication refreshed. Logged in as \`${login}\`.` });
    } catch (err) {
      this.logger.error({ err }, "gh-auth-refresh failed");
      const message = err instanceof Error ? ((err as any).stderr?.trim() || err.message) : String(err);
      await interaction.editReply({ content: `GitHub authentication refresh failed: ${message}` });
    }
  }

  private async handleCredentialFileUpload(
    interaction: ChatInputCommandInteraction,
    options: {
      enabledFlag: boolean;
      disabledMessage: string;
      permissionLabel: string;
      credPath: string;
      logLabel: string;
      logCommand: string;
      successMessage: string;
    }
  ): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: `You need the \`Manage Server\` permission to configure ${options.permissionLabel} auth.`,
        ephemeral: true
      });
      return;
    }

    if (!options.enabledFlag) {
      await interaction.reply({ content: options.disabledMessage, ephemeral: true });
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
      JSON.parse(content);

      await mkdir(dirname(options.credPath), { recursive: true });
      await writeFile(options.credPath, content, { mode: 0o600 });

      this.logger.info({ guildId: interaction.guildId, credPath: options.credPath }, options.logLabel);
      await interaction.editReply(options.successMessage);
    } catch (error) {
      this.logger.error({ error, guildId: interaction.guildId }, `${options.logCommand} failed`);
      await interaction.editReply(`Failed to save credentials: ${error instanceof Error ? error.message : "Unknown error"}`);
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

    if (isActiveRequestStatus(request.status)) {
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
    const attachments: PendingAttachment[] = [];
    for (let i = 1; i <= 5; i++) {
      const att = interaction.options.getAttachment(`attachment${i}`);
      if (att) {
        attachments.push({
          id: att.id,
          name: att.name ?? `attachment-${i}`,
          url: att.url,
          size: att.size,
          contentType: att.contentType,
        });
      }
    }

    if (attachments.length > 0) {
      const error = validateAttachments(attachments, {
        maxCount: this.config.attachmentMaxCount,
        maxFileSize: this.config.attachmentMaxFileSize,
        maxTotalSize: this.config.attachmentMaxTotalSize,
        maxInlineText: this.config.attachmentMaxInlineText,
      });
      if (error) {
        await interaction.reply({ content: error, ephemeral: true });
        return;
      }
    }

    await this.handleRepoCommand(interaction, { label: "request", attachments });
  }

  private async handleInstall(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to install tools.",
        ephemeral: true
      });
      return;
    }

    const selectedPackageId = interaction.options.getString("package");
    const aptPackage = interaction.options.getString("apt-package");
    const scope = interaction.options.getString("scope", true);
    if (scope !== "repo" && scope !== "request") {
      await interaction.reply({ content: "Invalid install scope.", ephemeral: true });
      return;
    }

    if ((!selectedPackageId && !aptPackage) || (selectedPackageId && aptPackage)) {
      await interaction.reply({
        content: "Specify exactly one of `package` or `apt-package`.",
        ephemeral: true
      });
      return;
    }

    let packageId: string;
    try {
      packageId = selectedPackageId ?? buildAptPackageId(aptPackage!);
    } catch (error) {
      await interaction.reply({ content: `Install failed: ${this.describeExecutionError(error)}`, ephemeral: true });
      return;
    }

    const repo = this.resolveRepoFromInteraction(interaction);
    if (!repo) {
      await interaction.reply({
        content: "No connected repo could be resolved. Run this in a mapped repo channel or thread.",
        ephemeral: true
      });
      return;
    }

    let threadId: string | null = null;
    let requestId: number | null = null;

    if (scope === "request") {
      if (!interaction.channel?.isThread()) {
        await interaction.reply({
          content: "Request-scoped installs must be run inside the request thread that should receive the tool.",
          ephemeral: true
        });
        return;
      }

      const latestRequest = this.db.getLatestRequestWithWorkspaceByThreadId(interaction.channelId);
      if (!latestRequest?.worktree_path) {
        await interaction.reply({
          content: "This thread does not have an active tracked worktree. Run `/ask` first before using request scope.",
          ephemeral: true
        });
        return;
      }

      threadId = interaction.channelId;
      requestId = latestRequest.id;
    }

    let installRequest;
    try {
      installRequest = this.installService.createApprovedInstallRequest({
        guildId: interaction.guildId,
        repoId: repo.id,
        requestId,
        threadId,
        packageId,
        scope,
        requestedByUserId: interaction.user.id,
        approvedByUserId: interaction.user.id
      });
    } catch (error) {
      const message = this.describeExecutionError(error);
      await interaction.reply({ content: `Install failed: ${message}`, ephemeral: true });
      return;
    }

    // Reply immediately — install may take a long time on slow connections
    await interaction.reply({
      content: `Installing ${this.describeInstallTarget(packageId)} in \`${scope}\` scope. I'll post here when it's done.`,
      ephemeral: true
    });

    const channel = interaction.channel?.isTextBased() && !interaction.channel.isDMBased() ? interaction.channel : null;
    const userId = interaction.user.id;

    void this.runQueuedGuildTask(
      interaction.guildId,
      async () => this.installService.runInstall(installRequest.id),
      threadId ?? undefined
    ).then(async (completedInstall) => {
      await channel?.send(
        [
          `<@${userId}> Installed ${this.describeInstallTarget(completedInstall.package_id, completedInstall.package_version)} in \`${scope}\` scope.`,
          `Install request: #${completedInstall.id}`,
          completedInstall.bin_path ? `PATH prefix: \`${completedInstall.bin_path}\`` : "PATH prefix: (none)"
        ].join("\n")
      );
    }).catch(async (error) => {
      const message = this.describeExecutionError(error);
      await channel?.send(`<@${userId}> Install failed: ${message}`);
    });
  }

  private async handleUninstall(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to invalidate tools.",
        ephemeral: true
      });
      return;
    }

    const selectedPackageId = interaction.options.getString("package");
    const aptPackage = interaction.options.getString("apt-package");
    const scope = interaction.options.getString("scope", true);
    if (scope !== "repo" && scope !== "request") {
      await interaction.reply({ content: "Invalid uninstall scope.", ephemeral: true });
      return;
    }
    if ((!selectedPackageId && !aptPackage) || (selectedPackageId && aptPackage)) {
      await interaction.reply({ content: "Specify exactly one of `package` or `apt-package`.", ephemeral: true });
      return;
    }

    let packageId: string;
    try {
      packageId = selectedPackageId ?? buildAptPackageId(aptPackage!);
    } catch (error) {
      await interaction.reply({ content: `Uninstall failed: ${this.describeExecutionError(error)}`, ephemeral: true });
      return;
    }

    const repo = this.resolveRepoFromInteraction(interaction);
    if (!repo) {
      await interaction.reply({
        content: "No connected repo could be resolved. Run this in a mapped repo channel or thread.",
        ephemeral: true
      });
      return;
    }

    let threadId: string | null = null;
    if (scope === "request") {
      if (!interaction.channel?.isThread()) {
        await interaction.reply({
          content: "Request-scoped installs must be invalidated from the request thread that owns them.",
          ephemeral: true
        });
        return;
      }
      threadId = interaction.channelId;
    }

    // Removing a large toolchain can exceed Discord's 3-second initial
    // response window, so acknowledge first. Queueing the invalidation keyed
    // on the thread keeps the deletion from racing a request that has the
    // install's binaries on its PATH; repo-scoped installs have no owning
    // thread, so they only get guild-level queue serialization.
    await interaction.deferReply({ ephemeral: true });

    try {
      const invalidated = await this.runQueuedGuildTask(
        interaction.guildId,
        async () => this.installService.invalidateInstall({
          repoId: repo.id,
          threadId,
          packageId,
          scope,
          invalidatedByUserId: interaction.user.id
        }),
        threadId ?? undefined
      );
      const aptNote = isAptPackageId(packageId)
        ? " The system APT package remains installed; only its Actuarius install record and managed marker files were removed."
        : "";
      await this.bestEffortLongRunningEditReply(
        interaction,
        `Invalidated install request #${invalidated.id} for ${this.describeInstallTarget(packageId)} in \`${scope}\` scope.${aptNote}`,
        "uninstall success acknowledgement"
      );
    } catch (error) {
      await this.bestEffortLongRunningEditReply(
        interaction,
        `Uninstall failed: ${this.describeExecutionError(error)}`,
        "uninstall failure acknowledgement"
      );
    }
  }

  private async runQueuedGuildTask<T>(guildId: string, task: () => Promise<T>, resourceKey?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.requestQueue.enqueue(guildId, async () => {
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      }, resourceKey);
    });
  }

  private async handleRepoCommand(
    interaction: ChatInputCommandInteraction,
    options: {
      label: string;
      promptTransformer?: (prompt: string) => string;
      rawOutput?: boolean;
      detachWorktree?: boolean;
      attachments?: PendingAttachment[];
      requireGitHubCli?: boolean;
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

    await interaction.deferReply({ ephemeral: true });

    if (options.requireGitHubCli) {
      if (!(await this.ensureGitHubCliAccess(interaction, [`/${options.label}`], true))) {
        return;
      }
    }

    const channel = (await interaction.guild.channels.fetch(repo.channel_id)) as GuildTextBasedChannel | null;
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.editReply("Mapped repo channel is unavailable or not a text channel.");
      return;
    }

    const seedMessage = await channel.send({
      content: `New ${options.label} from <@${interaction.user.id}> for \`${repo.full_name}\``
    });

    const thread = await seedMessage.startThread({
      name: buildThreadName(prompt),
      autoArchiveDuration: this.config.threadAutoArchiveMinutes,
      reason: `${options.label} thread for ${repo.full_name} by ${interaction.user.tag}`
    });

    const seedLines = [
      `Request by <@${interaction.user.id}>`,
      "",
      `**Prompt**`,
      prompt
    ];
    if (options.attachments && options.attachments.length > 0) {
      seedLines.push("", "**Attachments**", buildAttachmentSummary(options.attachments));
    }
    await thread.send(seedLines.join("\n"));

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
      const queuedInput: {
        requestId: number;
        threadId: string;
        repoId: number;
        repo: { owner: string; repo: string; fullName: string };
        prompt: string;
        provider: AiProvider;
        model?: string;
        promptTransformer?: (prompt: string) => string;
        rawOutput?: boolean;
        detachWorktree?: boolean;
        attachments?: PendingAttachment[];
      } = {
        requestId: request.id,
        threadId: thread.id,
        repoId: repo.id,
        repo: { owner: repo.owner, repo: repo.repo, fullName: repo.full_name },
        prompt,
        provider,
      };
      if (model) queuedInput.model = model;
      if (options.promptTransformer) queuedInput.promptTransformer = options.promptTransformer;
      if (options.rawOutput) queuedInput.rawOutput = true;
      if (options.detachWorktree) queuedInput.detachWorktree = true;
      if (options.attachments?.length) queuedInput.attachments = options.attachments;
      await this.runQueuedRequest(queuedInput);
    }, thread.id);

    await interaction.editReply(
      `Created ${options.label} thread <#${thread.id}>. Request queued for ${AI_PROVIDER_LABELS[provider]} execution.`
    );
  }

  private async resolvePlanRoleModels(guildId: string): Promise<{ planner: ResolvedModelRole; implementer: ResolvedModelRole }> {
    const config = this.db.getGuildModelConfig(guildId);
    const defaultProvider = config?.provider ?? "claude";
    const defaultModel = config?.model ?? null;

    const resolveRole = async (
      role: "planner" | "implementer",
      configuredProvider: AiProvider | null | undefined,
      configuredModel: string | null | undefined
    ): Promise<ResolvedModelRole> => {
      const provider = configuredProvider ?? defaultProvider;
      const model = configuredModel ?? (provider === defaultProvider ? defaultModel : null);
      const unavailable = await this.getProviderUnavailableMessage(provider);
      if (!unavailable) {
        return model ? { provider, model } : { provider };
      }

      return {
        provider: "claude",
        ...(model && provider === "claude" ? { model } : {}),
        fallbackReason: `${role} role requested ${AI_PROVIDER_LABELS[provider]}, but that provider is unavailable (${unavailable.replace(/\.$/u, "")}); falling back to Claude.`
      };
    };

    return {
      planner: await resolveRole("planner", config?.planner_provider, config?.planner_model),
      implementer: await resolveRole("implementer", config?.implementer_provider, config?.implementer_model)
    };
  }

  private async handlePlan(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    const prompt = interaction.options.getString("prompt", true).trim();
    const iterative = interaction.options.getBoolean("iterative") ?? true;
    if (!prompt) {
      await interaction.reply({ content: "Prompt cannot be empty.", ephemeral: true });
      return;
    }

    const resolvedChannelId =
      interaction.channel && interaction.channel.isThread() ? interaction.channel.parentId : interaction.channelId;
    if (!resolvedChannelId) {
      await interaction.reply({ content: "Could not resolve a parent channel for this thread.", ephemeral: true });
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

    await interaction.deferReply({ ephemeral: true });

    const channel = (await interaction.guild.channels.fetch(repo.channel_id)) as GuildTextBasedChannel | null;
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.editReply("Mapped repo channel is unavailable or not a text channel.");
      return;
    }

    const roles = await this.resolvePlanRoleModels(interaction.guildId);

    const seedMessage = await channel.send({
      content: `New plan request from <@${interaction.user.id}> for \`${repo.full_name}\``
    });
    const thread = await seedMessage.startThread({
      name: buildThreadName(prompt),
      autoArchiveDuration: this.config.threadAutoArchiveMinutes,
      reason: `plan thread for ${repo.full_name} by ${interaction.user.tag}`
    });
    await thread.send(["Request by <@" + interaction.user.id + ">", "", "**Prompt**", prompt].join("\n"));

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
      await this.runPlanRequest({
        requestId: request.id,
        threadId: thread.id,
        repoId: repo.id,
        repo: {
          owner: repo.owner,
          repo: repo.repo,
          fullName: repo.full_name
        },
        prompt,
        planner: roles.planner,
        implementer: roles.implementer,
        iterative
      });
    }, thread.id);

    const iterativeSuffix = iterative ? " (iterative)" : "";
    await interaction.editReply(
      `Created plan thread <#${thread.id}>. Planner: ${AI_PROVIDER_LABELS[roles.planner.provider]}; implementer: ${AI_PROVIDER_LABELS[roles.implementer.provider]}.${iterativeSuffix}`
    );
  }

  private async handlePlanOc(interaction: ChatInputCommandInteraction): Promise<void> {
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
      await interaction.reply({ content: "Could not resolve a parent channel for this thread.", ephemeral: true });
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

    await interaction.deferReply({ ephemeral: true });

    const unavailable = await this.getProviderUnavailableMessage("opencode");
    if (unavailable) {
      await interaction.editReply(unavailable);
      return;
    }

    const channel = (await interaction.guild.channels.fetch(repo.channel_id)) as GuildTextBasedChannel | null;
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.editReply("Mapped repo channel is unavailable or not a text channel.");
      return;
    }

    let agentSnapshot: Awaited<ReturnType<typeof createOpencodePlanAgentSnapshot>>;
    try {
      agentSnapshot = await createOpencodePlanAgentSnapshot();
    } catch (error) {
      this.logger.error({ error }, "Failed to snapshot OpenCode-native agent files");
      await interaction.editReply("Could not prepare the managed OpenCode agent files for this request.");
      return;
    }

    let snapshotEnqueued = false;
    try {
      const seedMessage = await channel.send({
        content: `New OpenCode-native plan request from <@${interaction.user.id}> for \`${repo.full_name}\``
      });
      const thread = await seedMessage.startThread({
        name: buildThreadName(prompt),
        autoArchiveDuration: this.config.threadAutoArchiveMinutes,
        reason: `OpenCode-native plan thread for ${repo.full_name} by ${interaction.user.tag}`
      });
      await thread.send(["Request by <@" + interaction.user.id + ">", "", "**Prompt**", prompt].join("\n"));

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
        await this.runPlanOcRequest({
          requestId: request.id,
          threadId: thread.id,
          repoId: repo.id,
          repo: {
            owner: repo.owner,
            repo: repo.repo,
            fullName: repo.full_name
          },
          prompt,
          agentSnapshot
        });
      }, thread.id);
      snapshotEnqueued = true;

      const plannerModel = agentSnapshot.models.planner ? `\`${agentSnapshot.models.planner}\`` : "OpenCode default";
      const implementerModel = agentSnapshot.models.implementer ? `\`${agentSnapshot.models.implementer}\`` : "inherit planner";
      await interaction.editReply(
        `Created OpenCode-native plan thread <#${thread.id}>. Planner: ${plannerModel}; implementer: ${implementerModel}.`
      );
    } finally {
      if (!snapshotEnqueued) {
        await agentSnapshot.cleanup().catch((error: unknown) => {
          this.logger.warn({ error }, "Failed to remove abandoned OpenCode-native agent snapshot");
        });
      }
    }
  }

  private async handleIssueCreate(interaction: ChatInputCommandInteraction, type: "bug" | "issue"): Promise<void> {
    const defaultLabel = type === "bug" ? "bug" : "enhancement";
    const promptTransformer = (prompt: string): string =>
      buildIssueCreationPrompt({ requestPrompt: prompt, defaultLabel });

    await this.handleRepoCommand(interaction, {
      label: type,
      promptTransformer,
      rawOutput: true,
      detachWorktree: true,
      requireGitHubCli: true
    });
  }

  private async ensureGitHubCliAccess(interaction: ChatInputCommandInteraction, commands: string[], deferred: boolean = false): Promise<boolean> {
    try {
      await ensureGitHubCliAuthenticated();
      const { spawnCollect } = await import("../utils/spawnCollect.js");
      await spawnCollect("gh", ["auth", "token", "--hostname", "github.com"], {
        cwd: process.cwd(),
        env: getGitHubCommandEnvironment(),
        timeoutMs: 10_000,
        maxBuffer: 4 * 1024
      });
      return true;
    } catch (err) {
      this.logger.warn({ err }, "GitHub CLI access check failed");
      const content =
        `GitHub CLI is not authenticated. Configure GitHub App credentials or \`GH_TOKEN\`, or run \`gh auth login\` on the host before using ${commands.join(" or ")}.`;
      if (deferred) {
        await interaction.editReply(content);
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
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
    const prompt = buildIssueSummaryPrompt({
      repoFullName: input.repoFullName,
      issues: input.issues
    });

    const result = await this.runProviderText({
      provider,
      cwd: input.cwd,
      prompt,
      ...(model ? { model } : {})
    });

    return result;
  }

  private isProviderEnabled(provider: AiProvider): boolean {
    if (provider === "codex") return !!this.config.enableCodexExecution;
    if (provider === "gemini") return !!this.config.enableGeminiExecution;
    if (provider === "opencode") return !!this.config.enableOpencodeExecution;
    return true;
  }

  private async validateReviewConfig(guildId: string): Promise<string | null> {
    const slots = this.db.getReviewerSlots(guildId);
    const reviewConfig = this.db.getGuildReviewConfig(guildId);

    if (slots.length > 0) {
      if (slots.length < 2) {
        return "**Insufficient reviewers configured** — at least 2 reviewer slots are required for `/review`. Use `/model-select reviewer-1` and `/model-select reviewer-2` to set them up.";
      }

      for (const slot of slots) {
        const unavailMsg = await this.getProviderUnavailableMessage(slot.provider);
        if (unavailMsg) {
          return `**Provider unavailable** — slot ${slot.slot_index} uses \`${slot.provider}\` which is not available. ${unavailMsg}`;
        }
      }

      const roles: ReviewModelRole[] = ["analyzer", "judge", "summarizer"];
      for (const role of roles) {
        const overrideProvider = reviewConfig?.[`${role}_provider` as keyof typeof reviewConfig] as AiProvider | undefined;
        if (overrideProvider) {
          const unavailMsg = await this.getProviderUnavailableMessage(overrideProvider);
          if (unavailMsg) {
            return `**Provider unavailable** — the \`${role}\` role override uses \`${overrideProvider}\` which is not available. ${unavailMsg}`;
          }
        }
      }

      return null;
    }

    const modelConfig = this.db.getGuildModelConfig(guildId);
    const preferredProvider: AiProvider = modelConfig?.provider ?? "claude";

    const preferredUnavail = await this.getProviderUnavailableMessage(preferredProvider);
    if (preferredUnavail) {
      return `**Provider unavailable** — saved default provider \`${preferredProvider}\` is not available. ${preferredUnavail}`;
    }

    const roles: ReviewModelRole[] = ["analyzer", "judge", "summarizer"];
    for (const role of roles) {
      const resolved = this.resolveReviewRoleOverride(guildId, role);
      if (resolved.provider) {
        const unavailMsg = await this.getProviderUnavailableMessage(resolved.provider);
        if (unavailMsg) {
          const source = resolved.source === "review_config" ? "`/model-select`" : "legacy configuration";
          return `**Provider unavailable** — the \`${role}\` role override uses \`${resolved.provider}\` (from ${source}) which is not available. ${unavailMsg}`;
        }
      }
    }

    const providers: AiProvider[] = [preferredProvider];
    for (const candidate of ["claude", "codex", "gemini", "opencode"] satisfies AiProvider[]) {
      if (!providers.includes(candidate)) {
        providers.push(candidate);
      }
    }

    const available: AiProvider[] = [];
    for (const provider of providers) {
      const unavailMsg = await this.getProviderUnavailableMessage(provider);
      if (!unavailMsg) {
        available.push(provider);
      }
    }

    if (available.length < 2) {
      return "**Insufficient reviewers configured** — at least 2 available AI providers are required for `/review`. Use `/model-select` to configure a second provider or ask the server administrator to enable or configure additional providers.";
    }

    return null;
  }

  private buildReviewRunners(input: {
    guildId: string;
    repoId: number;
    threadId?: string | null;
  }): {
    analyzer: ReviewModelRunner;
    reviewers: ReviewModelRunner[];
    judge: ReviewModelRunner;
    summarizer: ReviewModelRunner;
  } {
    const { guildId } = input;
    const reviewConfig = this.db.getGuildReviewConfig(guildId);
    const slots = this.db.getReviewerSlots(guildId);

    const hasSlotOverride = (role: ReviewModelRole): boolean =>
      !!reviewConfig?.[`${role}_provider` as keyof typeof reviewConfig];

    // Build the minimal execution env once for the whole review run. Without
    // this, review subprocesses inherited the full parent process.env (the
    // /ask path was migrated to a minimal env but /review was not), and — more
    // subtly — the transport byte estimate undercounted because it saw no env
    // while the kernel charged the inherited process.env against ARG_MAX.
    const reviewEnv = this.installService.buildMinimalExecutionEnvironment({
      repoId: input.repoId,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {})
    }).env;

    const buildRunner = (provider: AiProvider, defaultModel?: string | null, slotIndex?: number): ReviewModelRunner => ({
      provider,
      ...(defaultModel ? { model: defaultModel } : {}),
      label: slotIndex !== undefined ? `${AI_PROVIDER_LABELS[provider]} (Slot ${slotIndex})` : AI_PROVIDER_LABELS[provider],
      run: async ({ prompt, cwd, timeoutMs, model }) =>
        this.runProviderText({
          provider,
          prompt,
          cwd,
          timeoutMs,
          ...(model ? { model } : {}),
          env: reviewEnv
        })
    });

    if (slots.length > 0) {
      // Slot mode: legacy guild_model_config role overrides are intentionally bypassed.
      // If all slots are later deleted, legacy overrides will silently reappear.
      const reviewers: ReviewModelRunner[] = slots.map((s) =>
        buildRunner(s.provider, s.model, s.slot_index)
      );

      if (reviewers.length < 2) {
        throw new AdversarialReviewError(
          "INSUFFICIENT_REVIEWERS",
          "At least two reviewer slots are required for /review."
        );
      }

      const defaultSummarizer = reviewers.find(
        (r) => r.provider !== reviewers[0]!.provider || r.model !== reviewers[0]!.model
      ) ?? reviewers[0]!;
      const analyzer = hasSlotOverride("analyzer") && this.isProviderEnabled(reviewConfig!.analyzer_provider!)
        ? buildRunner(reviewConfig!.analyzer_provider!, reviewConfig!.analyzer_model)
        : reviewers[0]!;
      const judge = hasSlotOverride("judge") && this.isProviderEnabled(reviewConfig!.judge_provider!)
        ? buildRunner(reviewConfig!.judge_provider!, reviewConfig!.judge_model)
        : reviewers[0]!;
      const summarizer = hasSlotOverride("summarizer") && this.isProviderEnabled(reviewConfig!.summarizer_provider!)
        ? buildRunner(reviewConfig!.summarizer_provider!, reviewConfig!.summarizer_model)
        : defaultSummarizer;

      return { analyzer, reviewers, judge, summarizer };
    }

    const modelConfig = this.db.getGuildModelConfig(guildId);
    const preferredProvider: AiProvider = modelConfig?.provider ?? "claude";
    const preferredModel = modelConfig?.model ?? undefined;
    const providers: AiProvider[] = [preferredProvider];
    for (const candidate of ["claude", "codex", "gemini", "opencode"] satisfies AiProvider[]) {
      if (!providers.includes(candidate)) {
        providers.push(candidate);
      }
    }

    const reviewModels = new Map<AiProvider, string | undefined>();
    for (const provider of providers) {
      if (provider === preferredProvider) {
        reviewModels.set(provider, preferredModel);
        continue;
      }

      const history = this.db.getModelHistory(provider);
      reviewModels.set(provider, history[0]);
    }

    const reviewers: ReviewModelRunner[] = [];
    for (const provider of providers) {
      if (provider === "codex" && !this.config.enableCodexExecution) {
        continue;
      }
      if (provider === "gemini" && !this.config.enableGeminiExecution) {
        continue;
      }
      if (provider === "opencode" && !this.config.enableOpencodeExecution) {
        continue;
      }

      const reviewModel = reviewModels.get(provider);
      reviewers.push(buildRunner(provider, reviewModel));
    }

    if (reviewers.length < 2) {
      throw new AdversarialReviewError(
        "INSUFFICIENT_REVIEWERS",
        "At least two enabled AI providers are required for /review."
      );
    }

    const resolveRoleRunner = (
      role: ReviewModelRole,
      defaultRunner: ReviewModelRunner
    ): ReviewModelRunner => {
      const resolved = this.resolveReviewRoleOverride(guildId, role);
      if (!resolved.provider) return defaultRunner;
      if (!this.isProviderEnabled(resolved.provider)) return defaultRunner;
      return buildRunner(resolved.provider, resolved.model);
    };

    const analyzer = resolveRoleRunner("analyzer", reviewers[0]!);
    const judge = resolveRoleRunner("judge", reviewers[0]!);
    const defaultSummarizer = reviewers[1] ?? reviewers[0]!;
    const summarizer = resolveRoleRunner("summarizer", defaultSummarizer);
    return { analyzer, reviewers, judge, summarizer };
  }

  private getReviewRounds(guildId: string): number {
    return Math.max(1, this.db.getGuildReviewConfig(guildId)?.rounds ?? 2);
  }

  private async runProviderText(input: {
    provider: AiProvider;
    prompt: string;
    cwd: string;
    timeoutMs?: number;
    model?: string;
    env?: NodeJS.ProcessEnv;
    role?: "implementation" | "planner" | "verification";
    memoryWing?: string | null | undefined;
    diagnostics?: ProviderExecutionDiagnostics;
  }): Promise<string> {
    const request = {
      prompt: buildRepositoryMemoryScopedPrompt({
        prompt: input.prompt,
        memoryWing: input.memoryWing
      }),
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? this.config.askExecutionTimeoutMs,
      idleTimeoutMs: this.config.providerIdleTimeoutMs,
      ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.env ? { env: input.env } : {})
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
      case "opencode": {
        if (!this.config.enableOpencodeExecution) {
          throw new OpencodeExecutionError(
            "OPENCODE_DISABLED",
            "The server's configured AI provider (OpenCode) is currently disabled. An admin can switch providers with `/model-select`."
          );
        }

        const result = await runOpencodeRequest({
          ...request,
          ...(input.role ? { role: input.role } : {})
        }, this.logger);
        return result.text;
      }
      case "claude":
      default: {
        const result = await runClaudeRequest(request, this.logger);
        return result.text;
      }
    }
  }

  private formatReviewSummaryMessage(input: {
    requestId: number;
    branchName: string;
    reviewRunId: number;
    diffHeadSha: string;
    reviewersSucceeded: number;
    reviewersAttempted: number;
    artifactPath: string;
    summary: {
      executiveSummary: string;
      blockingIssues: Array<{ title: string }>;
      nonBlockingIssues: Array<{ title: string }>;
      missingTests: string[];
      outstandingConcerns: string[];
      verdict: "ready_for_pr" | "revise";
    };
  }): string[] {
    const header = `**Adversarial review completed**`;
    const body = [
      `Request: #${input.requestId}`,
      `Review run: #${input.reviewRunId}`,
      `Branch: \`${input.branchName}\``,
      `Reviewed commit: \`${input.diffHeadSha}\``,
      `Reviewers: ${input.reviewersSucceeded}/${input.reviewersAttempted} succeeded`,
      `Verdict: \`${input.summary.verdict}\``,
      `Artifact: \`${input.artifactPath}\``,
      "",
      input.summary.executiveSummary,
      "",
      `Blocking issues (${input.summary.blockingIssues.length}):`,
      ...(input.summary.blockingIssues.length > 0
        ? input.summary.blockingIssues.map((issue) => `- ${issue.title}`)
        : ["- None"]),
      "",
      `Non-blocking issues (${input.summary.nonBlockingIssues.length}):`,
      ...(input.summary.nonBlockingIssues.length > 0
        ? input.summary.nonBlockingIssues.map((issue) => `- ${issue.title}`)
        : ["- None"]),
      "",
      `Missing tests (${input.summary.missingTests.length}):`,
      ...(input.summary.missingTests.length > 0
        ? input.summary.missingTests.map((item) => `- ${item}`)
        : ["- None"]),
      "",
      `Outstanding concerns (${input.summary.outstandingConcerns.length}):`,
      ...(input.summary.outstandingConcerns.length > 0
        ? input.summary.outstandingConcerns.map((item) => `- ${item}`)
        : ["- None"])
    ].join("\n");
    return splitPlainTextForDiscord(body, header);
  }

  private async handleReview(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.channel?.isThread()) {
      await interaction.reply({ content: "`/review` must be run inside a request thread.", ephemeral: true });
      return;
    }

    const reviewThread = interaction.channel;
    const parentId = reviewThread.parentId;
    if (!parentId) {
      await interaction.reply({ content: "Could not resolve the parent repo channel for this thread.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    if (this.requestQueue.hasResourceWork(interaction.guildId, interaction.channelId)) {
      await interaction.editReply("Another operation in this thread is already queued or running. Wait for it to finish before reviewing.");
      return;
    }

    const currentRequest = this.db.getRequestByThreadId(interaction.channelId);
    if (currentRequest && isActiveRequestStatus(currentRequest.status)) {
      await interaction.editReply("The latest request in this thread is still queued or running. Wait for it to finish before reviewing.");
      return;
    }

    const latestRequest = this.db.getLatestRequestWithWorkspaceByThreadId(interaction.channelId);
    if (!latestRequest?.worktree_path || !latestRequest.branch_name) {
      await interaction.editReply("This thread does not have a tracked request branch. Run `/ask` first and keep the worktree attached.");
      return;
    }

    const isOwner = latestRequest.user_id === interaction.user.id;
    const canManageGuild = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
    if (!isOwner && !canManageGuild) {
      await interaction.editReply("Only the original requester or a user with `Manage Server` can run `/review` for this branch.");
      return;
    }

    if (!existsSync(latestRequest.worktree_path)) {
      await interaction.editReply("The tracked worktree for this thread no longer exists. Start a new `/ask` request before reviewing.");
      return;
    }

    const repo = this.db.getRepoByChannelId(interaction.guildId, parentId);
    if (!repo) {
      await interaction.editReply("This thread is not attached to a connected repository channel. Run `/connect-repo` first.");
      return;
    }

    const configError = await this.validateReviewConfig(interaction.guildId);
    if (configError) {
      await interaction.editReply(configError);
      return;
    }

    try {
      const result = await new Promise<Awaited<ReturnType<typeof runAdversarialReview>>>((resolve, reject) => {
        this.requestQueue.enqueue(interaction.guildId!, async () => {
          try {
            await reviewThread.send("Adversarial review started.");
            const autoCommitted = await autoCommitDirtyWorktree(latestRequest.worktree_path!);
            if (autoCommitted) {
              await reviewThread.send("Uncommitted changes in the worktree were auto-committed for review.");
            }

            const runners = this.buildReviewRunners({
              guildId: interaction.guildId!,
              repoId: repo.id,
              threadId: interaction.channelId
            });
            const threadHistory = await this.buildThreadHistory(reviewThread);
            resolve(await runAdversarialReview({
              db: this.db,
              logger: this.logger,
              requestId: latestRequest.id,
              threadId: interaction.channelId,
              repoFullName: repo.full_name,
              branchName: latestRequest.branch_name!,
              worktreePath: latestRequest.worktree_path!,
              artifactRootPath: latestRequest.worktree_path!,
              threadHistory,
              analyzer: runners.analyzer,
              reviewers: runners.reviewers,
              judge: runners.judge,
              summarizer: runners.summarizer,
              stageTimeoutMs: this.config.askExecutionTimeoutMs,
              reviewerTimeoutMs: this.config.reviewerTimeoutMs,
              totalTimeoutMs: this.config.askExecutionTimeoutMs * 2,
              reviewConcurrency: this.config.reviewConcurrency,
              maxConsensusRounds: this.getReviewRounds(interaction.guildId!),
              onProgress: async (event: ReviewProgressEvent) => {
                switch (event.type) {
                  case "analyzer-start":
                    await reviewThread.send("Analyzing change intent…");
                    break;
                  case "analyzer-complete":
                    await reviewThread.send("Analysis complete.");
                    break;
                  case "round-start":
                    await reviewThread.send(`Round ${event.round}/${event.maxRounds}: reviewing…`);
                    break;
                  case "round-complete":
                    if (event.consensusReached) {
                      await reviewThread.send(`Round ${event.round}/${event.maxRounds}: consensus reached.`);
                    } else {
                      await reviewThread.send(`Round ${event.round}/${event.maxRounds} complete.`);
                    }
                    break;
                  case "summarizer-start":
                    await reviewThread.send("Synthesizing final verdict…");
                    break;
                }
              }
            }));
          } catch (error) {
            reject(error);
          }
        }, interaction.channelId);
      });

      for (const chunk of this.formatReviewSummaryMessage({
        requestId: latestRequest.id,
        branchName: latestRequest.branch_name,
        reviewRunId: result.reviewRunId,
        diffHeadSha: result.diffHeadSha,
        reviewersSucceeded: result.reviewersSucceeded,
        reviewersAttempted: result.reviewersAttempted,
        artifactPath: result.artifactPath,
        summary: result.summary
      })) {
        await interaction.channel.send(chunk);
      }
      await this.bestEffortLongRunningEditReply(
        interaction,
        `Review completed for \`${repo.full_name}\` at \`${result.diffHeadSha}\` with verdict \`${result.summary.verdict}\`.`,
        "review completion acknowledgement"
      );
    } catch (error) {
      if (error instanceof GitWorkspaceError) {
        const detail = error.code === "AUTO_COMMIT_FAILED"
          ? "The worktree has changes that could not be auto-committed. This usually means the repository has a pre-existing conflict or an unexpected git state. Commit or stash changes manually and try again."
          : "Git is not available on this server. The review cannot prepare the worktree. Contact the server administrator.";
        const preflightMessage = error.code === "AUTO_COMMIT_FAILED"
          ? "Review preflight failed: The worktree could not be auto-committed. Commit or stash changes manually and try again."
          : "Review preflight failed: Git is not available on this server. Contact the server administrator.";
        await interaction.channel.send(`**Auto-commit failed** — ${detail}`);
        await this.bestEffortLongRunningEditReply(interaction, preflightMessage, "review preflight acknowledgement");
        return;
      }

      const message = this.describeExecutionError(error);
      await interaction.channel.send(`**Adversarial review failed**\n\n${clipForDiscord(message, DISCORD_MESSAGE_LIMIT - 40)}`);
      await this.bestEffortLongRunningEditReply(
        interaction,
        `Review failed: ${message}`,
        "review failure acknowledgement"
      );
    }
  }

  private async bestEffortLongRunningEditReply(
    interaction: ChatInputCommandInteraction,
    content: string,
    operation: string
  ): Promise<void> {
    try {
      await interaction.editReply(content);
    } catch (error) {
      // Never rethrow: by this point the durable outcome has already been
      // delivered (or the operation is admin-ephemeral by design), and callers
      // in catch blocks would turn an ack failure into a misleading
      // operation-failed message. Expired interaction tokens are expected for
      // long-running work; anything else is a real delivery problem and is
      // logged at error level so it stays visible.
      if (this.isExpiredInteractionError(error)) {
        this.logger.warn(
          { error, interactionId: interaction.id, operation },
          "Long-running interaction acknowledgement expired after durable delivery"
        );
      } else {
        this.logger.error(
          { error, interactionId: interaction.id, operation },
          "Long-running interaction acknowledgement failed for a reason other than token expiry"
        );
      }
    }
  }

  private isExpiredInteractionError(error: unknown): boolean {
    // 50027 = Invalid Webhook Token (interaction token past its 15-minute
    // lifetime); 10062 = Unknown interaction (token no longer resolvable).
    const code = (error as { code?: unknown })?.code;
    if (code === 50027 || code === 10062) return true;
    const message = error instanceof Error ? error.message : String(error);
    return /50027|10062|Invalid Webhook Token|Unknown interaction/iu.test(message);
  }

  private async handleRevise(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.channel?.isThread()) {
      await interaction.reply({ content: "`/revise` must be run inside a request thread.", ephemeral: true });
      return;
    }

    const parentId = interaction.channel.parentId;
    if (!parentId) {
      await interaction.reply({ content: "Could not resolve the parent repo channel for this thread.", ephemeral: true });
      return;
    }

    const latestRequest = this.db.getLatestRequestWithWorkspaceByThreadId(interaction.channelId);
    if (!latestRequest?.worktree_path || !latestRequest.branch_name) {
      await interaction.reply({
        content: "This thread does not have a tracked request branch. Run `/ask` or `/plan` first.",
        ephemeral: true
      });
      return;
    }

    if (!existsSync(latestRequest.worktree_path)) {
      await interaction.reply({
        content: "The tracked worktree for this thread no longer exists. Start a new `/plan` request before revising.",
        ephemeral: true
      });
      return;
    }

    const repo = this.db.getRepoByChannelId(interaction.guildId, parentId);
    if (!repo) {
      await interaction.reply({
        content: "This thread is not attached to a connected repository channel. Run `/connect-repo` first.",
        ephemeral: true
      });
      return;
    }

    const findingsRaw = interaction.options.getString("findings");
    const findings = findingsRaw?.trim() ? findingsRaw : null;
    const worktreePath: string = latestRequest.worktree_path;
    const branchName: string = latestRequest.branch_name;
    const sourceRequestId = latestRequest.id;

    const isOwner = latestRequest.user_id === interaction.user.id;
    const canManageGuild = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
    if (!isOwner && !canManageGuild) {
      await interaction.reply({
        content: "Only the original requester or a user with `Manage Server` can run `/revise` for this branch.",
        ephemeral: true
      });
      return;
    }

    const threadLatest = this.db.getRequestByThreadId(interaction.channelId);
    if (threadLatest && isActiveRequestStatus(threadLatest.status)) {
      await interaction.reply({
        content: "The latest request in this thread is still queued or running. Wait for it to finish before revising.",
        ephemeral: true
      });
      return;
    }

    if (this.requestQueue.hasResourceWork(interaction.guildId, interaction.channelId)) {
      await interaction.reply({
        content: "Another operation in this thread is already queued or running. Wait for it to finish before revising.",
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    let revisionRequestId: number | null = null;
    let roles: { planner: ResolvedModelRole; implementer: ResolvedModelRole };
    try {
      const revisionRequest = this.db.createRequest({ 
        guildId: interaction.guildId,
        repoId: repo.id,
        channelId: parentId,
        threadId: interaction.channelId,
        userId: latestRequest.user_id,
        prompt: latestRequest.prompt,
        status: "queued",
        revisionOfRequestId: sourceRequestId
      });
      revisionRequestId = revisionRequest.id;
      this.db.updateRequestWorkspace(revisionRequest.id, worktreePath, branchName);

      roles = await this.resolvePlanRoleModels(interaction.guildId);

      this.requestQueue.enqueue(interaction.guildId, async () => {
        await this.runReviseRequest({
          requestId: revisionRequest.id,
          sourceRequestId,
          threadId: interaction.channelId,
          repoId: repo.id,
          repo: {
            owner: repo.owner,
            repo: repo.repo,
            fullName: repo.full_name
          },
          prompt: latestRequest.prompt,
          worktreePath,
          branchName,
          planner: roles.planner,
          implementer: roles.implementer,
          findings
        });
      }, interaction.channelId);
    } catch (error) {
      if (revisionRequestId !== null) {
        try {
          this.db.updateRequestStatus(revisionRequestId, "failed");
        } catch (statusError) {
          this.logger.warn({ error: statusError, requestId: revisionRequestId }, "Failed to mark revision setup request failed");
        }
      }
      const message = this.describeExecutionError(error);
      this.logger.error({ error, sourceRequestId, revisionRequestId }, "Revision setup failed");
      try {
        await interaction.editReply(`Revision setup failed: ${clipForDiscord(message, 1500)}`);
      } catch {
        await interaction.followUp({ content: `Revision setup failed: ${clipForDiscord(message, 1500)}`, ephemeral: true });
      }
      return;
    }

    try {
      await interaction.channel!.send(`Revision queued for request #${sourceRequestId}.`);
    } catch (error) {
      this.logger.warn({ error, sourceRequestId, revisionRequestId }, "Failed to send revision start message");
    }

    const planningProvider = AI_PROVIDER_LABELS[roles.planner.provider];
    const implementerProvider = AI_PROVIDER_LABELS[roles.implementer.provider];
    await interaction.editReply(
      `Revision queued as request #${revisionRequestId} for request #${sourceRequestId}. Planner: ${planningProvider}; implementer: ${implementerProvider}.`
    );
  }

  private async handlePr(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.channel?.isThread()) {
      await interaction.reply({ content: "`/pr` must be run inside a request thread.", ephemeral: true });
      return;
    }

    const prThread = interaction.channel;
    const parentId = prThread.parentId;
    if (!parentId) {
      await interaction.reply({ content: "Could not resolve the parent repo channel for this thread.", ephemeral: true });
      return;
    }

    const currentRequest = this.db.getRequestByThreadId(interaction.channelId);
    if (currentRequest && isActiveRequestStatus(currentRequest.status)) {
      await interaction.reply({
        content: "The latest request in this thread is still queued or running. Wait for it to finish before opening a PR.",
        ephemeral: true
      });
      return;
    }

    const latestRequest = this.db.getLatestRequestWithWorkspaceByThreadId(interaction.channelId);
    if (!latestRequest?.worktree_path || !latestRequest.branch_name) {
      await interaction.reply({
        content: "This thread does not have a tracked request branch. Run `/ask` or `/plan` first and keep the worktree attached.",
        ephemeral: true
      });
      return;
    }

    const isOwner = latestRequest.user_id === interaction.user.id;
    const canManageGuild = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
    if (!isOwner && !canManageGuild) {
      await interaction.reply({
        content: "Only the original requester or a user with `Manage Server` can open a PR for this branch.",
        ephemeral: true
      });
      return;
    }

    if (!existsSync(latestRequest.worktree_path)) {
      await interaction.reply({
        content: "The tracked worktree for this thread no longer exists. Start a new `/ask` or `/plan` request before opening a PR.",
        ephemeral: true
      });
      return;
    }

    const repo = this.db.getRepoByChannelId(interaction.guildId, parentId);
    if (!repo) {
      await interaction.reply({
        content: "This thread is not attached to a connected repository channel. Run `/connect-repo` first.",
        ephemeral: true
      });
      return;
    }

    const latestReview = this.db.getLatestCompletedReviewRunForBranch(latestRequest.id, latestRequest.branch_name);
    if (!latestReview) {
      await interaction.reply({
        content: "Run `/review` first. `/pr` requires a completed review for this branch.",
        ephemeral: true
      });
      return;
    }

    if (latestReview.final_verdict !== "ready_for_pr") {
      await interaction.reply({
        content: `The latest completed review verdict is \`${latestReview.final_verdict ?? "unknown"}\`, not \`ready_for_pr\`. Address the review and run \`/review\` again before \`/pr\`.`,
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    if (this.requestQueue.hasResourceWork(interaction.guildId, interaction.channelId)) {
      await interaction.editReply("Another operation in this thread is already queued or running. Wait for it to finish before opening a PR.");
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        this.requestQueue.enqueue(interaction.guildId!, async () => {
          try {
            if (await hasUncommittedChangesExcluding(latestRequest.worktree_path!, ["docs/reviews/"])) {
              await this.bestEffortLongRunningEditReply(
                interaction,
                "The worktree has uncommitted changes. `/review` includes working-tree changes, but `/pr` can only push commits. Commit the reviewed changes, then run `/review` again before `/pr`.",
                "pr uncommitted changes warning"
              );
              resolve();
              return;
            }

            const currentHeadSha = await getHeadSha(latestRequest.worktree_path!, latestRequest.branch_name!);
            if (currentHeadSha !== latestReview.diff_head) {
              await this.bestEffortLongRunningEditReply(
                interaction,
                `The branch has changed since review. Latest review checked \`${latestReview.diff_head}\`, but current HEAD is \`${currentHeadSha}\`. Run \`/review\` again before \`/pr\`.`,
                "pr branch changed warning"
              );
              resolve();
              return;
            }

            await prThread.send(`Creating draft PR for \`${latestRequest.branch_name}\`.`);
            const base = await detectDefaultBranch(latestRequest.worktree_path!);
            await pushBranch(latestRequest.worktree_path!, latestRequest.branch_name!);

            const firstPromptLine = latestRequest.prompt.split("\n").map((line) => line.trim()).find(Boolean) ?? `Request #${latestRequest.id}`;
            const title = clipForPullRequestTitle(firstPromptLine);
            const body = [
              `Request: #${latestRequest.id}`,
              `Thread: ${prThread.url}`,
              `Review run: #${latestReview.id}`,
              `Reviewed SHA: ${latestReview.diff_head}`,
              latestReview.artifact_path ? `Review artifact: \`${latestReview.artifact_path}\`` : null,
              "",
              "Original prompt:",
              "",
              latestRequest.prompt
            ].filter((line): line is string => line !== null).join("\n");

            const prUrl = await createDraftPullRequest({
              worktreePath: latestRequest.worktree_path!,
              head: latestRequest.branch_name!,
              base: base.branchName,
              title,
              body
            });

            await prThread.send(`Draft PR opened: ${prUrl}`);
            await this.bestEffortLongRunningEditReply(
              interaction,
              `Draft PR opened for \`${repo.full_name}\`: ${prUrl}`,
              "pr creation success acknowledgement"
            );
            resolve();
          } catch (error) {
            reject(error);
          }
        }, interaction.channelId);
      });
    } catch (error) {
      const message = this.describeExecutionError(error);
      await interaction.channel.send(`**Draft PR creation failed**\n\n${clipForDiscord(message, DISCORD_MESSAGE_LIMIT - 40)}`);
      await this.bestEffortLongRunningEditReply(
        interaction,
        `PR creation failed: ${message}`,
        "pr creation failure acknowledgement"
      );
    }
  }

  private async handleUpdateClis(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "This command can only run in a Discord server.", ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the `Manage Server` permission to update provider CLIs.",
        ephemeral: true
      });
      return;
    }

    const selected = interaction.options.getString("provider") ?? "all";
    const packages = selected === "all"
      ? Object.values(PROVIDER_NPM_PACKAGES)
      : PROVIDER_NPM_PACKAGES[selected]
        ? [PROVIDER_NPM_PACKAGES[selected]!]
        : null;

    if (!packages) {
      await interaction.reply({
        content: `Unknown provider \`${selected}\`. Use \`claude\`, \`codex\`, \`gemini\`, \`opencode\`, or omit for all.`,
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const label = selected === "all" ? "All provider CLIs" : AI_PROVIDER_LABELS[selected as AiProvider] ?? selected;
    await interaction.editReply(`Updating ${label} to latest...`);

    this.requestQueue.enqueue(interaction.guildId, async () => {
      try {
        const { spawnCollect } = await import("../utils/spawnCollect.js");

        const result = await spawnCollect("npm", ["install", "-g", ...packages], {
          cwd: process.cwd(),
          env: { ...process.env },
          timeoutMs: 120_000,
          maxBuffer: 1024 * 1024
        });

        const installedList = packages.join(", ");
        const stderrTrimmed = result.stderr.trim();
        const body = [`Updated \`${installedList}\` to latest.`];
        if (stderrTrimmed) {
          body.push("", "```", stderrTrimmed.slice(0, 1500), "```");
        }
        await interaction.editReply(body.join("\n"));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Update failed.";
        this.logger.error({ error, provider: selected }, "Provider CLI update failed");
        await interaction.editReply(`Update failed: ${clipForDiscord(message, 1500)}`);
      }
    });
  }

  private async handleMemory(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.memPalace || !this.memPalace.isReady()) {
      await interaction.reply({
        content: "MemPalace is not enabled. Set `MEMPALACE_ENABLED=true` and ensure the `mempalace-mcp` binary is installed.",
        ephemeral: true
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);
    await interaction.deferReply({ ephemeral: true });

    try {
      if (subcommand === "search") {
        const query = interaction.options.getString("query", true);
        const result = await this.memPalace.search(query, { wing: BOT_MEMORY_WING });
        const body = result.trim() || "No results found.";
        for (const chunk of splitIntoDiscordMessages(body, "MemPalace")) {
          await interaction.followUp({ content: chunk, ephemeral: true });
        }
        await interaction.editReply(`Search results for \`${query}\`:`);
      } else if (subcommand === "status") {
        const result = await this.memPalace.status();
        const body = result.trim() || "No status available.";
        await interaction.editReply(clipForDiscord(body, DISCORD_MESSAGE_LIMIT));
      } else {
        await interaction.editReply("Unknown subcommand.");
      }
    } catch (err) {
      this.logger.error({ error: err }, "MemPalace command failed");
      await interaction.editReply("MemPalace query failed. Check logs for details.");
    }
  }

  private async runParsedIterativeImplementation(input: {
    requestId: number;
    workflow: "plan" | "revise";
    planText: string;
    repoFullName: string;
    originalPrompt: string;
    worktreePath: string;
    threadChannel: { send: (content: string) => Promise<unknown> };
    planner: ResolvedModelRole;
    implementer: ResolvedModelRole;
    env: NodeJS.ProcessEnv | undefined;
    timeoutMs: number;
    verificationTimeoutMs: number;
    memoryWing?: string | null | undefined;
  }): Promise<{
    tasks: IterativePlanTask[];
    overview: string;
    taskResults: IterativeTaskOutput[];
  }> {
    const parsed = parseIterativePlan(input.planText);
    if (!parsed || parsed.tasks.length === 0) {
      await input.threadChannel.send("Could not parse iterative plan as JSON. Running iterative mode with one task containing the planner output.");
    }

    let tasks: IterativePlanTask[];
    let overview: string;

    if (parsed && parsed.tasks.length > 0) {
      overview = parsed.overview;
      tasks = parsed.tasks;
      if (tasks.length > MAX_TASKS) {
        tasks = tasks.slice(0, MAX_TASKS);
        await input.threadChannel.send(`Warning: plan has more than ${MAX_TASKS} tasks. Using only the first ${MAX_TASKS}.`);
      }
    } else {
      overview = "Implement the request";
      tasks = [{ title: "Implement request", description: truncateText(input.planText, ITERATIVE_TASK_DESCRIPTION_LIMIT) }];
    }

    const taskListMessage = fitDiscordMessage(
      [`Plan completed. ${tasks.length} tasks:`, ...tasks.map((t, i) => `  ${i + 1}. ${t.title}`)],
      "Plan completed, but the task list was too long to display."
    );
    await input.threadChannel.send(taskListMessage);

    const taskResults = (await runIterativeTaskLoop({
      tasks,
      overview,
      originalPrompt: input.originalPrompt,
      repoFullName: input.repoFullName,
      worktreePath: input.worktreePath,
      requestId: input.requestId,
      workflow: input.workflow,
      threadChannel: input.threadChannel,
      plannerProvider: input.planner.provider,
      plannerModel: input.planner.model,
      implementerProvider: input.implementer.provider,
      implementerModel: input.implementer.model,
      runProviderText: async (opts) => this.runProviderText({
        ...opts,
        ...(opts.role === "implementation" && input.memoryWing
          ? { memoryWing: input.memoryWing }
          : {})
      }),
      timeoutMs: input.timeoutMs,
      verificationTimeoutMs: input.verificationTimeoutMs,
      env: input.env,
      getHeadSha,
      getDiffSinceRef,
      hasUncommittedChanges,
      autoCommitAll
    })).taskResults;

    return { tasks, overview, taskResults };
  }

  private async runPlanRequest(input: {
    requestId: number;
    threadId: string;
    repoId: number;
    repo: {
      owner: string;
      repo: string;
      fullName: string;
    };
    prompt: string;
    planner: ResolvedModelRole;
    implementer: ResolvedModelRole;
    iterative: boolean;
  }): Promise<void> {
    const startedAt = Date.now();
    let worktreePath: string | null = null;
    let branchName: string | null = null;
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

    const sendPreservedWorktreeNotice = async (): Promise<void> => {
      if (!worktreePath || !branchName || !threadChannel?.isThread()) {
        return;
      }

      try {
        await threadChannel.send(`The request branch \`${branchName}\` remains attached. Send a follow-up message or run \`/revise\` to continue; use \`/delete\` if you want to remove it.`);
      } catch (error) {
        this.logger.warn(
          { error, requestId: input.requestId, worktreePath, branchName },
          "Failed to send preserved worktree notice"
        );
      }
    };

    try {
      this.db.updateRequestStatus(input.requestId, "running");
      this.logger.info(
        {
          requestId: input.requestId,
          threadId: input.threadId,
          repo: input.repo.fullName,
          planner: input.planner,
          implementer: input.implementer
        },
        "Plan request started"
      );

      stage = "fetch-thread";
      const channel = await this.client.channels.fetch(input.threadId);
      if (!channel || !channel.isThread()) {
        markFailed();
        this.logger.error({ requestId: input.requestId, threadId: input.threadId }, "Plan request thread no longer available");
        return;
      }

      threadChannel = channel;
      for (const fallbackReason of [input.planner.fallbackReason, input.implementer.fallbackReason].filter(Boolean)) {
        await threadChannel.send(`Provider fallback: ${fallbackReason}`);
      }

      stage = "sync-repo";
      const checkout = await ensureRepoCheckedOutToMaster(this.config.reposRootPath, {
        owner: input.repo.owner,
        repo: input.repo.repo,
        fullName: input.repo.fullName
      });
      await this.prepareRepositoryMemory(input.repo, checkout.localPath, { queueMine: true });
      this.logger.info({ requestId: input.requestId, checkoutPath: checkout.localPath }, "Repository sync complete for plan request");

      stage = "create-worktree";
      const worktree = await createRequestWorktree(this.config.reposRootPath, {
        owner: input.repo.owner,
        repo: input.repo.repo,
        fullName: input.repo.fullName
      }, input.requestId);
      worktreePath = worktree.path;
      branchName = worktree.branchName;
      const memoryWing = await this.prepareWorktreeMemoryConfig(input.repo, worktreePath);
      this.db.updateRequestWorkspace(input.requestId, worktreePath, branchName);

      const executionEnvironment = this.installService.buildMinimalExecutionEnvironment({
        repoId: input.repoId,
        threadId: input.threadId
      });
      const env = executionEnvironment.env;

      stage = "planning";
      const plannerLabel = AI_PROVIDER_LABELS[input.planner.provider];
      const implementerLabel = AI_PROVIDER_LABELS[input.implementer.provider];
      await threadChannel.send(`${plannerLabel} planning started.`);

      const planPrompt = buildPlanPrompt({
        repoFullName: input.repo.fullName,
        requestPrompt: input.prompt,
        iterative: input.iterative,
        maxTasks: MAX_TASKS
      });

      const planText = await this.runProviderText({
        provider: input.planner.provider,
        prompt: planPrompt,
        cwd: worktreePath,
        timeoutMs: this.config.askExecutionTimeoutMs,
        role: "planner",
        diagnostics: {
          requestId: input.requestId,
          workflow: "plan",
          stage: "planning"
        },
        ...(input.planner.model ? { model: input.planner.model } : {}),
        env
      });
      if (!planText.trim()) {
        markFailed();
        await threadChannel.send("Planner produced no output; aborting before implementation.");
        await sendPreservedWorktreeNotice();
        this.logger.error({ requestId: input.requestId, durationMs: Date.now() - startedAt }, "Plan request failed with empty planner output");
        return;
      }

      for (const chunk of splitPlainTextForDiscord(planText, `**${plannerLabel} plan completed**`)) {
        await threadChannel.send(chunk);
      }

      if (input.iterative) {
        stage = "iterative-loop";
        const { tasks, overview, taskResults } = await this.runParsedIterativeImplementation({
          requestId: input.requestId,
          workflow: "plan",
          planText,
          repoFullName: input.repo.fullName,
          originalPrompt: input.prompt,
          worktreePath,
          threadChannel,
          planner: input.planner,
          implementer: input.implementer,
          env,
          timeoutMs: this.config.askExecutionTimeoutMs,
          verificationTimeoutMs: this.config.iterativeVerificationTimeoutMs,
          memoryWing
        });

        this.db.updateRequestStatus(input.requestId, "succeeded");
        statusFinalized = true;
        const approvedCount = taskResults.filter((result) => result.approved).length;
        const issueCount = taskResults.length - approvedCount;
        const outcomeLine = issueCount > 0
          ? `Plan implementation complete: ${approvedCount}/${taskResults.length} tasks approved, ${issueCount} reached max tweaks.`
          : `Plan implementation complete: ${approvedCount}/${taskResults.length} tasks approved.`;
        await threadChannel.send(`${outcomeLine} Run \`/review\` to review the working tree. Commit any remaining changes before \`/pr\`, then run \`/review\` again once the committed branch is ready.`);
        this.logger.info({ requestId: input.requestId, durationMs: Date.now() - startedAt }, "Iterative plan request succeeded");

        if (this.memPalace) {
          const taskSummaries = taskResults.map((r) => {
            const status = r.approved ? "approved" : `max-tweaks (${r.tweakAttempts})`;
            return `### ${r.title}\n- Status: ${status}\n- Implementer output:\n${r.implementerOutput}\n- Verification output:\n${r.verificationOutput}\n- Diff:\n${r.diff}`;
          }).join("\n\n");
          const drawerContent = [
            `# Iterative plan request #${input.requestId}: ${input.prompt}`,
            "",
            `Repo: ${input.repo.fullName}`,
            `Planner: ${input.planner.provider}${input.planner.model ? ` (${input.planner.model})` : ""}`,
            `Implementer: ${input.implementer.provider}${input.implementer.model ? ` (${input.implementer.model})` : ""}`,
            `Duration: ${Date.now() - startedAt}ms`,
            "",
            "## Plan",
            "",
            planText,
            "",
            "## Overview",
            "",
            overview,
            "",
            "## Task Results",
            "",
            taskSummaries
          ].join("\n");
          this.memPalace.addDrawer(drawerContent, BOT_MEMORY_WING, "requests").catch((err: unknown) => {
            this.logger.warn({ error: err, requestId: input.requestId }, "MemPalace addDrawer failed");
          });
        }
      } else {
        stage = "implementing";
        await threadChannel.send(`${implementerLabel} implementation started.`);
        const implementationPrompt = buildPlanImplementationPrompt({
          repoFullName: input.repo.fullName,
          originalPrompt: input.prompt,
          planText
        });
        const implementationText = await this.runProviderText({
          provider: input.implementer.provider,
          prompt: implementationPrompt,
          cwd: worktreePath,
          timeoutMs: this.config.askExecutionTimeoutMs,
          role: "implementation",
          diagnostics: {
            requestId: input.requestId,
            workflow: "plan",
            stage: "implementation"
          },
          ...(input.implementer.model ? { model: input.implementer.model } : {}),
          env,
          memoryWing
        });
        for (const chunk of splitIntoDiscordMessages(implementationText, implementerLabel)) {
          await threadChannel.send(chunk);
        }

        this.db.updateRequestStatus(input.requestId, "succeeded");
        statusFinalized = true;
        await threadChannel.send("Plan implementation complete. Run `/review` to review the working tree. Commit any remaining changes before `/pr`, then run `/review` again once the committed branch is ready.");
        this.logger.info({ requestId: input.requestId, durationMs: Date.now() - startedAt }, "Plan request succeeded");

        if (this.memPalace) {
          const drawerContent = [
            `# Plan request #${input.requestId}: ${input.prompt}`,
            "",
            `Repo: ${input.repo.fullName}`,
            `Planner: ${input.planner.provider}${input.planner.model ? ` (${input.planner.model})` : ""}`,
            `Implementer: ${input.implementer.provider}${input.implementer.model ? ` (${input.implementer.model})` : ""}`,
            `Duration: ${Date.now() - startedAt}ms`,
            "",
            "## Plan",
            "",
            planText,
            "",
            "## Implementation Output",
            "",
            implementationText
          ].join("\n");
          this.memPalace.addDrawer(drawerContent, BOT_MEMORY_WING, "requests").catch((err: unknown) => {
            this.logger.warn({ error: err, requestId: input.requestId }, "MemPalace addDrawer failed");
          });
        }
      }
    } catch (error) {
      markFailed();
      const message = this.describeExecutionError(error);
      if (threadChannel && threadChannel.isThread()) {
        if (isProviderTimeout(error)) {
          const timeoutReport = await buildTimeoutReportInner(error, worktreePath, branchName, "plan", this.logger);
          for (const chunk of splitPlainTextForDiscord(timeoutReport, `**Plan request timed out during ${stage}**`)) {
            await threadChannel.send({ content: chunk, allowedMentions: { parse: [] } });
          }
          await sendPreservedWorktreeNotice();
        } else {
          await threadChannel.send(`**Plan request failed during ${stage}**\n\n${clipForDiscord(message, DISCORD_MESSAGE_LIMIT - 60)}`);
          await sendPreservedWorktreeNotice();
        }
      }
      this.logger.error({
        ...executionErrorLogFields(error),
        requestId: input.requestId,
        workflow: "plan",
        durationMs: Date.now() - startedAt,
        stage
      }, "Plan request failed");
    }
  }

  private async runPlanOcRequest(input: {
    requestId: number;
    threadId: string;
    repoId: number;
    repo: {
      owner: string;
      repo: string;
      fullName: string;
    };
    prompt: string;
    agentSnapshot: Awaited<ReturnType<typeof createOpencodePlanAgentSnapshot>>;
  }): Promise<void> {
    const startedAt = Date.now();
    let worktreePath: string | null = null;
    let branchName: string | null = null;
    let statusFinalized = false;
    let stage = "init";
    let threadChannel: Awaited<ReturnType<Client["channels"]["fetch"]>> | null = null;
    const agentSnapshot = input.agentSnapshot;

    const markFailed = (): void => {
      if (statusFinalized) {
        return;
      }
      this.db.updateRequestStatus(input.requestId, "failed");
      statusFinalized = true;
    };

    const sendPreservedWorktreeNotice = async (): Promise<void> => {
      if (!worktreePath || !branchName || !threadChannel?.isThread()) {
        return;
      }

      try {
        await threadChannel.send(`The request branch \`${branchName}\` remains attached. Send a follow-up message or run \`/revise\` to continue; use \`/delete\` if you want to remove it.`);
      } catch (error) {
        this.logger.warn(
          { error, requestId: input.requestId, worktreePath, branchName },
          "Failed to send preserved OpenCode-native worktree notice"
        );
      }
    };

    try {
      this.db.updateRequestStatus(input.requestId, "running");
      this.logger.info(
        { requestId: input.requestId, threadId: input.threadId, repo: input.repo.fullName },
        "OpenCode-native plan request started"
      );

      stage = "fetch-thread";
      const channel = await this.client.channels.fetch(input.threadId);
      if (!channel || !channel.isThread()) {
        markFailed();
        this.logger.error(
          { requestId: input.requestId, threadId: input.threadId },
          "OpenCode-native plan request thread no longer available"
        );
        return;
      }
      threadChannel = channel;

      stage = "sync-repo";
      const checkout = await ensureRepoCheckedOutToMaster(this.config.reposRootPath, {
        owner: input.repo.owner,
        repo: input.repo.repo,
        fullName: input.repo.fullName
      });
      await this.prepareRepositoryMemory(input.repo, checkout.localPath, { queueMine: true });

      stage = "create-worktree";
      const worktree = await createRequestWorktree(this.config.reposRootPath, {
        owner: input.repo.owner,
        repo: input.repo.repo,
        fullName: input.repo.fullName
      }, input.requestId);
      worktreePath = worktree.path;
      branchName = worktree.branchName;
      const memoryWing = await this.prepareWorktreeMemoryConfig(input.repo, worktreePath);
      this.db.updateRequestWorkspace(input.requestId, worktreePath, branchName);

      const executionEnvironment = this.installService.buildMinimalExecutionEnvironment({
        repoId: input.repoId,
        threadId: input.threadId
      });

      const env: NodeJS.ProcessEnv = {
        ...executionEnvironment.env,
        OPENCODE_CONFIG_DIR: agentSnapshot.configDir
      };
      delete env.OPENCODE_CONFIG_CONTENT;

      stage = "plan-and-implement";
      const plannerModel = agentSnapshot.models.planner ?? "OpenCode default";
      const implementerModel = agentSnapshot.models.implementer ?? "inherit planner";
      await threadChannel.send(
        `OpenCode-native planning and implementation started in one CLI session. Planner: \`${plannerModel}\`; implementer: \`${implementerModel}\`.`
      );

      const result = await this.runCheckpointedPlanOc({
        requestId: input.requestId,
        prompt: buildRepositoryMemoryScopedPrompt({
          prompt: buildOpencodePlanWorkflowPrompt({
            repoFullName: input.repo.fullName,
            requestPrompt: input.prompt,
            implementerAgent: OPENCODE_IMPLEMENT_OC_AGENT
          }),
          memoryWing
        }),
        cwd: worktreePath,
        env,
        threadChannel
      });

      for (const chunk of splitPlainTextForDiscord(
        result.text,
        "**OpenCode-native plan and implementation completed**"
      )) {
        await threadChannel.send(chunk);
      }

      this.db.updateRequestStatus(input.requestId, "succeeded");
      statusFinalized = true;
      await threadChannel.send(
        "OpenCode-native plan implementation complete. Run `/review` to review the working tree. Commit any remaining changes before `/pr`, then run `/review` again once the committed branch is ready."
      );
      this.logger.info(
        { requestId: input.requestId, durationMs: Date.now() - startedAt },
        "OpenCode-native plan request succeeded"
      );

      if (this.memPalace) {
        const drawerContent = [
          `# OpenCode-native plan request #${input.requestId}: ${input.prompt}`,
          "",
          `Repo: ${input.repo.fullName}`,
          `Planner agent: ${OPENCODE_PLAN_OC_AGENT} (${plannerModel})`,
          `Implementer agent: ${OPENCODE_IMPLEMENT_OC_AGENT} (${implementerModel})`,
          `OpenCode session: ${result.sessionId ?? "(not reported)"}`,
          `Process segments: ${result.segments}`,
          `Completed managed tasks: ${result.completedTasks.length}`,
          `Duration: ${Date.now() - startedAt}ms`,
          "",
          "## Agent Output",
          "",
          result.text
        ].join("\n");
        this.memPalace.addDrawer(drawerContent, BOT_MEMORY_WING, "requests").catch((error: unknown) => {
          this.logger.warn({ error, requestId: input.requestId }, "MemPalace addDrawer failed");
        });
      }
    } catch (error) {
      markFailed();
      const message = this.describeExecutionError(error);
      if (threadChannel?.isThread()) {
        if (isProviderTimeout(error)) {
          const timeoutReport = await buildTimeoutReportInner(
            error,
            worktreePath,
            branchName,
            "OpenCode-native plan",
            this.logger
          );
          for (const chunk of splitPlainTextForDiscord(
            timeoutReport,
            `**OpenCode-native plan request timed out during ${stage}**`
          )) {
            await threadChannel.send({ content: chunk, allowedMentions: { parse: [] } });
          }
        } else {
          await threadChannel.send(
            `**OpenCode-native plan request failed during ${stage}**\n\n${clipForDiscord(message, DISCORD_MESSAGE_LIMIT - 80)}`
          );
        }
        await sendPreservedWorktreeNotice();
      }
      this.logger.error({
        ...executionErrorLogFields(error),
        requestId: input.requestId,
        workflow: "plan-oc",
        durationMs: Date.now() - startedAt,
        stage
      }, "OpenCode-native plan request failed");
    } finally {
      await agentSnapshot.cleanup().catch((error: unknown) => {
        this.logger.warn({ error, requestId: input.requestId }, "Failed to remove OpenCode-native agent snapshot");
      });
    }
  }

  private async runCheckpointedPlanOc(input: {
    requestId: number;
    prompt: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    threadChannel: { send: (content: string) => Promise<unknown> };
  }): Promise<{
    text: string;
    sessionId: string | null;
    completedTasks: CompletedOpencodeTask[];
    segments: number;
  }> {
    const overallStartedAt = Date.now();
    const completedTasks = new Map<string, CompletedOpencodeTask>();
    let sessionId: string | undefined;
    let segment = 0;
    let prompt = input.prompt;

    const recordTasks = (tasks: CompletedOpencodeTask[] | undefined): number => {
      const before = completedTasks.size;
      for (const task of tasks ?? []) {
        if (task.subagent === OPENCODE_IMPLEMENT_OC_AGENT) {
          completedTasks.set(task.id, task);
        }
      }
      return completedTasks.size - before;
    };

    while (true) {
      const elapsedMs = Date.now() - overallStartedAt;
      const remainingMs = this.config.askExecutionTimeoutMs - elapsedMs;
      if (remainingMs <= 0) {
        const error = new OpencodeExecutionError(
          "TIMEOUT",
          `OpenCode exceeded the total plan-oc execution timeout of ${String(this.config.askExecutionTimeoutMs)}ms.`
        );
        error.timeoutKind = "total";
        error.timeoutMs = this.config.askExecutionTimeoutMs;
        if (sessionId) error.providerSessionId = sessionId;
        throw error;
      }

      segment++;
      const segmentTimeoutMs = Math.min(this.config.planOcSegmentTimeoutMs, remainingMs);

      try {
        const result = await runOpencodeAgentRequest({
          prompt,
          cwd: input.cwd,
          timeoutMs: segmentTimeoutMs,
          idleTimeoutMs: Math.min(this.config.providerIdleTimeoutMs, segmentTimeoutMs),
          env: input.env,
          agent: OPENCODE_PLAN_OC_AGENT,
          ...(sessionId ? { sessionId } : {}),
          diagnostics: {
            requestId: input.requestId,
            workflow: "plan-oc",
            stage: "plan-and-implement",
            segment
          }
        }, this.logger);

        recordTasks(result.completedTasks);
        sessionId = result.sessionId ?? sessionId;
        if (completedTasks.size === 0) {
          throw new OpencodeExecutionError(
            "FAILED",
            `OpenCode primary agent did not complete the required \`${OPENCODE_IMPLEMENT_OC_AGENT}\` subagent task.`
          );
        }

        this.logger.info({
          requestId: input.requestId,
          workflow: "plan-oc",
          stage: "plan-and-implement",
          segment,
          sessionId,
          completedTaskCount: completedTasks.size,
          durationMs: Date.now() - overallStartedAt
        }, "OpenCode-native plan session completed from checkpoints");

        return {
          text: result.text,
          sessionId: sessionId ?? null,
          completedTasks: [...completedTasks.values()],
          segments: segment
        };
      } catch (error) {
        if (!(error instanceof OpencodeExecutionError) || error.code !== "TIMEOUT") {
          throw error;
        }

        const progress = parseOpencodeJsonEvents(error.partialStdout ?? "");
        const newTaskCount = recordTasks(progress.completedTasks);
        sessionId = progress.sessionId ?? error.providerSessionId ?? sessionId;
        const checkpoint = [...completedTasks.values()];
        const remainingAfterTimeoutMs = this.config.askExecutionTimeoutMs - (Date.now() - overallStartedAt);

        this.logger.warn({
          ...executionErrorLogFields(error),
          requestId: input.requestId,
          workflow: "plan-oc",
          stage: "plan-and-implement",
          segment,
          sessionId,
          timeoutKind: error.timeoutKind,
          timeoutMs: error.timeoutMs,
          lastActivity: error.lastActivity,
          newTaskCount,
          completedTaskCount: checkpoint.length,
          completedTaskIds: checkpoint.map((task) => task.id),
          remainingTotalMs: Math.max(0, remainingAfterTimeoutMs)
        }, "OpenCode-native plan segment timed out");

        if (!sessionId || newTaskCount === 0 || remainingAfterTimeoutMs <= 0) {
          throw error;
        }

        await input.threadChannel.send(
          `OpenCode-native checkpoint saved after segment ${segment}: ${checkpoint.length} managed implementation task${checkpoint.length === 1 ? "" : "s"} completed. Resuming session \`${sessionId}\` with ${Math.ceil(remainingAfterTimeoutMs / 60_000)} minute(s) left in the original total budget.`
        ).catch((sendError: unknown) => {
          this.logger.warn(
            { error: sendError, requestId: input.requestId, segment },
            "Failed to post plan-oc checkpoint notice"
          );
        });

        const completedLines = checkpoint.map((task, index) => {
          const description = task.description ? ` - ${task.description}` : "";
          return `${index + 1}. ${task.id}${description}`;
        });
        prompt = [
          "Continue the existing Actuarius plan-oc workflow from the saved checkpoint.",
          "Do not repeat completed implementation tasks. Inspect their resulting diff, then delegate only the remaining work to the managed implementation agent.",
          "",
          "Completed managed task checkpoints:",
          ...completedLines,
          "",
          "Finish validation and return the required final report when all acceptance criteria are met."
        ].join("\n");
      }
    }
  }

  private async runReviseRequest(input: {
    requestId: number;
    sourceRequestId: number;
    threadId: string;
    repoId: number;
    repo: { owner: string; repo: string; fullName: string };
    prompt: string;
    worktreePath: string;
    branchName: string;
    planner: ResolvedModelRole;
    implementer: ResolvedModelRole;
    findings: string | null;
  }): Promise<void> {
    const startedAt = Date.now();
    let statusFinalized = false;
    let stage = "init";
    let threadChannel: Awaited<ReturnType<Client["channels"]["fetch"]>> | null = null;

    const markFailed = (): void => {
      if (statusFinalized) return;
      this.db.updateRequestStatus(input.requestId, "failed");
      statusFinalized = true;
    };

    const findLatestReviewSummary = (): string | null => {
      const visited = new Set<number>();
      let requestId: number | null = input.sourceRequestId;

      while (requestId !== null && !visited.has(requestId)) {
        visited.add(requestId);
        const latestReview = this.db.getLatestCompletedReviewRunForBranch(requestId, input.branchName);
        if (latestReview?.summary_markdown) {
          return latestReview.summary_markdown;
        }

        requestId = this.db.getRequestById(requestId)?.revision_of_request_id ?? null;
      }

      return null;
    };

    try {
      this.db.updateRequestStatus(input.requestId, "running");
      this.logger.info(
        { requestId: input.requestId, threadId: input.threadId, repo: input.repo.fullName, planner: input.planner, implementer: input.implementer },
        "Revise request started"
      );

      stage = "fetch-thread";
      const channel = await this.client.channels.fetch(input.threadId);
      if (!channel || !channel.isThread()) {
        markFailed();
        this.logger.error({ requestId: input.requestId, threadId: input.threadId }, "Revise request thread no longer available");
        return;
      }

      threadChannel = channel;
      for (const fallbackReason of [input.planner.fallbackReason, input.implementer.fallbackReason].filter(Boolean)) {
        await threadChannel.send(`Provider fallback: ${fallbackReason}`);
      }

      const executionEnvironment = this.installService.buildMinimalExecutionEnvironment({
        repoId: input.repoId,
        threadId: input.threadId
      });
      const env = executionEnvironment.env;

      stage = "compute-diff";
      if (!existsSync(input.worktreePath)) {
        markFailed();
        await threadChannel.send("The tracked worktree for this thread no longer exists. Start a new `/plan` request before revising.");
        this.logger.error({ requestId: input.requestId, worktreePath: input.worktreePath }, "Revise request worktree no longer exists");
        return;
      }
      const memoryWing = await this.prepareWorktreeMemoryConfig(input.repo, input.worktreePath);
      const reviewDiff = await getReviewDiff(input.worktreePath, { headRef: input.branchName, excludePaths: ["docs/reviews/**"] });
      const currentDiff = reviewDiff.diffText;

      let reviewSummary: string | null = null;
      if (!input.findings) {
        reviewSummary = findLatestReviewSummary();
      }

      stage = "planning";
      const plannerLabel = AI_PROVIDER_LABELS[input.planner.provider];
      await threadChannel.send(`${plannerLabel} revision planning started.`);

      const planPrompt = buildRevisionPlanPrompt({
        repoFullName: input.repo.fullName,
        originalPrompt: input.prompt,
        currentDiff,
        maxTasks: MAX_TASKS,
        findings: input.findings,
        reviewSummary
      });

      const planText = await this.runProviderText({
        provider: input.planner.provider,
        prompt: planPrompt,
        cwd: input.worktreePath,
        timeoutMs: this.config.askExecutionTimeoutMs,
        role: "planner",
        diagnostics: {
          requestId: input.requestId,
          workflow: "revise",
          stage: "planning"
        },
        ...(input.planner.model ? { model: input.planner.model } : {}),
        env
      });

      if (!planText.trim()) {
        markFailed();
        await threadChannel.send("Planner produced no output; aborting revision.");
        this.logger.error({ requestId: input.requestId, durationMs: Date.now() - startedAt }, "Revise request failed with empty planner output");
        return;
      }

      for (const chunk of splitPlainTextForDiscord(planText, `**${plannerLabel} revision plan completed**`)) {
        await threadChannel.send(chunk);
      }

      stage = "iterative-loop";
      const { tasks, overview, taskResults } = await this.runParsedIterativeImplementation({
        requestId: input.requestId,
        workflow: "revise",
        planText,
        repoFullName: input.repo.fullName,
        originalPrompt: input.prompt,
        worktreePath: input.worktreePath,
        threadChannel,
        planner: input.planner,
        implementer: input.implementer,
        env,
        timeoutMs: this.config.askExecutionTimeoutMs,
        verificationTimeoutMs: this.config.iterativeVerificationTimeoutMs,
        memoryWing
      });

      this.db.updateRequestStatus(input.requestId, "succeeded");
      statusFinalized = true;
      const approvedCount = taskResults.filter((r) => r.approved).length;
      const issueCount = taskResults.length - approvedCount;
      const outcomeLine = issueCount > 0
        ? `Revision complete: ${approvedCount}/${taskResults.length} tasks approved, ${issueCount} reached max tweaks.`
        : `Revision complete: ${approvedCount}/${taskResults.length} tasks approved.`;
      await threadChannel.send(`${outcomeLine} Run \`/review\` again, then \`/pr\` once the verdict is \`ready_for_pr\`.`);
      this.logger.info({ requestId: input.requestId, durationMs: Date.now() - startedAt }, "Revise request succeeded");

      if (this.memPalace) {
        const taskSummaries = taskResults.map((r) => {
          const status = r.approved ? "approved" : `max-tweaks (${r.tweakAttempts})`;
          return `### ${r.title}\n- Status: ${status}\n- Implementer output:\n${r.implementerOutput}\n- Verification output:\n${r.verificationOutput}\n- Diff:\n${r.diff}`;
        }).join("\n\n");
        const drawerContent = [
          `# Revise request #${input.requestId}: ${input.prompt}`,
          "",
          `Repo: ${input.repo.fullName}`,
          `Source request: #${input.sourceRequestId}`,
          `Planner: ${input.planner.provider}${input.planner.model ? ` (${input.planner.model})` : ""}`,
          `Implementer: ${input.implementer.provider}${input.implementer.model ? ` (${input.implementer.model})` : ""}`,
          `Duration: ${Date.now() - startedAt}ms`,
          "",
          "## Revision Inputs",
          "",
          input.findings
            ? "### Explicit Findings"
            : reviewSummary
              ? "### Latest Review Summary"
              : "### Review Summary (none found)",
          "",
          input.findings ?? reviewSummary ?? "(none)",
          "",
          "### Current Branch Diff",
          "",
          currentDiff || "(no diff)",
          "",
          "## Revision Plan",
          "",
          planText,
          "",
          "## Overview",
          "",
          overview,
          "",
          "## Task Results",
          "",
          taskSummaries
        ].join("\n");
        this.memPalace.addDrawer(drawerContent, BOT_MEMORY_WING, "requests").catch((err: unknown) => {
          this.logger.warn({ error: err, requestId: input.requestId }, "MemPalace addDrawer failed");
        });
      }
    } catch (error) {
      markFailed();
      const message = this.describeExecutionError(error);
      if (threadChannel && threadChannel.isThread()) {
        if (isProviderTimeout(error)) {
          const timeoutReport = await buildTimeoutReportInner(error, input.worktreePath, input.branchName, "revision", this.logger);
          for (const chunk of splitPlainTextForDiscord(timeoutReport, `**Revision timed out during ${stage}**`)) {
            await threadChannel.send({ content: chunk, allowedMentions: { parse: [] } });
          }
        } else {
          await threadChannel.send(`**Revision failed during ${stage}**\n\n${clipForDiscord(message, DISCORD_MESSAGE_LIMIT - 60)}`);
        }
      }
      this.logger.error({
        ...executionErrorLogFields(error),
        requestId: input.requestId,
        workflow: "revise",
        durationMs: Date.now() - startedAt,
        stage
      }, "Revise request failed");
    }
  }

  private async runQueuedRequest(input: {
    requestId: number;
    threadId: string;
    repoId: number;
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
    attachments?: PendingAttachment[];
  }): Promise<void> {
    const startedAt = Date.now();
    const providerLabel = AI_PROVIDER_LABELS[input.provider];
    let worktreePath: string | null = null;
    let branchName: string | null = input.existingBranchName ?? null;
    let statusFinalized = false;
    let stage = "init";
    let threadChannel: Awaited<ReturnType<Client["channels"]["fetch"]>> | null = null;
    let memoryWing: string | null = null;

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
        memoryWing = await this.prepareWorktreeMemoryConfig(input.repo, worktreePath);
        this.logger.info({ requestId: input.requestId, worktreePath, branchName }, "Reusing existing worktree for follow-up");
      } else {
        stage = "sync-repo";
        this.logger.info({ requestId: input.requestId, repo: input.repo.fullName }, "Syncing repository before AI execution");
        const checkout = await ensureRepoCheckedOutToMaster(this.config.reposRootPath, {
          owner: input.repo.owner,
          repo: input.repo.repo,
          fullName: input.repo.fullName
        });
        await this.prepareRepositoryMemory(input.repo, checkout.localPath, { queueMine: true });
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
        memoryWing = await this.prepareWorktreeMemoryConfig(input.repo, worktreePath);
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
      effectivePrompt = buildRepositoryScopedPrompt({
        repoFullName: input.repo.fullName,
        prompt: effectivePrompt
      });
      if (input.promptTransformer && !input.existingWorktreePath) {
        effectivePrompt = input.promptTransformer(effectivePrompt);
      }

      if (input.attachments && input.attachments.length > 0) {
        const { promptSection } = await processAttachments(
          input.attachments,
          input.requestId,
          worktreePath!,
          {
            maxCount: this.config.attachmentMaxCount,
            maxFileSize: this.config.attachmentMaxFileSize,
            maxTotalSize: this.config.attachmentMaxTotalSize,
            maxInlineText: this.config.attachmentMaxInlineText,
          }
        );
        if (promptSection) {
          effectivePrompt += "\n\n" + promptSection;
        }
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

      const executionEnvironment = this.installService.buildMinimalExecutionEnvironment({
        repoId: input.repoId,
        threadId: input.threadId
      });

      const resultText = await this.runProviderText({
        provider: input.provider,
        prompt: effectivePrompt,
        cwd: worktreePath,
        env: executionEnvironment.env,
        memoryWing,
        diagnostics: {
          requestId: input.requestId,
          workflow: "ask",
          stage: "provider-execution"
        },
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

      if (this.memPalace) {
        const drawerContent = [
          `# Request #${input.requestId}: ${input.prompt}`,
          "",
          `Repo: ${input.repo.fullName}`,
          `Provider: ${input.provider}${input.model ? ` (${input.model})` : ""}`,
          `Duration: ${Date.now() - startedAt}ms`,
          "",
          "## Result",
          "",
          resultText,
        ].join("\n");
        this.memPalace.addDrawer(drawerContent, BOT_MEMORY_WING, "requests").catch((err: unknown) => {
          this.logger.warn({ error: err, requestId: input.requestId }, "MemPalace addDrawer failed");
        });
      }
    } catch (error) {
      markFailed();
      const message = this.describeExecutionError(error);
      if (threadChannel && threadChannel.isThread()) {
        if (isProviderTimeout(error)) {
          const timeoutReport = await buildTimeoutReportInner(error, worktreePath, branchName, providerLabel, this.logger);
          for (const chunk of splitPlainTextForDiscord(timeoutReport, `**${providerLabel} execution timed out**`)) {
            await threadChannel.send({ content: chunk, allowedMentions: { parse: [] } });
          }
        } else {
          await threadChannel.send(`**${providerLabel} execution failed**\n\n${clipForDiscord(message, DISCORD_MESSAGE_LIMIT - 40)}`);
        }
      }
      this.logger.error(
        {
          ...executionErrorLogFields(error),
          requestId: input.requestId,
          workflow: "ask",
          durationMs: Date.now() - startedAt,
          stage,
          provider: input.provider
        },
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

    if (error instanceof OpencodeExecutionError) {
      return error.message;
    }

    if (error instanceof RequestWorktreeError) {
      return `Worktree operation failed: ${error.message}`;
    }

    if (error instanceof GitWorkspaceError) {
      if (error.code === "AUTO_COMMIT_FAILED") {
        return `Auto-commit failed: ${error.message}. The worktree has changes that could not be committed; resolve conflicts manually and try again.`;
      }
      if (error.code === "GIT_UNAVAILABLE") {
        return "Git is not available on this server. Contact the server administrator.";
      }
      return `Repository sync failed: ${error.message}`;
    }

    if (error instanceof AdversarialReviewError) {
      return error.message;
    }

    if (error instanceof InstallServiceError) {
      return error.message;
    }

    if (error instanceof PullRequestServiceError) {
      return error.message;
    }

    if (error instanceof AttachmentError) {
      return error.message;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Unknown execution error.";
  }

  private describeInstallTarget(packageId: string, packageVersion?: string): string {
    if (isAptPackageId(packageId)) {
      const packageSpec = getAptPackageSpec(packageId) ?? packageVersion ?? packageId;
      return `APT package \`${packageSpec}\``;
    }

    return packageVersion ? `\`${packageId}@${packageVersion}\`` : `\`${packageId}\``;
  }

  private async buildThreadPromptWithHistory(channel: AnyThreadChannel, newMessageContent: string): Promise<string> {
    const fetched = await channel.messages.fetch({ limit: 50 });
    const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const history: Array<{ role: "user" | "assistant"; text: string }> = [];
    for (const msg of sorted) {
      const isBot = msg.author.id === this.client.user?.id;
      const entry = parseThreadEntry(msg.content, isBot, isBot ? [] : pendingAttachmentsFromMessage(msg));
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

    return buildThreadFollowUpPrompt({ history, newMessageContent });
  }

  private async buildThreadHistory(channel: AnyThreadChannel): Promise<string> {
    const fetched = await channel.messages.fetch({ limit: 50 });
    const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const lines: string[] = [];
    for (const msg of sorted) {
      const isBot = msg.author.id === this.client.user?.id;
      const entry = parseThreadEntry(msg.content, isBot, isBot ? [] : pendingAttachmentsFromMessage(msg));
      if (!entry) continue;
      lines.push(`[${entry.role === "user" ? "User" : "Assistant"}]: ${entry.text}`);
      lines.push("");
    }
    return lines.join("\n").trim();
  }

  public getCommandNames(): string[] {
    return commandBuilders.map((command) => command.name);
  }
}

// Module-level exports for testing — class methods delegate to these.
export function isProviderTimeout(error: unknown): boolean {
  return (
    (error instanceof ClaudeExecutionError && error.code === "TIMEOUT") ||
    (error instanceof CodexExecutionError && error.code === "TIMEOUT") ||
    (error instanceof GeminiExecutionError && error.code === "TIMEOUT") ||
    (error instanceof OpencodeExecutionError && error.code === "TIMEOUT")
  );
}

export function executionErrorLogFields(error: unknown): {
  error: unknown;
  timeoutKind?: ProviderTimeoutKind;
  timeoutMs?: number;
  providerSessionId?: string;
  lastActivity?: string;
} {
  if (!(error instanceof Error)) {
    return { error };
  }

  const providerError = error as Error & {
    code?: string;
    timeoutKind?: ProviderTimeoutKind;
    timeoutMs?: number;
    providerSessionId?: string;
    lastActivity?: string;
  };
  return {
    error: {
      type: providerError.name,
      message: providerError.message,
      stack: providerError.stack,
      code: providerError.code
    },
    ...(providerError.timeoutKind ? { timeoutKind: providerError.timeoutKind } : {}),
    ...(providerError.timeoutMs !== undefined ? { timeoutMs: providerError.timeoutMs } : {}),
    ...(providerError.providerSessionId ? { providerSessionId: providerError.providerSessionId } : {}),
    ...(providerError.lastActivity ? { lastActivity: providerError.lastActivity } : {})
  };
}

export async function buildTimeoutReportInner(
  error: unknown,
  worktreePath: string | null,
  branchName: string | null,
  providerLabel: string,
  logger?: pino.Logger
): Promise<string> {
  const err = error as {
    partialStdout?: string;
    partialStderr?: string;
    timeoutKind?: ProviderTimeoutKind;
    timeoutMs?: number;
    providerSessionId?: string;
    lastActivity?: string;
  } | null;
  const lines: string[] = [];

  const partialStdout = err?.partialStdout?.trim();
  const partialStderr = err?.partialStderr?.trim();

  if (err?.timeoutKind && err.timeoutMs !== undefined) {
    const description = err.timeoutKind === "idle"
      ? `No provider output was received for ${err.timeoutMs}ms.`
      : `The provider reached the total execution limit of ${err.timeoutMs}ms.`;
    lines.push(`**Timeout type:** ${err.timeoutKind}`, description);
    if (err.providerSessionId) {
      lines.push(`**Provider session:** \`${err.providerSessionId}\``);
    }
    if (err.lastActivity) {
      lines.push(`**Last recorded activity:** ${escapeDiscordFence(clipForDiscord(err.lastActivity, 1000))}`);
    }
    lines.push("");
  }

  if (partialStdout) {
    lines.push("**Partial output (stdout):**");
    lines.push("```");
    lines.push(escapeDiscordFence(clipForDiscord(partialStdout, 1800)));
    lines.push("```");
    lines.push("");
  }

  if (partialStderr) {
    lines.push("**Partial error output (stderr):**");
    lines.push("```");
    lines.push(escapeDiscordFence(clipTailForDiscord(partialStderr, 1800)));
    lines.push("```");
    lines.push("");
  }

  if (worktreePath) {
    if (branchName) {
      const baseRef = await getDefaultBranchBaseRef(worktreePath, logger);
      if (baseRef) {
        const commits = await getCommitsSinceBaseRef(worktreePath, baseRef, logger);
        if (commits.length > 0) {
          lines.push(`**Commits on \`${branchName}\` (since ${baseRef}):**`);
          for (const c of commits) {
            lines.push(c);
          }
          lines.push("");
        }
      }
    }

    const status = await getShortStatus(worktreePath, logger);
    if (status) {
      lines.push("**Working tree status:**");
      lines.push(`\`\`\`\n${escapeDiscordFence(clipForDiscord(status, 1800))}\n\`\`\``);
      lines.push("");
    }

    const diff = await getUnstagedDiffSummary(worktreePath, logger);
    if (diff) {
      lines.push("**Unstaged changes:**");
      lines.push(`\`\`\`diff\n${escapeDiscordFence(clipForDiscord(diff, 1800))}\n\`\`\``);
      lines.push("");
    }

    const stagedDiff = await getStagedDiffSummary(worktreePath, logger);
    if (stagedDiff) {
      lines.push("**Staged changes:**");
      lines.push(`\`\`\`diff\n${escapeDiscordFence(clipForDiscord(stagedDiff, 1800))}\n\`\`\``);
      lines.push("");
    }
  }

  const report = lines.join("\n").trim();
  if (!report) {
    return `${providerLabel} execution timed out. No partial output or worktree changes were captured.`;
  }

  return report;
}
