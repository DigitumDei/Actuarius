# Code Review Progress

## Critical

### 1. Queue silently swallows task errors
Status: Fixed
Notes: Queue now reports uncaught task errors via callback, and bot logs them with guild context.

### 2. Race condition / orphaned state in `runQueuedRequest`
Status: Fixed
Notes: Added top-level guard path in `runQueuedRequest` so unexpected throws after `running` transition to `failed`; cleanup warnings are now surfaced to thread and logs.

### 3. Hard `process.exit(0)` in shutdown handler
Status: Fixed
Notes: Replaced hard exit with `process.exitCode = 0`.

### 4. Error handler can itself throw
Status: Fixed
Notes: Wrapped interaction error-response path in nested try/catch and log secondary failures.

---

## High

### 5. Orphaned worktrees accumulate silently
Status: Fixed
Notes: Cleanup failures now surface in thread + logs; cleanup now always attempts `worktree prune`; worktree creation also prunes stale refs first.

### 6. Concurrent clones of same repo
Status: Fixed
Notes: Added per-repo in-process mutex in `ensureRepoCheckedOutToMaster`.

### 7. `bigint -> number` overflow silently corrupts IDs
Status: Fixed
Notes: Added safe-integer bounds checks before bigint/number conversion.

### 8. Error categorization via string matching is fragile
Status: Fixed
Notes: Primary classification now uses `ErrnoException.code` for `ENOENT`/`ETIMEDOUT` with timeout fallback checks.

### 9. `guild.members.fetchMe()` uncaught
Status: Fixed
Notes: `sendGuildWelcome` is now guarded with try/catch and warning logs.

---

## Medium

### 10. `lower(full_name)` lookup bypasses the UNIQUE constraint
Status: Fixed
Notes: `full_name` is normalized to lowercase on write and normalized in lookup input.

### 11. `startThread` can hit rate limits without retry logic
Status: Declined
Notes: Discord.js REST manager already handles retry/backoff for 429 responses; no custom retry layer added.

### 12. `registerSlashCommands` has no error handling
Status: Fixed
Notes: Added try/catch with structured error logging and rethrow.

### 13. `buildThreadName` can produce invalid names
Status: Declined
Notes: `sanitizeToken()` already guarantees fallback token (`"x"`), so empty thread names are not produced.

### 14. `RequestExecutionQueue` has no logger
Status: Fixed
Notes: Added queue state callback (`enqueued`/`started`/`finished`) and wired to bot debug logs.

### 15. Unsafe `as unknown as` casts in DB layer
Status: Declined
Notes: Valid concern, but full row-schema validation is a larger refactor; deferred for a dedicated DB hardening pass.

---

## Low

### 16. `capabilityService` warnings don't block startup
Status: Declined
Notes: Keeping current degraded-start behavior intentionally; capability failures are reported in logs.

### 17. No cleanup of `bot_state` table on guild leave
Status: Declined
Notes: No per-guild keys are currently written to `bot_state`; no leak path exists in current code.

### 18. `.worktrees` path is hardcoded
Status: Declined
Notes: Accepted for current milestone scope.

### 19. No metrics / observability
Status: Fixed
Notes: Added request duration logs and queue state logs.
