import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/db/database.js";

function createInMemoryDb(): AppDatabase {
  const db = new AppDatabase(":memory:");
  db.runMigrations();
  return db;
}

describe("AppDatabase request workspace state", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createInMemoryDb();
    db.upsertGuild("guild-1", "Test Guild");
    db.createRepo({
      guildId: "guild-1",
      owner: "octocat",
      repo: "hello-world",
      fullName: "octocat/hello-world",
      visibility: "private",
      channelId: "channel-1",
      linkedByUserId: "user-1"
    });
  });

  it("stores and retrieves branch_name for the latest thread request", () => {
    const first = db.createRequest({
      guildId: "guild-1",
      repoId: 1,
      channelId: "channel-1",
      threadId: "thread-1",
      userId: "user-1",
      prompt: "first",
      status: "succeeded"
    });
    db.updateRequestWorkspace(first.id, "/tmp/worktree-1", "ask/1-123");

    const second = db.createRequest({
      guildId: "guild-1",
      repoId: 1,
      channelId: "channel-1",
      threadId: "thread-1",
      userId: "user-1",
      prompt: "follow-up",
      status: "queued"
    });
    db.updateRequestWorkspace(second.id, "/tmp/worktree-1", "ask/1-123");

    expect(db.getRequestByThreadId("thread-1")).toMatchObject({
      id: second.id,
      worktree_path: "/tmp/worktree-1",
      branch_name: "ask/1-123"
    });
  });

  it("round-trips revision_of_request_id through request APIs", () => {
    const source = db.createRequest({
      guildId: "guild-1",
      repoId: 1,
      channelId: "channel-1",
      threadId: "thread-revise",
      userId: "user-1",
      prompt: "source",
      status: "succeeded"
    });
    db.updateRequestWorkspace(source.id, "/tmp/worktree-revise", "ask/41-123");

    const revision = db.createRequest({
      guildId: "guild-1",
      repoId: 1,
      channelId: "channel-1",
      threadId: "thread-revise",
      userId: "user-1",
      prompt: "source",
      status: "queued",
      revisionOfRequestId: source.id
    });
    db.updateRequestWorkspace(revision.id, "/tmp/worktree-revise", "ask/41-123");

    expect(revision.revision_of_request_id).toBe(source.id);
    expect(db.getRequestById(revision.id)).toMatchObject({
      id: revision.id,
      revision_of_request_id: source.id
    });
    expect(db.getRequestByThreadId("thread-revise")).toMatchObject({
      id: revision.id,
      revision_of_request_id: source.id
    });
    expect(db.getLatestRequestWithWorkspaceByThreadId("thread-revise")).toMatchObject({
      id: revision.id,
      revision_of_request_id: source.id
    });
  });

  it("retrieves the latest request that still has workspace state", () => {
    const first = db.createRequest({
      guildId: "guild-1",
      repoId: 1,
      channelId: "channel-1",
      threadId: "thread-workspace",
      userId: "user-1",
      prompt: "first",
      status: "succeeded"
    });
    db.updateRequestWorkspace(first.id, "/tmp/worktree-keep", "ask/keep-123");

    db.createRequest({
      guildId: "guild-1",
      repoId: 1,
      channelId: "channel-1",
      threadId: "thread-workspace",
      userId: "user-1",
      prompt: "queued follow-up",
      status: "queued"
    });

    expect(db.getLatestRequestWithWorkspaceByThreadId("thread-workspace")).toMatchObject({
      id: first.id,
      worktree_path: "/tmp/worktree-keep",
      branch_name: "ask/keep-123"
    });
  });

  it("clears stored workspace state when requested", () => {
    const request = db.createRequest({
      guildId: "guild-1",
      repoId: 1,
      channelId: "channel-1",
      threadId: "thread-2",
      userId: "user-1",
      prompt: "cleanup",
      status: "failed"
    });
    db.updateRequestWorkspace(request.id, "/tmp/worktree-2", "ask/2-123");
    db.updateRequestWorkspace(request.id, null, null);

    expect(db.getRequestByThreadId("thread-2")).toMatchObject({
      worktree_path: null,
      branch_name: null
    });
  });

  it("persists completed review runs with reviewed sha", () => {
    const request = db.createRequest({
      guildId: "guild-1",
      repoId: 1,
      channelId: "channel-1",
      threadId: "thread-review",
      userId: "user-1",
      prompt: "review target",
      status: "succeeded"
    });
    db.updateRequestWorkspace(request.id, "/tmp/worktree-review", "ask/99-123");

    const reviewRun = db.createReviewRun({
      requestId: request.id,
      threadId: request.thread_id,
      branchName: "ask/99-123",
      status: "running",
      configJson: "{\"reviewers\":2}",
      diffBase: "origin/main",
      diffHead: "abc123def"
    });

    db.completeReviewRun({
      reviewRunId: reviewRun.id,
      status: "completed",
      finalVerdict: "revise",
      summaryMarkdown: "# Review",
      rawResultJson: "{\"ok\":true}",
      artifactPath: "docs/reviews/1/review.md"
    });

    expect(db.getLatestReviewRunForRequest(request.id)).toMatchObject({
      id: reviewRun.id,
      request_id: request.id,
      branch_name: "ask/99-123",
      status: "completed",
      diff_base: "origin/main",
      diff_head: "abc123def",
      final_verdict: "revise",
      artifact_path: "docs/reviews/1/review.md"
    });
  });

  it("retrieves latest completed review run for a branch", () => {
    const request = db.createRequest({
      guildId: "guild-1",
      repoId: 1,
      channelId: "channel-1",
      threadId: "thread-pr",
      userId: "user-1",
      prompt: "review target",
      status: "succeeded"
    });

    const older = db.createReviewRun({
      requestId: request.id,
      threadId: request.thread_id,
      branchName: "ask/1-123",
      status: "running",
      configJson: "{}",
      diffBase: "origin/main",
      diffHead: "oldsha"
    });
    db.completeReviewRun({
      reviewRunId: older.id,
      status: "completed",
      finalVerdict: "revise",
      summaryMarkdown: null,
      rawResultJson: null,
      artifactPath: null
    });

    db.createReviewRun({
      requestId: request.id,
      threadId: request.thread_id,
      branchName: "ask/1-123",
      status: "running",
      configJson: "{}",
      diffBase: "origin/main",
      diffHead: "pendingsha"
    });

    const newer = db.createReviewRun({
      requestId: request.id,
      threadId: request.thread_id,
      branchName: "ask/1-123",
      status: "running",
      configJson: "{}",
      diffBase: "origin/main",
      diffHead: "newsha"
    });
    db.completeReviewRun({
      reviewRunId: newer.id,
      status: "completed",
      finalVerdict: "ready_for_pr",
      summaryMarkdown: null,
      rawResultJson: null,
      artifactPath: null
    });

    expect(db.getLatestCompletedReviewRunForBranch(request.id, "ask/1-123")).toMatchObject({
      id: newer.id,
      diff_head: "newsha",
      final_verdict: "ready_for_pr"
    });
  });

  it("persists install requests and resolves scoped successful installs", () => {
    const request = db.createRequest({
      guildId: "guild-1",
      repoId: 1,
      channelId: "channel-1",
      threadId: "thread-install",
      userId: "user-1",
      prompt: "install tool",
      status: "queued"
    });
    db.updateRequestWorkspace(request.id, "/tmp/worktree-install", "ask/71-123");

    const repoInstall = db.createInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      packageId: "npm-prettier",
      packageVersion: "3",
      scope: "repo",
      status: "approved",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1",
      installRoot: "/data/tool-installs/repo/1/npm-prettier"
    });
    db.updateInstallRequest({
      installRequestId: repoInstall.id,
      status: "succeeded",
      binPath: "/data/tool-installs/repo/1/npm-prettier/bin",
      envJson: "{}",
      logs: "ok",
      completedAt: "2026-03-31T00:00:00.000Z"
    });

    const requestInstall = db.createInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      requestId: request.id,
      threadId: "thread-install",
      packageId: "rustup-default-stable",
      packageVersion: "stable",
      scope: "request",
      status: "approved",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1",
      installRoot: "/data/tool-installs/request/thread-install/rustup-default-stable"
    });
    db.updateInstallRequest({
      installRequestId: requestInstall.id,
      status: "succeeded",
      binPath: "/data/tool-installs/request/thread-install/rustup-default-stable/bin",
      envJson: "{\"RUSTUP_TOOLCHAIN\":\"stable\"}",
      logs: "ok",
      completedAt: "2026-03-31T00:00:00.000Z"
    });

    expect(db.getInstallRequestById(requestInstall.id)).toMatchObject({
      request_id: request.id,
      thread_id: "thread-install",
      package_id: "rustup-default-stable",
      status: "succeeded"
    });

    expect(db.listSuccessfulInstallRequestsForScope({ repoId: 1, threadId: "thread-install" })).toMatchObject([
      expect.objectContaining({ id: repoInstall.id, scope: "repo", package_id: "npm-prettier" }),
      expect.objectContaining({ id: requestInstall.id, scope: "request", package_id: "rustup-default-stable" })
    ]);
  });

  it("preserves nullable install request fields on partial updates", () => {
    const install = db.createInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      packageId: "npm-prettier",
      packageVersion: "3",
      scope: "repo",
      status: "approved",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1",
      installRoot: "/data/tool-installs/repo/1/npm-prettier"
    });

    db.updateInstallRequest({
      installRequestId: install.id,
      status: "succeeded",
      binPath: "/data/tool-installs/repo/1/npm-prettier/bin",
      envJson: "{}",
      logs: "install ok",
      errorMessage: "old error",
      completedAt: "2026-03-31T00:00:00.000Z"
    });
    db.updateInstallRequest({
      installRequestId: install.id,
      status: "failed"
    });

    expect(db.getInstallRequestById(install.id)).toMatchObject({
      status: "failed",
      bin_path: "/data/tool-installs/repo/1/npm-prettier/bin",
      env_json: "{}",
      logs: "install ok",
      error_message: "old error",
      completed_at: "2026-03-31T00:00:00.000Z"
    });
  });
});

