# Actuarius

Discord bot container that links GitHub repos to Discord channels and creates request threads per prompt.

## What v1 does

- Runs as a Docker container.
- Includes these CLIs in-container:
  - `git`
  - `gh`
  - `node`
  - `npm`
  - `codex`
  - `claude`
  - `gemini`
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
- Support private repos.
- Use GitHub App installation flow.

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
- `GH_TOKEN` (recommended for GitHub CLI operations)
- `DATABASE_PATH` (default `/data/app.db`)
- `REPOS_ROOT_PATH` (default `/data/repos`)
- `LOG_LEVEL` (default `info`)
- `THREAD_AUTO_ARCHIVE_MINUTES` (`60`, `1440`, `4320`, or `10080`)
- `ASK_CONCURRENCY_PER_GUILD` (default `3`)
- `ASK_EXECUTION_TIMEOUT_MS` (default `1200000`)
- `CLAUDE_CREDENTIALS_FILE` (optional, path to mounted Claude `.credentials.json`)
- `CLAUDE_CREDENTIALS_B64` (optional, base64 payload of Claude `.credentials.json`)

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

### PowerShell helper

```powershell
.\scripts\start-local.ps1
```

Useful flags:

- `-SkipBuild` to skip `docker build`
- `-Logs` to stream container logs after startup
- `-CredentialsPath .\.claude.credentials.json` to override credential file path

### Manual Docker commands

```bash
docker build -t actuarius:latest .
docker run --rm \
  --name actuarius \
  --env-file .env \
  -v actuarius_data:/data \
  actuarius:latest
```

### Claude login persistence in Docker

Avoid baking Claude credentials into the image at build time. Use runtime injection:

- Mount a credentials file and set `CLAUDE_CREDENTIALS_FILE`.
- Or pass `CLAUDE_CREDENTIALS_B64` from a secret manager.

Example (mounted file):

```bash
docker run --rm \
  --name actuarius \
  --env-file .env \
  -e CLAUDE_CREDENTIALS_FILE=/run/secrets/claude_credentials \
  -v actuarius_data:/data \
  -v /path/to/.credentials.json:/run/secrets/claude_credentials:ro \
  actuarius:latest
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
- Public repos only in v1.
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

## Testing

```bash
npm test
npm run check
```
