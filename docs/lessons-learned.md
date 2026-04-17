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
