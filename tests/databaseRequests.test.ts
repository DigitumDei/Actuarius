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
});
