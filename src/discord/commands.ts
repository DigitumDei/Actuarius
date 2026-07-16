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
    .addStringOption((option) => option.setName("prompt").setDescription("Request text for this thread.").setRequired(true))
    .addAttachmentOption((option) => option.setName("attachment1").setDescription("Optional file attachment").setRequired(false))
    .addAttachmentOption((option) => option.setName("attachment2").setDescription("Optional file attachment").setRequired(false))
    .addAttachmentOption((option) => option.setName("attachment3").setDescription("Optional file attachment").setRequired(false))
    .addAttachmentOption((option) => option.setName("attachment4").setDescription("Optional file attachment").setRequired(false))
    .addAttachmentOption((option) => option.setName("attachment5").setDescription("Optional file attachment").setRequired(false)),
  new SlashCommandBuilder()
    .setName("plan")
    .setDescription("Plan with a deep model, implement with a flash model, then stop for review.")
    .addStringOption((option) => option.setName("prompt").setDescription("Request text for the plan-and-implement thread.").setRequired(true))
    .addBooleanOption((option) =>
      option.setName("iterative").setDescription("Iterative per-task implementation and verification. Defaults true; set false for single-shot.").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("install")
    .setDescription("Install an allowlisted tool or apt package. Requires Manage Server permission.")
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription("Installation scope")
        .setRequired(true)
        .addChoices(
          { name: "Repo", value: "repo" },
          { name: "Request", value: "request" }
        )
    )
    .addStringOption((option) =>
      INSTALLER_PACKAGE_CHOICES.reduce(
        (builder, choice) => builder.addChoices({ name: choice.name, value: choice.value }),
        option.setName("package").setDescription("Allowlisted package ID to install.").setRequired(false)
      )
    )
    .addStringOption((option) =>
      option
        .setName("apt-package")
        .setDescription("APT package name or space-separated package specs to install.")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("uninstall")
    .setDescription("Invalidate a managed install and remove its managed files. Requires Manage Server permission.")
    .addStringOption((option) =>
      option
        .setName("scope")
        .setDescription("Installation scope")
        .setRequired(true)
        .addChoices(
          { name: "Repo", value: "repo" },
          { name: "Request", value: "request" }
        )
    )
    .addStringOption((option) =>
      INSTALLER_PACKAGE_CHOICES.reduce(
        (builder, choice) => builder.addChoices({ name: choice.name, value: choice.value }),
        option.setName("package").setDescription("Allowlisted package ID to invalidate.").setRequired(false)
      )
    )
    .addStringOption((option) =>
      option
        .setName("apt-package")
        .setDescription("APT package spec whose install record should be invalidated.")
        .setRequired(false)
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
    .setDescription("Set the AI provider and model for /ask, /plan, and review roles. Requires Manage Server permission.")
    .addStringOption((option) =>
      option
        .setName("provider")
        .setDescription("AI provider to use (optional when clearing)")
        .setRequired(false)
        .addChoices(
          { name: "Claude", value: "claude" },
          { name: "Codex", value: "codex" },
          { name: "Gemini", value: "gemini" },
          { name: "OpenCode (DeepSeek)", value: "opencode" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("model")
        .setDescription("Model name (e.g. claude-opus-4-5, o4-mini, gemini-2.0-flash). Omit to use the CLI default.")
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("role")
        .setDescription("Which model role to configure.")
        .setRequired(false)
        .addChoices(
          { name: "Default (/ask, /bug, /issue)", value: "default" },
          { name: "Planner (/plan stage A)", value: "planner" },
          { name: "Implementer (/plan stage B)", value: "implementer" },
          { name: "Reviewer Slot 1", value: "reviewer-1" },
          { name: "Reviewer Slot 2", value: "reviewer-2" },
          { name: "Reviewer Slot 3", value: "reviewer-3" },
          { name: "Reviewer Slot 4", value: "reviewer-4" },
          { name: "Reviewer Analyzer", value: "reviewer-analyzer" },
          { name: "Reviewer Judge", value: "reviewer-judge" },
          { name: "Reviewer Summarizer", value: "reviewer-summarizer" }
        )
    )
    .addBooleanOption((option) =>
      option
        .setName("clear")
        .setDescription("Clear a reviewer slot or reviewer role override instead of setting it.")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("model-current")
    .setDescription("Show the active AI provider, model, reviewer slots, and review role overrides for this server."),
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
    .setName("opencode-auth")
    .setDescription("Configure an API key for OpenCode (e.g. deepseek, openai). Requires Manage Server permission.")
    .addStringOption((option) =>
      option
        .setName("provider")
        .setDescription("AI provider to configure the key for (e.g. deepseek, openai, anthropic)")
        .setRequired(true)
        .addChoices(
          { name: "DeepSeek", value: "deepseek" },
          { name: "OpenAI", value: "openai" },
          { name: "Anthropic", value: "anthropic" },
          { name: "Google", value: "google" },
          { name: "xAI", value: "xai" },
          { name: "Groq", value: "groq" },
          { name: "OpenRouter", value: "openrouter" },
          { name: "Together", value: "together" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("key")
        .setDescription("Your API key for the selected provider")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("auth-openai-opencode")
    .setDescription("Connect a ChatGPT Pro/Plus subscription to OpenCode. Requires Manage Server permission."),
  new SlashCommandBuilder()
    .setName("opencode-auth-remove")
    .setDescription("Remove a stored OpenCode credential. Requires Manage Server permission.")
    .addStringOption((option) =>
      option
        .setName("provider")
        .setDescription("AI provider to remove the key for")
        .setRequired(true)
        .addChoices(
          { name: "DeepSeek", value: "deepseek" },
          { name: "OpenAI", value: "openai" },
          { name: "Anthropic", value: "anthropic" },
          { name: "Google", value: "google" },
          { name: "xAI", value: "xai" },
          { name: "Groq", value: "groq" },
          { name: "OpenRouter", value: "openrouter" },
          { name: "Together", value: "together" }
        )
    ),
  new SlashCommandBuilder()
    .setName("gh-auth-refresh")
    .setDescription("Force-refresh the GitHub App authentication token. Requires Manage Server permission."),
  new SlashCommandBuilder()
    .setName("delete")
    .setDescription("Delete the worktree branch associated with this request thread."),
  new SlashCommandBuilder()
    .setName("review")
    .setDescription("Run adversarial code review (auto-commits pending work before diffing)."),
  new SlashCommandBuilder()
    .setName("revise")
    .setDescription("Revise the existing request branch in the current request thread.")
    .addStringOption((option) =>
      option
        .setName("findings")
        .setDescription("Optional findings to address. If omitted, the latest review summary is used.")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("pr")
    .setDescription("Push the reviewed request branch and open a draft pull request."),
  new SlashCommandBuilder()
    .setName("update-clis")
    .setDescription("Update provider CLIs (claude, codex, gemini, opencode) to latest. Requires Manage Server permission.")
    .addStringOption((option) =>
      option
        .setName("provider")
        .setDescription("Which CLI to update. Omit to update all.")
        .setRequired(false)
        .addChoices(
          { name: "All", value: "all" },
          { name: "Claude", value: "claude" },
          { name: "Codex", value: "codex" },
          { name: "Gemini", value: "gemini" },
          { name: "OpenCode", value: "opencode" }
        )
    ),
  new SlashCommandBuilder()
    .setName("memory")
    .setDescription("Search or inspect the MemPalace memory store for this server.")
    .addSubcommand((sub) =>
      sub
        .setName("search")
        .setDescription("Semantic search across past requests, reviews, and findings.")
        .addStringOption((option) =>
          option.setName("query").setDescription("What to search for.").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Show MemPalace palace overview and statistics.")
    ),
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
  | "plan"
  | "install"
  | "uninstall"
  | "bug"
  | "issue"
  | "model-select"
  | "model-current"
  | "review-rounds"
  | "codex-auth"
  | "opencode-auth"
  | "auth-openai-opencode"
  | "opencode-auth-remove"
  | "gh-auth-refresh"
  | "delete"
  | "review"
  | "revise"
  | "pr"
  | "update-clis";

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
