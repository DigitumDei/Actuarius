# Lessons Learned

Hard-won knowledge from debugging and development. Read this before making changes to avoid repeating past mistakes.

## Subprocess stdin must be closed

`execFile`/`promisify` leaves stdin as an open pipe. CLI tools like Claude wait on stdin before running, even with `-p`, causing the process to stall indefinitely.

**Fix:** Use `spawn` with `stdio: ["ignore", "pipe", "pipe"]` so stdin is definitively closed. See `src/utils/spawnCollect.ts`.

**Rule:** For any subprocess that should run non-interactively, always use `spawnCollect` or explicitly set `stdio[0]` to `"ignore"`. Do not use `execFile`/`promisify` for CLI tools that may check stdin.

## `--add-dir` is redundant

`claude --add-dir <cwd>` was redundant since `cwd` is already set to the worktree root. The CLI operates on its working directory by default. Removed to avoid confusion.

## `spawnCollect` errors put details in `stderr`, not `message`

When `spawnCollect` rejects, `error.message` is generic (e.g. `"Process exited with code 128"`). The actual error output is in `error.stderr`. This differs from `execFile`/`promisify` which concatenates stderr into the error message. When switching from `execFile` to `spawnCollect`, update any catch blocks that inspect `error.message` for specific error strings — they need to check `error.stderr` as well.

## Single-guild deployment model

Actuarius is one instance per Discord guild. Multi-guild from a single instance is not supported and would be a major architectural change. Do not add multi-guild abstractions or per-guild isolation for shared resources (credentials, toolchains, etc.).
