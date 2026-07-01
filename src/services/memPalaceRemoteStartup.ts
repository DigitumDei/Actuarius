import type { Logger } from "pino";
import type { RepoRow } from "../db/types.js";
import { MemPalaceRemoteConfigError, type MemPalaceRemoteService } from "./memPalaceRemoteService.js";

const MEMPALACE_REMOTE_START_MAX_ATTEMPTS = 4;
const MEMPALACE_REMOTE_START_RETRY_DELAY_MS = 20_000;

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retries the initial federation server start a few times before giving up.
 * A cold start (first-ever palace creation) can occasionally exceed the
 * 15s waitForHealth() deadline under host I/O contention; once the caller
 * discards the service instance the internal retry/recovery machinery in
 * MemPalaceRemoteService never gets a chance to run, so a single slow boot
 * would otherwise disable federation for the rest of the process lifetime.
 * 4 attempts * 15s + 3 delays * 20s = ~2 minutes worst case.
 *
 * Deterministic failures (missing binary, malformed existing project config —
 * see MemPalaceRemoteConfigError) skip the retry loop entirely: they won't
 * resolve themselves between attempts, so retrying just delays startup for
 * no benefit.
 *
 * Kept in its own module (no import of ../config.js) so it can be
 * unit-tested without evaluating the app's env-validated config.
 */
export async function startMemPalaceRemoteWithRetry(
  service: MemPalaceRemoteService,
  existingRepos: RepoRow[],
  log: Logger,
  options: { maxAttempts?: number; retryDelayMs?: number; signal?: AbortSignal } = {}
): Promise<boolean> {
  const maxAttempts = options.maxAttempts ?? MEMPALACE_REMOTE_START_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? MEMPALACE_REMOTE_START_RETRY_DELAY_MS;
  const { signal } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) return false;
    try {
      await service.start(existingRepos);
      return true;
    } catch (err) {
      const isConfigError = err instanceof MemPalaceRemoteConfigError;
      const isLastAttempt = isConfigError || attempt === maxAttempts;
      log.warn(
        { error: err, attempt, maxAttempts },
        isConfigError
          ? "MemPalace federation server has a configuration problem that a retry cannot fix - remote repo memory disabled for this session"
          : isLastAttempt
            ? "MemPalace federation server failed to start after all retries - remote repo memory disabled for this session"
            : "MemPalace federation server failed to start; retrying"
      );
      // Always stop, even between retries: a failed start() leaves the
      // service's own background retry timer scheduled (see scheduleServerRetry
      // in memPalaceRemoteService.ts), and stop() clears it — otherwise our
      // manual retries and that internal timer could both attempt recovery.
      await service.stop().catch((stopError: unknown) => {
        log.warn({ error: stopError }, "MemPalace federation server cleanup failed");
      });
      if (isLastAttempt) {
        return false;
      }
      await abortableDelay(retryDelayMs, signal);
    }
  }
  return false;
}
