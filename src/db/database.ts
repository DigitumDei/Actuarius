import { DatabaseSync } from "node:sqlite";
import type {
  AiProvider,
  GuildModelConfigRow,
  GuildReviewConfigRow,
  InstallRequestRow,
  InstallRequestStatus,
  InstallScope,
  RepoRow,
  RequestRow,
  RequestStatus,
  ReviewRunRow,
  ReviewRunStatus,
  ReviewVerdict
} from "./types.js";

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

      CREATE TABLE IF NOT EXISTS review_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL,
        diff_base TEXT NOT NULL,
        diff_head TEXT NOT NULL,
        final_verdict TEXT,
        summary_markdown TEXT,
        raw_result_json TEXT,
        artifact_path TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS install_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        repo_id INTEGER NOT NULL,
        request_id INTEGER,
        thread_id TEXT,
        package_id TEXT NOT NULL,
        package_version TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by_user_id TEXT NOT NULL,
        approved_by_user_id TEXT,
        install_root TEXT NOT NULL,
        bin_path TEXT,
        env_json TEXT,
        logs TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT,
        FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
        FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
        FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE SET NULL
      );
    `);

    // Incremental migrations
    try {
      this.db.exec("ALTER TABLE requests ADD COLUMN worktree_path TEXT");
    } catch {
      // Column already exists
    }

    try {
      this.db.exec("ALTER TABLE requests ADD COLUMN branch_name TEXT");
    } catch {
      // Column already exists
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_model_config (
        guild_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT,
        updated_by_user_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_review_config (
        guild_id TEXT PRIMARY KEY,
        rounds INTEGER NOT NULL,
        updated_by_user_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (provider, model)
      );
    `);

    const installRequestColumns = [
      "thread_id TEXT",
      "package_version TEXT NOT NULL DEFAULT ''",
      "approved_by_user_id TEXT",
      "install_root TEXT NOT NULL DEFAULT ''",
      "bin_path TEXT",
      "env_json TEXT",
      "logs TEXT",
      "error_message TEXT",
      "completed_at TEXT"
    ];

    for (const column of installRequestColumns) {
      try {
        this.db.exec(`ALTER TABLE install_requests ADD COLUMN ${column}`);
      } catch {
        // Column already exists
      }
    }
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

  private mapRequestRow(row: (RequestRow & { id: number | bigint; repo_id: number | bigint }) | undefined): RequestRow | undefined {
    if (!row) {
      return undefined;
    }

    return {
      ...row,
      id: toNumber(row.id),
      repo_id: toNumber(row.repo_id)
    };
  }

  private mapReviewRunRow(
    row:
      | (ReviewRunRow & {
        id: number | bigint;
        request_id: number | bigint;
      })
      | undefined
  ): ReviewRunRow | undefined {
    if (!row) {
      return undefined;
    }

    return {
      ...row,
      id: toNumber(row.id),
      request_id: toNumber(row.request_id)
    };
  }

  private mapInstallRequestRow(
    row:
      | (InstallRequestRow & {
        id: number | bigint;
        repo_id: number | bigint;
        request_id: number | bigint | null;
      })
      | undefined
  ): InstallRequestRow | undefined {
    if (!row) {
      return undefined;
    }

    return {
      ...row,
      id: toNumber(row.id),
      repo_id: toNumber(row.repo_id),
      request_id: row.request_id === null ? null : toNumber(row.request_id)
    };
  }

  public updateRequestStatus(requestId: number, status: RequestStatus): void {
    this.db.prepare("UPDATE requests SET status = ? WHERE id = ?").run(status, requestId);
  }

  public updateRequestWorkspace(requestId: number, worktreePath: string | null, branchName: string | null): void {
    this.db.prepare("UPDATE requests SET worktree_path = ?, branch_name = ? WHERE id = ?").run(worktreePath, branchName, requestId);
  }

  public getWorktreeForThread(threadId: string): string | null {
    const row = this.db
      .prepare("SELECT worktree_path FROM requests WHERE thread_id = ? AND worktree_path IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(threadId) as { worktree_path: string } | undefined;
    return row?.worktree_path ?? null;
  }

  public getLatestRequestWithWorkspaceByThreadId(threadId: string): RequestRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM requests WHERE thread_id = ? AND worktree_path IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(threadId) as (RequestRow & { id: number | bigint; repo_id: number | bigint }) | undefined;

    return this.mapRequestRow(row);
  }

  public getRequestByThreadId(threadId: string): RequestRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM requests WHERE thread_id = ? ORDER BY id DESC LIMIT 1")
      .get(threadId) as (RequestRow & { id: number | bigint; repo_id: number | bigint }) | undefined;

    return this.mapRequestRow(row);
  }

  public getGuildModelConfig(guildId: string): GuildModelConfigRow | undefined {
    return this.db
      .prepare("SELECT * FROM guild_model_config WHERE guild_id = ?")
      .get(guildId) as GuildModelConfigRow | undefined;
  }

  public setGuildModelConfig(guildId: string, provider: AiProvider, model: string | null, updatedByUserId: string): GuildModelConfigRow {
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

  public getGuildReviewConfig(guildId: string): GuildReviewConfigRow | undefined {
    return this.db
      .prepare("SELECT * FROM guild_review_config WHERE guild_id = ?")
      .get(guildId) as GuildReviewConfigRow | undefined;
  }

  public setGuildReviewConfig(guildId: string, rounds: number, updatedByUserId: string): GuildReviewConfigRow {
    return this.db
      .prepare(
        `INSERT INTO guild_review_config (guild_id, rounds, updated_by_user_id)
         VALUES (?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE
         SET rounds = excluded.rounds,
             updated_by_user_id = excluded.updated_by_user_id,
             updated_at = CURRENT_TIMESTAMP
         RETURNING *`
      )
      .get(guildId, rounds, updatedByUserId) as unknown as GuildReviewConfigRow;
  }

  public addModelToHistory(provider: AiProvider, model: string): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO model_history (provider, model)
           VALUES (?, ?)
           ON CONFLICT(provider, model) DO UPDATE
           SET used_at = CURRENT_TIMESTAMP`
        )
        .run(provider, model);

      // Keep only the 3 most recently used models per provider
      this.db
        .prepare(
          `DELETE FROM model_history
           WHERE provider = ? AND id NOT IN (
             SELECT id FROM model_history WHERE provider = ? ORDER BY used_at DESC LIMIT 3
           )`
        )
        .run(provider, provider);

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  public getModelHistory(provider: AiProvider): string[] {
    const rows = this.db
      .prepare("SELECT model FROM model_history WHERE provider = ? ORDER BY used_at DESC LIMIT 3")
      .all(provider) as Array<{ model: string }>;
    return rows.map((row) => row.model);
  }

  public createReviewRun(input: {
    requestId: number;
    threadId: string;
    branchName: string;
    status: ReviewRunStatus;
    configJson: string;
    diffBase: string;
    diffHead: string;
  }): ReviewRunRow {
    const row = this.db
      .prepare(
        `INSERT INTO review_runs (request_id, thread_id, branch_name, status, config_json, diff_base, diff_head)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        input.requestId,
        input.threadId,
        input.branchName,
        input.status,
        input.configJson,
        input.diffBase,
        input.diffHead
      ) as unknown as ReviewRunRow & { id: number | bigint; request_id: number | bigint };

    return this.mapReviewRunRow(row)!;
  }

  public completeReviewRun(input: {
    reviewRunId: number;
    status: Exclude<ReviewRunStatus, "running">;
    finalVerdict: ReviewVerdict | null;
    summaryMarkdown: string | null;
    rawResultJson: string | null;
    artifactPath: string | null;
  }): void {
    this.db
      .prepare(
        `UPDATE review_runs
         SET status = ?,
             final_verdict = ?,
             summary_markdown = ?,
             raw_result_json = ?,
             artifact_path = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(
        input.status,
        input.finalVerdict,
        input.summaryMarkdown,
        input.rawResultJson,
        input.artifactPath,
        input.reviewRunId
      );
  }

  public getLatestReviewRunForRequest(requestId: number): ReviewRunRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM review_runs WHERE request_id = ? ORDER BY id DESC LIMIT 1")
      .get(requestId) as (ReviewRunRow & { id: number | bigint; request_id: number | bigint }) | undefined;

    return this.mapReviewRunRow(row);
  }

  public createInstallRequest(input: {
    guildId: string;
    repoId: number;
    requestId?: number | null;
    threadId?: string | null;
    packageId: string;
    packageVersion: string;
    scope: InstallScope;
    status: InstallRequestStatus;
    requestedByUserId: string;
    approvedByUserId?: string | null;
    installRoot: string;
  }): InstallRequestRow {
    const row = this.db
      .prepare(
        `INSERT INTO install_requests (
          guild_id,
          repo_id,
          request_id,
          thread_id,
          package_id,
          package_version,
          scope,
          status,
          requested_by_user_id,
          approved_by_user_id,
          install_root
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *`
      )
      .get(
        input.guildId,
        input.repoId,
        input.requestId ?? null,
        input.threadId ?? null,
        input.packageId,
        input.packageVersion,
        input.scope,
        input.status,
        input.requestedByUserId,
        input.approvedByUserId ?? null,
        input.installRoot
      ) as unknown as InstallRequestRow & {
        id: number | bigint;
        repo_id: number | bigint;
        request_id: number | bigint | null;
      };

    return this.mapInstallRequestRow(row)!;
  }

  public updateInstallRequest(input: {
    installRequestId: number;
    status: InstallRequestStatus;
    approvedByUserId?: string | null;
    binPath?: string | null;
    envJson?: string | null;
    logs?: string | null;
    errorMessage?: string | null;
    completedAt?: string | null;
  }): void {
    this.db
      .prepare(
        `UPDATE install_requests
         SET status = ?,
             approved_by_user_id = COALESCE(?, approved_by_user_id),
             bin_path = ?,
             env_json = ?,
             logs = ?,
             error_message = ?,
             completed_at = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(
        input.status,
        input.approvedByUserId ?? null,
        input.binPath ?? null,
        input.envJson ?? null,
        input.logs ?? null,
        input.errorMessage ?? null,
        input.completedAt ?? null,
        input.installRequestId
      );
  }

  public getInstallRequestById(installRequestId: number): InstallRequestRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM install_requests WHERE id = ?")
      .get(installRequestId) as (InstallRequestRow & {
        id: number | bigint;
        repo_id: number | bigint;
        request_id: number | bigint | null;
      }) | undefined;

    return this.mapInstallRequestRow(row);
  }

  public listSuccessfulInstallRequestsForScope(input: {
    repoId: number;
    threadId?: string | null;
  }): InstallRequestRow[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM install_requests
         WHERE status = 'succeeded'
           AND (
             (scope = 'repo' AND repo_id = ?)
             OR (scope = 'request' AND thread_id = ?)
           )
         ORDER BY id ASC`
      )
      .all(input.repoId, input.threadId ?? null) as unknown as Array<InstallRequestRow & {
      id: number | bigint;
      repo_id: number | bigint;
      request_id: number | bigint | null;
    }>;

    return rows
      .map((row) => this.mapInstallRequestRow(row))
      .filter((row): row is InstallRequestRow => Boolean(row));
  }

  public close(): void {
    this.db.close();
  }
}
