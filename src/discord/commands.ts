import { REST, Routes, SlashCommandBuilder } from "discord.js";
import type { AppConfig } from "../config.js";
import type pino from "pino";

export const commandBuilders = [
  new SlashCommandBuilder().setName("help").setDescription("Show supported commands and usage."),
  new SlashCommandBuilder()
    .setName("connect-repo")
    .setDescription("Connect a public GitHub repo to this Discord server.")
    .addStringOption((option) =>
      option.setName("repo").setDescription("GitHub repo as owner/name or https://github.com/owner/name").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("sync-repo")
    .setDescription("Sync an already connected repo checkout to origin/master.")
    .addStringOption((option) =>
      option
        .setName("repo")
        .setDescription("Optional owner/name. If omitted, infer from current repo channel or thread.")
        .setRequired(false)
    ),
  new SlashCommandBuilder().setName("repos").setDescription("List repos connected in this Discord server."),
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Create a request thread in the connected repo channel.")
    .addStringOption((option) => option.setName("prompt").setDescription("Request text for this thread.").setRequired(true)),
  new SlashCommandBuilder()
    .setName("model-select")
    .setDescription("Set the AI provider and model for /ask in this server. Requires Manage Server permission.")
    .addStringOption((option) =>
      option
        .setName("provider")
        .setDescription("AI provider to use")
        .setRequired(true)
        .addChoices(
          { name: "Claude", value: "claude" },
          { name: "Codex", value: "codex" },
          { name: "Gemini", value: "gemini" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("model")
        .setDescription("Model name (e.g. claude-opus-4-5, o4-mini, gemini-2.0-flash). Omit to use the CLI default.")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("model-current")
    .setDescription("Show the active AI provider and model for /ask in this server."),
  new SlashCommandBuilder()
    .setName("gemini-auth")
    .setDescription("Start Google OAuth flow to authenticate the Gemini CLI. Requires Manage Server permission."),
  new SlashCommandBuilder()
    .setName("gemini-auth-complete")
    .setDescription("Complete Gemini OAuth by entering the authorization code from Google.")
    .addStringOption((option) =>
      option
        .setName("code")
        .setDescription("Authorization code from the Google OAuth page")
        .setRequired(true)
    )
];

export type CommandName = "help" | "connect-repo" | "sync-repo" | "repos" | "ask" | "model-select" | "model-current" | "gemini-auth" | "gemini-auth-complete";

export async function registerSlashCommands(config: AppConfig, logger: pino.Logger): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const body = commandBuilders.map((builder) => builder.toJSON());

  try {
    if (config.discordGuildId) {
      await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), { body });
      logger.info({ guildId: config.discordGuildId }, "Registered guild slash commands");
      return;
    }

    await rest.put(Routes.applicationCommands(config.discordClientId), { body });
    logger.info("Registered global slash commands");
  } catch (error) {
    logger.error({ error }, "Failed to register slash commands");
    throw error;
  }
}
