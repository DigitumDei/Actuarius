import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import { spawnCollect } from "../utils/spawnCollect.js";

/**
 * Antigravity CLI (agy) — Google's successor to the Gemini CLI. Actuarius
 * drives the same Gemini models through the `agy` executable:
 *
 * - Headless runs: `agy -p "<prompt>"` (text output on stdout, diagnostics on
 *   stderr).
 * - Oversized prompts keep the payload off argv via the documented streaming
 *   stdin protocol (`--input-format stream-json` + a `user` message line).
 * - API-key auth requires BOTH `modelProvider: "gemini"` in
 *   `~/.gemini/antigravity-cli/settings.json` AND `GEMINI_API_KEY`. A key alone
 *   has no effect; conversely, `agy` refuses to start when `modelProvider` is
 *   `gemini` but the key is missing. Actuarius therefore writes the settings
 *   marker only when the key is present, preserving unrelated keys.
 * - Without a key, `agy` uses the operator's signed-in account session
 *   (keyring or SSH OAuth). No settings marker is needed for that path, and
 *   Actuarius never demands a key.
 */

export const AGY_BINARY = "agy";
export const AGY_INSTALL_URL = "https://antigravity.google/cli/install.sh";

/** Relative home path of agy's dedicated settings file. */
const AGY_SETTINGS_REL = [".gemini", "antigravity-cli", "settings.json"] as const;

/** Relative home path of agy's dedicated MCP config file (global servers). */
const AGY_MCP_CONFIG_REL = [".gemini", "config", "mcp_config.json"] as const;

export function antigravitySettingsPath(home: string): string {
  return join(home, ...AGY_SETTINGS_REL);
}

export function antigravityMcpConfigPath(home: string): string {
  return join(home, ...AGY_MCP_CONFIG_REL);
}

/**
 * Ensure authentication is wired up for agy. API-key authentication uses
 * `modelProvider: "gemini"`; account authentication must not retain that
 * selector because agy treats it as an API-key mode request.
 * in `~/.gemini/antigravity-cli/settings.json`, merged with any existing
 * operator settings (permissions, rendering, etc., which are preserved). The
 * file is created only when absent and read/written with 0600 permissions.
 * A malformed or non-object existing file is left untouched rather than
 * overwriting operator content; agy will surface its own parse error.
 *
 * `hasApiKey` is based on the environment the child process receives. When it
 * is false, only the stale Gemini selector is removed; unrelated settings are
 * preserved and account authentication remains available.
 */
export async function ensureAntigravityApiKeyConfig(
  logger: Logger,
  home: string = homedir(),
  hasApiKey = true
): Promise<void> {
  const settingsPath = antigravitySettingsPath(home);
  let existing: string;
  try {
    existing = await readFile(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(dirname(settingsPath), { recursive: true });
      if (!hasApiKey) return;
      await writeFile(settingsPath, '{\n  "modelProvider": "gemini"\n}\n', { mode: 0o600 });
      logger.info({ settingsPath }, "Bootstrapped agy API-key auth settings");
      return;
    }
    throw error;
  }

  let config: unknown;
  try {
    config = JSON.parse(existing) as unknown;
  } catch {
    logger.warn(
      { settingsPath },
      "Preserving malformed agy settings file unchanged; agy API-key auth may not be active"
    );
    return;
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    logger.warn(
      { settingsPath },
      "Preserving non-object agy settings file unchanged; agy API-key auth may not be active"
    );
    return;
  }

  const next = { ...config as Record<string, unknown> };
  if (hasApiKey) {
    next.modelProvider = "gemini";
  } else if (next.modelProvider === "gemini") {
    delete next.modelProvider;
  }
  const serialized = JSON.stringify(next, null, 2) + "\n";
  if (serialized === existing) return;

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, serialized, { mode: 0o600 });
  try {
    await chmod(settingsPath, 0o600);
  } catch {
    // Best effort — the file was just written with 0600.
  }
  logger.info({ settingsPath }, "Merged modelProvider into existing agy settings");
}

/**
 * Install or update the Antigravity CLI binary using Google's official
 * installer. The installer is downloaded to a temp file and executed with
 * bash (never piped), with the supported `--dir` argument pointing at a fresh
 * staging directory. The validated staged binary is then atomically moved to
 * `~/.local/bin/agy`, so existing installations are really updated without
 * risking the known-good binary. Throws on non-zero exit.
 */
