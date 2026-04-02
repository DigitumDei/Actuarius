# GEMINI.md

User-level defaults for Gemini on this machine.

## Scope

- These instructions apply as baseline guidance for any repository on this machine.
- Repository-local instruction files override these defaults when they provide more specific guidance.
- System or tool-provided policies remain authoritative over anything in this file.

## Defaults

- Respect repository-local instruction files when they are present.
- Keep global guidance generic and avoid treating this file as a place for repository-specific architecture or workflow details.
- Prefer `gh` for GitHub operations when a repository uses GitHub.
- Use `gh` for author-sensitive GitHub actions such as creating pull requests, posting comments, and replying to review threads so the configured machine identity is used.
- Avoid destructive git commands such as `git reset --hard`, `git checkout --`, or force-pushing unless explicitly requested.
- Keep changes scoped to the task at hand and do not revert unrelated user changes.
- Before making non-trivial changes, look for repository guidance such as `AGENTS.md`, `CLAUDE.md`, `README.md`, or nearby docs.

## Precedence

1. System and tool-enforced instructions
2. Repository-local instruction files
3. This user-level file
