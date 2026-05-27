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

mkdir -p "$HOME/.gemini"
if [ ! -f "$HOME/.gemini/settings.json" ]; then
  echo '{"security":{"auth":{"selectedType":"oauth-personal"}}}' > "$HOME/.gemini/settings.json"
fi
if [ -x "$MEMPALACE_BINARY_PATH" ]; then
  python3 - "$HOME/.gemini/settings.json" "$MEMPALACE_BINARY_PATH" "$MEMPALACE_PALACE_PATH" <<'PYEOF'
import json, sys
path, binary, palace = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f: cfg = json.load(f)
if "mcpServers" not in cfg:
    cfg["mcpServers"] = {}
if "mempalace" not in cfg["mcpServers"]:
    cfg["mcpServers"]["mempalace"] = {
        "command": binary,
        "env": {"MEMPALACE_PALACE_PATH": palace, "MEMPALACE_EMBED_ALLOW_DOWNLOADS": "1"}
    }
    with open(path, "w") as f: json.dump(cfg, f, indent=2)
PYEOF
fi

if [ -x "$MEMPALACE_BINARY_PATH" ]; then
  if ! grep -q '"mempalace"' "$HOME/.claude.json" 2>/dev/null; then
    python3 - "$HOME/.claude.json" "$MEMPALACE_BINARY_PATH" "$MEMPALACE_PALACE_PATH" <<'PYEOF'
import json, sys, os
path, binary, palace = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = {}
if os.path.exists(path):
    with open(path) as f: cfg = json.load(f)
if "mcpServers" not in cfg: cfg["mcpServers"] = {}
cfg["mcpServers"]["mempalace"] = {
    "command": binary,
    "env": {"MEMPALACE_PALACE_PATH": palace, "MEMPALACE_EMBED_ALLOW_DOWNLOADS": "1"}
}
with open(path, "w") as f: json.dump(cfg, f, indent=2)
PYEOF
  fi

  mkdir -p "$HOME/.codex"
  if ! grep -q '\[mcp_servers\.mempalace\]' "$HOME/.codex/config.toml" 2>/dev/null; then
    cat <<EOF >> "$HOME/.codex/config.toml"

[mcp_servers.mempalace]
command = "$MEMPALACE_BINARY_PATH"

[mcp_servers.mempalace.env]
MEMPALACE_PALACE_PATH = "$MEMPALACE_PALACE_PATH"
MEMPALACE_EMBED_ALLOW_DOWNLOADS = "1"
EOF
  fi

  OPENCODE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
  mkdir -p "$OPENCODE_CONFIG_DIR"
  if ! grep -q '"mempalace"' "$OPENCODE_CONFIG_DIR/config.json" 2>/dev/null; then
    python3 - "$OPENCODE_CONFIG_DIR/config.json" "$MEMPALACE_BINARY_PATH" "$MEMPALACE_PALACE_PATH" <<'PYEOF'
import json, sys, os
path, binary, palace = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = {}
if os.path.exists(path):
    with open(path) as f: cfg = json.load(f)
if "mcp" not in cfg: cfg["mcp"] = {}
cfg["mcp"]["mempalace"] = {
    "type": "local",
    "enabled": True,
    "command": [binary],
    "environment": {"MEMPALACE_PALACE_PATH": palace, "MEMPALACE_EMBED_ALLOW_DOWNLOADS": "1"}
}
with open(path, "w") as f: json.dump(cfg, f, indent=2)
PYEOF
  fi
fi

git config --global user.name "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"

if [ -n "${GH_TOKEN:-}" ]; then
  git config --global --replace-all credential.https://github.com.helper \
    '!f() { echo username=x-token; printf "password=%s\n" "$GH_TOKEN"; }; f'
fi

exec "$@"
