#!/bin/sh
set -eu

prefix="${NPM_CONFIG_PREFIX:?NPM_CONFIG_PREFIX must be set}"
missing_packages=""

queue_package_if_missing() {
  binary_name="$1"
  package_name="$2"

  if [ -x "$prefix/bin/$binary_name" ]; then
    return
  fi

  if [ -n "$missing_packages" ]; then
    missing_packages="$missing_packages $package_name"
  else
    missing_packages="$package_name"
  fi
}

queue_package_if_missing "claude" "@anthropic-ai/claude-code"
queue_package_if_missing "codex" "@openai/codex"
queue_package_if_missing "gemini" "@google/gemini-cli"
queue_package_if_missing "opencode" "opencode-ai"

if [ -n "$missing_packages" ]; then
  # Intentionally rely on word splitting so npm receives one package per argument.
  npm install -g $missing_packages
fi
