#!/bin/bash
# Usage:
#   ./redeploy.sh            # pull and run latest
#   ./redeploy.sh <sha>      # roll back to a specific git SHA
set -euo pipefail

META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
HDR="Metadata-Flavor: Google"
get_meta() { curl -sf -H "$HDR" "$META/$1"; }

IMAGE_TAG="${1:-latest}"
IMAGE="ghcr.io/digitumdei/actuarius:$IMAGE_TAG"

echo "Deploying $IMAGE ..."

docker pull "$IMAGE"
docker stop actuarius 2>/dev/null || true
docker rm   actuarius 2>/dev/null || true

GUILD_ID=$(get_meta "env-discord-guild-id" || true)
GUILD_ARG=""
if [ -n "$GUILD_ID" ]; then
  GUILD_ARG="-e DISCORD_GUILD_ID=$GUILD_ID"
fi

docker run -d \
  --name actuarius \
  --restart unless-stopped \
  -v /mnt/disks/data:/data \
  -e DISCORD_TOKEN="$(get_meta env-discord-token)" \
  -e DISCORD_CLIENT_ID="$(get_meta env-discord-client-id)" \
  $GUILD_ARG \
  -e GH_TOKEN="$(get_meta env-gh-token)" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$(get_meta env-claude-oauth-token)" \
  -e DATABASE_PATH=/data/app.db \
  -e REPOS_ROOT_PATH=/data/repos \
  -e ASK_CONCURRENCY_PER_GUILD="$(get_meta env-ask-concurrency)" \
  -e LOG_LEVEL=info \
  "$IMAGE"

echo "Done. Logs: docker logs -f actuarius"
