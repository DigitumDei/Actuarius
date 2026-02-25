# Move Actuarius Online — GCP Free Tier Deployment Plan

## Context

Deploy the Actuarius Discord bot to a GCP free-tier e2-micro VM so it runs 24/7 at zero cost.
The GCP billing account already has paid resources in other regions — the free tier e2-micro is
per-billing-account and still applies.

## Key Constraints

- **e2-micro**: 2 shared vCPU, 1 GB RAM — **cannot build Docker images on-VM** (will OOM)
- **Free tier regions**: `us-west1`, `us-central1`, `us-east1` only → using **`us-east1`**
- **Free disk**: 30 GB pd-standard total across billing account; ~20 GB already used in asia-east → **10 GB remaining**
- **Free egress**: 1 GB/mo (bot traffic is ~50 MB/mo, fine)

## Architecture

```
GitHub push to main
  → GitHub Actions builds Docker image
  → Pushes to ghcr.io/DigitumDei/actuarius:latest  (free, public repo)
                              ↓
  GCP e2-micro (Container-Optimized OS, us-east1)
    ← docker pull on startup
    → runs bot container
    → data in /data on boot disk
```

**Why this approach:**
- Pre-build on GitHub Actions (free 2000 min/mo) instead of on-VM — avoids OOM on 1 GB RAM
- Container-Optimized OS has Docker pre-installed; minimal, auto-updates
- Plain `docker run` (COS doesn't have docker-compose; single container anyway)
- Secrets via instance metadata — simple, adequate for a personal project
- `ASK_CONCURRENCY_PER_GUILD=1` — two concurrent Claude CLI subprocesses would OOM

## Free Tier Budget

| Resource | Free Allowance | Our Usage | OK? |
|----------|---------------|-----------|-----|
| e2-micro | 1 instance, all hours/mo | 1 instance, 24/7 | ✓ |
| pd-standard | 30 GB (10 GB left) | 10 GB boot disk | ✓ |
| Egress | 1 GB/mo | ~50 MB | ✓ |
| External IP | Ephemeral (free while VM runs) | Ephemeral | ✓ |
| ghcr.io | Free for public repos | Public repo | ✓ |

**Disk strategy**: Single 10 GB boot disk. `/data` lives on boot disk.
Data survives reboots but NOT VM deletion. If the asia-east disks are freed, add a
separate persistent data disk for durability.

## File Structure to Create

```
infra/
  main.tf                    # Provider config, terraform block
  variables.tf               # All inputs, secrets marked sensitive
  network.tf                 # VPC, subnet, SSH firewall rule
  iam.tf                     # Minimal service account
  compute.tf                 # e2-micro VM, boot disk
  outputs.tf                 # External IP, SSH command
  startup.sh                 # Cloud-init script (templatefile)
  terraform.tfvars.example   # Safe-to-commit template (no real values)

.github/
  workflows/
    docker-publish.yml       # Build + push image to ghcr.io on push to main
```

## Implementation Steps

### Step 1 — GitHub Actions: `.github/workflows/docker-publish.yml`

On every push to `main`:
1. Checkout repo
2. Login to ghcr.io using `GITHUB_TOKEN` (auto-provided)
3. Build and push:
   - `ghcr.io/DigitumDei/actuarius:latest`
   - `ghcr.io/DigitumDei/actuarius:<git-sha>`

Uses `docker/build-push-action@v5`.

### Step 2 — Terraform: `infra/main.tf`

```hcl
terraform {
  required_version = ">= 1.5"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
}

provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
  zone    = var.gcp_zone
}
```

Local state (no GCS bucket — single operator, keep simple).

### Step 3 — Variables: `infra/variables.tf`

```hcl
variable "gcp_project_id"        { type = string }
variable "gcp_region"            { type = string; default = "us-east1" }
variable "gcp_zone"              { type = string; default = "us-east1-b" }
variable "docker_image"          { type = string; default = "ghcr.io/DigitumDei/actuarius:latest" }
variable "ask_concurrency"       { type = number; default = 1 }
variable "ssh_source_ranges"     { type = list(string); default = ["0.0.0.0/0"] }  # restrict to your IP

# Secrets
variable "discord_token"         { type = string; sensitive = true }
variable "discord_client_id"     { type = string; sensitive = true }
variable "gh_token"              { type = string; sensitive = true }
variable "claude_credentials_b64" { type = string; sensitive = true }
```

### Step 4 — Network: `infra/network.tf`

- Custom VPC (`actuarius-vpc`) + subnet (`actuarius-subnet`, `10.0.0.0/24`)
- Firewall rule: allow TCP 22 from `var.ssh_source_ranges` for SSH access
- Default egress allow (no changes needed — GCP allows all outbound by default)

### Step 5 — IAM: `infra/iam.tf`

- Service account `actuarius-bot@<project>.iam.gserviceaccount.com`
- No extra IAM roles (VM only needs to read its own metadata)

### Step 6 — Compute: `infra/compute.tf`

```hcl
resource "google_compute_instance" "actuarius" {
  name         = "actuarius-bot"
  machine_type = "e2-micro"
  zone         = var.gcp_zone

  boot_disk {
    initialize_params {
      image = "projects/cos-cloud/global/images/family/cos-stable"
      size  = 10       # GB, within 10 GB free tier remaining
      type  = "pd-standard"
    }
  }

  network_interface {
    network    = google_compute_network.vpc.self_link
    subnetwork = google_compute_subnetwork.subnet.self_link
    access_config {}   # Ephemeral public IP (free while VM runs)
  }

  metadata = {
    env-discord-token       = var.discord_token
    env-discord-client-id   = var.discord_client_id
    env-gh-token            = var.gh_token
    env-claude-creds-b64    = var.claude_credentials_b64
  }

  metadata_startup_script = templatefile("${path.module}/startup.sh", {
    docker_image    = var.docker_image
    ask_concurrency = var.ask_concurrency
  })

  service_account {
    email  = google_service_account.actuarius_bot.email
    scopes = ["cloud-platform"]
  }

  tags                      = ["actuarius-bot"]
  allow_stopping_for_update = true
}
```

**Do NOT set `preemptible = true`** — that disqualifies the VM from the free tier.

### Step 7 — Startup Script: `infra/startup.sh`

Runs on every boot (must be idempotent):

```bash
#!/bin/bash
set -euo pipefail

# --- Swap (safety margin for Claude CLI subprocesses) ---
SWAP=/var/actuarius.swap
if [ ! -f "$SWAP" ]; then
  fallocate -l 1G "$SWAP"
  chmod 600 "$SWAP"
  mkswap "$SWAP"
fi
swapon "$SWAP" 2>/dev/null || true

# --- Data directory ---
mkdir -p /var/actuarius/data

# --- Read secrets from instance metadata ---
META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
HDR="Metadata-Flavor: Google"
DISCORD_TOKEN=$(curl -sf -H "$HDR" "$META/env-discord-token")
DISCORD_CLIENT_ID=$(curl -sf -H "$HDR" "$META/env-discord-client-id")
GH_TOKEN=$(curl -sf -H "$HDR" "$META/env-gh-token")
CLAUDE_CREDS_B64=$(curl -sf -H "$HDR" "$META/env-claude-creds-b64")

# --- Pull latest image ---
docker pull ${docker_image}

# --- Stop existing container (idempotent) ---
docker stop actuarius 2>/dev/null || true
docker rm   actuarius 2>/dev/null || true

# --- Run bot ---
docker run -d \
  --name actuarius \
  --restart unless-stopped \
  -v /var/actuarius/data:/data \
  -e DISCORD_TOKEN="$DISCORD_TOKEN" \
  -e DISCORD_CLIENT_ID="$DISCORD_CLIENT_ID" \
  -e GH_TOKEN="$GH_TOKEN" \
  -e CLAUDE_CREDENTIALS_B64="$CLAUDE_CREDS_B64" \
  -e DATABASE_PATH=/data/app.db \
  -e REPOS_ROOT_PATH=/data/repos \
  -e ASK_CONCURRENCY_PER_GUILD=${ask_concurrency} \
  -e LOG_LEVEL=info \
  ${docker_image}
```

Note: `/var` is writable on COS. `${docker_image}` and `${ask_concurrency}` are
interpolated by Terraform's `templatefile()` before the script is sent to the VM.

### Step 8 — Outputs: `infra/outputs.tf`

```hcl
output "instance_ip" {
  value = google_compute_instance.actuarius.network_interface[0].access_config[0].nat_ip
}

output "ssh_command" {
  value = "gcloud compute ssh actuarius-bot --zone ${var.gcp_zone} --project ${var.gcp_project_id}"
}
```

### Step 9 — `infra/terraform.tfvars.example`

```hcl
gcp_project_id         = "your-gcp-project-id"
gcp_region             = "us-east1"
gcp_zone               = "us-east1-b"
docker_image           = "ghcr.io/DigitumDei/actuarius:latest"
ask_concurrency        = 1
ssh_source_ranges      = ["YOUR_IP/32"]   # optional: restrict SSH to your IP

discord_token          = "replace_me"
discord_client_id      = "replace_me"
gh_token               = "replace_me"
claude_credentials_b64 = "replace_me"    # base64 of ~/.claude/.credentials.json
```

### Step 10 — Update `.gitignore`

Add:
```
infra/*.tfvars
infra/.terraform/
infra/terraform.tfstate
infra/terraform.tfstate.backup
```

## Deployment Commands

```bash
# One-time setup
cd infra
terraform init

# Preview
terraform plan -var-file=terraform.tfvars

# Deploy
terraform apply -var-file=terraform.tfvars

# Get SSH command
terraform output ssh_command

# Check bot is running
gcloud compute ssh actuarius-bot --zone us-east1-b -- docker ps
gcloud compute ssh actuarius-bot --zone us-east1-b -- docker logs actuarius --tail 50
```

## Update Flow (after code changes)

1. Push to `main`
2. GitHub Actions builds + pushes new image to ghcr.io
3. SSH to VM and redeploy:

```bash
gcloud compute ssh actuarius-bot --zone us-east1-b -- \
  'docker pull ghcr.io/DigitumDei/actuarius:latest && \
   docker stop actuarius && docker rm actuarius && \
   docker run -d --name actuarius --restart unless-stopped \
     -v /var/actuarius/data:/data \
     ... (same env vars) \
     ghcr.io/DigitumDei/actuarius:latest'
```

Or just re-run `terraform apply` which re-executes the startup script via instance recreation.

## Verification Checklist

- [ ] `terraform plan` shows only the expected resources (VPC, subnet, firewall, SA, VM)
- [ ] `terraform apply` completes without error
- [ ] `docker ps` shows `actuarius` container running
- [ ] `docker logs actuarius` shows successful Discord login (`Logged in as ...`)
- [ ] `/ask` command works in Discord, response posted in thread
- [ ] GCP Billing → Cost breakdown shows $0.00 for Compute Engine

## Gotchas

- **Free disk budget is tight**: 10 GB remaining (20 GB used in asia-east). Do NOT add extra
  disks without first removing the asia-east one. If that disk is freed, add a separate
  10 GB persistent data disk so `/data` survives VM deletion.
- **Data on boot disk**: Survives reboots, lost on VM deletion. Back up SQLite DB periodically
  if the data matters (`docker cp actuarius:/data/app.db ./backup.db`).
- **Image pulls eat disk**: Each `docker pull` layers over the old image. Run
  `docker image prune -f` periodically to reclaim space.
- **Ephemeral IP**: Changes if the VM is stopped. Save the new IP after any stop/start
  (`terraform output instance_ip`).
- **Concurrency locked to 1**: If RAM usage improves (or if asia-east disk freed and we add swap
  on a data disk), can raise `ask_concurrency` to 2.
- **COS auto-updates reboot the VM**: The `--restart unless-stopped` flag handles this.
