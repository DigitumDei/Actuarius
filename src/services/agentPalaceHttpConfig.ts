import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Converge persistent harness registrations after the server token is resolved. */
export async function configureAgentPalaceHttp(home: string, url: string, token: string, xdgConfigHome = join(home, ".config")): Promise<void> {
  const headers = { Authorization: `Bearer ${token}` };
  const registrations = [
    [join(home, ".claude.json"), "mcpServers", { type: "http", url, headers }],
    [join(home, ".gemini", "settings.json"), "mcpServers", { httpUrl: url, headers }],
    [join(xdgConfigHome, "opencode", "config.json"), "mcp", { type: "remote", url, headers, oauth: false, enabled: true }],
    [join(xdgConfigHome, "opencode", "opencode.json"), "mcp", { type: "remote", url, headers, oauth: false, enabled: true }],
  ] as const;
  for (const [path, key, entry] of registrations) {
    const text = await readOptional(path);
    const config = text ? JSON.parse(text) as Record<string, unknown> : {};
    const servers = config[key] ?? {};
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error(`Invalid MCP configuration in ${path}`);
    const next = { ...servers } as Record<string, unknown>;
    delete next.mempalace;
    next.agentpalace = entry;
    config[key] = next;
    await writePrivate(path, JSON.stringify(config, null, 2) + "\n");
  }
  const path = join(home, ".codex", "config.toml");
  const current = await readOptional(path);
  const stripped = current.replace(/^\[mcp_servers\.(?:mempalace|agentpalace)(?:\.[A-Za-z0-9_]+)?\][\s\S]*?(?=^\[|(?![\s\S]))/gm, "").trimEnd();
  const block = `[mcp_servers.agentpalace]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(headers.Authorization)} }\n`;
  await writePrivate(path, (stripped ? stripped + "\n\n" : "") + block);
}

/** Planning snapshots can override global MCP entries, so converge this layer too. */
export async function configureOpencodeSnapshot(target: string, source = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "opencode.json")): Promise<void> {
  const sourceText = await readOptional(source);
  if (!sourceText) return;
  const sourceConfig = JSON.parse(sourceText);
  const entry = sourceConfig.mcp?.agentpalace;
  if (!entry) return;
  const config = JSON.parse(await readOptional(target) || "{}");
  config.mcp ??= {};
  delete config.mcp.mempalace;
  config.mcp.agentpalace = entry;
  await writePrivate(target, JSON.stringify(config, null, 2) + "\n");
}

async function readOptional(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Tighten existing files before writing credentials, not just newly created files.
  try { await chmod(path, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (await readOptional(path) !== content) await writeFile(path, content, { mode: 0o600 });
}
