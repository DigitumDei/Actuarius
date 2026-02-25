#!/bin/bash
# Usage:
#   ./redeploy.sh            # pull and run latest
#   ./redeploy.sh <sha>      # roll back to a specific git SHA
set -euo pipefail

META="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
HDR="Metadata-Flavor: Google"
get_meta() { curl -sf -H "$HDR" "$META/$1"; }

IMAGE_TAG="${1:-latest}"
BASE_IMAGE=$(get_meta "env-docker-image")
BASE_IMAGE="${BASE_IMAGE%:*}"  # strip existing tag
IMAGE="$BASE_IMAGE:$IMAGE_TAG"

echo "Deploying $IMAGE ..."

DISCORD_TOKEN=$(get_meta env-discord-token)
DISCORD_CLIENT_ID=$(get_meta env-discord-client-id)
GUILD_ID=$(get_meta "env-discord-guild-id" || true)
GH_TOKEN=$(get_meta env-gh-token)
CLAUDE_CODE_OAUTH_TOKEN=$(get_meta env-claude-oauth-token)
ASK_CONCURRENCY=$(get_meta env-ask-concurrency)

if [ -z "$DISCORD_TOKEN" ];          then echo "FATAL: env-discord-token is not set"      >&2; exit 1; fi
if [ -z "$DISCORD_CLIENT_ID" ];      then echo "FATAL: env-discord-client-id is not set"  >&2; exit 1; fi
if [ -z "$GH_TOKEN" ];               then echo "FATAL: env-gh-token is not set"            >&2; exit 1; fi
if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ];then echo "FATAL: env-claude-oauth-token is not set" >&2; exit 1; fi
if [ -z "$ASK_CONCURRENCY" ];        then echo "FATAL: env-ask-concurrency is not set"     >&2; exit 1; fi

EXTRA_ARGS=()
if [ -n "$GUILD_ID" ]; then
  EXTRA_ARGS+=(-e "DISCORD_GUILD_ID=$GUILD_ID")
fi

docker pull "$IMAGE"
docker rm -f actuarius 2>/dev/null || true

docker run -d \
  --name actuarius \
  --restart unless-stopped \
  -v /mnt/disks/data:/data \
  -e DISCORD_TOKEN="$DISCORD_TOKEN" \
  -e DISCORD_CLIENT_ID="$DISCORD_CLIENT_ID" \
  "${EXTRA_ARGS[@]}" \
  -e GH_TOKEN="$GH_TOKEN" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  -e DATABASE_PATH=/data/app.db \
  -e REPOS_ROOT_PATH=/data/repos \
  -e ASK_CONCURRENCY_PER_GUILD="$ASK_CONCURRENCY" \
  -e LOG_LEVEL=info \
  "$IMAGE"
docker image prune -f
echo "Done. Logs: docker logs -f actuarius"
