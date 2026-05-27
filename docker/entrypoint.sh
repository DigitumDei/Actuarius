#!/bin/sh
set -eu

GIT_USER_NAME="${GIT_USER_NAME:-Actuarius Bot}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-actuarius-bot@users.noreply.github.com}"

mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"
mkdir -p "$NPM_CONFIG_PREFIX"
mkdir -p "${MEMPALACE_PALACE_PATH:-/data/mempalace/palace}"

/app/install-llm-user-instructions.sh
if ! /app/seed-provider-clis.sh; then
  echo "WARNING: provider CLI seeding failed; continuing startup with currently installed CLIs" >&2
fi

MEMPALACE_BINARY_PATH="${MEMPALACE_BINARY_PATH:-/usr/local/bin/mempalace-mcp}"
MEMPALACE_PALACE_PATH="${MEMPALACE_PALACE_PATH:-/data/mempalace/palace}"

if [ ! -f "$HOME/.gemini/settings.json" ]; then
  if [ -x "$MEMPALACE_BINARY_PATH" ]; then
    cat <<EOF > "$HOME/.gemini/settings.json"
{
  "security": {
    "auth": {
      "selectedType": "oauth-personal"
    }
  },
  "mcpServers": {
    "mempalace": {
      "command": "$MEMPALACE_BINARY_PATH",
      "env": {
        "MEMPALACE_PALACE_PATH": "$MEMPALACE_PALACE_PATH",
        "MEMPALACE_EMBED_ALLOW_DOWNLOADS": "1"
      }
    }
  }
}
EOF
  else
    cat <<EOF > "$HOME/.gemini/settings.json"
{
  "security": {
    "auth": {
      "selectedType": "oauth-personal"
    }
  }
}
EOF
  fi
fi

if [ -x "$MEMPALACE_BINARY_PATH" ]; then
  if [ ! -f "$HOME/.claude/settings.json" ]; then
    mkdir -p "$HOME/.claude"
    cat <<EOF > "$HOME/.claude/settings.json"
{
  "mcpServers": {
    "mempalace": {
      "command": "$MEMPALACE_BINARY_PATH",
      "env": {
        "MEMPALACE_PALACE_PATH": "$MEMPALACE_PALACE_PATH",
        "MEMPALACE_EMBED_ALLOW_DOWNLOADS": "1"
      }
    }
  }
}
EOF
  fi

  if [ ! -f "$HOME/.codex/config.toml" ]; then
    mkdir -p "$HOME/.codex"
    cat <<EOF > "$HOME/.codex/config.toml"
[[mcp_servers]]
name = "mempalace"
command = ["$MEMPALACE_BINARY_PATH"]

[mcp_servers.env]
MEMPALACE_PALACE_PATH = "$MEMPALACE_PALACE_PATH"
MEMPALACE_EMBED_ALLOW_DOWNLOADS = "1"
EOF
  fi

  OPENCODE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
  if [ ! -f "$OPENCODE_CONFIG_DIR/config.json" ]; then
    mkdir -p "$OPENCODE_CONFIG_DIR"
    cat <<EOF > "$OPENCODE_CONFIG_DIR/config.json"
{
  "mcp": {
    "mempalace": {
      "command": ["$MEMPALACE_BINARY_PATH"],
      "environment": {
        "MEMPALACE_PALACE_PATH": "$MEMPALACE_PALACE_PATH",
        "MEMPALACE_EMBED_ALLOW_DOWNLOADS": "1"
      }
    }
  }
}
EOF
  fi
fi

git config --global user.name "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"

if [ -n "${GH_TOKEN:-}" ]; then
  git config --global --replace-all credential.https://github.com.helper \
    '!f() { echo username=x-token; printf "password=%s\n" "$GH_TOKEN"; }; f'
fi

exec "$@"
