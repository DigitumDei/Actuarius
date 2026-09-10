#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { migratePalaceData, type MigrationLogger } from "../services/memPalacePalaceMigrator.js";

/**
 * One-off two-palace consolidation migration.
 *
 * Run with the bot stopped (no other writers), after snapshotting the data
 * disk. It starts a throwaway `mempalace-cli serve` hub over the orphaned
 * two-palace store and another over the consolidated store, then copies
 * drawers and knowledge-graph facts across REST (see
 * `memPalacePalaceMigrator.ts`). The old directory is left in place: verify,
 * then delete it manually.
 *
 *   node dist/tools/migrateMemPalace.js \
 *     --from-palace /data/mempalace/remote-palace \
 *     --to-palace /data/mempalace/palace
 */

const DEFAULT_CLI_PATH = process.env.MEMPALACE_CLI_PATH ?? "/usr/local/bin/mempalace-cli";
const DEFAULT_TOKEN_FILE = process.env.MEMPALACE_REMOTE_TOKEN_FILE ?? "/data/mempalace/server_tokens.json";
const DEFAULT_FROM_PALACE = "/data/mempalace/remote-palace";
const DEFAULT_TO_PALACE = process.env.MEMPALACE_PALACE_PATH ?? "/data/mempalace/palace";
const DEFAULT_EMBEDDING_PROFILE = process.env.MEMPALACE_EMBEDDING_PROFILE ?? "low_cpu";
const FROM_BIND = "127.0.0.1:8791";
const TO_BIND = "127.0.0.1:8792";

interface ToolArgs {
  fromPalace: string;
  toPalace: string;
  cliPath: string;
  tokenFile: string;
  embeddingProfile: string;
  dryRun: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usage(): string {
  return [
    "Usage: node dist/tools/migrateMemPalace.js [options]",
    "",
    "Copies drawers and knowledge-graph facts from the orphaned two-palace",
    "serve store into the consolidated local palace. Stop the bot first and",
    "snapshot the data disk; the old directory is never modified or deleted.",
    "",
    "Options:",
    "  --from-palace <dir>   Old serve palace (default " + DEFAULT_FROM_PALACE + ")",
    "  --to-palace <dir>     Consolidated local palace (default " + DEFAULT_TO_PALACE + ")",
    "  --cli <path>          mempalace-cli binary (default " + DEFAULT_CLI_PATH + ")",
    "  --token-file <path>   Server token file (default " + DEFAULT_TOKEN_FILE + ")",
    "  --embedding-profile <name>  low_cpu|balanced (default " + DEFAULT_EMBEDDING_PROFILE + ")",
    "  --dry-run             Read and count only; write nothing to the target",
    "  --help                Show this help"
  ].join("\n");
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value) throw new Error(flag + " requires a value");
  return value;
}

export function parseArgs(argv: string[]): ToolArgs {
  const args: ToolArgs = {
    fromPalace: DEFAULT_FROM_PALACE,
    toPalace: DEFAULT_TO_PALACE,
    cliPath: DEFAULT_CLI_PATH,
    tokenFile: DEFAULT_TOKEN_FILE,
    embeddingProfile: DEFAULT_EMBEDDING_PROFILE,
    dryRun: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--from-palace":
        args.fromPalace = requireValue(flag, argv[++index]);
        break;
      case "--to-palace":
        args.toPalace = requireValue(flag, argv[++index]);
        break;
      case "--cli":
        args.cliPath = requireValue(flag, argv[++index]);
        break;
      case "--token-file":
        args.tokenFile = requireValue(flag, argv[++index]);
        break;
      case "--embedding-profile":
        args.embeddingProfile = requireValue(flag, argv[++index]);
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
        process.stdout.write(usage() + "\n");
        process.exit(0);
        break;
      default:
        throw new Error("Unknown argument: " + String(flag) + "\n\n" + usage());
    }
  }
  if (args.fromPalace === args.toPalace) {
    throw new Error("--from-palace and --to-palace must be different directories");
  }
  return args;
}

