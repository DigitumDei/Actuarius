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

install_instruction_file "$SOURCE_ROOT/.claude/CLAUDE.md" "$TARGET_HOME/.claude/CLAUDE.md"
install_instruction_file "$SOURCE_ROOT/.codex/AGENTS.md" "$TARGET_HOME/.codex/AGENTS.md"
install_instruction_file "$SOURCE_ROOT/.gemini/GEMINI.md" "$TARGET_HOME/.gemini/GEMINI.md"
