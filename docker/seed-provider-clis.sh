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
# Each install is best-effort and isolated: if one package fails (npm registry
# unreachable, a yanked version, etc.) we keep going so the others still update
# and any previously installed CLI stays in place. We exit non-zero when any
# package failed so the entrypoint logs a warning, but startup still continues.

packages="@anthropic-ai/claude-code @openai/codex @google/gemini-cli opencode-ai"

failed=""
for package in $packages; do
  if ! npm install -g "$package@latest"; then
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
