# Deploy

This document describes the deployment lifecycle for the Actuarius Discord bot on GCP.

## Overview

```
publish reviewed scripts ──► guarded cutover (once) ──► reboot + verify ──► terraform apply/redeploy
```

The bot runs as a Docker container on a single GCE VM. Infrastructure is managed with Terraform; the application is deployed via a helper script fetched from instance metadata.

## Terraform

The `infra/` directory defines the VM, disk, networking, and service account. Sensible values go in `terraform.tfvars` (gitignored — never commit secrets here).

Terraform writes all **non-secret** configuration into [instance metadata](https://cloud.google.com/compute/docs/metadata) — environment variables and the redeploy script itself (`env-redeploy-script`) — and creates empty [Secret Manager](https://cloud.google.com/secret-manager) containers for the secret values (see below).

Before applying, inspect the plan. On an existing VM, a plan that changes a
stop-required instance property may restart the VM because the instance allows
stopping updates. If the legacy container still uses restart policy
`unless-stopped`, complete the one-time cutover below **before** any full apply.
After that cutover and its required reboot have been verified, apply normally:

```bash
cd infra
terraform plan
terraform apply
```

### Mandatory one-time metadata-isolation cutover

When upgrading a VM whose existing `actuarius` container still has Docker
restart policy `unless-stopped`, do **not** run a full `terraform apply`, reboot,
or redeploy yet. A stopping Terraform update could reboot the VM and let Docker
auto-start that legacy container before the metadata firewall exists.

From the repository root of the exact reviewed checkout, first publish only the
two hash-bound script payloads. `gcloud compute instances add-metadata` updates
metadata in place and does not stop the VM:

```bash
gcloud compute instances add-metadata actuarius-bot \
  --project <YOUR_PROJECT_ID> --zone <ZONE> \
  --metadata-from-file=env-startup-script=infra/startup.sh,env-redeploy-script=scripts/redeploy.sh
```

Then copy and run the cutover:

```bash
gcloud compute scp scripts/cutover-metadata-isolation.sh \
  actuarius-bot:/tmp/cutover-metadata-isolation.sh \
  --project <YOUR_PROJECT_ID> --zone <ZONE> --tunnel-through-iap

gcloud compute ssh actuarius-bot \
  --project <YOUR_PROJECT_ID> --zone <ZONE> --tunnel-through-iap \
  --command 'sudo bash /tmp/cutover-metadata-isolation.sh'
```

The script refuses to mutate the container unless both published metadata
payload hashes match its reviewed release. Success means the restart policy is
`no` and the legacy container is stopped. **Reboot immediately; do not run the
new redeploy payload in this gap**, because `startup.sh` has not installed the
systemd units yet:

```bash
gcloud compute ssh actuarius-bot \
  --project <YOUR_PROJECT_ID> --zone <ZONE> --tunnel-through-iap \
  --command 'sudo reboot'
```

After the VM returns, verify the units and container before the full Terraform
apply or any manual redeploy:

```bash
gcloud compute ssh actuarius-bot \
  --project <YOUR_PROJECT_ID> --zone <ZONE> --tunnel-through-iap \
  --command 'sudo systemctl --no-pager --full status actuarius-firewall.service actuarius-bot.service && sudo docker inspect -f "restart={{.HostConfig.RestartPolicy.Name}} running={{.State.Running}}" actuarius'
```

Both units must be active, and the container must report restart policy `no`
and running state `true`. The full `terraform plan` / `terraform apply` may now proceed;
any stop-required update is safe because Docker no longer owns container
restart. New VMs and already-migrated stopped containers are handled
idempotently; a brand-new VM may be created with the normal Terraform flow.

## Secrets

Secret values (Discord token, GitHub App private key, Claude OAuth token, API
keys, MemPalace federation token) never pass through Terraform: not in
`terraform.tfvars`, not in state, not in saved plan files, not in VM metadata.
Terraform only creates the secret *containers* (`infra/secrets.tf`) and grants
the VM service account `roles/secretmanager.secretAccessor`. Add or rotate
values with:

```bash
gcloud secrets versions add actuarius-discord-token --data-file=-   # paste value, then Ctrl+D
```

Secret names: `actuarius-discord-token`, `actuarius-claude-oauth-token`,
`actuarius-github-app-private-key-b64` (or `actuarius-github-app-private-key`
for a raw PEM — set only one), `actuarius-gh-token`, `actuarius-gemini-api-key`,
`actuarius-mempalace-remote-token`. `redeploy.sh` always reads
`versions/latest`, so rotation is: add a new version, run redeploy. Never pass
secrets as command-line arguments — they end up in shell history and `ps`.

## Redeploy

The startup script (`infra/startup.sh`) fetches `env-redeploy-script` from metadata and runs it on every boot. To redeploy *without* rebooting, fetch and run it manually:

```bash
sudo bash /var/redeploy.sh              # deploy latest image
sudo bash /var/redeploy.sh abc1234      # roll back to a specific commit
```

If the metadata has changed since the last boot (e.g. after `terraform apply`), the local `/var/redeploy.sh` is stale. Re-fetch it from metadata first:

```bash
META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
curl -sf -H "Metadata-Flavor: Google" "$META/env-redeploy-script" | sudo tee /var/redeploy.sh > /dev/null
sudo bash /var/redeploy.sh
```

The first reboot after the mandatory cutover is part of that procedure. Do not
manually redeploy until it has installed and started the two systemd units.

## What redeploy.sh does

1. Reads non-secret config from metadata (`env-discord-client-id`, `env-enable-codex-execution`, etc.) and secret values from Secret Manager (`actuarius-discord-token`, etc.) using the VM service account's access token
2. Pulls the Docker image (`ghcr.io/digitumdei/actuarius:latest` or a specific SHA tag)
3. Stops and removes the old container
4. Creates a new `restart=no` container with the correct env vars
5. Starts it through `actuarius-bot.service`, whose pre-start gate revalidates
   metadata isolation every time the container starts
6. Reclaims disk by removing old `ghcr.io/digitumdei/actuarius:*` images

### Image retention and disk space

Each release image is about 1.5 GB and the Docker data-root partition is only
5.7 GB, so three resident images fill it. `docker image prune -f` alone never
helped: it only removes *dangling* images, never tagged `:<git-sha>` releases.
A `docker pull` that runs out of room fails partway through
(`failed to register layer: ... no space left on device`) after the old
container has already been removed, which turns a routine deploy into an
outage.

`redeploy.sh` therefore:

- Logs free space on the Docker data-root partition before pulling.
- Prunes *before* the pull when free space is under 2560 MB (override with
  `PRUNE_MIN_FREE_MB`), because that is the case where the pull would fail.
- Prunes again after the new container has been created and started.
- Always retains the image just deployed **and** the single most recent
  previous release image — that pair is the rollback pair described under
  [MemPalace binary upgrades and rollback](#mempalace-binary-upgrades-and-rollback).
- Never removes an image that still backs an existing container.
- Treats every pruning step as best effort: a failure logs a warning and the
  deploy still succeeds.

To retain more than one rollback image, remove old images manually instead of
loosening this, and check free space first.

### COS disk layout gotcha

`df -h /` on the VM is misleading — `/` is a read-only ~1.9 GB COS vroot that
has nothing to do with image storage. The numbers that matter:

```bash
# Where Docker actually stores images (/dev/sda1, ~5.7 GB total)
df -h /mnt/stateful_partition
docker info --format '{{.DockerRootDir}}'

# The persistent data disk: /mnt/disks/data on the host, /data in the container
df -h /mnt/disks/data
```

Running `df -h /data` **on the host** legitimately returns nothing; `/data` only
exists inside the container. Check `/mnt/disks/data` from the host, or run
`docker exec actuarius df -h /data`.

Production deploys constrain the container to 700 MB RAM, 2 GB memory+swap,
0.8 CPU, and 1024 tasks by default. These cgroup limits keep provider builds
or fork storms from starving the VM host. Note the pids limit counts threads
as well as processes — each concurrent provider CLI stack uses roughly 60–80
tasks, so the earlier 256 default caused `EAGAIN` (os error 11) thread-creation
failures when three reviewers ran at once. The swap allowance matters: the VM
provisions a 1536 MB swapfile (`infra/startup.sh`) so heavy provider CLI
subprocesses spill to swap instead of being SIGKILLed by the OOM killer.
Override the limits with Terraform variables `container_memory`,
`container_memory_swap`, `container_cpus`, and `container_pids_limit`; keep the
memory limit below total VM RAM so Docker, SSH, and system services retain
headroom, and set `container_memory_swap` equal to `container_memory` to
disable swap entirely.

Local Docker Compose uses the same defaults. Override them with
`ACTUARIUS_CONTAINER_MEMORY`, `ACTUARIUS_CONTAINER_MEMORY_SWAP`,
`ACTUARIUS_CONTAINER_CPUS`, and `ACTUARIUS_CONTAINER_PIDS_LIMIT` when a
development machine has different capacity.

## Logs (no SSH needed)

The VM metadata sets `google-logging-enabled = "true"`, which turns on the
Container-Optimized OS logging agent: all container stdout/stderr streams to
Cloud Logging (the service account has `roles/logging.logWriter`). Read logs
from anywhere with gcloud:

```bash
# Last 30 minutes of bot logs
gcloud logging read 'logName:cos_containers AND jsonPayload."cos.googleapis.com/container_name"="actuarius"' \
  --freshness=30m --limit=100 --order=desc --format='value(timestamp, jsonPayload.message)'

# Live tail
gcloud alpha logging tail 'jsonPayload."cos.googleapis.com/container_name"="actuarius"'
```

Or use the Logs Explorer in the GCP Console. The bot logs structured JSON
(pino), so fields like `level` and `msg` are queryable. Within the free tier
(50 GiB/month ingestion, 30-day retention) this costs nothing at this bot's
volume. `docker logs actuarius` over SSH still works as a fallback.

## MemPalace Remote

To run the AgentPalace HTTP MCP client plus shared federation server in production, set both Terraform switches:

```hcl
enable_mempalace        = true
enable_mempalace_remote = true
```

Optional variables map directly to the redeploy metadata keys and can stay blank to use app defaults: `mempalace_remote_url`, `mempalace_remote_bind`, `mempalace_remote_name`, `mempalace_remote_token`, `mempalace_remote_timeout_ms`, `mempalace_remote_mine_on_sync`, `mempalace_remote_mine_timeout_ms`, and `mempalace_remote_mine_batch_size`. If `mempalace_remote_token` is blank, Actuarius generates a token and persists it under `/data/mempalace/server_tokens.json`.

After `terraform apply`, reboot or re-fetch `/var/redeploy.sh` from metadata so the new metadata keys reach the container.

### AgentPalace 0.1.47 HTTP cutover

When both memory flags are disabled, startup removes managed `mempalace` and `agentpalace` MCP registrations from every provider. Connecting a repository saves its checkout mapping without restarting the shared server or interrupting active tools. AgentPalace 0.1.47 loads these mappings at startup, so source retrieval for a newly connected repository requires the next planned server restart; ordinary memory reads, writes, and mining remain available.


This upgrade supersedes the shared-directory approach in PR #215. **Do not run its remote-to-local merge.** Keep the existing `/data/mempalace/remote-palace` (or configured override) as the server authority; this preserves coordination state, drawers, KG, IDs and history in place.

1. Record the deployed image and take the stopped-bot snapshot described below. It must include both palace directories, `$HOME/.mempalace`, tokens, provider configs and model cache.
2. Deploy the pinned image. It uses one `agentpalace` executable. Existing `MEMPALACE_*` metadata values remain supported, so no Terraform resource changes are needed for this upgrade. Custom CLI paths must point at the new executable.
3. The entrypoint retains the old model cache under the new cache name when the new directory is absent; both are preserved when both exist. The service uses `AGENTPALACE_CONFIG_DIR=$HOME/.mempalace` so identity and server settings are retained. Old tool prefixes in identity are updated without replacing operator text.
4. Startup allows up to two minutes for a cold model load (with cancellable shutdown), removes self-federation routes, verifies the authenticated `/mcp` handshake, then writes HTTP registrations for Claude, Codex, Gemini, OpenCode, and OpenCode planning snapshots. A failed server startup aborts boot rather than launching LLMs against stale stdio registrations. All clients share the server's palace and embedding runtime.
5. Verify `agentpalace --version` reports 0.1.47, `/v1/info` reports the expected version and `low_cpu`, all four providers discover `agentpalace_*` tools, and a drawer written via HTTP MCP is readable from a home PC through federation. Check simultaneous clients and server restart recovery. Home-PC stdio configurations are unchanged.

**Local-only history:** the former `/data/mempalace/palace` is preserved untouched as an archive. Its old local-only diaries are not silently copied into the shared server and will not appear in new wake-ups. Keep that directory and the snapshot; if historical diary retrieval is needed, open a *snapshot copy* with an isolated matching-version server and explicit palace/config paths. New bot/LLM diaries live in the authoritative shared palace. Identity remains available through the retained config directory.

Provider config files contain the local unrestricted bearer token, as required by HTTP MCP. They are mode 0600. Rotate it through the configured token source and restart the bot to converge registrations. Continue using loopback/IAP; this change does not expose a public port.

Provider configuration references: [Claude](https://code.claude.com/docs/en/mcp), [Codex](https://developers.openai.com/codex/mcp), [Gemini](https://geminicli.com/docs/tools/mcp-server/), [OpenCode](https://opencode.ai/docs/mcp-servers/).

### AgentPalace performance harness

`scripts/perf-agentpalace-http.mjs` measures the shared HTTP MCP. **Measuring an existing server is the production path**; it runs a sequential baseline first, then a concurrent phase, and reports per-tool latency percentiles, throughput, errors, peak/mean server RSS, and the container's CPU-throttling, memory/swap, and pressure counters across the measured window.

```bash
npm run build

# Production path: measure the deployed server without restarting it or touching its palace.
PERF_BASE_URL=http://127.0.0.1:8765 \
PERF_TOKEN_FILE=/data/mempalace/server_tokens.json \
PERF_PALACE_PATH=/data/mempalace/remote-palace \
PERF_WING=wing_actuarius \
PERF_QUERY='shared violet telescope calibration record' \
PERF_CLIENTS=1 PERF_ITERATIONS=2 PERF_OPERATIONS=status,search \
node scripts/perf-agentpalace-http.mjs
```

Set `PERF_WING` and `PERF_QUERY` to a representative project wing and query; otherwise searches use the synthetic `wing_perf` probe and the report flags this as a caveat. A live target defaults to one client and read-only operations so it does not overload the running bot.

Booting a disposable palace under `/tmp` (never `/data`) is for local development and CI only and requires explicit opt-in, because a second server competes for the deployed container's shared CPU and memory quota. The harness also refuses to run at all unless `PERF_BASE_URL` or `PERF_ALLOW_BOOT=1` is set:

```bash
PERF_ALLOW_BOOT=1 npm run perf:agentpalace
```

Tune the run with `PERF_CLIENTS` (default 4; live defaults to 1), `PERF_ITERATIONS` (default 3), `PERF_BASELINE_ITERATIONS` (default 3; `0` disables the sequential baseline), `PERF_WARMUP` (default 1), `PERF_SAMPLE_INTERVAL_MS` (default 250), and `PERF_OPERATIONS` (default `status,search,wake_up,add_drawer,kg_add,diary_write`; `list_wings`, `taxonomy`, and `check_duplicate` are also available). Use `PERF_REAL_EMBEDDINGS=1` for the real model, `PERF_MAX_P95_MS` and `PERF_MAX_ERROR_RATE` to gate the run on a budget, and `PERF_JSON=<path>` to capture a machine-readable report.

The report separates the sequential baseline from the concurrent phase, records CPU throttling and memory/swap/pressure deltas before and after the run, samples peak and mean AgentPalace RSS (not just the endpoint value), and lists pre-existing disposable-palace directories or harness, mining, or bot processes that could contend. **p95/p99 with fewer than 20 samples per operation are marked as indicative only** — the default live run is a small sample, so treat those percentiles as directional rather than a robust production baseline. The container is capped below one CPU, so latency grows with concurrency and throughput does not scale linearly with clients.

### MemPalace binary upgrades and rollback

Treat a MemPalace binary upgrade as a data migration. Coordination schema
migrations are lazy: the new schema may not be written until the first
coordination request. Once that happens, rolling back only the container image
is unsafe because an older binary may not be able to write to the migrated
SQLite tables.

Before deploying an image with a newer MemPalace version:

1. Record the currently deployed Actuarius image SHA.
2. Stop `actuarius-bot.service` so the local and remote palaces have no writers.
3. Run `sync`, then snapshot the persistent data disk. The snapshot is the
   rollback boundary and must contain each palace's `storage.sqlite3` and
   `lancedb/` directory from the same point in time.
4. Start the bot again if the new image is not being deployed immediately.

After deploying, verify the loopback federation server through the IAP tunnel:

```bash
curl -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:8765/v1/info
```

Confirm the expected `server_version` and capabilities. For releases that add
federated coordination, the capability list must contain `coordination`; an
unknown `agentpalace_task_get` should return `found: false`, not a capability
error.

Rollback is a paired operation: deploy the recorded old image **and** restore
the matching pre-upgrade data-disk snapshot. Never run the old binary against a
palace after the new binary has opened its coordination store. Existing token
files without a `scopes` field remain unrestricted; if scopes are added, note
that an empty array deliberately grants nothing and unknown or misspelled token
fields fail closed.

## Adding a new env var

**Non-secret config** — three places:

| Step | File | What to add |
|------|------|-------------|
| 1. Terraform variable | `infra/variables.tf` | New `variable` block |
| 2. Metadata mapping | `infra/compute.tf` | New `env-<name>` metadata entry referencing the variable |
| 3. Container env | `scripts/redeploy.sh` | `get_meta` call + `-e` flag in `EXTRA_ARGS` |

**Secret values** — never a Terraform variable:

| Step | Where | What to do |
|------|-------|------------|
| 1. Secret container | `infra/secrets.tf` | Add the name to `local.actuarius_secrets` |
| 2. Secret value | `gcloud` | `gcloud secrets versions add actuarius-<name> --data-file=-` |
| 3. Container env | `scripts/redeploy.sh` | `get_secret` call + `-e` flag in `EXTRA_ARGS` |

After Terraform changes: run `terraform apply` to push metadata / create containers.
After `redeploy.sh` changes: the redeploy script must be re-fetched (reboot or manual `curl`).
