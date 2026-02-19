import { DatabaseSync } from "node:sqlite";
import type { RepoRow, RequestRow } from "./types.js";

function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
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
    const row = this.db
      .prepare("SELECT * FROM repos WHERE guild_id = ? AND lower(full_name) = lower(?)")
      .get(guildId, fullName) as (RepoRow & { id: number | bigint }) | undefined;

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
        input.fullName,
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
    status: string;
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

  public close(): void {
    this.db.close();
  }
}
