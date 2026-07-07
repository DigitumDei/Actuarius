#!/bin/bash
# Usage:
#   ./redeploy.sh            # pull and run latest
#   ./redeploy.sh <sha>      # roll back to a specific git SHA
set -euo pipefail

MDS="http://metadata.google.internal/computeMetadata/v1"
META="$MDS/instance/attributes"
HDR="Metadata-Flavor: Google"
get_meta() { curl -sf -m 5 -H "$HDR" "$META/$1"; }

# Secrets live in Secret Manager, not metadata (see infra/secrets.tf). They are
# fetched with the VM service account's access token; only curl/sed/base64 are
# available on Container-Optimized OS, so the JSON is parsed with sed. Timeouts
# keep a hung metadata server or API from blocking the deploy indefinitely.
PROJECT_ID=$(curl -sf -m 5 -H "$HDR" "$MDS/project/project-id")
if [ -z "$PROJECT_ID" ]; then
  echo "FATAL: failed to fetch GCP project ID from the metadata server" >&2; exit 1
fi
ACCESS_TOKEN=$(curl -sf -m 5 -H "$HDR" "$MDS/instance/service-accounts/default/token" \
  | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')
if [ -z "$ACCESS_TOKEN" ]; then
  echo "FATAL: failed to fetch an access token from the metadata server" >&2; exit 1
fi
get_secret() {
  local response
  response=$(curl -sf -m 10 -H "Authorization: Bearer $ACCESS_TOKEN" \
    "https://secretmanager.googleapis.com/v1/projects/$PROJECT_ID/secrets/$1/versions/latest:access") || return 1
  printf '%s' "$response" | sed -n 's/.*"data" *: *"\([^"]*\)".*/\1/p' | base64 -d
}

IMAGE_TAG="${1:-latest}"
BASE_IMAGE=$(get_meta "env-docker-image")
BASE_IMAGE="${BASE_IMAGE%:*}"  # strip existing tag
IMAGE="$BASE_IMAGE:$IMAGE_TAG"
DATA_ROOT="/mnt/disks/data"

echo "Deploying $IMAGE ..."

DISCORD_TOKEN=$(get_secret actuarius-discord-token || true)
DISCORD_CLIENT_ID=$(get_meta env-discord-client-id)
GUILD_ID=$(get_meta "env-discord-guild-id" || true)
GH_TOKEN=$(get_secret actuarius-gh-token || true)
GITHUB_APP_ID=$(get_meta "env-github-app-id" || true)
GITHUB_APP_INSTALLATION_ID=$(get_meta "env-github-app-installation-id" || true)
GITHUB_APP_PRIVATE_KEY=$(get_secret actuarius-github-app-private-key || true)
GITHUB_APP_PRIVATE_KEY_B64=$(get_secret actuarius-github-app-private-key-b64 || true)
CLAUDE_CODE_OAUTH_TOKEN=$(get_secret actuarius-claude-oauth-token || true)
ASK_CONCURRENCY=$(get_meta env-ask-concurrency)
CONTAINER_MEMORY=$(get_meta env-container-memory || true)
CONTAINER_CPUS=$(get_meta env-container-cpus || true)
CONTAINER_PIDS_LIMIT=$(get_meta env-container-pids-limit || true)

CONTAINER_MEMORY="${CONTAINER_MEMORY:-700m}"
CONTAINER_CPUS="${CONTAINER_CPUS:-0.8}"
CONTAINER_PIDS_LIMIT="${CONTAINER_PIDS_LIMIT:-256}"

HAS_GITHUB_APP_ID=false
HAS_GITHUB_APP_INSTALLATION_ID=false
HAS_GITHUB_APP_PRIVATE_KEY=false
HAS_GITHUB_APP_PRIVATE_KEY_B64=false
if [ -n "$GITHUB_APP_ID" ]; then HAS_GITHUB_APP_ID=true; fi
if [ -n "$GITHUB_APP_INSTALLATION_ID" ]; then HAS_GITHUB_APP_INSTALLATION_ID=true; fi
if [ -n "$GITHUB_APP_PRIVATE_KEY" ]; then HAS_GITHUB_APP_PRIVATE_KEY=true; fi
if [ -n "$GITHUB_APP_PRIVATE_KEY_B64" ]; then HAS_GITHUB_APP_PRIVATE_KEY_B64=true; fi
HAS_ANY_GITHUB_APP_CONFIG=false
if $HAS_GITHUB_APP_ID || $HAS_GITHUB_APP_INSTALLATION_ID || $HAS_GITHUB_APP_PRIVATE_KEY || $HAS_GITHUB_APP_PRIVATE_KEY_B64; then
  HAS_ANY_GITHUB_APP_CONFIG=true
fi
HAS_COMPLETE_GITHUB_APP_CONFIG=false
if $HAS_GITHUB_APP_ID && $HAS_GITHUB_APP_INSTALLATION_ID && { $HAS_GITHUB_APP_PRIVATE_KEY || $HAS_GITHUB_APP_PRIVATE_KEY_B64; }; then
  HAS_COMPLETE_GITHUB_APP_CONFIG=true
fi

if [ -z "$DISCORD_TOKEN" ];          then echo "FATAL: secret actuarius-discord-token is not set"      >&2; exit 1; fi
if [ -z "$DISCORD_CLIENT_ID" ];      then echo "FATAL: env-discord-client-id is not set"  >&2; exit 1; fi
if $HAS_GITHUB_APP_PRIVATE_KEY && $HAS_GITHUB_APP_PRIVATE_KEY_B64; then
  echo "FATAL: set only one of secret actuarius-github-app-private-key or actuarius-github-app-private-key-b64" >&2; exit 1
fi
if $HAS_ANY_GITHUB_APP_CONFIG && ! $HAS_COMPLETE_GITHUB_APP_CONFIG; then
  echo "FATAL: GitHub App credentials must include env-github-app-id, env-github-app-installation-id, and exactly one of the secrets actuarius-github-app-private-key or actuarius-github-app-private-key-b64" >&2; exit 1
fi
if [ -z "$GH_TOKEN" ] && ! $HAS_COMPLETE_GITHUB_APP_CONFIG; then
  echo "FATAL: either the actuarius-gh-token secret or all GitHub App credentials (env-github-app-id, env-github-app-installation-id, and exactly one of the secrets actuarius-github-app-private-key or actuarius-github-app-private-key-b64) must be set" >&2; exit 1
fi
if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ];then echo "FATAL: secret actuarius-claude-oauth-token is not set" >&2; exit 1; fi
if [ -z "$ASK_CONCURRENCY" ];        then echo "FATAL: env-ask-concurrency is not set"     >&2; exit 1; fi

