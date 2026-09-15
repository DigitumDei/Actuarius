#!/bin/sh
set -eu

# npm needs a writable global prefix; fail loudly if it is missing.
: "${NPM_CONFIG_PREFIX:?NPM_CONFIG_PREFIX must be set}"

# Provider CLIs install into $NPM_CONFIG_PREFIX (npm) or $HOME/.local/bin
# (agy, the Antigravity CLI), both of which live on the persisted /data volume.
# Installing "only when missing" means a CLI that landed on the volume during an
# earlier container run is never upgraded — it goes stale even after the image
# is rebuilt. So we always install the latest of each provider on startup; a
# restart then picks up upstream releases.
#
# Each install is best-effort and isolated: if one provider fails we keep going
# so the others still update, and we exit non-zero (with a warning) only at the
# end so the entrypoint logs it but still starts the bot.

packages="@anthropic-ai/claude-code @openai/codex opencode-ai"

# Antigravity CLI (agy) replaces the discontinued @google/gemini-cli npm
# package and is distributed as a native binary via Google's official installer
# (https://antigravity.google/cli/install.sh), which installs to ~/.local/bin.
# The container HOME is on the persisted /data volume, so the binary and its
# auth state survive container replacement.
AGY_INSTALL_URL="https://antigravity.google/cli/install.sh"

modules_dir="$NPM_CONFIG_PREFIX/lib/node_modules"

install_package() {
  package="$1"

  if npm install -g "$package@latest"; then
    return 0
  fi

  # npm upgrades a global package in place by renaming the existing directory
  # aside before unpacking the new one. On the persisted /data volume that
  # rename intermittently fails with ENOTEMPTY, leaving a half-updated tree and
  # stray ".<name>-XXXX" staging dirs. Remove the package and any leftover
  # staging dirs, then reinstall from clean — this avoids the rename entirely.
  # (A first attempt failing on ENOTEMPTY means the registry was reachable, so
  # the clean reinstall should succeed.)
  echo "npm install of $package failed; cleaning package dir and retrying" >&2
  parent_dir="$modules_dir/$(dirname "$package")"
  base="$(basename "$package")"
  rm -rf "$modules_dir/$package" 2>/dev/null || true
  rm -rf "$parent_dir/.$base-"* 2>/dev/null || true

  npm install -g "$package@latest"
}

# Install/update the Antigravity CLI binary. The installer is downloaded to a
# temp file and executed (never piped) so a failed download is detected rather
# than masked by the pipe's exit status. --skip-aliases --skip-path stop the
# installer from editing shell profiles — the container PATH is managed by the
# image and entrypoint, and `~/.local/bin` is already on it. A failed update is
# retried once but never deletes an existing `agy`: a previously working binary
# is better than none, and the installer replaces atomically on success.
install_agy() {
  installer="${TMPDIR:-/tmp}/actuarius-agy-install-$$.sh"
  if curl -fsSL "$AGY_INSTALL_URL" -o "$installer" && bash "$installer" --skip-aliases --skip-path; then
    rm -f "$installer"
    return 0
  fi
  echo "agy install failed; removing partial install and retrying" >&2
  rm -f "$installer"
  installer="${TMPDIR:-/tmp}/actuarius-agy-install-$$.sh"
  if curl -fsSL "$AGY_INSTALL_URL" -o "$installer" && bash "$installer" --skip-aliases --skip-path; then
    rm -f "$installer"
    return 0
  fi
  rm -f "$installer"
  return 1
}

failed=""
for package in $packages; do
  if ! install_package "$package"; then
    if [ -n "$failed" ]; then
      failed="$failed $package"
    else
      failed="$package"
    fi
  fi
done

if ! install_agy; then
  if [ -n "$failed" ]; then
    failed="$failed agy"
  else
    failed="agy"
  fi
fi

if [ -n "$failed" ]; then
  echo "WARNING: failed to install/update provider CLIs:$failed" >&2
  exit 1
fi
