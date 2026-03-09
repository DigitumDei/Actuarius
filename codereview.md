# Code Review — Detailed Logic Trace

## Scope
All changes on `ask/36-1773058780869` vs `main`. Covers `/bug`, `/issue`, `/model-select`, `/model-current`, auth commands, multi-provider support, and the `handleRepoCommand` refactor.

---

## 1. `/bug` and `/issue` — Full Flow Trace

### Command registration (`commands.ts`)
- Both commands registered with a required `prompt` string option. Correct.
- `CommandName` type updated to include both. Correct.

### `handleIssueCreate` (bot.ts:900–931)
1. **`gh auth status` pre-check** — Uses dynamic `import("node:child_process")` to run `gh auth status` with a 10s timeout. If it fails, replies with an ephemeral error. **Works correctly**, but the dynamic import is unnecessary since `spawn` is already statically imported at the top of the file. Minor style issue only.

2. **Prompt transformer** — Wraps the user prompt with instructions to create a GitHub issue via `gh issue create`. Includes the label (`"bug"` or `"enhancement"`) and a fallback instruction to omit `--label` if the label doesn't exist. **Correct.**

3. **Delegates to `handleRepoCommand`** with `{ label: type, promptTransformer, rawOutput: true }`. **Correct.**

### `handleRepoCommand` (bot.ts:789–898)
Trace for `/bug` with label="bug":
1. Guild validation — checks `interaction.guild` and `interaction.guildId`. ✅
2. Extracts `prompt` from interaction options. ✅
3. Resolves channel — handles both direct channel and thread context (resolves parent). ✅
4. Looks up repo by channel. ✅
5. Gets model config from DB. ✅
6. Creates seed message: `"New bug from @user for \`owner/repo\`"` ✅
7. Creates thread from seed message. ✅
8. Posts prompt to thread. ✅
9. Creates DB request record. ✅
10. Enqueues `runQueuedRequest` with `promptTransformer` and `rawOutput: true`. ✅
11. Replies with: `"Created bug thread #thread. Request queued for {Provider} execution."` ✅

### `runQueuedRequest` — worktree handling (bot.ts:933–1101)
For initial `/bug` request (no `existingWorktreePath`):
1. Updates status to "running". ✅
2. Fetches thread channel. ✅
3. Posts `"{Provider} execution started."` ✅
4. **Syncs repo** via `ensureRepoCheckedOutToMaster`. ✅
5. **Creates worktree** via `createRequestWorktree`. ✅

**ISSUE: Worktree creates a new branch.** `createRequestWorktree` (requestWorktreeService.ts:74) runs:
```
git worktree add -B ask/{requestId}-{timestamp} {path} master
```
This creates a **new branch** named `ask/{requestId}-{timestamp}` based on master. For `/bug` and `/issue`, the user explicitly requested that worktrees should be isolated copies of master **without creating a new branch** (e.g. using `--detach`). The current implementation still creates a branch for every bug/issue request.

**Severity: Medium** — Functionally it works (the code is isolated), but it creates unnecessary branches that accumulate and don't serve a purpose for read-only analysis. The user specifically asked for detached-HEAD worktrees for bug/issue.

6. **Prompt transformation** — `promptTransformer` is applied only when `!input.existingWorktreePath` (i.e., initial request only, not follow-ups). ✅ This correctly fixes the earlier review item.

7. **Provider dispatch** — dispatches to `runClaudeRequest`, `runCodexRequest`, or `runGeminiRequest` based on `input.provider`. Checks `enableCodexExecution` / `enableGeminiExecution` before dispatching. ✅

8. **Response formatting** — When `rawOutput: true`, skips code-fence wrapping. ✅ For bug/issue responses (which contain GitHub issue links), raw output makes sense.

9. **Overflow handling** — Falls back to `clipForDiscord` with `DISCORD_MESSAGE_LIMIT - 40` when response exceeds limit. ✅

---

## 2. Follow-up Messages in `/bug` and `/issue` Threads

### `handleThreadMessage` (bot.ts:193–235)
When a user types in a thread created by `/bug` or `/issue`:
1. Looks up `worktreePath` from DB via `getWorktreeForThread`. ✅
2. Queues `runQueuedRequest` with `existingWorktreePath` set. ✅
3. **Does NOT pass `promptTransformer` or `rawOutput`** — so follow-up messages use the plain prompt (no issue-creation wrapper) and get code-fence formatting. ✅ This is correct behavior.

**However:** Follow-ups in a bug/issue thread will use the same AI provider but the output will be code-fenced (not raw). This is a minor UX inconsistency — the initial bug response shows raw output (the GitHub issue link), but follow-ups get wrapped in `` ```text``` ``. This is probably fine since follow-ups are conversational.

---

## 3. `/model-select` — Logic Trace

### `handleModelSelect` (bot.ts:478–534)
1. Guild check. ✅
2. Permission check (`ManageGuild`). ✅
3. Validates provider against `AI_PROVIDER_LABELS` keys. ✅
4. Checks `enableCodexExecution` / `enableGeminiExecution` for non-Claude providers. ✅
5. Upserts guild, then sets model config in DB. ✅
6. Reply mentions `/ask`, `/bug`, and `/issue`. ✅

### DB layer (`database.ts`)
- `guild_model_config` table: `guild_id` PK, `provider`, `model` (nullable), `updated_by_user_id`, `updated_at`. ✅
- `setGuildModelConfig` uses `INSERT ... ON CONFLICT DO UPDATE ... RETURNING *`. ✅
- `getGuildModelConfig` returns the row or undefined. ✅