ENABLE_CODEX=$(get_meta "env-enable-codex-execution" || true)
ENABLE_GEMINI=$(get_meta "env-enable-gemini-execution" || true)
ENABLE_OPENCODE=$(get_meta "env-enable-opencode-execution" || true)
ENABLE_MEMPALACE=$(get_meta "env-enable-mempalace" || true)
ENABLE_MEMPALACE_REMOTE=$(get_meta "env-enable-mempalace-remote" || true)
MEMPALACE_REMOTE_URL=$(get_meta "env-mempalace-remote-url" || true)
MEMPALACE_REMOTE_BIND=$(get_meta "env-mempalace-remote-bind" || true)
MEMPALACE_REMOTE_NAME=$(get_meta "env-mempalace-remote-name" || true)
MEMPALACE_REMOTE_TOKEN=$(get_secret actuarius-mempalace-remote-token || true)
MEMPALACE_REMOTE_TIMEOUT_MS=$(get_meta "env-mempalace-remote-timeout-ms" || true)
MEMPALACE_REMOTE_MINE_ON_SYNC=$(get_meta "env-mempalace-remote-mine-on-sync" || true)
MEMPALACE_REMOTE_MINE_TIMEOUT_MS=$(get_meta "env-mempalace-remote-mine-timeout-ms" || true)
MEMPALACE_REMOTE_MINE_BATCH_SIZE=$(get_meta "env-mempalace-remote-mine-batch-size" || true)
GEMINI_API_KEY=$(get_secret actuarius-gemini-api-key || true)

EXTRA_ARGS=()
if [ -n "$GUILD_ID" ]; then
  EXTRA_ARGS+=(-e "DISCORD_GUILD_ID=$GUILD_ID")
fi
if [ -n "$GH_TOKEN" ]; then
  EXTRA_ARGS+=(-e "GH_TOKEN=$GH_TOKEN")
fi
if $HAS_COMPLETE_GITHUB_APP_CONFIG; then
  EXTRA_ARGS+=(-e "GITHUB_APP_ID=$GITHUB_APP_ID")
  EXTRA_ARGS+=(-e "GITHUB_APP_INSTALLATION_ID=$GITHUB_APP_INSTALLATION_ID")
  if $HAS_GITHUB_APP_PRIVATE_KEY; then
    EXTRA_ARGS+=(-e "GITHUB_APP_PRIVATE_KEY=$GITHUB_APP_PRIVATE_KEY")
  else
    EXTRA_ARGS+=(-e "GITHUB_APP_PRIVATE_KEY_B64=$GITHUB_APP_PRIVATE_KEY_B64")
  fi
fi
if [ "$ENABLE_CODEX" = "true" ]; then
  EXTRA_ARGS+=(-e "ENABLE_CODEX_EXECUTION=true")
fi
if [ "$ENABLE_GEMINI" = "true" ]; then
  EXTRA_ARGS+=(-e "ENABLE_GEMINI_EXECUTION=true")
