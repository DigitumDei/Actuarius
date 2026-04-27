# Actuarius

Discord bot container that links GitHub repos to Discord channels and creates request threads per prompt.

**Deployment model:** One instance per Discord guild. Multi-guild operation from a single instance is not supported. Each instance supports multiple repositories via dedicated channels.

## What v1 does

- Runs as a Docker container.
- Includes these CLIs in-container:
  - `git`
  - `gh`
  - `node`
  - `npm`
  - `codex` (seeded into `/data/home/appuser/.npm-global/bin` on first boot)
  - `claude` (seeded into `/data/home/appuser/.npm-global/bin` on first boot)
  - `gemini` (seeded into `/data/home/appuser/.npm-global/bin` on first boot)
- Waits for Discord server invite if not yet in any server.
- Registers slash commands:
  - `/help`
  - `/connect-repo`
  - `/sync-repo`
  - `/repos`
  - `/ask`
- Creates one dedicated channel per connected repo (per Discord server).
- Creates one thread per `/ask` request to preserve request-specific history.
- Runs Claude for each `/ask` request in an isolated git worktree.
- Queues `/ask` jobs with bounded per-guild concurrency.
- Stores guild/repo/request mappings in SQLite.

## What v1 does not do

- Execute Codex/Gemini tasks from Discord requests yet.

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
- `GEMINI_API_KEY` (required for Gemini execution)
- `CLAUDE_CODE_OAUTH_TOKEN` (optional for local/manual runs, required by the production redeploy helper for non-interactive Claude auth)

Provider CLI auth state is persisted under `/data/home/appuser` inside the container. The provider CLIs themselves are also installed under `/data/home/appuser/.npm-global`, with `docker/entrypoint.sh` seeding them on first boot if missing. That keeps Claude and Codex authentication and CLI updates across container replacement, because production mounts `/data` from the persistent disk. Gemini execution uses `GEMINI_API_KEY` instead of persisted OAuth state.

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

The first container start after a fresh volume mount is slower than normal because it seeds `claude`, `codex`, and `gemini` into `/data/home/appuser/.npm-global`. Later restarts skip that install unless one of the binaries is missing.

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
```

## Production operations (GCP VM)

Every push to `main` builds and pushes two image tags to ghcr.io:
- `ghcr.io/digitumdei/actuarius:latest`
- `ghcr.io/digitumdei/actuarius:<git-sha>`

The VM startup script reads the target image from instance metadata and pulls it on every boot.

### Deploy latest image or roll back

SSH into the VM and run the helper script:

```bash
# Pull and run latest
sudo /var/redeploy.sh

# Roll back to a specific git SHA
sudo /var/redeploy.sh abc1234
```

Find a SHA to roll back to:
- **GitHub UI**: repo → Commits → copy the short SHA next to any commit
- **CLI**: `git log --oneline`


### Watch startup logs

```bash
gcloud compute ssh actuarius-bot --zone us-east1-b --project <YOUR_PROJECT_ID> --tunnel-through-iap
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
- Queues the request and runs Claude in a per-request worktree rooted under `REPOS_ROOT_PATH/.worktrees`.
- Posts a final completion/failure message in the thread.
- Persists request metadata and lifecycle status for history/audit.

## Data model

SQLite tables:

- `guilds`
- `repos`
- `requests`
- `bot_state`

## Security considerations

Actuarius executes AI agents (Claude, Codex, Gemini) with full shell access inside the container. User-supplied prompts from `/ask`, `/bug`, and `/issue` are passed directly to these agents, which run with unrestricted permissions (e.g. `--dangerously-auto-approve`, `--yolo`). This is by design — the bot's purpose is to let AI agents work freely on code.

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
