#!/bin/bash
# Actuarius bot startup script — runs on every VM boot (must be idempotent)
set -euo pipefail

# --- Mount persistent data disk ---
DATA_DEV="/dev/disk/by-id/google-actuarius-data"
DATA_MNT="/mnt/disks/data"
mkdir -p "$DATA_MNT"

# Try to mount first. Only format if mount fails (truly new/empty disk).
# This avoids accidental data loss from blkid race conditions on boot.
if ! mount -o defaults "$DATA_DEV" "$DATA_MNT" 2>/dev/null; then
  echo "Mount failed — formatting new disk..."
  mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0 "$DATA_DEV"
  mount -o defaults "$DATA_DEV" "$DATA_MNT"
fi

if ! grep -q "google-actuarius-data" /etc/fstab; then
  echo "$DATA_DEV $DATA_MNT ext4 defaults,nofail 0 2" >> /etc/fstab
fi

mkdir -p "$DATA_MNT/repos"

# --- Ensure app data is owned by appuser (UID 1001) inside the container ---
touch "$DATA_MNT/app.db"
chown 1001:1001 "$DATA_MNT"
find "$DATA_MNT" -maxdepth 1 -not -name .swapfile -not -path "$DATA_MNT" -exec chown -R 1001:1001 {} +

# --- Swap file (safety margin for Claude CLI subprocesses) ---
# Lives on the stateful partition, NOT the data disk: the data disk holds the
# palace/repos/worktrees and is space-constrained — a full /data wedges the bot,
# whereas the stateful partition (shared with /var/lib/docker) has headroom.
SWAP="/mnt/stateful_partition/swapfile"
# Migrate off the old data-disk location if present, reclaiming ~1 GB on /data.
OLD_SWAP="$DATA_MNT/.swapfile"
if [ -f "$OLD_SWAP" ]; then
  swapoff "$OLD_SWAP" 2>/dev/null || true
  rm -f "$OLD_SWAP"
fi
if [ ! -f "$SWAP" ]; then
  fallocate -l 1536M "$SWAP"
  chmod 600 "$SWAP"
  mkswap "$SWAP"
fi
swapon "$SWAP" 2>/dev/null || true

# --- Install redeploy helper script from metadata ---
# Note: /var is mounted noexec on COS, so scripts must be invoked with `bash`
META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
HDR="Metadata-Flavor: Google"
curl -sf -H "$HDR" "$META/env-redeploy-script" > /var/redeploy.sh

# --- Deploy the bot (reuses the same script used for manual redeploys) ---
bash /var/redeploy.sh
