# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Actuarius is a Discord bot that bridges GitHub repositories with Discord channels. Users connect repos to channels and submit `/ask <prompt>` commands that run the Claude CLI in isolated git worktrees, posting results back to per-request threads.

## Commands

```bash
npm run dev       # Run in development mode (tsx, no build step)
npm run build     # Compile TypeScript to dist/
npm run check     # Type-check without emitting
npm test          # Run all tests (Vitest)
```

To run a single test file:
```bash
npx vitest run tests/claudeExecutionService.test.ts
```

Docker (preferred for production):
```bash
docker-compose up --build
```

## Architecture

### Request Flow

```
/ask prompt → create Discord thread → enqueue in RequestExecutionQueue
  → sync repo to master (gitWorkspaceService)
  → create isolated worktree (requestWorktreeService)
  → run claude CLI (claudeExecutionService)
  → post result to thread → update DB
```

### Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Bootstrap: DB init, capability checks, command registration, bot start |
| `src/discord/bot.ts` | Main bot class: all slash command handlers and request orchestration |
| `src/services/requestExecutionQueue.ts` | Per-guild bounded concurrency (FIFO, default 3 parallel) |
| `src/services/claudeExecutionService.ts` | Spawns `claude` CLI, parses JSON output |
| `src/services/requestWorktreeService.ts` | Creates/removes git worktrees under `.worktrees/<owner>/<repo>/<requestId>` |
| `src/services/gitWorkspaceService.ts` | Clones/updates repos under `<REPOS_ROOT_PATH>/<owner>/<repo>` |
| `src/db/database.ts` | SQLite wrapper (Node.js `DatabaseSync`): guilds, repos, requests, bot_state |
| `src/config.ts` | Zod-validated env config |

### Slash Commands

- `/connect-repo <owner/name>` — validates GitHub repo and creates a dedicated channel
- `/sync-repo [owner/name]` — re-syncs a repo checkout to latest master/main
- `/repos` — lists repos connected to the current guild
- `/ask <prompt>` — runs Claude in an isolated worktree on the repo linked to the current channel
- `/help` — usage instructions

### Database Schema (SQLite)

Four tables: `guilds`, `repos`, `requests`, `bot_state`. The `requests` table tracks all `/ask` invocations with status: `queued → running → succeeded | failed`.

### Environment Variables

Required: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`
Optional: `GH_TOKEN`, `DATABASE_PATH`, `REPOS_ROOT_PATH`, `ASK_CONCURRENCY_PER_GUILD`, `ASK_EXECUTION_TIMEOUT_MS`, `DISCORD_GUILD_ID` (dev: guild-scoped command registration), `LOG_LEVEL`, `THREAD_AUTO_ARCHIVE_MINUTES`

## TypeScript Configuration

- ES modules (`"type": "module"` in package.json)
- Strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
- Import paths must include `.js` extensions (NodeNext module resolution)
- Node.js >= 22 required (uses `DatabaseSync` from `node:sqlite`)
