import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  AiProvider,
  GuildModelConfigRow,
  GuildReviewConfigRow,
  InstallRequestRow,
  InstallRequestStatus,
  InstallScope,
  ModelRole,
  ReviewModelRole,
  ReviewerSlotRow,
  RepoRow,
  RequestRow,
  RequestStatus,
  ReviewRunRow,
  ReviewRunStatus,
  ReviewVerdict
} from "./types.js";
import {
  guildModelConfigRowSchema,
  guildReviewConfigRowRawSchema,
  installRequestRowRawSchema,
  modelHistoryRowSchema,
  reviewerSlotRowRawSchema,
  repoRowRawSchema,
  requestRowRawSchema,
  reviewRunRowRawSchema,
  tableInfoRowSchema,
  worktreePathRowSchema,
} from "./schemas.js";

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
        package_version TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by_user_id TEXT NOT NULL,
        approved_by_user_id TEXT,
        install_root TEXT NOT NULL DEFAULT '',
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

    try {
      this.db.exec("ALTER TABLE requests ADD COLUMN revision_of_request_id INTEGER");
    } catch {
      // Column already exists
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_model_config (
        guild_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT,
        planner_provider TEXT,
        planner_model TEXT,
        implementer_provider TEXT,
        implementer_model TEXT,
        analyzer_provider TEXT,
        analyzer_model TEXT,
        judge_provider TEXT,
        judge_model TEXT,
        summarizer_provider TEXT,
        summarizer_model TEXT,
        updated_by_user_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
      );
    `);

    // Migrate: the original schema had `model TEXT NOT NULL`; it must be nullable so
    // setGuildRoleModelConfig can insert a placeholder row without a default model.
    // SQLite cannot drop a NOT NULL constraint via ALTER TABLE, so recreate the table.
    const guildModelConfigModelInfo = this.db.prepare("PRAGMA table_info(guild_model_config)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    if (guildModelConfigModelInfo.find((c) => c.name === "model")?.notnull === 1) {
      // PR #123 recreate: preserve any role-override columns that may exist.
      const knownExtraCols = [
        "planner_provider", "planner_model",
        "implementer_provider", "implementer_model",
        "analyzer_provider", "analyzer_model",
        "judge_provider", "judge_model",
        "summarizer_provider", "summarizer_model",
      ];
      const extraCols = knownExtraCols.filter((c) =>
        guildModelConfigModelInfo.some((col) => col.name === c)
      );
      const insertCols = ["guild_id", "provider", "model", "updated_by_user_id", "updated_at", ...extraCols].join(", ");
      const selectCols = ["guild_id", "provider", "NULLIF(model, '')", "updated_by_user_id", "updated_at", ...extraCols].join(", ");

      this.db.exec("BEGIN");
      try {
        this.db.exec(`
          CREATE TABLE guild_model_config_v2 (
            guild_id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            model TEXT,
            planner_provider TEXT,
            planner_model TEXT,
            implementer_provider TEXT,
            implementer_model TEXT,
            analyzer_provider TEXT,
            analyzer_model TEXT,
            judge_provider TEXT,
            judge_model TEXT,
            summarizer_provider TEXT,
            summarizer_model TEXT,
            updated_by_user_id TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
          );
          INSERT INTO guild_model_config_v2 (${insertCols})
            SELECT ${selectCols} FROM guild_model_config;
          DROP TABLE guild_model_config;
          ALTER TABLE guild_model_config_v2 RENAME TO guild_model_config;
        `);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    const guildModelConfigColumns = new Map([
      ["planner_provider", "TEXT"],
      ["planner_model", "TEXT"],
      ["implementer_provider", "TEXT"],
      ["implementer_model", "TEXT"],
      ["analyzer_provider", "TEXT"],
      ["analyzer_model", "TEXT"],
      ["judge_provider", "TEXT"],
      ["judge_model", "TEXT"],
      ["summarizer_provider", "TEXT"],
      ["summarizer_model", "TEXT"]
    ]);
    const existingGuildModelConfigColumns = new Set(
      z.array(tableInfoRowSchema)
        .parse(this.db.prepare("PRAGMA table_info(guild_model_config)").all())
        .map((column) => column.name)
    );

    for (const [columnName, columnDefinition] of guildModelConfigColumns) {
      if (!existingGuildModelConfigColumns.has(columnName)) {
        this.db.exec(`ALTER TABLE guild_model_config ADD COLUMN ${columnName} ${columnDefinition}`);
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_review_config (
        guild_id TEXT PRIMARY KEY,
        rounds INTEGER NOT NULL,
        analyzer_provider TEXT,
        analyzer_model TEXT,
        judge_provider TEXT,
        judge_model TEXT,
        summarizer_provider TEXT,
        summarizer_model TEXT,
        updated_by_user_id TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
      );
    `);

    // Keep additive migrations for deployments that already had guild_review_config before these columns existed.
    const reviewConfigColumns = new Map<string, string>([
      ["analyzer_provider", "TEXT"],
      ["analyzer_model", "TEXT"],
      ["judge_provider", "TEXT"],
      ["judge_model", "TEXT"],
      ["summarizer_provider", "TEXT"],
      ["summarizer_model", "TEXT"],
    ]);
    const existingReviewConfigColumns = new Set(
      z.array(tableInfoRowSchema)
        .parse(this.db.prepare("PRAGMA table_info(guild_review_config)").all())
        .map((column) => column.name)
    );
    for (const [columnName, columnDefinition] of reviewConfigColumns) {
      if (!existingReviewConfigColumns.has(columnName)) {
        this.db.exec(`ALTER TABLE guild_review_config ADD COLUMN ${columnName} ${columnDefinition}`);
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guild_reviewer_slots (
        guild_id TEXT NOT NULL,
        slot_index INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        updated_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, slot_index),
        FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
      );
    `);

    // Migrate from legacy reviewer_slots table, preserving existing data
    const hasLegacyReviewerSlots =
      this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='reviewer_slots'"
      ).get() !== undefined;

    if (hasLegacyReviewerSlots) {
      // Detect which columns exist in the legacy table. The real production
      // schema only had (guild_id, slot_index, provider, model) — no audit columns.
      const existingLegacyColumns = new Set(
        z.array(tableInfoRowSchema)
          .parse(this.db.prepare("PRAGMA table_info(reviewer_slots)").all())
          .map((column) => column.name)
      );

      const coreColumns: Array<{ name: string; select: string }> = [
        { name: "guild_id", select: "guild_id" },
        { name: "slot_index", select: "slot_index + 1 AS slot_index" },
        { name: "provider", select: "provider" },
        { name: "model", select: "model" },
      ];
      const columnMap = [...coreColumns];

      if (existingLegacyColumns.has("updated_by_user_id")) {
        columnMap.push({ name: "updated_by_user_id", select: "updated_by_user_id" });
      } else {
        columnMap.push({ name: "updated_by_user_id", select: "'system-migration' AS updated_by_user_id" });
      }
      if (existingLegacyColumns.has("created_at")) {
        columnMap.push({ name: "created_at", select: "created_at" });
      } else {
        columnMap.push({ name: "created_at", select: "CURRENT_TIMESTAMP AS created_at" });
      }
      if (existingLegacyColumns.has("updated_at")) {
        columnMap.push({ name: "updated_at", select: "updated_at" });
      } else {
        columnMap.push({ name: "updated_at", select: "CURRENT_TIMESTAMP AS updated_at" });
      }

      this.db.exec("BEGIN");
      try {
        this.db.exec(`
          INSERT OR IGNORE INTO guild_reviewer_slots
            (${columnMap.map((c) => c.name).join(", ")})
          SELECT ${columnMap.map((c) => c.select).join(", ")}
          FROM reviewer_slots
        `);
        this.db.exec("DROP TABLE reviewer_slots");
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (provider, model)
      );
    `);

    // Keep additive migrations for deployments that already had install_requests before these later columns existed.
    const installRequestColumns = new Map([
      ["thread_id", "TEXT"],
      ["package_version", "TEXT NOT NULL DEFAULT ''"],
      ["approved_by_user_id", "TEXT"],
      ["install_root", "TEXT NOT NULL DEFAULT ''"],
      ["bin_path", "TEXT"],
      ["env_json", "TEXT"],
      ["logs", "TEXT"],
      ["error_message", "TEXT"],
      ["completed_at", "TEXT"]
    ]);
    const existingInstallRequestColumns = new Set(
      z.array(tableInfoRowSchema)
        .parse(this.db.prepare("PRAGMA table_info(install_requests)").all())
        .map((column) => column.name)
    );

    for (const [columnName, columnDefinition] of installRequestColumns) {
      if (!existingInstallRequestColumns.has(columnName)) {
        this.db.exec(`ALTER TABLE install_requests ADD COLUMN ${columnName} ${columnDefinition}`);
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
    const raw = repoRowRawSchema.optional().parse(
      this.db
        .prepare("SELECT * FROM repos WHERE guild_id = ? AND lower(full_name) = lower(?)")
        .get(guildId, normalizedFullName)
    );

    if (!raw) {
      return undefined;
    }

    return {
      ...raw,
      id: toNumber(raw.id)
    };
  }

  public getRepoByChannelId(guildId: string, channelId: string): RepoRow | undefined {
    const raw = repoRowRawSchema.optional().parse(
      this.db
        .prepare("SELECT * FROM repos WHERE guild_id = ? AND channel_id = ?")
        .get(guildId, channelId)
    );

    if (!raw) {
      return undefined;
    }

    return {
      ...raw,
      id: toNumber(raw.id)
    };
  }

  public getRepoById(repoId: number): RepoRow | undefined {
    const raw = repoRowRawSchema.optional().parse(
      this.db.prepare("SELECT * FROM repos WHERE id = ?").get(repoId)
    );

    if (!raw) {
      return undefined;
    }

    return {
      ...raw,
      id: toNumber(raw.id)
    };
  }

  public listReposByGuild(guildId: string): RepoRow[] {
    const rows = z.array(repoRowRawSchema).parse(
      this.db.prepare("SELECT * FROM repos WHERE guild_id = ? ORDER BY created_at ASC").all(guildId)
    );

    return rows.map((row) => ({
      ...row,
      id: toNumber(row.id)
    }));
  }

  public listAllRepos(): RepoRow[] {
    const rows = z.array(repoRowRawSchema).parse(
      this.db.prepare("SELECT * FROM repos ORDER BY guild_id ASC, created_at ASC").all()
    );

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
    const raw = repoRowRawSchema.parse(
      this.db
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
        )
    );

    return {
      ...raw,
      id: toNumber(raw.id)
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
    revisionOfRequestId?: number;
  }): RequestRow {
    const raw = requestRowRawSchema.parse(
      this.db
        .prepare(
          `INSERT INTO requests (guild_id, repo_id, channel_id, thread_id, user_id, prompt, status, revision_of_request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`
        )
        .get(
          input.guildId,
          input.repoId,
          input.channelId,
          input.threadId,
          input.userId,
          input.prompt,
          input.status,
          input.revisionOfRequestId ?? null
        )
    );

    return {
      ...raw,
      id: toNumber(raw.id),
      repo_id: toNumber(raw.repo_id),
      revision_of_request_id: raw.revision_of_request_id === null
        ? null
        : toNumber(raw.revision_of_request_id)
    };
  }

  private mapRequestRow(raw: z.infer<typeof requestRowRawSchema> | undefined): RequestRow | undefined {
    if (!raw) {
      return undefined;
    }

    return {
      ...raw,
      id: toNumber(raw.id),
      repo_id: toNumber(raw.repo_id),
      revision_of_request_id: raw.revision_of_request_id === null
        ? null
        : toNumber(raw.revision_of_request_id)
    };
  }

  private mapReviewRunRow(
    raw: z.infer<typeof reviewRunRowRawSchema> | undefined
  ): ReviewRunRow | undefined {
    if (!raw) {
      return undefined;
    }

    return {
      ...raw,
      id: toNumber(raw.id),
      request_id: toNumber(raw.request_id)
    };
  }

  private mapInstallRequestRow(
    raw: z.infer<typeof installRequestRowRawSchema> | undefined
  ): InstallRequestRow | undefined {
    if (!raw) {
      return undefined;
    }

    return {
      ...raw,
      id: toNumber(raw.id),
      repo_id: toNumber(raw.repo_id),
      request_id: raw.request_id === null ? null : toNumber(raw.request_id)
    };
  }

  public updateRequestStatus(requestId: number, status: RequestStatus): void {
    this.db.prepare("UPDATE requests SET status = ? WHERE id = ?").run(status, requestId);
  }

  // A freshly booted process has no in-flight work (single-instance
  // deployment), so any row still marked active was interrupted by a restart.
  // Left as-is, such rows block their thread ("already queued or running")
  // and their install root ("INSTALL_ALREADY_ACTIVE") forever.
  public failInterruptedWork(): { requests: number; installRequests: number } {
    const requests = this.db
      .prepare("UPDATE requests SET status = 'failed' WHERE status IN ('queued', 'running', 'install_approved', 'install_running')")
      .run();
    const installRequests = this.db
      .prepare("UPDATE install_requests SET status = 'failed' WHERE status IN ('approved', 'running')")
      .run();
    return { requests: Number(requests.changes), installRequests: Number(installRequests.changes) };
  }

  public updateRequestWorkspace(requestId: number, worktreePath: string | null, branchName: string | null): void {
    this.db.prepare("UPDATE requests SET worktree_path = ?, branch_name = ? WHERE id = ?").run(worktreePath, branchName, requestId);
  }

  public getWorktreeForThread(threadId: string): string | null {
    const row = worktreePathRowSchema.optional().parse(
      this.db
        .prepare("SELECT worktree_path FROM requests WHERE thread_id = ? AND worktree_path IS NOT NULL ORDER BY id DESC LIMIT 1")
        .get(threadId)
    );
    return row?.worktree_path ?? null;
  }

  public getLatestRequestWithWorkspaceByThreadId(threadId: string): RequestRow | undefined {
    const raw = requestRowRawSchema.optional().parse(
      this.db
        .prepare("SELECT * FROM requests WHERE thread_id = ? AND worktree_path IS NOT NULL ORDER BY id DESC LIMIT 1")
        .get(threadId)
    );

    return this.mapRequestRow(raw);
  }

  public getRequestByThreadId(threadId: string): RequestRow | undefined {
    const raw = requestRowRawSchema.optional().parse(
      this.db
        .prepare("SELECT * FROM requests WHERE thread_id = ? ORDER BY id DESC LIMIT 1")
        .get(threadId)
    );

    return this.mapRequestRow(raw);
  }

  public getRequestById(requestId: number): RequestRow | undefined {
    const raw = requestRowRawSchema.optional().parse(
      this.db
        .prepare("SELECT * FROM requests WHERE id = ?")
        .get(requestId)
    );

    return this.mapRequestRow(raw);
  }

  public getGuildModelConfig(guildId: string): GuildModelConfigRow | undefined {
    return guildModelConfigRowSchema.optional().parse(
      this.db
        .prepare("SELECT * FROM guild_model_config WHERE guild_id = ?")
        .get(guildId)
    );
  }

  public setGuildModelConfig(guildId: string, provider: AiProvider, model: string | null, updatedByUserId: string): GuildModelConfigRow {
    return guildModelConfigRowSchema.parse(
      this.db
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
        .get(guildId, provider, model, updatedByUserId)
    );
  }

  public setGuildRoleModelConfig(
    guildId: string,
    role: Exclude<ModelRole, "default">,
    provider: AiProvider,
    model: string | null,
    updatedByUserId: string
  ): GuildModelConfigRow {
    const providerColumn = role === "planner" ? "planner_provider" : "implementer_provider";
    const modelColumn = role === "planner" ? "planner_model" : "implementer_model";

    return guildModelConfigRowSchema.parse(
      this.db
        .prepare(
          `INSERT INTO guild_model_config (
             guild_id,
             provider,
             model,
             ${providerColumn},
             ${modelColumn},
             updated_by_user_id
           )
           VALUES (?, 'claude', NULL, ?, ?, ?)
           ON CONFLICT(guild_id) DO UPDATE
           SET ${providerColumn} = excluded.${providerColumn},
               ${modelColumn} = excluded.${modelColumn},
               updated_by_user_id = excluded.updated_by_user_id,
               updated_at = CURRENT_TIMESTAMP
           RETURNING *`
        )
        .get(guildId, provider, model, updatedByUserId)
    );
  }

  public getGuildReviewConfig(guildId: string): GuildReviewConfigRow | undefined {
    const raw = guildReviewConfigRowRawSchema.optional().parse(
      this.db
        .prepare("SELECT * FROM guild_review_config WHERE guild_id = ?")
        .get(guildId)
    );

    if (!raw) {
      return undefined;
    }

    return {
      ...raw,
      rounds: toNumber(raw.rounds)
    };
  }

  public setGuildReviewConfig(
    guildId: string,
    rounds: number,
    updatedByUserId: string,
    options?: {
      analyzerProvider?: AiProvider | null;
      analyzerModel?: string | null;
      judgeProvider?: AiProvider | null;
      judgeModel?: string | null;
      summarizerProvider?: AiProvider | null;
      summarizerModel?: string | null;
    }
  ): GuildReviewConfigRow {
    const overrideSpec: Array<{ key: string; col: string }> = [
      { key: "analyzerProvider", col: "analyzer_provider" },
      { key: "analyzerModel", col: "analyzer_model" },
      { key: "judgeProvider", col: "judge_provider" },
      { key: "judgeModel", col: "judge_model" },
      { key: "summarizerProvider", col: "summarizer_provider" },
      { key: "summarizerModel", col: "summarizer_model" },
    ];

    const valueColumns: string[] = ["guild_id", "rounds", "updated_by_user_id"];
    const params: unknown[] = [guildId, rounds, updatedByUserId];
    const setClauses: string[] = [
      "rounds = excluded.rounds",
      "updated_by_user_id = excluded.updated_by_user_id",
    ];

    if (options) {
      const opts = options as Record<string, unknown>;
      for (const { key, col } of overrideSpec) {
        if (key in opts) {
          valueColumns.push(col);
          params.push(opts[key] === undefined ? null : opts[key]);
          setClauses.push(`${col} = excluded.${col}`);
        }
      }
    }

    const sql = `INSERT INTO guild_review_config (${valueColumns.join(", ")})
                 VALUES (${valueColumns.map(() => "?").join(", ")})
                 ON CONFLICT(guild_id) DO UPDATE
                 SET ${setClauses.join(", ")},
                     updated_at = CURRENT_TIMESTAMP
                 RETURNING *`;

    const raw = guildReviewConfigRowRawSchema.parse(
      (this.db.prepare(sql).get as (...args: unknown[]) => unknown)(...params)
    );

    return {
      ...raw,
      rounds: toNumber(raw.rounds)
    };
  }

  public getReviewerSlots(guildId: string): ReviewerSlotRow[] {
    return z.array(reviewerSlotRowRawSchema).parse(
      this.db
        .prepare("SELECT * FROM guild_reviewer_slots WHERE guild_id = ? ORDER BY slot_index")
        .all(guildId)
    ).map((slot) => ({
      ...slot,
      slot_index: toNumber(slot.slot_index)
    }));
  }

  public setReviewerSlots(guildId: string, slots: Array<{ slot_index: number; provider: AiProvider; model: string | null }>, updatedByUserId: string): ReviewerSlotRow[] {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM guild_reviewer_slots WHERE guild_id = ?").run(guildId);
      for (const slot of slots) {
        this.db
          .prepare(
            "INSERT INTO guild_reviewer_slots (guild_id, slot_index, provider, model, updated_by_user_id) VALUES (?, ?, ?, ?, ?)"
          )
          .run(guildId, slot.slot_index, slot.provider, slot.model, updatedByUserId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getReviewerSlots(guildId);
  }

  public setReviewerSlot(
    guildId: string,
    slotIndex: number,
    provider: AiProvider,
    model: string | null,
    updatedByUserId: string
  ): ReviewerSlotRow {
    const raw = reviewerSlotRowRawSchema.parse(
      this.db
        .prepare(
          `INSERT INTO guild_reviewer_slots (guild_id, slot_index, provider, model, updated_by_user_id)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(guild_id, slot_index) DO UPDATE
           SET provider = excluded.provider,
               model = excluded.model,
               updated_by_user_id = excluded.updated_by_user_id,
               updated_at = CURRENT_TIMESTAMP
           RETURNING *`
        )
        .get(guildId, slotIndex, provider, model, updatedByUserId)
    );
    return {
      ...raw,
      slot_index: toNumber(raw.slot_index)
    };
  }

  public clearReviewerSlot(guildId: string, slotIndex: number): void {
    this.db
      .prepare("DELETE FROM guild_reviewer_slots WHERE guild_id = ? AND slot_index = ?")
      .run(guildId, slotIndex);
  }

  public setGuildReviewRoleConfig(
    guildId: string,
    role: ReviewModelRole,
    provider: AiProvider | null,
    model: string | null,
    updatedByUserId: string
  ): GuildReviewConfigRow {
    const providerColumn = `${role}_provider` as const;
    const modelColumn = `${role}_model` as const;

    const raw = guildReviewConfigRowRawSchema.parse(
      this.db
        .prepare(
          `INSERT INTO guild_review_config (
             guild_id, rounds,
             ${providerColumn},
             ${modelColumn},
             updated_by_user_id
           )
           VALUES (?, 2, ?, ?, ?)
           ON CONFLICT(guild_id) DO UPDATE
           SET ${providerColumn} = excluded.${providerColumn},
               ${modelColumn} = excluded.${modelColumn},
               updated_by_user_id = excluded.updated_by_user_id,
               updated_at = CURRENT_TIMESTAMP
           RETURNING *`
        )
        .get(guildId, provider, model, updatedByUserId)
    );

    return {
      ...raw,
      rounds: toNumber(raw.rounds)
    };
  }

  public clearGuildReviewRoleConfig(
    guildId: string,
    role: ReviewModelRole,
    updatedByUserId: string
  ): void {
    const providerColumn = `${role}_provider` as const;
    const modelColumn = `${role}_model` as const;

    this.db
      .prepare(
        `UPDATE guild_review_config
         SET ${providerColumn} = NULL,
             ${modelColumn} = NULL,
             updated_by_user_id = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE guild_id = ?`
      )
      .run(updatedByUserId, guildId);
  }

  public clearGuildModelConfigReviewRole(
    guildId: string,
    role: ReviewModelRole,
    updatedByUserId: string
  ): void {
    const providerColumn = `${role}_provider` as const;
    const modelColumn = `${role}_model` as const;

    this.db
      .prepare(
        `UPDATE guild_model_config
         SET ${providerColumn} = NULL,
             ${modelColumn} = NULL,
             updated_by_user_id = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE guild_id = ?`
      )
      .run(updatedByUserId, guildId);
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
    const rows = z.array(modelHistoryRowSchema).parse(
      this.db
        .prepare("SELECT model FROM model_history WHERE provider = ? ORDER BY used_at DESC LIMIT 3")
        .all(provider)
    );
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
    const raw = reviewRunRowRawSchema.parse(
      this.db
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
        )
    );

    return this.mapReviewRunRow(raw)!;
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
    const raw = reviewRunRowRawSchema.optional().parse(
      this.db
        .prepare("SELECT * FROM review_runs WHERE request_id = ? ORDER BY id DESC LIMIT 1")
        .get(requestId)
    );

    return this.mapReviewRunRow(raw);
  }

  public getLatestCompletedReviewRunForBranch(requestId: number, branchName: string): ReviewRunRow | undefined {
    const row = reviewRunRowRawSchema.optional().parse(
      this.db
        .prepare(
          `SELECT * FROM review_runs
           WHERE request_id = ? AND branch_name = ? AND status = 'completed'
           ORDER BY id DESC
           LIMIT 1`
        )
        .get(requestId, branchName)
    );

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
    const raw = installRequestRowRawSchema.parse(
      this.db
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
        )
    );

    return this.mapInstallRequestRow(raw)!;
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
             bin_path = COALESCE(?, bin_path),
             env_json = COALESCE(?, env_json),
             logs = COALESCE(?, logs),
             error_message = COALESCE(?, error_message),
             completed_at = COALESCE(?, completed_at),
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
    const raw = installRequestRowRawSchema.optional().parse(
      this.db
        .prepare("SELECT * FROM install_requests WHERE id = ?")
        .get(installRequestId)
    );

    return this.mapInstallRequestRow(raw);
  }

  public getActiveInstallRequestByRoot(installRoot: string): InstallRequestRow | undefined {
    const raw = installRequestRowRawSchema.optional().parse(
      this.db
        .prepare(
          `SELECT *
           FROM install_requests
           WHERE install_root = ?
             AND status IN ('approved', 'running')
           ORDER BY id DESC
           LIMIT 1`
        )
        .get(installRoot)
    );

    return this.mapInstallRequestRow(raw);
  }

  public listSuccessfulInstallRequestsForScope(input: {
    repoId: number;
    threadId?: string | null;
  }): InstallRequestRow[] {
    const rows = z.array(installRequestRowRawSchema).parse(
      this.db
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
        .all(input.repoId, input.threadId ?? null)
    );

    return rows
      .map((row) => this.mapInstallRequestRow(row))
      .filter((row): row is InstallRequestRow => Boolean(row));
  }

  public listSuccessfulInstallRequestsByPackage(input: {
    repoId: number;
    threadId?: string | null;
    packageId: string;
    scope: InstallScope;
  }): InstallRequestRow[] {
    const rows = z.array(installRequestRowRawSchema).parse(
      this.db
        .prepare(
          `SELECT *
           FROM install_requests
           WHERE status = 'succeeded'
             AND repo_id = ?
             AND package_id = ?
             AND scope = ?
             AND (
               scope = 'repo'
               OR thread_id = ?
             )
           ORDER BY id DESC`
        )
        .all(input.repoId, input.packageId, input.scope, input.threadId ?? null)
    );

    return rows
      .map((row) => this.mapInstallRequestRow(row))
      .filter((row): row is InstallRequestRow => Boolean(row));
  }

  public close(): void {
    this.db.close();
  }
}
