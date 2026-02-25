#!/bin/sh
set -eu

CLAUDE_HOME="${HOME:-/home/appuser}/.claude"
CLAUDE_CREDENTIALS_TARGET="$CLAUDE_HOME/.credentials.json"

mkdir -p "$CLAUDE_HOME"

if [ -n "${CLAUDE_CREDENTIALS_FILE:-}" ] && [ -f "${CLAUDE_CREDENTIALS_FILE}" ]; then
  cp "${CLAUDE_CREDENTIALS_FILE}" "$CLAUDE_CREDENTIALS_TARGET"
  chmod 600 "$CLAUDE_CREDENTIALS_TARGET"
elif [ -n "${CLAUDE_CREDENTIALS_B64:-}" ]; then
  tmp_file="$CLAUDE_HOME/.credentials.json.tmp"
  printf "%s" "$CLAUDE_CREDENTIALS_B64" | base64 -d > "$tmp_file"
  mv "$tmp_file" "$CLAUDE_CREDENTIALS_TARGET"
  chmod 600 "$CLAUDE_CREDENTIALS_TARGET"
fi

GIT_USER_NAME="${GIT_USER_NAME:-Actuarius Bot}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-actuarius-bot@users.noreply.github.com}"
git config --global user.name "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"

if [ -n "${GH_TOKEN:-}" ]; then
  git config --global --replace-all credential.https://github.com.helper \
    '!f() { echo username=x-token; printf "password=%s\n" "$GH_TOKEN"; }; f'
fi

exec "$@"
