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
    .addStringOption((option) => option.setName("prompt").setDescription("Request text for this thread.").setRequired(true))
];

export type CommandName = "help" | "connect-repo" | "sync-repo" | "repos" | "ask";

export async function registerSlashCommands(config: AppConfig, logger: pino.Logger): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const body = commandBuilders.map((builder) => builder.toJSON());

  if (config.discordGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), { body });
    logger.info({ guildId: config.discordGuildId }, "Registered guild slash commands");
    return;
  }

  await rest.put(Routes.applicationCommands(config.discordClientId), { body });
  logger.info("Registered global slash commands");
}
