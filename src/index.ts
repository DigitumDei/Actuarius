import { appConfig } from "./config.js";
import { AppDatabase } from "./db/database.js";
import { registerSlashCommands } from "./discord/commands.js";
import { ActuariusBot } from "./discord/bot.js";
import { logger } from "./logger.js";
import { runCapabilityChecks } from "./services/capabilityService.js";
import { initializeGitHubAuth } from "./services/githubAuthService.js";
import { MemPalaceClient } from "./services/memPalaceClient.js";

async function main(): Promise<void> {
  const db = new AppDatabase(appConfig.databasePath);
  db.runMigrations();

  await initializeGitHubAuth(appConfig, logger);
  runCapabilityChecks(logger);
  await registerSlashCommands(appConfig, logger);

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

  const bot = new ActuariusBot(appConfig, logger, db, memPalace);
  await bot.start();

  const gracefulShutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down");
    try {
      await bot.stop();
      if (memPalace) {
        await memPalace.stop();
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

void main();
