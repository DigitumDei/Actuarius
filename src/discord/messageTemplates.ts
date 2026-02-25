export function buildHelpText(): string {
  return [
    "**Actuarius Commands**",
    "- `/help` Show this command list.",
    "- `/connect-repo repo:<owner/name>` Link a public GitHub repo to this server and create its channel.",
    "- `/sync-repo [repo:<owner/name>]` Sync an existing connected repo checkout to `master`.",
    "- `/repos` List connected repos and their channels.",
    "- `/ask prompt:<text>` Create a new request thread and run AI in an isolated worktree.",
    "- `/model-select provider:<claude|codex|gemini> model:<name>` Set the AI provider and model for `/ask` (admin only).",
    "- `/model-current` Show the active AI provider and model for this server.",
    "",
    "v1 notes:",
    "- Repo support is public GitHub repos only.",
    "- `/ask` uses queued AI execution with per-guild concurrency limits.",
    "- Codex and Gemini require `ENABLE_CODEX_EXECUTION` / `ENABLE_GEMINI_EXECUTION` to be enabled."
  ].join("\n");
}
