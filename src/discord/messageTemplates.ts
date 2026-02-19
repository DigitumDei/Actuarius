export function buildHelpText(): string {
  return [
    "**Actuarius Commands**",
    "- `/help` Show this command list.",
    "- `/connect-repo repo:<owner/name>` Link a public GitHub repo to this server and create its channel.",
    "- `/repos` List connected repos and their channels.",
    "- `/ask repo:<owner/name> prompt:<text>` Create a new thread for this request in the repo channel.",
    "",
    "v1 notes:",
    "- Repo support is public GitHub repos only.",
    "- LLM CLIs are installed and health-checked, but not executed from Discord requests yet."
  ].join("\n");
}

