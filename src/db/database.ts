import { DatabaseSync } from "node:sqlite";
import type { AiProvider, GuildModelConfigRow, RepoRow, RequestRow, RequestStatus } from "./types.js";

function toNumber(value: number | bigint): number {
  if (typeof value === "bigint") {
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
    if (value > maxSafe || value < minSafe) {
      throw new RangeError(`SQLite integer ${value.toString()} exceeds JS safe integer range.`);
    }
    return Number(value);
  }

  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`SQLite integer ${value} exceeds JS safe integer range.`);
  }

  return value;
}

function normalizeRepoFullName(fullName: string): string {
  return fullName.trim().toLowerCase();
}

export class AppDatabase {
  private readonly db: DatabaseSync;

  public constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  public runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guilds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        full_name TEXT NOT NULL,
        visibility TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        linked_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (guild_id, full_name),
        FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        repo_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
        FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS bot_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Incremental migrations
    try {
      this.db.exec("ALTER TABLE requests ADD COLUMN worktree_path TEXT");
    } catch {
      // Column already exists
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_model_config (
        guild_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        updated_by_user_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
      );
    `);
  }

  public upsertGuild(id: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO guilds (id, name)
         VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE
         SET name = excluded.name,
             updated_at = CURRENT_TIMESTAMP`
      )
      .run(id, name);
  }

  public removeGuild(id: string): void {
    this.db.prepare("DELETE FROM guilds WHERE id = ?").run(id);
  }

  public getRepoByFullName(guildId: string, fullName: string): RepoRow | undefined {
    const normalizedFullName = normalizeRepoFullName(fullName);
    const row = this.db
      .prepare("SELECT * FROM repos WHERE guild_id = ? AND lower(full_name) = lower(?)")
      .get(guildId, normalizedFullName) as (RepoRow & { id: number | bigint }) | undefined;

    if (!row) {
      return undefined;
    }

    return {
      ...row,
      id: toNumber(row.id)
    };
  }

  public getRepoByChannelId(guildId: string, channelId: string): RepoRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM repos WHERE guild_id = ? AND channel_id = ?")
      .get(guildId, channelId) as (RepoRow & { id: number | bigint }) | undefined;

    if (!row) {
      return undefined;
    }

    return {
      ...row,
      id: toNumber(row.id)
    };
  }

  public listReposByGuild(guildId: string): RepoRow[] {
    const rows = this.db.prepare("SELECT * FROM repos WHERE guild_id = ? ORDER BY created_at ASC").all(guildId) as unknown as Array<
      RepoRow & { id: number | bigint }
    >;

    return rows.map((row) => ({
      ...row,
      id: toNumber(row.id)
    }));
  }

  public createRepo(input: {
    guildId: string;
    owner: string;
    repo: string;
    fullName: string;
    visibility: string;
    channelId: string;
    linkedByUserId: string;
  }): RepoRow {
    const row = this.db
      .prepare(
        `INSERT INTO repos (guild_id, owner, repo, full_name, visibility, channel_id, linked_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        input.guildId,
        input.owner,
        input.repo,
        normalizeRepoFullName(input.fullName),
        input.visibility,
        input.channelId,
        input.linkedByUserId
      ) as unknown as RepoRow & { id: number | bigint };

    return {
      ...row,
      id: toNumber(row.id)
    };
  }

  public createRequest(input: {
    guildId: string;
    repoId: number;
    channelId: string;
    threadId: string;
    userId: string;
    prompt: string;
    status: RequestStatus;
  }): RequestRow {
    const row = this.db
      .prepare(
        `INSERT INTO requests (guild_id, repo_id, channel_id, thread_id, user_id, prompt, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        input.guildId,
        input.repoId,
        input.channelId,
        input.threadId,
        input.userId,
        input.prompt,
        input.status
      ) as unknown as RequestRow & { id: number | bigint; repo_id: number | bigint };

    return {
      ...row,
      id: toNumber(row.id),
      repo_id: toNumber(row.repo_id)
    };
  }

  public updateRequestStatus(requestId: number, status: RequestStatus): void {
    this.db.prepare("UPDATE requests SET status = ? WHERE id = ?").run(status, requestId);
  }

  public updateRequestWorktreePath(requestId: number, worktreePath: string): void {
    this.db.prepare("UPDATE requests SET worktree_path = ? WHERE id = ?").run(worktreePath, requestId);
  }

  public getWorktreeForThread(threadId: string): string | null {
    const row = this.db
      .prepare("SELECT worktree_path FROM requests WHERE thread_id = ? AND worktree_path IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(threadId) as { worktree_path: string } | undefined;
    return row?.worktree_path ?? null;
  }

  public getGuildModelConfig(guildId: string): GuildModelConfigRow | undefined {
    return this.db
      .prepare("SELECT * FROM guild_model_config WHERE guild_id = ?")
      .get(guildId) as GuildModelConfigRow | undefined;
  }

  public setGuildModelConfig(guildId: string, provider: AiProvider, model: string, updatedByUserId: string): GuildModelConfigRow {
    return this.db
      .prepare(
        `INSERT INTO guild_model_config (guild_id, provider, model, updated_by_user_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE
         SET provider = excluded.provider,
             model = excluded.model,
             updated_by_user_id = excluded.updated_by_user_id,
             updated_at = CURRENT_TIMESTAMP
         RETURNING *`
      )
      .get(guildId, provider, model, updatedByUserId) as unknown as GuildModelConfigRow;
  }

  public close(): void {
    this.db.close();
  }
}
