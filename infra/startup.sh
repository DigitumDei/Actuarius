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

# --- Ensure data dir is owned by appuser (UID 1001) inside the container ---
chown -R 1001:1001 "$DATA_MNT"

# --- Swap file on data disk (safety margin for Claude CLI subprocesses) ---
SWAP="$DATA_MNT/.swapfile"
if [ ! -f "$SWAP" ]; then
  fallocate -l 1G "$SWAP"
  chmod 600 "$SWAP"
  mkswap "$SWAP"
fi
swapon "$SWAP" 2>/dev/null || true

# --- Read config from instance metadata service ---
META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
HDR="Metadata-Flavor: Google"
get_meta() { curl -sf -H "$HDR" "$META/$1"; }

DISCORD_TOKEN=$(get_meta "env-discord-token")
DISCORD_CLIENT_ID=$(get_meta "env-discord-client-id")
DISCORD_GUILD_ID=$(get_meta "env-discord-guild-id" || true)
GH_TOKEN=$(get_meta "env-gh-token")
CLAUDE_OAUTH_TOKEN=$(get_meta "env-claude-oauth-token")
DOCKER_IMAGE=$(get_meta "env-docker-image")
ASK_CONCURRENCY=$(get_meta "env-ask-concurrency")

# --- Install redeploy helper script ---
get_meta "env-redeploy-script" > /var/redeploy.sh
chmod +x /var/redeploy.sh

# --- Pull latest image (public ghcr.io, no auth needed) ---
docker pull "$DOCKER_IMAGE"

# --- Remove existing container if present (idempotent) ---
docker stop actuarius 2>/dev/null || true
docker rm   actuarius 2>/dev/null || true

# --- Run the bot ---
GUILD_ARG=""
if [ -n "$DISCORD_GUILD_ID" ]; then
  GUILD_ARG="-e DISCORD_GUILD_ID=$DISCORD_GUILD_ID"
fi

docker run -d \
  --name actuarius \
  --restart unless-stopped \
  -v "$DATA_MNT:/data" \
  -e DISCORD_TOKEN="$DISCORD_TOKEN" \
  -e DISCORD_CLIENT_ID="$DISCORD_CLIENT_ID" \
  $GUILD_ARG \
  -e GH_TOKEN="$GH_TOKEN" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_OAUTH_TOKEN" \
  -e DATABASE_PATH=/data/app.db \
  -e REPOS_ROOT_PATH=/data/repos \
  -e ASK_CONCURRENCY_PER_GUILD="$ASK_CONCURRENCY" \
  -e LOG_LEVEL=info \
  "$DOCKER_IMAGE"

# --- Clean up old images to reclaim disk space ---
docker image prune -f || true