fi
if [ "$ENABLE_OPENCODE" = "true" ]; then
  EXTRA_ARGS+=(-e "ENABLE_OPENCODE_EXECUTION=true")
fi
if [ "$ENABLE_MEMPALACE" = "true" ]; then
  EXTRA_ARGS+=(-e "MEMPALACE_ENABLED=true")
fi
if [ "$ENABLE_MEMPALACE_REMOTE" = "true" ]; then
  EXTRA_ARGS+=(-e "MEMPALACE_ENABLED=true")
  EXTRA_ARGS+=(-e "MEMPALACE_REMOTE_ENABLED=true")
  # Publish the federation server on the VM's loopback only. Remote access
  # goes through an IAP SSH tunnel; the port is never exposed publicly.
  REMOTE_PORT="${MEMPALACE_REMOTE_BIND##*:}"
  case "$REMOTE_PORT" in
    ''|*[!0-9]*) REMOTE_PORT="8765" ;;
  esac
  # The in-container server must listen on all container interfaces for the
  # published port to reach it; a container-loopback bind is unreachable from
  # docker-proxy. Host exposure is still governed by the 127.0.0.1 publish.
  MEMPALACE_REMOTE_BIND="0.0.0.0:$REMOTE_PORT"
  EXTRA_ARGS+=(-p "127.0.0.1:$REMOTE_PORT:$REMOTE_PORT")
fi
if [ -n "$MEMPALACE_REMOTE_URL" ]; then
  EXTRA_ARGS+=(-e "MEMPALACE_REMOTE_URL=$MEMPALACE_REMOTE_URL")
fi
if [ -n "$MEMPALACE_REMOTE_BIND" ]; then
  EXTRA_ARGS+=(-e "MEMPALACE_REMOTE_BIND=$MEMPALACE_REMOTE_BIND")
fi
if [ -n "$MEMPALACE_REMOTE_NAME" ]; then
  EXTRA_ARGS+=(-e "MEMPALACE_REMOTE_NAME=$MEMPALACE_REMOTE_NAME")
fi
if [ -n "$MEMPALACE_REMOTE_TOKEN" ]; then
  EXTRA_ARGS+=(-e "MEMPALACE_REMOTE_TOKEN=$MEMPALACE_REMOTE_TOKEN")
fi
if [ -n "$MEMPALACE_REMOTE_TIMEOUT_MS" ]; then
  EXTRA_ARGS+=(-e "MEMPALACE_REMOTE_TIMEOUT_MS=$MEMPALACE_REMOTE_TIMEOUT_MS")
fi
if [ -n "$MEMPALACE_REMOTE_MINE_ON_SYNC" ]; then
  EXTRA_ARGS+=(-e "MEMPALACE_REMOTE_MINE_ON_SYNC=$MEMPALACE_REMOTE_MINE_ON_SYNC")
fi
if [ -n "$MEMPALACE_REMOTE_MINE_TIMEOUT_MS" ]; then
  EXTRA_ARGS+=(-e "MEMPALACE_REMOTE_MINE_TIMEOUT_MS=$MEMPALACE_REMOTE_MINE_TIMEOUT_MS")
fi
if [ -n "$MEMPALACE_REMOTE_MINE_BATCH_SIZE" ]; then
  EXTRA_ARGS+=(-e "MEMPALACE_REMOTE_MINE_BATCH_SIZE=$MEMPALACE_REMOTE_MINE_BATCH_SIZE")
fi
if [ -n "$GEMINI_API_KEY" ]; then
  EXTRA_ARGS+=(-e "GEMINI_API_KEY=$GEMINI_API_KEY")
fi

docker pull "$IMAGE"
docker rm -f actuarius 2>/dev/null || true
mkdir -p "$DATA_ROOT/home/appuser"
chown -R 1001:1001 "$DATA_ROOT/home"

docker run -d \
  --name actuarius \
  --restart unless-stopped \
  --memory "$CONTAINER_MEMORY" \
  --memory-swap "$CONTAINER_MEMORY" \
  --cpus "$CONTAINER_CPUS" \
  --pids-limit "$CONTAINER_PIDS_LIMIT" \
  -v "$DATA_ROOT:/data" \
  -e DISCORD_TOKEN="$DISCORD_TOKEN" \
  -e DISCORD_CLIENT_ID="$DISCORD_CLIENT_ID" \
  "${EXTRA_ARGS[@]}" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  -e DATABASE_PATH=/data/app.db \
  -e REPOS_ROOT_PATH=/data/repos \
  -e ASK_CONCURRENCY_PER_GUILD="$ASK_CONCURRENCY" \
  -e LOG_LEVEL=info \
  "$IMAGE"
docker image prune -f
echo "Done. Logs: docker logs -f actuarius"
