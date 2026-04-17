#!/bin/sh
set -eu

SOURCE_ROOT="${1:-/app/llm-user-instructions}"
TARGET_HOME="${2:-$HOME}"

install_instruction_file() {
  source_path="$1"
  target_path="$2"

  mkdir -p "$(dirname "$target_path")"
  cp "$source_path" "$target_path"
  chmod 0644 "$target_path"
}

for file in ".claude/CLAUDE.md" ".codex/AGENTS.md" ".gemini/GEMINI.md"; do
  install_instruction_file "$SOURCE_ROOT/$file" "$TARGET_HOME/$file"
done
