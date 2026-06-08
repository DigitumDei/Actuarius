# Lessons Learned

Hard-won knowledge from debugging and development. Read this before making changes to avoid repeating past mistakes.

## Recovering from an expired `gh` token on the deployed box

If `gh auth status` shows a 401 inside the `actuarius` container, the GitHub App installation token in `/data/.gh/hosts.yml` is stale. The auth manager's scheduled refresh loop uses pino with the `error` key (instead of `err`), so `error.message` is silently dropped from logs — only the error `code` is visible.

**Recovery options (in order of preference):**
1. `/gh-auth-refresh` — Discord slash command (requires Manage Server). Force-mints a fresh installation token and re-runs `gh auth login`. Reports the logged-in account name on success.
2. `docker restart actuarius` — re-runs `initialize()`, which also mints a fresh token. Use when the bot is unreachable via Discord.
3. If both fail: the GitHub App private key or installation ID is the culprit. Regenerate the private key on GitHub, re-encode it (`base64 -w0 private-key.pem`), update `.env` `GITHUB_APP_PRIVATE_KEY_B64`, and `docker compose up -d --build`.

## Subprocess stdin must be closed

`execFile`/`promisify` leaves stdin as an open pipe. CLI tools like Claude wait on stdin before running, even with `-p`, causing the process to stall indefinitely.

**Fix:** Use `spawn` with `stdio: ["ignore", "pipe", "pipe"]` so stdin is definitively closed. See `src/utils/spawnCollect.ts`.

**Rule:** For any subprocess that should run non-interactively, always use `spawnCollect` or explicitly set `stdio[0]` to `"ignore"`. Do not use `execFile`/`promisify` for CLI tools that may check stdin.

## `--add-dir` is redundant

`claude --add-dir <cwd>` was redundant since `cwd` is already set to the worktree root. The CLI operates on its working directory by default. Removed to avoid confusion.

## `spawnCollect` errors put details in `stderr`, not `message`

When `spawnCollect` rejects, `error.message` is generic (e.g. `"Process exited with code 128"`). The actual error output is in `error.stderr`. This differs from `execFile`/`promisify` which concatenates stderr into the error message. When switching from `execFile` to `spawnCollect`, update any catch blocks that inspect `error.message` for specific error strings — they need to check `error.stderr` as well.

## `blkid` can race on boot and wipe the data disk

On Container-Optimized OS, `blkid` may return false on a freshly attached disk (even one restored from a snapshot) if the device isn't fully ready yet. Using `blkid` to gate `mkfs.ext4` is unsafe — it can cause the disk to be reformatted and all data lost.

**Fix:** Attempt `mount` first. Only run `mkfs.ext4` if mount fails — a mount failure is the only reliable signal that the disk genuinely has no filesystem. See `infra/startup.sh`.

**Rule:** Never use `blkid` as the sole guard before formatting a disk. Always try mount first.

## `/data` fills from per-repo toolchains and build caches, not worktrees

When the 10 GB `/data` disk hits `ENOSPC`, the bot fails to start (npm can't unpack provider CLIs, git can't write `.gitconfig.lock`). The culprit is two append-mostly sources — *not* worktrees, which are bounded by request count and partly reaped:

- **Per-repo toolchains** installed via `/install`, under `/data/tool-installs/<scope>/<id>/`. The JVM/Android stack is heaviest — one Android repo pulled ~1.1 GB (`java-temurin` ~500 MB + `android-sdk` ~600 MB).
- **Build-tool caches** in the container `$HOME` (`/data/home/appuser`): `.npm` (npm cache), `.gradle/caches`, `.cargo/registry`, `.rustup` (Rust toolchains), `.cache`.

Two gotchas:
- **Host vs container path:** the disk is `/mnt/disks/data` on the COS host but `/data` inside the container (`$HOME` = `/data/home/appuser`). `rm` against the wrong namespace silently no-ops — `df`/`du` won't budge.
- **Installs are explicit and admin-gated** (`/install`) — nothing auto-installs toolchains. Deleting a toolchain's files does NOT clear its `install_requests` row, so `buildMinimalExecutionEnvironment` keeps injecting the dead `bin_path` onto `PATH` (harmless), and the bot won't reinstall until `/install` is re-run.

**Fix (reclaim, run inside the container):** all of these regenerate or are re-`/install`able:
```bash
rm -rf ~/.npm/_cacache ~/.gradle/caches ~/.cargo/registry ~/.cache/*   # caches
rm -rf ~/.rustup ~/.cargo                                              # Rust toolchain
rm -rf /data/tool-installs/repo/<id>/{java-temurin,android-sdk}        # JVM/Android toolchains
```
Do NOT delete `.npm-global` (the provider CLIs) or auth files (`.codex/auth.json`, `.local/share/opencode/auth.json`, `.gemini` creds).

**Rule:** When `/data` approaches full, reclaim caches + unused per-repo toolchains first. The durable fix is a larger disk — follow the snapshot-first resize procedure (confirm `prevent_destroy`, snapshot `actuarius-data`, bump `size` in `infra/compute.tf`, `terraform apply`, then `resize2fs`); a botched resize previously caused full data loss.

## Updating `scripts/redeploy.sh` requires a manual refresh on the VM

`infra/startup.sh` fetches `scripts/redeploy.sh` from VM metadata at boot and saves it to `/var/redeploy.sh`. When Terraform updates the `env-redeploy-script` metadata key (e.g. adding a new env var), the VM is not rebooted, so `/var/redeploy.sh` stays stale.

**Fix:** After a `terraform apply` that changes `scripts/redeploy.sh`, refresh the script on the VM before running it:
```bash
sudo bash -c "curl -sf -H 'Metadata-Flavor: Google' 'http://metadata.google.internal/computeMetadata/v1/instance/attributes/env-redeploy-script' > /var/redeploy.sh"
sudo bash /var/redeploy.sh
```

**Rule:** Any new env var added to `scripts/redeploy.sh` won't be picked up by a running VM until the script is manually refreshed or the VM is rebooted.

## Single-guild deployment model

Actuarius is one instance per Discord guild. Multi-guild from a single instance is not supported and would be a major architectural change. Do not add multi-guild abstractions or per-guild isolation for shared resources (credentials, toolchains, etc.).
