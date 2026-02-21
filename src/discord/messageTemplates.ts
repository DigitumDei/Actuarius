export function buildHelpText(): string {
  return [
    "**Actuarius Commands**",
    "- `/help` Show this command list.",
    "- `/connect-repo repo:<owner/name>` Link a public GitHub repo to this server and create its channel.",
    "- `/sync-repo [repo:<owner/name>]` Sync an existing connected repo checkout to `master`.",
    "- `/repos` List connected repos and their channels.",
    "- `/ask prompt:<text>` Create a new request thread and run Claude in an isolated worktree.",
    "",
    "v1 notes:",
    "- Repo support is public GitHub repos only.",
    "- `/ask` uses queued Claude execution with per-guild concurrency limits."
  ].join("\n");
}
