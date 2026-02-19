import {
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildTextBasedChannel
} from "discord.js";
import type pino from "pino";
import type { AppConfig } from "../config.js";
import { AppDatabase } from "../db/database.js";
import { commandBuilders } from "./commands.js";
import { buildHelpText } from "./messageTemplates.js";
import { buildRepoChannelName, buildThreadName } from "./naming.js";
import { GitHubRepoLookupError, lookupRepo, parseRepoReference } from "../services/githubService.js";
import { GitWorkspaceError, ensureRepoCheckedOutToMaster } from "../services/gitWorkspaceService.js";

export class ActuariusBot {
  private readonly client: Client;
  private readonly config: AppConfig;
  private readonly logger: pino.Logger;
  private readonly db: AppDatabase;

  public constructor(config: AppConfig, logger: pino.Logger, db: AppDatabase) {
    this.config = config;
    this.logger = logger;
    this.db = db;
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds]
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

    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }

      try {
        await this.handleCommand(interaction);
      } catch (error) {
        this.logger.error({ error }, "Command handler failed");
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: "Unexpected error. Please try again.", ephemeral: true });
        } else {
          await interaction.reply({ content: "Unexpected error. Please try again.", ephemeral: true });
        }
      }
    });
  }

  private async sendGuildWelcome(guild: Guild): Promise<void> {
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
      case "repos":
        await this.handleRepos(interaction);
        return;
      case "ask":
        await this.handleAsk(interaction);
        return;
      default:
        await interaction.reply({ content: "Unknown command.", ephemeral: true });
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
      if (!lookup.isPublic) {
        await interaction.editReply("v1 supports public GitHub repos only.");
        return;
      }

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
          await interaction.editReply("Repository not found. Check the owner/name and ensure it is public.");
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

    const rawRepo = interaction.options.getString("repo");
    const resolvedChannelId =
      interaction.channel && interaction.channel.isThread() ? interaction.channel.parentId : interaction.channelId;

    let repo = null;

    if (rawRepo) {
      const parsedReference = parseRepoReference(rawRepo);
      if (!parsedReference) {
        await interaction.reply({
          content: "Invalid repo format. Use `owner/name` or `https://github.com/owner/name`.",
          ephemeral: true
        });
        return;
      }

      repo = this.db.getRepoByFullName(interaction.guildId, parsedReference.fullName);
    } else if (resolvedChannelId) {
      repo = this.db.getRepoByChannelId(interaction.guildId, resolvedChannelId);
    }

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

  private async handleAsk(interaction: ChatInputCommandInteraction): Promise<void> {
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

    const channel = (await interaction.guild.channels.fetch(repo.channel_id)) as GuildTextBasedChannel | null;
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.reply({ content: "Mapped repo channel is unavailable or not a text channel.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const seedMessage = await channel.send({
      content: `New request from <@${interaction.user.id}> for \`${repo.full_name}\``
    });

    const thread = await seedMessage.startThread({
      name: buildThreadName(prompt),
      autoArchiveDuration: this.config.threadAutoArchiveMinutes,
      reason: `Request thread for ${repo.full_name} by ${interaction.user.tag}`
    });

    await thread.send(
      [
        `Request by <@${interaction.user.id}>`,
        "",
        `**Prompt**`,
        prompt,
        "",
        "_LLM execution is not enabled in v1. This thread is the canonical history container for the request._"
      ].join("\n")
    );

    this.db.createRequest({
      guildId: interaction.guildId,
      repoId: repo.id,
      channelId: repo.channel_id,
      threadId: thread.id,
      userId: interaction.user.id,
      prompt,
      status: "created"
    });

    await interaction.editReply(`Created request thread <#${thread.id}>.`);
  }

  public getCommandNames(): string[] {
    return commandBuilders.map((command) => command.name);
  }
}
