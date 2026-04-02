import { REST, Routes, SlashCommandBuilder } from "discord.js";
import type { AppConfig } from "../config.js";
import type pino from "pino";
import { INSTALLER_PACKAGE_CHOICES } from "../services/installerRegistry.js";

export const commandBuilders = [
  new SlashCommandBuilder().setName("help").setDescription("Show supported commands and usage."),
  new SlashCommandBuilder()
    .setName("connect-repo")
    .setDescription("Connect a GitHub repo to this Discord server.")
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
  new SlashCommandBuilder()
    .setName("branches")
    .setDescription("List local and origin branches for a connected repository.")
    .addStringOption((option) =>
      option
        .setName("repo")
        .setDescription("Optional owner/name. If omitted, infer from current repo channel or thread.")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("cleanup")
    .setDescription("Delete local branches whose origin branches were removed.")
    .addStringOption((option) =>
      option
        .setName("repo")
        .setDescription("Optional owner/name. Otherwise infer the current repo, or clean all repos in this server.")
        .setRequired(false)
    ),
  new SlashCommandBuilder().setName("repos").setDescription("List repos connected in this Discord server."),
  new SlashCommandBuilder()
    .setName("issues")
    .setDescription("List, summarize, or view GitHub issues for the connected repository.")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Issue view mode")
        .setRequired(false)
        .addChoices(
          { name: "List", value: "list" },
          { name: "Summary", value: "summary" },
          { name: "Detail", value: "detail" }
        )
    )
    .addIntegerOption((option) =>
      option
        .setName("issue")
        .setDescription("Issue number to view when mode is detail.")
        .setRequired(false)
        .setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Create a request thread in the connected repo channel.")
    .addStringOption((option) => option.setName("prompt").setDescription("Request text for this thread.").setRequired(true)),
  new SlashCommandBuilder()
    .setName("install")
    .setDescription("Install an allowlisted tool into repo or request scope. Requires Manage Server permission.")
    .addStringOption((option) =>
      INSTALLER_PACKAGE_CHOICES.reduce(
        (builder, choice) => builder.addChoices({ name: choice.name, value: choice.value }),
        option.setName("package").setDescription("Allowlisted package ID to install.").setRequired(true)
      )
    )
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription("Installation scope")
        .setRequired(true)
        .addChoices(
          { name: "Repo", value: "repo" },
          { name: "Request", value: "request" }
        )
    ),
  new SlashCommandBuilder()
    .setName("bug")
    .setDescription("Create a bug report issue on GitHub by analyzing the codebase.")
    .addStringOption((option) => option.setName("prompt").setDescription("Bug details or description.").setRequired(true)),
  new SlashCommandBuilder()
    .setName("issue")
    .setDescription("Create an issue on GitHub by analyzing the codebase.")
    .addStringOption((option) => option.setName("prompt").setDescription("Issue details or description.").setRequired(true)),
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
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName("model-current")
    .setDescription("Show the active AI provider and model for /ask in this server."),
  new SlashCommandBuilder()
    .setName("review-rounds")
    .setDescription("Show or set the maximum adversarial review consensus rounds for this server.")
    .addIntegerOption((option) =>
      option
        .setName("rounds")
        .setDescription("Set the max review rounds. Omit to show the current value.")
        .setRequired(false)
        .setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName("codex-auth")
    .setDescription("Upload Codex credentials file (~/.codex/auth.json). Requires Manage Server permission.")
    .addAttachmentOption((option) =>
      option
        .setName("credentials")
        .setDescription("The auth.json file from ~/.codex/ (or %USERPROFILE%\\.codex\\)")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("delete")
    .setDescription("Delete the worktree branch associated with this request thread."),
  new SlashCommandBuilder()
    .setName("review")
    .setDescription("Run adversarial code review for the current request thread.")
];

export type CommandName =
  | "help"
  | "connect-repo"
  | "sync-repo"
  | "branches"
  | "cleanup"
  | "repos"
  | "issues"
  | "ask"
  | "install"
  | "bug"
  | "issue"
  | "model-select"
  | "model-current"
  | "review-rounds"
  | "codex-auth"
  | "delete"
  | "review";

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
