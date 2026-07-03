# Actuarius

Discord bot container that links GitHub repos to Discord channels and creates request threads per prompt.

**Deployment model:** One instance per Discord guild. Multi-guild operation from a single instance is not supported. Each instance supports multiple repositories via dedicated channels.

## What v1 does

- Runs as a Docker container.
- Includes these CLIs in-container:
  - `git`, `gh`, `node`, `npm`
  - `claude`, `codex`, `gemini`, `opencode` (seeded into `/data/home/appuser/.npm-global/bin` on first boot)
- Waits for Discord server invite if not yet in any server.
- Registers slash commands for repo management, AI execution, and server administration (20+ commands — see `src/discord/commands.ts` for the full list).
- Creates one dedicated channel per connected repo (per Discord server).
- Creates one thread per `/ask` request to preserve request-specific history.
- Runs the configured AI provider (Claude, Codex, Gemini, or OpenCode) for each `/ask` request in an isolated git worktree.
- Queues `/ask` jobs with bounded per-guild concurrency and support for `/review` (adversarial code review across multiple provider CLIs).
- Stores guild/repo/request mappings in SQLite.
- Supports `/opencode-auth` for per-provider API key management when using OpenCode as the provider.

## What v1 does not do

- Multi-guild operation from a single instance (one instance per guild, always).
- Expose a public API or web UI.

## Requirements

- Docker (recommended for runtime)
- Discord application + bot token
- Discord bot scopes:
  - `bot`
  - `applications.commands`
- Bot permissions:
  - Read/Send Messages
  - Create Public Threads
  - Manage Channels (for repo channel creation)

## Configuration

Copy `.env.example` to `.env` and set:

