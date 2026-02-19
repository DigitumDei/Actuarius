import { appConfig } from "./config.js";
import { AppDatabase } from "./db/database.js";
import { registerSlashCommands } from "./discord/commands.js";
import { ActuariusBot } from "./discord/bot.js";
import { logger } from "./logger.js";
import { runCapabilityChecks } from "./services/capabilityService.js";

async function main(): Promise<void> {
  const db = new AppDatabase(appConfig.databasePath);
  db.runMigrations();

  runCapabilityChecks(logger);
  await registerSlashCommands(appConfig, logger);

  const bot = new ActuariusBot(appConfig, logger, db);
  await bot.start();

  const gracefulShutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down");
    try {
      await bot.stop();
    } finally {
      db.close();
      process.exit(0);
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

