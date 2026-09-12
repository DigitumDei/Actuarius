import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "pino";

/**
 * Wing for the bot's own operational memory (wake-up context, request
 * summaries, diary). Deliberately distinct from the repo memory wing the
 * repo named `Actuarius` derives (`wing_actuarius`), and from mempalace's
 * reserved shared diary wing (`wing_agents`).
 */
export const BOT_MEMORY_WING = "wing_actuarius_agent";

/**
 * Seeded into the palace when no identity.txt exists, so agents waking up via
 * agentpalace_wake_up receive baseline conduct rules. Written once; operator
 * edits on the persistent disk are never overwritten.
 */
const IDENTITY_TEMPLATE = `# Identity — Actuarius agents

You are an AI agent (Claude, Codex, Gemini, or OpenCode) executing requests
for the Actuarius Discord bot. Requests arrive from Discord threads and run in
isolated git worktrees on a branch created for the request.

## Git rules
- NEVER push directly to \`main\` or \`master\`. Work on the request branch you
  were given; changes reach main through pull requests.
- Do not force-push or rewrite published history.
- Do not run destructive git commands (\`git reset --hard\`, \`git checkout --\`)
  on work you did not create in this request.
- Use \`gh\` for author-sensitive GitHub actions (pull requests, comments,
  review replies) so the bot identity is used.
- Pushing the request branch and opening a draft PR for CI validation is part
  of the standard workflow and needs no additional approval. Only merging, or
  anything that touches \`main\` or \`master\` directly, requires the operator.

## Build & validation rules
- This VM is small. Do not run heavy builds (Gradle, Android, large native
  compiles) locally — they starve the machine and time out.
- Run lightweight checks locally (lint, type-check, focused unit tests), then
  push your branch and let the repository's CI validate the full build.

## Memory rules
- Repo knowledge belongs in the repo's wing (see agentpalace.yaml in your
  worktree); use the branch name as the room.
- Verify facts about people, projects, or past events with mempalace search
  or kg queries before asserting them. Never guess.
`;

/**
 * Seed the palace identity file agents receive from agentpalace_wake_up. Runs
 * for every MemPalace-enabled deployment (local-only or remote). Only writes
 * when the file is absent so operator edits persist; failure is non-fatal —
 * agents just wake up without an identity, as before.
 */
export async function ensurePalaceIdentity(logger: Logger, homeDir: string = homedir()): Promise<void> {
  const identityPath = join(homeDir, ".mempalace", "identity.txt");
  try {
    await access(identityPath);
    const current = await readFile(identityPath, "utf8");
    const migrated = current.replace(/\bmempalace_/g, "agentpalace_");
    if (migrated !== current) await writeFile(identityPath, migrated, "utf8");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn({ error, identityPath }, "Could not read or migrate palace identity; preserving it");
      return;
    }
    // absent — seed below
  }
  try {
    await mkdir(dirname(identityPath), { recursive: true });
    await writeFile(identityPath, IDENTITY_TEMPLATE, "utf8");
    logger.info({ identityPath }, "Seeded MemPalace identity file");
  } catch (error) {
    logger.warn({ error, identityPath }, "Could not seed MemPalace identity file");
  }
}

function extractText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as { content?: unknown };
  if (!Array.isArray(r.content)) return "";
  return r.content
    .filter((c): c is { type: string; text: string } =>
      typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text"
    )
    .map((c) => c.text)
    .join("\n");
}

export class MemPalaceClient {
  private nextId = 1;
  private ready = false;
  private readonly abort = new AbortController();

  public constructor(private readonly url: string, private readonly token: string, private readonly logger: Logger) {}

  public async start(): Promise<void> {
    const result = await this.sendRequest("initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "actuarius", version: "1.0.0" }
    }) as { protocolVersion?: string };
    if (result?.protocolVersion !== "2025-03-26") throw new Error("Unsupported AgentPalace MCP protocol");
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.ready = true;
    this.logger.info({ url: this.url }, "AgentPalace HTTP MCP ready");
  }

  public async stop(): Promise<void> {
    this.ready = false;
    this.abort.abort();
  }

  public async wakeUp(wing?: string): Promise<string> {
    return this.callTool("agentpalace_wake_up", {
      agent_name: "actuarius",
      ...(wing !== undefined ? { wing } : {}),
    });
  }

  public async addDrawer(content: string, wing: string, room: string): Promise<void> {
    await this.callTool("agentpalace_add_drawer", { content, wing, room });
  }

  public async search(query: string, options?: { wing?: string; room?: string }): Promise<string> {
    return this.callTool("agentpalace_search", {
      query,
      ...(options?.wing !== undefined ? { wing: options.wing } : {}),
      ...(options?.room !== undefined ? { room: options.room } : {}),
    });
  }

  public async kgAdd(subject: string, predicate: string, object: string): Promise<void> {
    await this.callTool("agentpalace_kg_add", { subject, predicate, object });
  }

  public async diaryWrite(content: string, topic: string): Promise<void> {
    await this.callTool("agentpalace_diary_write", {
      agent_name: "actuarius",
      entry: content,
      summary: content.slice(0, 400),
      topic,
      scope: "project",
      wing: BOT_MEMORY_WING,
    });
  }

  public async status(): Promise<string> {
    return this.callTool("agentpalace_status", {});
  }

  public isReady(): boolean {
    return this.ready;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.ready) {
      throw new Error("MemPalace client is not ready");
    }
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    if ((result as { isError?: boolean })?.isError) throw new Error(extractText(result));
    return extractText(result);
  }

  private async post(body: unknown): Promise<Response> {
    const response = await fetch(this.url, {
      method: "POST", headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        Authorization: "Bearer " + this.token, "MCP-Protocol-Version": "2025-03-26"
      }, body: JSON.stringify(body), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)])
    });
    if (!response.ok) throw new Error("AgentPalace HTTP MCP returned HTTP " + response.status);
    return response;
  }

  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params });
    const message = await response.json() as { id?: number; result?: unknown; error?: { code: number; message: string } };
    if (message.id !== id) throw new Error("AgentPalace MCP response ID mismatch");
    if (message.error) throw new Error("MCP error " + message.error.code + ": " + message.error.message);
    return message.result;
  }
}
