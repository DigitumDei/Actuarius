export function buildHelpText(): string {
  return [
    "**Actuarius Commands**",
    "- `/help` Show this command list.",
    "- `/connect-repo repo:<owner/name>` Link a GitHub repo to this server and create its channel.",
    "- `/sync-repo [repo:<owner/name>]` Sync an existing connected repo checkout to `master`.",
    "- `/cleanup [repo:<owner/name>]` Delete local branches whose origin branches are gone. In a non-repo channel, cleans all connected repos after confirmation.",
    "- `/repos` List connected repos and their channels.",
    "- `/issues [mode:<list|summary|detail>] [issue:<number>]` Read open GitHub issues for the connected repo.",
    "- `/ask prompt:<text>` Create a new request thread and run AI in an isolated worktree.",
    "- `/install [package:<allowed-package-id>] [apt-package:<deb-specs>] scope:<repo|request>` Install an allowlisted tool or apt package (admin only; specify exactly one of `package` or `apt-package`).",
    "- `/review` Run adversarial code review in the current request thread (request owner or Manage Server).",
    "- `/review-rounds [rounds:<number>]` Show or set the max `/review` consensus rounds for this server (admin only to set).",
    "- `/model-select provider:<claude|codex|gemini> model:<name>` Set the AI provider and model for `/ask` (admin only).",
    "- `/model-current` Show the active AI provider and model for this server.",
    "- `/codex-auth credentials:<file>` Upload Codex credentials file from `~/.codex/auth.json` (admin only).",
    "",
    "v1 notes:",
    "- Private repos work when the configured GitHub identity can access them.",
    "- `/ask` uses queued AI execution with per-guild concurrency limits.",
    "- Codex and Gemini require `ENABLE_CODEX_EXECUTION` / `ENABLE_GEMINI_EXECUTION` to be enabled.",
    "- Gemini additionally requires `GEMINI_API_KEY`."
  ].join("\n");
}
