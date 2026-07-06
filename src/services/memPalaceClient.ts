import { existsSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
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
 * mempalace_wake_up receive baseline conduct rules. Written once; operator
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

## Build & validation rules
- This VM is small. Do not run heavy builds (Gradle, Android, large native
  compiles) locally — they starve the machine and time out.
- Run lightweight checks locally (lint, type-check, focused unit tests), then
  push your branch and let the repository's CI validate the full build.

## Memory rules
- Repo knowledge belongs in the repo's wing (see mempalace.yaml in your
  worktree); use the branch name as the room.
- Verify facts about people, projects, or past events with mempalace search
  or kg queries before asserting them. Never guess.
`;

/**
 * Seed the palace identity file agents receive from mempalace_wake_up. Runs
 * for every MemPalace-enabled deployment (local-only or remote). Only writes
 * when the file is absent so operator edits persist; failure is non-fatal —
 * agents just wake up without an identity, as before.
 */
export async function ensurePalaceIdentity(logger: Logger, homeDir: string = homedir()): Promise<void> {
  const identityPath = join(homeDir, ".mempalace", "identity.txt");
  try {
    await access(identityPath);
    return;
  } catch {
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

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface McpResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
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
  private child: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private ready = false;

  public constructor(
    private readonly binaryPath: string,
    private readonly palacePath: string,
    private readonly logger: Logger
  ) {}

  public async start(): Promise<void> {
    if (!existsSync(this.binaryPath)) {
      throw new Error(`mempalace-mcp binary not found at ${this.binaryPath}`);
    }

    this.child = spawn(this.binaryPath, [], {
      env: {
        ...process.env,
        MEMPALACE_PALACE_PATH: this.palacePath,
        MEMPALACE_EMBED_ALLOW_DOWNLOADS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: this.child.stdout! });
    rl.on("line", (line) => {
      if (this.child?.killed) return;
      this.handleLine(line);
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      if (this.child?.killed) return;
      this.logger.debug({ stderr: chunk.toString().trim() }, "mempalace-mcp stderr");
    });

    this.child.on("error", (err) => {
      this.logger.error({ error: err }, "mempalace-mcp process error");
      this.rejectAllPending(err);
    });

    this.child.on("close", (code) => {
      if (this.ready) {
        this.logger.warn({ code }, "mempalace-mcp process exited unexpectedly");
      }
      this.rejectAllPending(new Error(`mempalace-mcp exited (code=${String(code)})`));
      this.ready = false;
    });

    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "actuarius", version: "1.0.0" },
    });
    this.sendNotification("notifications/initialized");
    this.ready = true;
    this.logger.info({ palacePath: this.palacePath }, "mempalace-mcp ready");
  }

  public async stop(): Promise<void> {
    this.ready = false;
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }

  public async wakeUp(wing?: string): Promise<string> {
    return this.callTool("mempalace_wake_up", {
      agent_name: "actuarius",
      ...(wing !== undefined ? { wing } : {}),
    });
  }

  public async addDrawer(content: string, wing: string, room: string): Promise<void> {
    await this.callTool("mempalace_add_drawer", { content, wing, room });
  }

  public async search(query: string, options?: { wing?: string; room?: string }): Promise<string> {
    return this.callTool("mempalace_search", {
      query,
      ...(options?.wing !== undefined ? { wing: options.wing } : {}),
      ...(options?.room !== undefined ? { room: options.room } : {}),
    });
  }

  public async kgAdd(subject: string, predicate: string, object: string): Promise<void> {
    await this.callTool("mempalace_kg_add", { subject, predicate, object });
  }

  public async diaryWrite(content: string, topic: string): Promise<void> {
    await this.callTool("mempalace_diary_write", {
      agent_name: "actuarius",
      content,
      topic,
      scope: "project",
      wing: BOT_MEMORY_WING,
    });
  }

  public async status(): Promise<string> {
    return this.callTool("mempalace_status", {});
  }

  public isReady(): boolean {
    return this.ready;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.ready) {
      throw new Error("MemPalace client is not ready");
    }
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    return extractText(result);
  }

  private sendRequest(method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin || this.child.killed) {
        reject(new Error("MemPalace client is not connected"));
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });

      this.sendLine({ jsonrpc: "2.0", id, method, params });
    });
  }

  private sendNotification(method: string): void {
    this.sendLine({ jsonrpc: "2.0", method });
  }

  private sendLine(obj: unknown): void {
    this.child?.stdin?.write(JSON.stringify(obj) + "\n");
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.logger.debug({ line: trimmed }, "mempalace-mcp: skipping non-JSON line");
      return;
    }

    const response = msg as McpResponse;
    if (response.id === undefined) return; // notification, not a response

    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
    } else {
      pending.resolve(response.result);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
