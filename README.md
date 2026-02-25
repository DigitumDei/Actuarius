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
- `CLAUDE_CODE_OAUTH_TOKEN` (required for production — generate once with `claude setup-token`, valid 1 year)

## Local development

```bash
npm install
npm run dev
```

## Build and run with Docker

```bash
docker build -t actuarius:latest .
docker run --rm \
  --name actuarius \
  --env-file .env \
  -v actuarius_data:/data \
  actuarius:latest
```

### Local one-command startup (PowerShell)

Use the helper script to build, run, persist state, and bootstrap Claude credentials:

```powershell
.\scripts\start-local.ps1
```

Useful flags:

- `-SkipBuild` to skip `docker build`
- `-Logs` to stream container logs after startup
- `-CredentialsPath .\.claude.credentials.json` to override credential file path

## Production operations (GCP VM)

Every push to `main` builds and pushes two image tags to ghcr.io:
- `ghcr.io/digitumdei/actuarius:latest`
- `ghcr.io/digitumdei/actuarius:<git-sha>`

The VM startup script reads the target image from instance metadata and pulls it on every boot.

### Deploy latest image

Stop and reset the VM — the startup script pulls `:latest` automatically:

```bash
gcloud compute instances reset actuarius-bot --zone=us-east1-b
```

### Roll back to a previous version

Find the git SHA of the version you want. Options:

- **GitHub UI**: go to the repo → Commits → copy the short SHA from any commit
- **CLI**: `git log --oneline` on main

Then update the metadata and reset:

```bash
gcloud compute instances add-metadata actuarius-bot --zone=us-east1-b \
  --metadata env-docker-image=ghcr.io/digitumdei/actuarius:<sha>

gcloud compute instances reset actuarius-bot --zone=us-east1-b
```

### Restore to latest after a rollback

```bash
gcloud compute instances add-metadata actuarius-bot --zone=us-east1-b \
  --metadata env-docker-image=ghcr.io/digitumdei/actuarius:latest

gcloud compute instances reset actuarius-bot --zone=us-east1-b
```

### Watch startup logs

```bash
gcloud compute ssh actuarius-bot --zone=us-east1-b
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
