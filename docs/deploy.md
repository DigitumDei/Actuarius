# Deploy

This document describes the deployment lifecycle for the Actuarius Discord bot on GCP.

## Overview

```
terraform apply ──► updates metadata ──► reboot or curl ──► redeploy.sh ──► docker run
```

The bot runs as a Docker container on a single GCE VM. Infrastructure is managed with Terraform; the application is deployed via a helper script fetched from instance metadata.

## Terraform

The `infra/` directory defines the VM, disk, networking, and service account. Sensible values go in `terraform.tfvars` (gitignored — never commit secrets here).

Apply with:

```bash
cd infra
terraform apply
```

This writes all **non-secret** configuration into [instance metadata](https://cloud.google.com/compute/docs/metadata) — environment variables and the redeploy script itself (`env-redeploy-script`) — and creates empty [Secret Manager](https://cloud.google.com/secret-manager) containers for the secret values (see below). **It does not restart the VM or the container.**

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

Or reboot the VM so `startup.sh` handles it:

```bash
sudo reboot
```

## What redeploy.sh does

1. Reads non-secret config from metadata (`env-discord-client-id`, `env-enable-codex-execution`, etc.) and secret values from Secret Manager (`actuarius-discord-token`, etc.) using the VM service account's access token
2. Pulls the Docker image (`ghcr.io/digitumdei/actuarius:latest` or a specific SHA tag)
3. Stops and removes the old container
4. Starts a new container with the correct env vars mapped from metadata

Production deploys constrain the container to 700 MB RAM, 2 GB memory+swap,
0.8 CPU, and 256 processes by default. These cgroup limits keep provider builds
or fork storms from starving the VM host. The swap allowance matters: the VM
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

To run the local MemPalace MCP plus Actuarius' loopback remote repo store in production, set both Terraform switches:

```hcl
enable_mempalace        = true
enable_mempalace_remote = true
```

Optional variables map directly to the redeploy metadata keys and can stay blank to use app defaults: `mempalace_remote_url`, `mempalace_remote_bind`, `mempalace_remote_name`, `mempalace_remote_token`, `mempalace_remote_timeout_ms`, `mempalace_remote_mine_on_sync`, `mempalace_remote_mine_timeout_ms`, and `mempalace_remote_mine_batch_size`. If `mempalace_remote_token` is blank, Actuarius generates a token and persists it under `/data/mempalace/server_tokens.json`.

After `terraform apply`, reboot or re-fetch `/var/redeploy.sh` from metadata so the new metadata keys reach the container.

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
