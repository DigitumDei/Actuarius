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
rm -rf ~/.npm/_cacache ~/.gradle/caches ~/.cargo/registry             # caches
find ~/.cache -mindepth 1 -maxdepth 1 ! -name mempalace -exec rm -rf {} +  # keep the embedding model
rm -rf ~/.rustup ~/.cargo                                              # Rust toolchain
rm -rf /data/tool-installs/*/*/{java-temurin,android-sdk}             # JVM/Android toolchains (all repos)
```
Do NOT delete `.npm-global` (the provider CLIs), auth files (`.codex/auth.json`, `.local/share/opencode/auth.json`, `.gemini` creds), or `~/.cache/mempalace`.

**`~/.cache/mempalace` is not a disposable cache.** MemPalace stores its downloaded ONNX embedding model there (~86 MB), derived from `XDG_CACHE_HOME` — the binary exposes no path override (only `MEMPALACE_EMBED_ALLOW_DOWNLOADS`, `MEMPALACE_EMBEDDING_PROFILE`, `MEMPALACE_STUB_EMBEDDINGS`). A blanket `rm -rf ~/.cache` in `docker/entrypoint.sh` was deleting it on every container start, costing an ~86 MB refetch and a slow first search each boot while reclaiming only ~8 MB of genuinely disposable cache. The entrypoint now prunes `~/.cache` entry-by-entry (`prune_cache_dir`) with `mempalace` preserved.

**Rule:** When `/data` approaches full, reclaim caches + unused per-repo toolchains first. The durable fix is a larger disk — follow the snapshot-first resize procedure (confirm `prevent_destroy`, snapshot `actuarius-data-balanced-20260731`, bump `size` in `infra/compute.tf`, `terraform apply`, then `resize2fs`); a botched resize previously caused full data loss.

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

## Terraform plan/state files contain secrets in cleartext — never in the repo tree

On 2026-07-07 a saved plan file (`terraform plan -out=...`) written into `infra/` was swept into a commit by `git add -A` and pushed to the then-public repo. Plan files embed the full prior state, including every VM metadata value — at the time that meant the Discord token, GitHub App private key, Claude OAuth token, and Gemini API key. Three independent scanners (GitHub secret scanning, Discord, Google) detected it within minutes; all credentials had to be rotated.

**Rules:**
- Never write `terraform plan -out` files, state files, or state backups inside the repo tree; use a temp/scratch directory. `.gitignore` now blocks `tfplan*` as a backstop.
- Prefer `git add <specific files>` over `git add -A` after infra work.
- Secret values must not pass through Terraform at all: they live in Secret Manager (`infra/secrets.tf` creates containers; values added via `gcloud secrets versions add`), so tfvars, state, and plan files stay secret-free by construction.

## `docker image prune -f` never reclaims old release images

On 2026-09-08 the MemPalace v0.1.38 deploy died mid-pull with `failed to register layer: write /usr/lib/x86_64-linux-gnu/libclang-19.so.19: no space left on device`. The old container had already been removed, so this turned a routine deploy into an outage. Manual fix was `sudo docker rmi <old-sha-tag> ghcr.io/digitumdei/actuarius:latest`, which freed 1.5 GB.

Cause: `scripts/redeploy.sh` ended with `docker image prune -f`, which only removes **dangling** images. Tagged `ghcr.io/digitumdei/actuarius:<git-sha>` releases were never touched, and each is ~1.5 GB against a 5.7 GB Docker data-root partition — three resident images fill it.

**Rules:**
- `df -h /` on the VM is misleading: `/` is a read-only ~1.9 GB COS vroot. Check `df -h /mnt/stateful_partition` (or `docker info --format '{{.DockerRootDir}}'`) for image storage, and `df -h /mnt/disks/data` for the persistent data disk. `df -h /data` on the *host* legitimately returns nothing — `/data` is the in-container mount point; use `docker exec actuarius df -h /data`.
- `redeploy.sh` now logs free space before pulling, prunes early when it is under 2560 MB, and prunes again after the new container starts. It always retains the deployed image plus one previous release (the rollback pair in [docs/deploy.md](deploy.md)) and never touches an image backing a container.
- Pruning is best effort by design: a failure warns and the deploy continues. Reclaiming disk must never be able to fail a deploy.

## Both disk configs drifted from the disks that actually exist

The 2026-07-31 `pd-standard` -> `pd-balanced` migration recreated the data disk from a snapshot under a **new name**, but `infra/compute.tf` was never updated. The config kept describing the March disk, so from then on every `terraform plan` wanted to replace the live production disk on three ForceNew attributes at once:

| | `infra/compute.tf` | Live disk in state |
|---|---|---|
| `name` | `actuarius-data` | `actuarius-data-balanced-20260731` |
| `type` | `pd-standard` | `pd-balanced` |
| `snapshot` | unset (null) | `actuarius-data-pre-balanced-20260731-1530z` |

This surfaced on 2026-09-09 as `- snapshot = "...actuarius-data-pre-balanced-20260731-1530z" -> null # forces replacement`, and the plan **errored** because `prevent_destroy` refused the destroy. That error was the guardrail working, not a bug to route around. Removing `prevent_destroy` would have destroyed the production data disk — and then failed anyway, because the orphaned `actuarius-data` disk still exists unattached and would have collided on the name.

`snapshot` is the subtle one: it is ForceNew but also populated by refresh from the disk's immutable `sourceSnapshot`, so it records provenance the config never asked for and can never satisfy. It is now under `ignore_changes`.

### The same thing had happened to the boot disk

The 2026-08-01 migration cloned the boot disk to `actuarius-boot-balanced-20260801` (`pd-balanced`, from snapshot `actuarius-boot-pre-balanced-20260801-0828z`) and likewise left `infra/compute.tf` saying `pd-standard`. That surfaced immediately after the data disk was fixed, as `~ type = "pd-balanced" -> "pd-standard" # forces replacement`.

This one was **more dangerous**, because `boot_disk.initialize_params.type` is ForceNew on `google_compute_instance` and that resource had **no `prevent_destroy`**. Nothing would have stopped the apply from destroying and recreating the VM, which would have wiped `/mnt/stateful_partition` (the whole Docker image cache) and re-run the boot path that decides whether to `mkfs.ext4` the data disk. `prevent_destroy` has since been added to the instance.

**Rules:**
- After any migration that recreates a disk (type change, restore-from-snapshot, rename), update `infra/compute.tf` in the same change. State and reality diverging silently is how these stayed latent for six weeks and five weeks respectively.
- A plan that wants to replace `google_compute_disk.data` or `google_compute_instance.actuarius` is always a bug in the config, never a thing to apply. Reconcile the config to reality; never relax a lifecycle block to make a plan go through.
- Fix *all* the drifted attributes at once. These arrived one plan line at a time (`snapshot`, then boot `type`), which invites whack-a-mole. When a ForceNew attribute is stale, diff the whole resource against the live API before writing the fix.
- Terraform prints `state -> config`. If the live value is on the left and the wrong value on the right, the config is stale, not the cloud.
- Old disks are not cleaned up automatically. `actuarius-data` (10 GB `pd-standard`, 2026-03-17) is unattached and billed, and holds a stale March copy of production data. `actuarius-bot` (10 GB `pd-standard`, 2026-03-17) is the pre-migration boot disk, deliberately retained for rollback per its own description.