export async function installOrUpdateAgy(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  targetPath?: string;
} = {}): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const tempDir = await mkdtemp(join(tmpdir(), "actuarius-agy-install-"));
  const installerPath = join(tempDir, "install.sh");
  const targetPath = options.targetPath
    ?? join(options.env?.HOME ?? homedir(), ".local", "bin", AGY_BINARY);
  const targetDir = dirname(targetPath);
  await mkdir(targetDir, { recursive: true });
  const stagingDir = await mkdtemp(join(targetDir, ".agy-staging-"));
  const stagedPath = join(stagingDir, AGY_BINARY);
  try {
    const download = await spawnCollect("curl", ["-fsSL", AGY_INSTALL_URL, "-o", installerPath], {
      cwd: options.cwd ?? process.cwd(),
      timeoutMs,
      maxBuffer: 1024 * 1024,
      ...(options.env ? { env: options.env } : {}),
    });
    const install = await spawnCollect(
      "bash",
      [installerPath, "--dir", stagingDir],
      {
        cwd: options.cwd ?? process.cwd(),
        timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        ...(options.env ? { env: options.env } : {}),
      }
    );
    const installed = await stat(stagedPath).catch(() => undefined);
    if (!installed?.isFile() || (installed.mode & 0o111) === 0) {
      throw new Error(`agy installer completed without producing an executable at ${stagedPath}`);
    }
    const validation = await spawnCollect(stagedPath, ["--version"], {
      cwd: options.cwd ?? process.cwd(),
      timeoutMs: Math.min(timeoutMs, 15_000),
      maxBuffer: 64 * 1024,
      ...(options.env ? { env: options.env } : {}),
    });
    await rename(stagedPath, targetPath);
    return {
      stdout: [download.stdout, install.stdout, validation.stdout].filter(Boolean).join("\n"),
      stderr: [download.stderr, install.stderr, validation.stderr].filter(Boolean).join("\n")
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Transform agy `stream-json` stdout (one event object per line) into the
 * final response text. The terminal `result` event carries `response`.
 * Falls back to the raw stdout when no `result` event is found, so the plain
 * `text` output format of the small-prompt argv path passes through untouched.
 */
export function extractAntigravityStreamResponse(stdout: string, requireTerminalResult = false): string {
  let terminalResult: Record<string, unknown> | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(event) || event.event !== "result") continue;
    // A stream session may contain one result per turn. The final result is
    // authoritative; never retain a response from an earlier turn if the
    // terminal envelope is malformed.
    terminalResult = isRecord(event.result) ? event.result : undefined;
  }
  const response = terminalResult?.response;
  if (requireTerminalResult && (!terminalResult || typeof response !== "string")) {
    throw new Error("Antigravity stream-json output did not contain a terminal result response");
  }
  return typeof response === "string" ? response : stdout;
}

/**
 * Render the stream-json stdin payload carrying a single prompt, matching
 * agy's documented `user` event message shape. The `content` field accepts a
 * plain string; no other block types are used.
 */
export function buildAntigravityStreamPrompt(prompt: string): string {
  return JSON.stringify({ event: "user", message: { content: prompt } }) + "\n";
}

/**
 * Detect a non-success terminal status in agy `stream-json` stdout. The
 * documented terminal `result` event carries `result.status` (SUCCESS, ERROR,
 * CANCELED, INTERRUPTED, INVALID, WAITING, RUNNING) and, on failure, an
 * `result.error` message. A clean process exit can still accompany a failed
 * run, so callers should treat any non-SUCCESS terminal status as a provider
 * failure rather than trusting the exit code alone.
 *
 * Returns undefined when stdout has no `result` event (e.g. the plain `text`
 * argv transport) or when the terminal status is `SUCCESS`.
 */
export function detectAntigravityResultFailure(
  stdout: string,
  requireTerminalResult = false
): { status: string; error?: string } | undefined {
  let terminalResult: Record<string, unknown> | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(event) || event.event !== "result") continue;
    terminalResult = isRecord(event.result) ? event.result : undefined;
  }
  if (!terminalResult || typeof terminalResult.status !== "string") {
    return requireTerminalResult ? { status: "MISSING_RESULT" } : undefined;
  }
  const lastStatus = terminalResult.status;
  if (lastStatus.toUpperCase() === "SUCCESS") return undefined;
  return typeof terminalResult.error === "string"
    ? { status: lastStatus, error: terminalResult.error }
    : { status: lastStatus };
}