async function resolveToken(tokenFile: string): Promise<string> {
  if (existsSync(tokenFile)) {
    const parsed = JSON.parse(await readFile(tokenFile, "utf8")) as unknown;
    const entries = Array.isArray(parsed) ? parsed.filter(isRecord) : [];
    const usable = (candidate: Record<string, unknown> | undefined): candidate is Record<string, unknown> & { token: string } =>
      candidate !== undefined && candidate.enabled !== false && typeof candidate.token === "string";
    // Prefer the unrestricted local token; a scoped peer token would hide wings
    // and silently under-copy.
    const entry = entries.find((candidate) => candidate.name === "actuarius-local" && usable(candidate)) ?? entries.find(usable);
    if (entry && typeof entry.token === "string") return entry.token;
    throw new Error("No enabled token found in " + tokenFile + "; refusing to rotate a live token file");
  }
  const token = randomBytes(32).toString("base64url");
  await mkdir(dirname(tokenFile), { recursive: true });
  await writeFile(tokenFile, JSON.stringify([{ token, name: "migrator", enabled: true }], null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600
  });
  return token;
}

function startHub(args: ToolArgs, palace: string, bind: string, homeDir: string, logger: pino.Logger): ChildProcess {
  const child = spawn(args.cliPath, ["--palace", palace, "serve", "--bind", bind, "--token-file", args.tokenFile], {
    env: {
      ...process.env,
      // A throwaway HOME keeps the stale two-palace global config (which names
      // the removed self remote) from making serve fail to load. The palace
      // path and token file are passed explicitly.
      HOME: homeDir,
      MEMPALACE_EMBEDDING_PROFILE: args.embeddingProfile,
      MEMPALACE_EMBED_ALLOW_DOWNLOADS: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk: Buffer) => logger.debug({ palace, line: chunk.toString().trim() }, "migrate hub stdout"));
  child.stderr?.on("data", (chunk: Buffer) => logger.debug({ palace, line: chunk.toString().trim() }, "migrate hub stderr"));
  child.on("error", (error) => logger.error({ palace, error }, "migrate hub process error"));
  return child;
}

async function stopHub(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const healthUrl = new URL("/v1/health", baseUrl).toString();
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = "HTTP " + response.status;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Migration hub at " + baseUrl + " did not become healthy: " + lastError);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
  if (!existsSync(args.cliPath)) {
    throw new Error("mempalace-cli not found at " + args.cliPath);
  }
  await mkdir(args.fromPalace, { recursive: true });
  await mkdir(args.toPalace, { recursive: true });

  const sandboxHome = await mkdtemp(join(tmpdir(), "mempalace-migrate-home-"));
  await mkdir(join(sandboxHome, ".mempalace"), { recursive: true });
  const token = await resolveToken(args.tokenFile);
  const fromUrl = "http://" + FROM_BIND;
  const toUrl = "http://" + TO_BIND;

  logger.info(
    { fromPalace: args.fromPalace, toPalace: args.toPalace, dryRun: args.dryRun },
    "Starting MemPalace two-palace migration"
  );
  const fromHub = startHub(args, args.fromPalace, FROM_BIND, sandboxHome, logger);
  const toHub = startHub(args, args.toPalace, TO_BIND, sandboxHome, logger);
  try {
    await waitForHealth(fromUrl, 60_000);
    await waitForHealth(toUrl, 60_000);
    const summary = await migratePalaceData({
      fromBaseUrl: fromUrl,
      toBaseUrl: toUrl,
      token,
      logger: logger as unknown as MigrationLogger,
      dryRun: args.dryRun
    });
    logger.info({ ...summary }, "MemPalace two-palace migration complete");
    return summary.errors > 0 ? 1 : 0;
  } finally {
    await stopHub(fromHub);
    await stopHub(toHub);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
      process.exitCode = 1;
    });
}
