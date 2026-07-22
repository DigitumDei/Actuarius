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
  if ! grep -q '"type"' "$OPENCODE_CONFIG_DIR/config.json" 2>/dev/null; then
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

# ── cache rotation ────────────────────────────────────────────
# Delete every top-level entry in $1 except the names listed after it.
# Used instead of a blanket `rm -rf` on ~/.cache so the rotation keeps its
# catch-all property (any new cache that shows up still gets reaped) without
# taking expensive-to-rebuild caches with it.
prune_cache_dir() {
  cache_dir="$1"
  shift
  [ -d "$cache_dir" ] || return 0
  for entry in "$cache_dir"/* "$cache_dir"/.[!.]*; do
    [ -e "$entry" ] || continue
    entry_name="${entry##*/}"
    keep_entry=false
    for preserved in "$@"; do
      if [ "$entry_name" = "$preserved" ]; then
        keep_entry=true
      fi
    done
    if [ "$keep_entry" != "true" ]; then
      rm -rf "$entry" 2>/dev/null || true
    fi
  done
  return 0
}

# Clean accumulating caches on every container start to prevent
# incremental disk fill (compounding npm/cargo/opencode caches).
# Skippable via SKIP_CACHE_ROTATION for local testing, where the wipe just
# forces every provider CLI to redownload from scratch on each restart —
# disk-fill isn't a concern on a throwaway local volume the way it is in
# production. Defaults to running the wipe (production-safe).
if [ "${SKIP_CACHE_ROTATION:-false}" != "true" ]; then
  rm -rf "$HOME/.npm/_cacache" 2>/dev/null || true
  # NOT a blanket `rm -rf "$HOME/.cache"`: MemPalace stores its downloaded ONNX
  # embedding model under $XDG_CACHE_HOME/mempalace (== $HOME/.cache/mempalace
  # in the image), and wiping it forced an ~86 MB re-download plus a slow first
  # search on every single container start. Everything else under .cache is
  # cheap to regenerate locally, so only mempalace is preserved.
  prune_cache_dir "$HOME/.cache" mempalace
  rm -rf "$HOME/.cargo/registry/cache" 2>/dev/null || true
  rm -f "$HOME/.local/share/opencode/opencode.db" "$HOME/.local/share/opencode/opencode.db-shm" "$HOME/.local/share/opencode/opencode.db-wal" 2>/dev/null || true
  rm -rf "$HOME/.codex/tmp" "$HOME/.codex/sessions" 2>/dev/null || true
fi

git config --global user.name "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"

if [ -n "${GH_TOKEN:-}" ]; then
  git config --global --replace-all credential.https://github.com.helper \
    '!f() { echo username=x-token; printf "password=%s\n" "$GH_TOKEN"; }; f'
fi

# Stub out global Rust to prevent ~/.rustup and ~/.cargo disk bloat.  The
# scoped installer (/install rustup-default-stable) downloads its own
# rustup-init and places wrappers in a scoped bin dir that comes first in
# PATH, so these stubs do NOT interfere with scoped Rust access.
STUB_DIR="$HOME/.local/bin"
mkdir -p "$STUB_DIR"
export PATH="$STUB_DIR:$PATH"
for tool in rustup cargo rustc rustfmt; do
  cat > "$STUB_DIR/$tool" <<'RUSTSTUB'
#!/bin/sh
echo "Cannot run rust on this VM, please use CI to validate build." >&2
exit 1
RUSTSTUB
  chmod +x "$STUB_DIR/$tool"
done

exec "$@"