**Note:** The `FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE` requires that the guild exists. `handleModelSelect` calls `upsertGuild` before `setGuildModelConfig`, so this is safe. `handleThreadMessage` and `handleRepoCommand` both call `getGuildModelConfig` without upserting the guild first, but that's fine because they're read-only — if no config exists, it defaults to Claude. ✅

---

## 4. `/model-current` — Logic Trace

### `handleModelCurrent` (bot.ts:536–558)
1. If no config, shows default (Claude). ✅
2. Formats timestamp as Discord relative time (`<t:...>`) if valid. ✅
3. Shows model or "none (CLI default)". ✅

---

## 5. Provider Execution Services

### `spawnCollect.ts` (new shared utility)
- Extracted from `claudeExecutionService.ts`. ✅
- Adds buffer overflow detection (checks combined stdout+stderr against `maxBuffer`). New behavior vs original. Uses `EMSGSIZE` error code. ✅
- Timeout handling: sets `timedOut` flag, kills with SIGTERM, rejects with `ETIMEDOUT`. ✅
- `stdin: "ignore"` prevents interactive prompts. ✅

### `runProviderRequest.ts` (new shared utility)
- Generic CLI runner for Codex and Gemini.
- Builds args with optional `prefixArgs`, `positionalPrompt`, `extraArgs`, and `--model`. ✅
- Error handling: ENOENT → unavailable, auth pattern match → not authenticated, EMSGSIZE → buffer overflow, ETIMEDOUT/killed → timeout. ✅
- **Post-success auth check**: After clean exit, re-tests stdout+stderr against `authFailurePattern`. This catches cases where the CLI exits 0 but printed an auth prompt instead of useful output. ✅ Good defensive coding.
- Empty output check. ✅

### `codexExecutionService.ts`
- Binary: `codex`, prefix args: `["exec"]`, positional prompt, extra: `["--dangerously-bypass-approvals-and-sandbox"]`. ✅
- Auth pattern: `/401 Unauthorized/i`. ✅

### `geminiExecutionService.ts`
- Binary: `gemini`, no prefix args, flag-based prompt (`-p`), extra: `["--yolo"]`. ✅
- Auth pattern: `/set an Auth method|authentication required|not authenticated|Enter the authorization code:/i`. ✅

### `claudeExecutionService.ts`
- Refactored to import `spawnCollect` from shared utility. ✅
- Added optional `model` parameter, passed as `--model`. ✅
- JSON parsing logic unchanged. ✅

---

## 6. Auth Commands

### `/gemini-auth` (bot.ts:570–651)
- Spawns `gemini` process, watches stdout/stderr for a Google OAuth URL.
- Stores `{ child, timeoutHandle }` in `pendingGeminiAuth` map keyed by guildId.
- 5-minute expiry timeout kills the process.
- 30-second initial timeout for URL detection.
- **Potential issue**: If the `gemini` binary is not installed, `child.on("error")` fires with ENOENT, which rejects the promise. The catch block will `editReply` with the error. ✅

### `/gemini-auth-complete` (bot.ts:653–724)
- Retrieves pending auth from map.
- Checks if child process is still alive.
- Writes auth code to stdin, waits for success pattern.
- 30-second timeout.
- **Note:** The success detection regex `/loaded cached credentials|credentials saved|authenticated/i` is broad. The word "authenticated" also appears in "not authenticated". However, this runs only after writing the code to stdin, and the Gemini CLI should respond with a positive message, so false positives are unlikely. Minor concern only.

### `/codex-auth` (bot.ts:726–787)
- Takes an attachment (`.json` file, max 10KB).
- Downloads from Discord CDN, validates JSON, writes to `~/.codex/auth.json` with mode 0600.
- **Security note:** This writes credentials to the host filesystem. It's scoped to `ManageGuild` permission holders only. The file size and extension checks provide basic validation. ✅

---

## 7. Thread History Parsing (`parseThreadEntry`)

- Updated regexes from `/^\*\*Claude execution completed\*\*/` to `/^\*\*[A-Za-z]+ execution completed\*\*/`. ✅
- This handles Claude, Codex, Gemini (and any future single-word provider name). ✅

---

## 8. `messageTemplates.ts`

- Help text updated to list all new commands. ✅
- Notes updated to mention Codex/Gemini feature flags. ✅

---

## 9. Config Changes

- `ENABLE_CODEX_EXECUTION` and `ENABLE_GEMINI_EXECUTION` added as string→boolean transforms, defaulting to `"false"`. ✅
- Exposed as `enableCodexExecution` and `enableGeminiExecution` on `AppConfig`. ✅

---

## Summary of Issues Found

| # | Severity | Description |
|---|----------|-------------|
| 1 | **Medium** | `/bug` and `/issue` create unnecessary git branches via `createRequestWorktree`. User requested detached-HEAD worktrees (isolated copy of master, no branch). Need to add a `detach` option to `createRequestWorktree` that uses `git worktree add --detach {path} master` instead of `git worktree add -B {branchName} {path} master`. |
| 2 | **Low** | `handleIssueCreate` uses dynamic `import("node:child_process")` for `gh auth status` check, but `spawn` is already statically imported at the top of the file. Should use the static import or `execFile` from the static import. |
| 3 | **Low** | Follow-up messages in bug/issue threads get code-fenced output while the initial response is raw. Minor UX inconsistency — probably acceptable. |
| 4 | **Nit** | `gemini-auth-complete` success regex could match "not authenticated" due to the broad `authenticated` alternative. Low risk in practice since it only runs after writing the auth code. |
