# CLAUDE.md

User-level defaults for Claude on this machine.

## Scope

- These instructions apply as baseline guidance for any repository on this machine.
- Repository-local instruction files override these defaults when they provide more specific guidance.
- System or tool-provided policies remain authoritative over anything in this file.

## Defaults

- Respect repository-local instruction files when they are present.
- Keep global guidance generic and avoid treating this file as a place for repository-specific architecture or workflow details.
- Prefer `gh` for GitHub operations when a repository uses GitHub.
- Use `gh` for author-sensitive GitHub actions such as creating pull requests, posting comments, and replying to review threads so the configured machine identity is used.
- When addressing pull request review comments, always reply on the review thread after making the requested change unless explicitly told not to.
- Avoid destructive git commands such as `git reset --hard`, `git checkout --`, or force-pushing unless explicitly requested.
- Keep changes scoped to the task at hand and do not revert unrelated user changes.
- Before making non-trivial changes, look for repository guidance such as `AGENTS.md`, `CLAUDE.md`, `README.md`, or nearby docs.

## Memory — MemPalace

MemPalace is the persistent memory store. Use it to remember and recall anything that matters across sessions.

**On session start:** Call `mempalace_wake_up(agent_name: "claude")` to orient yourself — this loads identity, palace status, recent changes, and diary entries in one call.

**During a session:**
- When working in a worktree, the wing should be for the base repo, and the room for the specific branch of that worktree.
- Before answering questions about people, projects, or past events: search first with `mempalace_kg_query` or `mempalace_search`. Never guess — verify.
- File important decisions, facts, or context with `mempalace_add_drawer`.
- Record structured facts (relationships, states, timelines) with `mempalace_kg_add`.
- When facts change, invalidate the old one with `mempalace_kg_invalidate` before adding the new one.

**On session end:** Write a diary entry with `mempalace_diary_write(agent_name: "claude", ...)` summarising what happened and what matters.

**ALWAYS use MemPalace for memory. Do NOT write new memories to the auto-memory system.** The auto-memory files are a read-only legacy fallback — MemPalace is the only memory store. If in doubt, use MemPalace.

## Precedence

1. System and tool-enforced instructions
2. Repository-local instruction files
3. This user-level file
