import type { Logger } from "pino";
import { fileURLToPath } from "node:url";
import { appConfig } from "./config.js";
import { AppDatabase } from "./db/database.js";
import type { RepoRow } from "./db/types.js";
import { registerSlashCommands } from "./discord/commands.js";
import { ActuariusBot } from "./discord/bot.js";
import { logger } from "./logger.js";
import { runCapabilityChecks } from "./services/capabilityService.js";
import { initializeGitHubAuth } from "./services/githubAuthService.js";
import { MemPalaceClient } from "./services/memPalaceClient.js";
import { MemPalaceRemoteService } from "./services/memPalaceRemoteService.js";

const MEMPALACE_REMOTE_START_MAX_ATTEMPTS = 4;
const MEMPALACE_REMOTE_START_RETRY_DELAY_MS = 20_000;

/**
 * Retries the initial federation server start a few times before giving up.
 * A cold start (first-ever palace creation) can occasionally exceed the
 * 15s waitForHealth() deadline under host I/O contention; once index.ts
 * discards the service instance the internal retry/recovery machinery in
 * MemPalaceRemoteService never gets a chance to run, so a single slow boot
 * would otherwise disable federation for the rest of the process lifetime.
 * 4 attempts * 15s + 3 delays * 20s = ~2 minutes worst case.
 */
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
      const isLastAttempt = attempt === maxAttempts;
      log.warn(
        { error: err, attempt, maxAttempts },
        isLastAttempt
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

async function main(): Promise<void> {
  const db = new AppDatabase(appConfig.databasePath);
  db.runMigrations();

  await initializeGitHubAuth(appConfig, logger);
  runCapabilityChecks(logger);
  await registerSlashCommands(appConfig, logger);

  let memPalaceRemote: MemPalaceRemoteService | null = null;
  if (appConfig.mempalaceRemoteEnabled) {
    memPalaceRemote = new MemPalaceRemoteService(appConfig, logger);
    // Retrying can take up to ~2 minutes; abort the wait promptly on shutdown
    // rather than leaving the process unresponsive to SIGINT/SIGTERM for that
    // whole window (the permanent shutdown handlers aren't registered yet).
    const startupAbort = new AbortController();
    const abortStartup = (): void => startupAbort.abort();
    process.once("SIGINT", abortStartup);
    process.once("SIGTERM", abortStartup);
    try {
      const started = await startMemPalaceRemoteWithRetry(memPalaceRemote, db.listAllRepos(), logger, {
        signal: startupAbort.signal
      });
      if (!started) {
        memPalaceRemote = null;
      }
    } finally {
      process.off("SIGINT", abortStartup);
      process.off("SIGTERM", abortStartup);
    }
  }

  let memPalace: MemPalaceClient | null = null;
  if (appConfig.mempalaceEnabled) {
    memPalace = new MemPalaceClient(appConfig.mempalaceBinaryPath, appConfig.mempalacePalacePath, logger);
    try {
      await memPalace.start();
    } catch (err) {
      logger.warn({ error: err }, "MemPalace failed to start — memory layer disabled for this session");
      memPalace = null;
    }
  }

  const bot = new ActuariusBot(appConfig, logger, db, memPalace, memPalaceRemote);
  await bot.start();

  const gracefulShutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down");
    try {
      await bot.stop();
      if (memPalace) {
        await memPalace.stop();
      }
      if (memPalaceRemote) {
        await memPalaceRemote.stop();
      }
    } finally {
      db.close();
      process.exitCode = 0;
    }
  };

  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

  process.on("unhandledRejection", (error) => {
    logger.error({ error }, "Unhandled promise rejection");
  });

  process.on("uncaughtException", (error) => {
    logger.error({ error }, "Uncaught exception");
  });
}

// Only bootstrap when run directly (`node dist/index.js`), not when imported
// for testing (e.g. startMemPalaceRemoteWithRetry).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
