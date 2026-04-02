# LLM User-Level Instructions

Issue `#84` defines machine-wide user-level defaults for the LLM tools used in this environment.

## Files

- `~/.claude/CLAUDE.md`
- `~/.codex/AGENTS.md`
- `~/.gemini/GEMINI.md`

In this environment, "user-level" is effectively the same as "VM-wide" because the machine is operated through a single user account.

## Purpose

These files provide generic defaults that should apply across repositories. They are intentionally not the place for project architecture, local commands, or repository-specific workflow details.

Repository-specific behavior belongs in repo-local files such as `AGENTS.md`, `CLAUDE.md`, `README.md`, or other project docs.

## Precedence

1. System and tool-enforced instructions
2. Repository-local instruction files
3. User-level files in the home directory

That means this repository's local instruction files remain authoritative for repo-specific behavior, while the home-directory files provide fallback defaults for repos that do not override them.

## Baseline Defaults

- Respect repository-local instructions when present.
- Prefer `gh` for GitHub operations.
- Use `gh` for author-sensitive GitHub actions so the configured machine identity is used.
- Avoid destructive git commands unless explicitly requested.
- Keep global instructions generic rather than repository-specific.

## Validation

Later expansion should verify each tool with two cases:

1. Run the tool in a directory without repo-local instruction files and confirm the user-level file is applied.
2. Run the tool in a repository with local instruction files and confirm the repo-local guidance takes precedence over the user-level defaults.
