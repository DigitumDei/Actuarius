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

This writes all configuration into [instance metadata](https://cloud.google.com/compute/docs/metadata) — environment variables, secrets, and the redeploy script itself (`env-redeploy-script`). **It does not restart the VM or the container.**

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

1. Reads metadata env vars (`env-discord-token`, `env-enable-codex-execution`, `env-enable-opencode-execution`, etc.)
2. Pulls the Docker image (`ghcr.io/digitumdei/actuarius:latest` or a specific SHA tag)
3. Stops and removes the old container
4. Starts a new container with the correct env vars mapped from metadata

## Adding a new env var

Three places need updating:

| Step | File | What to add |
|------|------|-------------|
| 1. Terraform variable | `infra/variables.tf` | New `variable` block |
| 2. Metadata mapping | `infra/compute.tf` | New `env-<name>` metadata entry referencing the variable |
| 3. Container env | `scripts/redeploy.sh` | `get_meta` call + `-e` flag in `EXTRA_ARGS` |

After steps 1-2: run `terraform apply` to push the metadata.
After step 3: the redeploy script must be re-fetched (reboot or manual `curl`).