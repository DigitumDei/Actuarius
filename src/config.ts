import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

// Treat empty strings as undefined for optional fields
const optionalNonEmpty = z
  .string()
  .optional()
  .transform((val) => (val === "" ? undefined : val));

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: optionalNonEmpty,
  GH_TOKEN: optionalNonEmpty,
  GITHUB_APP_ID: optionalNonEmpty,
  GITHUB_APP_PRIVATE_KEY: optionalNonEmpty,
  GITHUB_APP_PRIVATE_KEY_B64: optionalNonEmpty,
  GITHUB_APP_INSTALLATION_ID: optionalNonEmpty,
  GIT_USER_NAME: optionalNonEmpty,
  GIT_USER_EMAIL: optionalNonEmpty,
  GEMINI_API_KEY: optionalNonEmpty,
  DATABASE_PATH: z.string().default("/data/app.db"),
  REPOS_ROOT_PATH: z.string().default("/data/repos"),
  INSTALLS_ROOT_PATH: z.string().default("/data/tool-installs"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  THREAD_AUTO_ARCHIVE_MINUTES: z
    .string()
    .default("1440")
    .transform((value) => Number.parseInt(value, 10))
    .refine((value) => Number.isFinite(value), "THREAD_AUTO_ARCHIVE_MINUTES must be a number"),
  ASK_CONCURRENCY_PER_GUILD: z
    .string()
    .default("3")
    .transform((value) => Number.parseInt(value, 10))
    .refine((value) => Number.isFinite(value) && value > 0, "ASK_CONCURRENCY_PER_GUILD must be a positive number"),
  ASK_EXECUTION_TIMEOUT_MS: z
    .string()
    .default("2700000")
    .transform((value) => Number.parseInt(value, 10))
    .refine((value) => Number.isFinite(value) && value > 0, "ASK_EXECUTION_TIMEOUT_MS must be a positive number"),
  INSTALL_STEP_TIMEOUT_MS: z
    .string()
    .default("3600000")
    .transform((value) => Number.parseInt(value, 10))
    .refine((value) => Number.isFinite(value) && value > 0, "INSTALL_STEP_TIMEOUT_MS must be a positive number"),
  APT_INSTALL_HELPER_PATH: optionalNonEmpty,
  ENABLE_CODEX_EXECUTION: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  ENABLE_GEMINI_EXECUTION: z
    .string()
    .default("false")
    .transform((value) => value === "true")
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const message = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`Invalid environment configuration: ${message}`);
}

const rawConfig = parsed.data;
if (rawConfig.GITHUB_APP_PRIVATE_KEY && rawConfig.GITHUB_APP_PRIVATE_KEY_B64) {
  throw new Error("Invalid environment configuration: provide only one of GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_B64.");
}

const hasAnyGitHubAppConfig = Boolean(
  rawConfig.GITHUB_APP_ID || rawConfig.GITHUB_APP_INSTALLATION_ID || rawConfig.GITHUB_APP_PRIVATE_KEY || rawConfig.GITHUB_APP_PRIVATE_KEY_B64
);

if (
  hasAnyGitHubAppConfig &&
  (!rawConfig.GITHUB_APP_ID ||
    !rawConfig.GITHUB_APP_INSTALLATION_ID ||
    (!rawConfig.GITHUB_APP_PRIVATE_KEY && !rawConfig.GITHUB_APP_PRIVATE_KEY_B64))
) {
  throw new Error(
    "Invalid environment configuration: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and either GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_B64 are required together."
  );
}

if ((rawConfig.GIT_USER_NAME && !rawConfig.GIT_USER_EMAIL) || (!rawConfig.GIT_USER_NAME && rawConfig.GIT_USER_EMAIL)) {
  throw new Error("Invalid environment configuration: GIT_USER_NAME and GIT_USER_EMAIL must be provided together.");
}

const databaseDirectory = dirname(rawConfig.DATABASE_PATH);
mkdirSync(databaseDirectory, { recursive: true });
mkdirSync(rawConfig.REPOS_ROOT_PATH, { recursive: true });
mkdirSync(rawConfig.INSTALLS_ROOT_PATH, { recursive: true });
const githubCliConfigPath = resolve(rawConfig.REPOS_ROOT_PATH, "..", ".gh");
mkdirSync(githubCliConfigPath, { recursive: true });

export const appConfig = {
  discordToken: rawConfig.DISCORD_TOKEN,
  discordClientId: rawConfig.DISCORD_CLIENT_ID,
  discordGuildId: rawConfig.DISCORD_GUILD_ID,
  ghToken: rawConfig.GH_TOKEN,
  githubAppId: rawConfig.GITHUB_APP_ID,
  githubAppPrivateKey: rawConfig.GITHUB_APP_PRIVATE_KEY,
  githubAppPrivateKeyB64: rawConfig.GITHUB_APP_PRIVATE_KEY_B64,
  githubAppInstallationId: rawConfig.GITHUB_APP_INSTALLATION_ID,
  gitUserName: rawConfig.GIT_USER_NAME,
  gitUserEmail: rawConfig.GIT_USER_EMAIL,
  geminiApiKey: rawConfig.GEMINI_API_KEY,
  databasePath: rawConfig.DATABASE_PATH,
  reposRootPath: rawConfig.REPOS_ROOT_PATH,
  installsRootPath: rawConfig.INSTALLS_ROOT_PATH,
  githubCliConfigPath,
  logLevel: rawConfig.LOG_LEVEL,
  threadAutoArchiveMinutes: normalizeArchiveDuration(rawConfig.THREAD_AUTO_ARCHIVE_MINUTES),
  askConcurrencyPerGuild: rawConfig.ASK_CONCURRENCY_PER_GUILD,
  askExecutionTimeoutMs: rawConfig.ASK_EXECUTION_TIMEOUT_MS,
  installStepTimeoutMs: rawConfig.INSTALL_STEP_TIMEOUT_MS,
  aptInstallHelperPath: rawConfig.APT_INSTALL_HELPER_PATH,
  enableCodexExecution: rawConfig.ENABLE_CODEX_EXECUTION,
  enableGeminiExecution: rawConfig.ENABLE_GEMINI_EXECUTION
};

export type AppConfig = typeof appConfig;
