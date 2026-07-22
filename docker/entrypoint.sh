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
# Agent-spawned MCP servers do not reliably inherit the container environment,
# so the profile is written into each client's server definition explicitly.
MEMPALACE_EMBEDDING_PROFILE="${MEMPALACE_EMBEDDING_PROFILE:-low_cpu}"

mkdir -p "$HOME/.gemini"
if [ ! -f "$HOME/.gemini/settings.json" ]; then
  echo '{"security":{"auth":{"selectedType":"oauth-personal"}}}' > "$HOME/.gemini/settings.json"
fi

# These registrations converge to the declared state on every start rather than
# writing only when absent. $HOME is on the persistent data disk, so an upgraded
# container finds MemPalace already registered from a previous image; a
# write-if-absent guard would leave those stale definitions untouched and the
# agents would keep launching MemPalace on whatever profile was baked in when
# the entry was first written. Each writer is a no-op when the file already
# matches, so repeated restarts do not churn the file.
if [ -x "$MEMPALACE_BINARY_PATH" ]; then
  mkdir -p "$HOME/.codex"
  OPENCODE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
  mkdir -p "$OPENCODE_CONFIG_DIR"

  python3 - "$MEMPALACE_BINARY_PATH" "$MEMPALACE_PALACE_PATH" "$MEMPALACE_EMBEDDING_PROFILE" \
    "$HOME/.gemini/settings.json" "$HOME/.claude.json" "$HOME/.codex/config.toml" \
    "$OPENCODE_CONFIG_DIR/config.json" <<'PYEOF'
import json, os, re, sys

binary, palace, profile = sys.argv[1], sys.argv[2], sys.argv[3]
gemini_path, claude_path, codex_path, opencode_path = sys.argv[4:8]

env = {
    "MEMPALACE_PALACE_PATH": palace,
    "MEMPALACE_EMBEDDING_PROFILE": profile,
    "MEMPALACE_EMBED_ALLOW_DOWNLOADS": "1",
}


def load_json(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as handle:
            return json.load(handle)
    except (ValueError, OSError) as exc:
        # A corrupt agent config must not take the whole container down.
        print("WARNING: could not parse %s (%s); leaving it alone" % (path, exc), file=sys.stderr)
        return None


def write_json_if_changed(path, cfg, before):
    after = json.dumps(cfg, indent=2, sort_keys=True)
    if after == before:
        return
    with open(path, "w") as handle:
        json.dump(cfg, handle, indent=2)


def upsert_json(path, container_key, entry):
    cfg = load_json(path)
    if cfg is None:
        return
    before = json.dumps(cfg, indent=2, sort_keys=True)
    cfg.setdefault(container_key, {})["mempalace"] = entry
    write_json_if_changed(path, cfg, before)


upsert_json(gemini_path, "mcpServers", {"command": binary, "env": dict(env)})
upsert_json(claude_path, "mcpServers", {"command": binary, "env": dict(env)})
upsert_json(
    opencode_path,
    "mcp",
    {"type": "local", "enabled": True, "command": [binary], "environment": dict(env)},
)

# Codex uses TOML and Python ships no stdlib writer, so the mempalace tables are
# stripped and re-appended. The lookahead ends a section at the next table
# header at line start (not at any "[") so that a value containing a TOML array
# does not truncate the match and leave orphaned syntax behind.
try:
    with open(codex_path) as handle:
        codex = handle.read()
except OSError:
    codex = ""

stripped = re.sub(
    r"(?ms)^\[mcp_servers\.mempalace(?:\.[A-Za-z0-9_]+)?\].*?(?=^\[|\Z)",
    "",
    codex,
).rstrip()

block = ['[mcp_servers.mempalace]', 'command = "%s"' % binary, '', '[mcp_servers.mempalace.env]']
block += ['%s = "%s"' % (key, value) for key, value in env.items()]
desired = (stripped + "\n\n" if stripped else "") + "\n".join(block) + "\n"

if desired != codex:
    with open(codex_path, "w") as handle:
        handle.write(desired)
PYEOF
fi

# ── cache rotation ────────────────────────────────────────────
# Clean accumulating caches on every container start to prevent
# incremental disk fill (compounding npm/cargo/opencode caches).
# Skippable via SKIP_CACHE_ROTATION for local testing, where the wipe just
# forces every provider CLI to redownload from scratch on each restart —
# disk-fill isn't a concern on a throwaway local volume the way it is in
# production. Defaults to running the wipe (production-safe).
if [ "${SKIP_CACHE_ROTATION:-false}" != "true" ]; then
  rm -rf "$HOME/.npm/_cacache" 2>/dev/null || true
  rm -rf "$HOME/.cache" 2>/dev/null || true
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
