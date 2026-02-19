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
  - `/repos`
  - `/ask`
- Creates one dedicated channel per connected repo (per Discord server).
- Creates one thread per `/ask` request to preserve request-specific history.
- Stores guild/repo/request mappings in SQLite.

## What v1 does not do

- Execute Codex/Claude/Gemini tasks from Discord requests yet.
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
- `DATABASE_PATH` (default `/data/app.db`)
- `LOG_LEVEL` (default `info`)
- `THREAD_AUTO_ARCHIVE_MINUTES` (`60`, `1440`, `4320`, or `10080`)

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

## Command behavior

### `/connect-repo repo:<owner/name>`

- Requires `Manage Server` permission.
- Verifies repo with `gh repo view`.
- Public repos only in v1.
- Creates channel `repo-<owner>-<repo>` (normalized).
- Stores guild->repo->channel mapping in SQLite.

### `/repos`

- Lists connected repos for the current Discord server.

### `/ask repo:<owner/name> prompt:<text>`

- Must be run in the mapped repo channel.
- Creates a new thread automatically.
- Posts the prompt in the thread.
- Persists request metadata for history/audit.

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
