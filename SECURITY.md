# Security

## Accepted Risks

### AI Execution Without Human-in-the-Loop Confirmation

The supported AI providers (Claude, Codex, Gemini) are configured to run in fully autonomous mode, bypassing their built-in confirmation prompts. This is an inherent requirement of the Discord bot architecture — there is no human at a terminal to approve each tool invocation.

**Mitigations in place:**
- The bot runs inside a Docker container, limiting blast radius
- Each request executes in an isolated git worktree
- The container runs as a non-root user with limited privileges
- If a prompt injection or malicious action destroys the container, it can be respun with only uncommitted work lost

**Why further restrictions are impractical:**
- Strictly limiting the AI toolset would severely hamper the bot's usefulness — the value comes from giving the AI full access to the codebase and its tools
- A Discord-based approval flow for each AI action would add massive UX friction and fundamentally break the async model
- Per-request containers would add significant complexity and latency for marginal security gain over the existing Docker isolation

### Prompt Injection

User-provided Discord messages are passed directly as prompts to the AI providers without sanitization.

**Why this is accepted:**
- Sanitizing natural language prompts is essentially impossible without breaking legitimate use — there is no reliable way to distinguish malicious instructions from valid prompts
- The AI CLIs have their own built-in system prompts, safety layers, and guardrails
- Prompt injection is an unsolved problem industry-wide; no amount of prompt wrapping guarantees safety
- The real mitigation is container isolation (see above) — the blast radius of a successful injection is limited to the ephemeral Docker environment

### Credential File Writes (`/codex-auth`, `/gemini-auth`)

Admin commands allow uploading provider credentials that are written to the container filesystem.

**Controls in place:**
- Commands are gated behind Discord's `Manage Server` permission — only server admins can invoke them
- File paths are hardcoded (e.g. `~/.codex/auth.json`) — there is no user-controlled path component
- Files are written with restrictive permissions (`0o600`)

### Debug Logging

At `debug` log level, raw prompts, provider stdio, and auth flow output are logged without redaction.

**Why this is accepted:**
- Production deployments should run at `info` level or above, where this does not apply
- Logs remain on the Docker host and are not shipped to external sinks unless explicitly configured
- Debug logging is intended for development and troubleshooting — sensitive content at this level is expected