- `DISCORD_TOKEN` (required)
- `DISCORD_CLIENT_ID` (required)
- `DISCORD_GUILD_ID` (optional, for fast guild-scoped command registration during development)
- `GITHUB_APP_ID` + `GITHUB_APP_INSTALLATION_ID` + exactly one of `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_B64` (preferred for GitHub bot identity)
- `GH_TOKEN` (optional fallback for backward compatibility)
- `GIT_USER_NAME` + `GIT_USER_EMAIL` (optional commit identity override)
- `DATABASE_PATH` (default `/data/app.db`)
- `REPOS_ROOT_PATH` (default `/data/repos`)
- `LOG_LEVEL` (default `info`)
- `THREAD_AUTO_ARCHIVE_MINUTES` (`60`, `1440`, `4320`, or `10080`)
- `ASK_CONCURRENCY_PER_GUILD` (default `3`)
- `ASK_EXECUTION_TIMEOUT_MS` (default `1200000`)
- `ENABLE_CODEX_EXECUTION` (default `false`, enables Codex/OpenAI provider)
- `ENABLE_GEMINI_EXECUTION` (default `false`, enables Gemini provider)
- `ENABLE_OPENCODE_EXECUTION` (default `false`, enables OpenCode/DeepSeek provider)
- `GEMINI_API_KEY` (required for Gemini execution)
- `DEEPSEEK_API_KEY` (required for OpenCode execution when not using `/opencode-auth`)
- `CLAUDE_CODE_OAUTH_TOKEN` (optional for local/manual runs, required by the production redeploy helper for non-interactive Claude auth)
- `MEMPALACE_ENABLED` (default `false`, enables the local MemPalace MCP for agents)
- `MEMPALACE_REMOTE_ENABLED` (default `false`, starts Actuarius' loopback MemPalace federation server and routes repo memory through it)
- `MEMPALACE_REMOTE_URL` (default `http://127.0.0.1:8765`)
- `MEMPALACE_REMOTE_TOKEN` (optional; generated and persisted if omitted)
- `MEMPALACE_REMOTE_MINE_ON_SYNC` (default `true`, queues repo mining after connect/sync/checkouts)

Provider CLI auth state is persisted under `/data/home/appuser` inside the container. The provider CLIs themselves are also installed under `/data/home/appuser/.npm-global`, with `docker/entrypoint.sh` seeding them on first boot if missing. That keeps Claude and Codex authentication and CLI updates across container replacement, because production mounts `/data` from the persistent disk. Gemini and OpenCode execution use API keys instead of persisted OAuth state — set `GEMINI_API_KEY` / `DEEPSEEK_API_KEY` as env vars, or use `/opencode-auth` to store per-provider keys in `auth.json` with support for DeepSeek, OpenAI, Anthropic, Google, xAI, Groq, OpenRouter, and Together.

### MemPalace federation

When both `MEMPALACE_ENABLED=true` and `MEMPALACE_REMOTE_ENABLED=true` are set, Actuarius runs two MemPalace stores:

- Local agent memory at `/data/mempalace/palace`, exposed to Claude/Codex/Gemini/OpenCode through the local `mempalace-mcp` config.
- Remote repo memory at `/data/mempalace/remote-palace`, served by `mempalace-cli serve` on `MEMPALACE_REMOTE_BIND` and reached by the local MCP through `MEMPALACE_REMOTE_URL`.

For each connected repository, Actuarius assigns a deterministic wing named after the repo (e.g. `wing_actuarius`, matching `mempalace-cli init` naming so wings federate by name with locally initialised palaces), writes federation routing to `/data/home/appuser/.mempalace/config.json`, and queues a background `mempalace-cli mine` of the main checkout after repo connect/sync/checkouts. If a repo checkout already has `mempalace.yaml` or `mempal.yaml`, Actuarius honors its `wing:` value. Otherwise it writes an ignored `mempalace.yaml` into the checkout; request worktrees receive a copy of the main checkout's config so hand-tuned rooms carry over. Repo-scoped records route in combined mode with writes going to the remote store.

## Local development

### Dev bot setup

To develop locally while a live instance is running, create a separate Discord application to avoid event conflicts:

1. Create a new app at https://discord.com/developers/applications (e.g. "Actuarius Dev")
2. Under **Bot**: create the bot, copy the token, enable **Message Content Intent**
3. Under **OAuth2 > URL Generator**: select scopes `bot` + `applications.commands`, then permissions: Read Messages/View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, Manage Channels
4. Invite the dev bot to a test Discord server
5. Copy the test server's ID (enable Developer Mode in Discord settings, then right-click server > Copy Server ID)

Set up your `.env`:

```env
DISCORD_TOKEN=<dev bot token>
DISCORD_CLIENT_ID=<dev client id>
DISCORD_GUILD_ID=<test server id>
```

`DISCORD_GUILD_ID` scopes slash command registration to just that server (instant, no collision with prod global commands).

### Running locally

Without Docker:

```bash
npm install
npm run dev
```

With Docker Compose (recommended):

```bash
docker-compose up --build
```

Or without rebuilding (uses cached image):

```bash
docker-compose up
```

The first container start after a fresh volume mount is slower than normal because it seeds `claude`, `codex`, `gemini`, and `opencode` into `/data/home/appuser/.npm-global`. Later restarts skip installs for CLIs that are already present and only repair the specific provider binaries that are missing.

If the npm registry is unavailable during first boot or a later repair of a missing CLI, the bot still starts and logs a warning instead of crash-looping. Requests that need a missing provider CLI will continue to fail until network access is restored and the container is restarted or the CLI is reinstalled manually.

### PowerShell helper

```powershell
.\scripts\start-local.ps1
```

Useful flags:

- `-SkipBuild` to skip `docker build`
- `-Logs` to stream container logs after startup
- `-CredentialsPath .\.claude.credentials.json` to override the optional local bootstrap path for an existing Claude credentials file

### Manual Docker commands

```bash
docker build -t actuarius:latest .
docker run --rm \
  --name actuarius \
  --env-file .env \
  -v actuarius_data:/data \
  actuarius:latest
```

### Claude auth in Docker

Production uses `CLAUDE_CODE_OAUTH_TOKEN` for non-interactive Claude authentication. For local Docker usage, Claude auth state also persists under `/data/home/appuser/.claude`, so you can either reuse that persisted state or pass the OAuth token explicitly.

Example:

```bash
docker run --rm \
  --name actuarius \
  --env-file .env \
  -e CLAUDE_CODE_OAUTH_TOKEN=<your-oauth-token> \
  -v actuarius_data:/data \
  actuarius:latest
```

If you authenticate Claude interactively once inside a container with the `/data` volume mounted, that persisted state is also reused on later starts. Codex CLI auth is stored under the same persisted home tree. Gemini requires `GEMINI_API_KEY`.

### Updating provider CLIs without rebuilding

Because the provider CLIs live under `/data/home/appuser/.npm-global`, you can update them directly inside the running container without rebuilding the image:

```bash
docker exec -u appuser actuarius npm install -g @anthropic-ai/claude-code@latest
docker exec -u appuser actuarius npm install -g @openai/codex@latest
docker exec -u appuser actuarius npm install -g @google/gemini-cli@latest
docker exec -u appuser actuarius npm install -g opencode-ai@latest
```

Or use the `/update-clis` slash command in Discord (supports all four providers).

## Production operations (GCP VM)

Every push to `main` builds and pushes two image tags to ghcr.io:
- `ghcr.io/digitumdei/actuarius:latest`
- `ghcr.io/digitumdei/actuarius:<git-sha>`

Infrastructure is managed via Terraform (`infra/`). VM instance metadata is the source of truth for env vars and the redeploy script itself.

### Deploy latest image or roll back

SSH into the VM and run the helper script. **After `terraform apply`**, the local `/var/redeploy.sh` is stale — reboot or re-fetch it from metadata first:

```bash
# Re-fetch redeploy.sh from fresh metadata after terraform apply
META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
curl -sf -H "Metadata-Flavor: Google" "$META/env-redeploy-script" | sudo tee /var/redeploy.sh > /dev/null

# Pull and run latest
sudo bash /var/redeploy.sh

# Roll back to a specific git SHA
sudo bash /var/redeploy.sh abc1234
```

See `docs/deploy.md` for the full deployment lifecycle.

Find a SHA to roll back to:
- **GitHub UI**: repo → Commits → copy the short SHA next to any commit
- **CLI**: `git log --oneline`

### Watch startup logs

```bash
gcloud compute ssh actuarius-bot --zone <region> --project <YOUR_PROJECT_ID> --tunnel-through-iap
sudo journalctl -u google-startup-scripts -f
```

## Command behavior

### `/connect-repo repo:<owner/name>`

- Requires `Manage Server` permission.
- Verifies repo with `gh repo view`.
- Public and private repos are supported if the configured GitHub identity can access them.
- Checks out the repository locally and forces branch to `master`.
- Creates channel `repo-<owner>-<repo>` (normalized).
- Stores guild->repo->channel mapping in SQLite.

### `/sync-repo [repo:<owner/name>]`

- Requires `Manage Server` permission.
- Re-syncs an existing connected repository checkout.
- Checks out local branch `master` from `origin/master`.
- If `repo` is omitted, infers from the current mapped repo channel (or its thread parent).

### `/repos`

- Lists connected repos for the current Discord server.

### `/ask prompt:<text>`

- Must be run in the mapped repo channel.
- Creates a new thread automatically.
- Posts the prompt in the thread.
- Queues the request and runs the configured AI provider in a per-request worktree rooted under `REPOS_ROOT_PATH/.worktrees`.
- Posts a final completion/failure message in the thread.
- Persists request metadata and lifecycle status for history/audit.

## Data model

SQLite tables:

- `guilds`
- `repos`
- `requests`
- `bot_state`

## Security considerations

Actuarius executes AI agents (Claude, Codex, Gemini, OpenCode) with full shell access inside the container. User-supplied prompts from `/ask`, `/bug`, and `/issue` are passed directly to these agents, which run with unrestricted permissions (e.g. `--dangerously-auto-approve`, `--yolo`). This is by design — the bot's purpose is to let AI agents work freely on code.

**This means any Discord user who can run slash commands in your server can instruct the AI to execute arbitrary shell commands inside the container.** There is no prompt sanitization or sandboxing beyond the container boundary itself.

Mitigations:

- **Run on private servers only.** Do not add this bot to public Discord servers. Treat server membership as the trust boundary.
- **Container isolation.** The Docker container limits blast radius — the AI cannot escape the container, but it has full access to everything inside it (repos, tokens, CLI tools).
- **Scoped GitHub access.** Prefer a GitHub App installation with only the repository permissions the bot needs. If you keep using `GH_TOKEN`, keep its scope minimal.
- **No secrets in the worktree.** Do not store sensitive files in repositories the bot has access to.

If you choose to run this bot on a public or semi-public server, you accept the risk of prompt injection attacks that could abuse the AI's shell access within the container.

## Testing

```bash
npm test
npm run check
```
