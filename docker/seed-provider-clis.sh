#!/bin/sh
set -eu

# npm needs a writable global prefix; fail loudly if it is missing.
: "${NPM_CONFIG_PREFIX:?NPM_CONFIG_PREFIX must be set}"

# Provider CLIs install into $NPM_CONFIG_PREFIX, which lives on the persisted
# /data volume. Installing "only when missing" means a CLI that landed on the
# volume during an earlier container run is never upgraded — it goes stale even
# after the image is rebuilt. So we always install the latest of each package
# on startup; a restart then picks up upstream releases.
#
# Each install is best-effort and isolated: if one package fails we keep going
# so the others still update, and we exit non-zero (with a warning) only at the
# end so the entrypoint logs it but still starts the bot.

packages="@anthropic-ai/claude-code @openai/codex @google/gemini-cli opencode-ai"
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

if [ -n "$failed" ]; then
  echo "WARNING: failed to install/update provider CLIs:$failed" >&2
  exit 1
fi
