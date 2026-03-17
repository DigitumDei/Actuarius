#!/bin/bash
# Actuarius bot startup script — runs on every VM boot (must be idempotent)
set -euo pipefail

# --- Mount persistent data disk ---
DATA_DEV="/dev/disk/by-id/google-actuarius-data"
DATA_MNT="/mnt/disks/data"

if ! blkid "$DATA_DEV" &>/dev/null; then
  mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0 "$DATA_DEV"
fi

mkdir -p "$DATA_MNT"
mount -o defaults "$DATA_DEV" "$DATA_MNT"

if ! grep -q "google-actuarius-data" /etc/fstab; then
  echo "$DATA_DEV $DATA_MNT ext4 defaults,nofail 0 2" >> /etc/fstab
fi

mkdir -p "$DATA_MNT/repos"

# --- Ensure app dirs are owned by appuser (UID 1001) inside the container ---
# (Docker's data-root must stay root-owned, so we only chown app directories)
chown -R 1001:1001 "$DATA_MNT/repos"
touch "$DATA_MNT/app.db"
chown 1001:1001 "$DATA_MNT/app.db"

# --- Swap file on data disk (safety margin for Claude CLI subprocesses) ---
SWAP="$DATA_MNT/.swapfile"
if [ ! -f "$SWAP" ]; then
  fallocate -l 1G "$SWAP"
  chmod 600 "$SWAP"
  mkswap "$SWAP"
fi
swapon "$SWAP" 2>/dev/null || true

# --- Install redeploy helper script from metadata ---
META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
HDR="Metadata-Flavor: Google"
curl -sf -H "$HDR" "$META/env-redeploy-script" > /var/redeploy.sh
chmod +x /var/redeploy.sh

# --- Move Docker data-root to the persistent data disk ---
DOCKER_DATA="$DATA_MNT/docker"
mkdir -p "$DOCKER_DATA"
cat > /etc/docker/daemon.json <<DJSON
{"data-root": "$DOCKER_DATA"}
DJSON
systemctl restart docker

# --- Deploy the bot (reuses the same script used for manual redeploys) ---
/var/redeploy.sh
