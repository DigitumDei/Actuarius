import { beforeEach, describe, expect, it } from "vitest";
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