describe("AppDatabase migration from legacy reviewer_slots", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "actuarius-migration-test-"));
  });

  it("preserves data when upgrading from old reviewer_slots schema", () => {
    const dbPath = join(tmpDir, "test-migrate.db");

    // Seed a database with the legacy reviewer_slots table
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec("PRAGMA journal_mode = WAL");
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS guilds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    legacyDb.exec("INSERT OR IGNORE INTO guilds (id, name) VALUES ('guild-1', 'Test Guild')");

    // Create the legacy reviewer_slots table (real production schema before migration
    // — only guild_id, slot_index, provider, model with composite PK)
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS reviewer_slots (
        guild_id TEXT NOT NULL,
        slot_index INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        PRIMARY KEY (guild_id, slot_index)
      )
    `);

    legacyDb
      .prepare("INSERT INTO reviewer_slots (guild_id, slot_index, provider, model) VALUES (?, ?, ?, ?)")
      .run("guild-1", 0, "claude", "claude-sonnet-4-20250514");
    legacyDb
      .prepare("INSERT INTO reviewer_slots (guild_id, slot_index, provider, model) VALUES (?, ?, ?, ?)")
      .run("guild-1", 1, "gemini", "gemini-2.5-pro");
    legacyDb.close();

    // Open with AppDatabase — triggers runMigrations
    const db = new AppDatabase(dbPath);
    db.runMigrations();
    db.upsertGuild("guild-1", "Test Guild");

    const slots = db.getReviewerSlots("guild-1");
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({
      guild_id: "guild-1",
      slot_index: 1,
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      updated_by_user_id: "system-migration"
    });
    expect(slots[1]).toMatchObject({
      guild_id: "guild-1",
      slot_index: 2,
      provider: "gemini",
      model: "gemini-2.5-pro",
      updated_by_user_id: "system-migration"
    });

    // Confirm old table is gone
    const checkDb = new DatabaseSync(dbPath);
    const row = checkDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reviewer_slots'")
      .get();
    expect(row).toBeUndefined();
    checkDb.close();

    db.close();
  });

  it("survives a second runMigrations call without data loss", () => {
    const dbPath = join(tmpDir, "test-twice.db");

    // Seed legacy schema
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec("PRAGMA journal_mode = WAL");
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS guilds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    legacyDb.exec("INSERT OR IGNORE INTO guilds (id, name) VALUES ('guild-1', 'Test Guild')");
    legacyDb.exec(`
      CREATE TABLE IF NOT EXISTS reviewer_slots (
        guild_id TEXT NOT NULL,
        slot_index INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        PRIMARY KEY (guild_id, slot_index)
      )
    `);
    legacyDb
      .prepare("INSERT INTO reviewer_slots (guild_id, slot_index, provider, model) VALUES (?, ?, ?, ?)")
      .run("guild-1", 0, "claude", "claude-sonnet-4-20250514");
    legacyDb.close();

    const db = new AppDatabase(dbPath);
    db.runMigrations();
    db.upsertGuild("guild-1", "Test Guild");
    expect(db.getReviewerSlots("guild-1")).toHaveLength(1);

    // Run migrations again — should be idempotent
    db.runMigrations();

    const slots = db.getReviewerSlots("guild-1");
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      guild_id: "guild-1",
      slot_index: 1,
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      updated_by_user_id: "system-migration"
    });

    db.close();
  });

  it("does not require the legacy table", () => {
    const db = new AppDatabase(":memory:");
    db.runMigrations();
    db.upsertGuild("guild-1", "Test Guild");
    expect(db.getReviewerSlots("guild-1")).toEqual([]);
  });
});

describe("AppDatabase startup reconciliation of interrupted work", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createInMemoryDb();
    db.upsertGuild("guild-1", "Test Guild");
    db.createRepo({
      guildId: "guild-1",
      owner: "octocat",
      repo: "hello-world",
      fullName: "octocat/hello-world",
      visibility: "private",
      channelId: "channel-1",
      linkedByUserId: "user-1"
    });
  });

  function createRequestWithStatus(threadId: string, status: "queued" | "running" | "succeeded" | "failed" | "install_approved" | "install_running") {
    return db.createRequest({
      guildId: "guild-1",
      repoId: 1,
      channelId: "channel-1",
      threadId,
      userId: "user-1",
      prompt: "prompt",
      status
    });
  }

  it("fails requests left in an active status and leaves terminal ones alone", () => {
    const queued = createRequestWithStatus("thread-queued", "queued");
    const running = createRequestWithStatus("thread-running", "running");
    const installApproved = createRequestWithStatus("thread-install-approved", "install_approved");
    const installRunning = createRequestWithStatus("thread-install-running", "install_running");
    const succeeded = createRequestWithStatus("thread-succeeded", "succeeded");
    const failed = createRequestWithStatus("thread-failed", "failed");

    const result = db.failInterruptedWork();

    expect(result.requests).toBe(4);
    expect(db.getRequestByThreadId("thread-queued")?.status).toBe("failed");
    expect(db.getRequestByThreadId("thread-running")?.status).toBe("failed");
    expect(db.getRequestByThreadId("thread-install-approved")?.status).toBe("failed");
    expect(db.getRequestByThreadId("thread-install-running")?.status).toBe("failed");
    expect(db.getRequestByThreadId("thread-succeeded")?.status).toBe("succeeded");
    expect(db.getRequestByThreadId("thread-failed")?.status).toBe("failed");
    expect([queued.id, running.id, installApproved.id, installRunning.id, succeeded.id, failed.id]).toHaveLength(6);
  });

  it("fails active install requests so the install root is released", () => {
    db.createInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      packageId: "pkg",
      packageVersion: "1.0.0",
      scope: "repo",
      status: "approved",
      requestedByUserId: "user-1",
      installRoot: "/data/installs/repo-1"
    });

    expect(db.getActiveInstallRequestByRoot("/data/installs/repo-1")).toBeDefined();

    const result = db.failInterruptedWork();

    expect(result.installRequests).toBe(1);
    expect(db.getActiveInstallRequestByRoot("/data/installs/repo-1")).toBeUndefined();
  });

  it("reports zero changes when there is nothing to reconcile", () => {
    createRequestWithStatus("thread-done", "succeeded");

    expect(db.failInterruptedWork()).toEqual({ requests: 0, installRequests: 0 });
  });
});
