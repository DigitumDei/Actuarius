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
