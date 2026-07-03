import { fileURLToPath } from "node:url";
import { appConfig } from "./config.js";
import { AppDatabase } from "./db/database.js";
import { registerSlashCommands } from "./discord/commands.js";
import { ActuariusBot } from "./discord/bot.js";
import { logger } from "./logger.js";
import { runCapabilityChecks } from "./services/capabilityService.js";
import { initializeGitHubAuth } from "./services/githubAuthService.js";
import { ensurePalaceIdentity, MemPalaceClient } from "./services/memPalaceClient.js";
import { MemPalaceRemoteService } from "./services/memPalaceRemoteService.js";
import { startMemPalaceRemoteWithRetry } from "./services/memPalaceRemoteStartup.js";

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
      if (startupAbort.signal.aborted) {
        // A shutdown signal arrived during the retry window and the permanent
        // gracefulShutdown handlers below aren't registered yet — clean up
        // and exit here instead of continuing to boot the rest of the app.
        logger.info("Shutdown received during MemPalace federation startup; aborting boot");
        await memPalaceRemote.stop().catch((stopError: unknown) => {
          logger.warn({ error: stopError }, "MemPalace federation server cleanup failed during aborted startup");
        });
        db.close();
        process.exitCode = 0;
        return;
      }
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
    await ensurePalaceIdentity(logger);
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

// Only bootstrap when run directly (`node dist/index.js`), not if this module
// is ever imported elsewhere (e.g. for testing).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
