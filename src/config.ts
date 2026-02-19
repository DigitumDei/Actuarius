import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

loadDotEnv();

const allowedArchiveDurations = [60, 1440, 4320, 10080] as const;
type AllowedArchiveDuration = (typeof allowedArchiveDurations)[number];

function normalizeArchiveDuration(rawValue: number): AllowedArchiveDuration {
  if (allowedArchiveDurations.includes(rawValue as AllowedArchiveDuration)) {
    return rawValue as AllowedArchiveDuration;
  }

  return 1440;
}

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1).optional(),
  DATABASE_PATH: z.string().default("/data/app.db"),
  REPOS_ROOT_PATH: z.string().default("/data/repos"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  THREAD_AUTO_ARCHIVE_MINUTES: z
    .string()
    .default("1440")
    .transform((value) => Number.parseInt(value, 10))
    .refine((value) => Number.isFinite(value), "THREAD_AUTO_ARCHIVE_MINUTES must be a number")
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const message = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`Invalid environment configuration: ${message}`);
}

const rawConfig = parsed.data;
const databaseDirectory = dirname(rawConfig.DATABASE_PATH);
mkdirSync(databaseDirectory, { recursive: true });
mkdirSync(rawConfig.REPOS_ROOT_PATH, { recursive: true });

export const appConfig = {
  discordToken: rawConfig.DISCORD_TOKEN,
  discordClientId: rawConfig.DISCORD_CLIENT_ID,
  discordGuildId: rawConfig.DISCORD_GUILD_ID,
  databasePath: rawConfig.DATABASE_PATH,
  reposRootPath: rawConfig.REPOS_ROOT_PATH,
  logLevel: rawConfig.LOG_LEVEL,
  threadAutoArchiveMinutes: normalizeArchiveDuration(rawConfig.THREAD_AUTO_ARCHIVE_MINUTES)
};

export type AppConfig = typeof appConfig;
