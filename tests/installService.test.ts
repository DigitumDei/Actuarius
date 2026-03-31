import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { AppDatabase } from "../src/db/database.js";
import { InstallService } from "../src/services/installService.js";

vi.mock("../src/utils/spawnCollect.js");

const { spawnCollect } = await import("../src/utils/spawnCollect.js");
const mockSpawnCollect = vi.mocked(spawnCollect);

function createInMemoryDb(): AppDatabase {
  const db = new AppDatabase(":memory:");
  db.runMigrations();
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
  return db;
}

describe("InstallService", () => {
  let db: AppDatabase;
  let service: InstallService;

  beforeEach(() => {
    vi.resetAllMocks();
    db = createInMemoryDb();
    service = new InstallService(
      {
        discordToken: "token",
        discordClientId: "client",
        discordGuildId: undefined,
        ghToken: undefined,
        githubAppId: undefined,
        githubAppPrivateKey: undefined,
        githubAppPrivateKeyB64: undefined,
        githubAppInstallationId: undefined,
        gitUserName: undefined,
        gitUserEmail: undefined,
        geminiApiKey: undefined,
        databasePath: ":memory:",
        reposRootPath: "/data/repos",
        installsRootPath: "/data/tool-installs",
        githubCliConfigPath: "/data/.gh",
        logLevel: "info",
        threadAutoArchiveMinutes: 1440,
        askConcurrencyPerGuild: 1,
        askExecutionTimeoutMs: 1000,
        enableCodexExecution: false,
        enableGeminiExecution: false
      },
      pino({ level: "silent" }),
      db
    );
  });

  it("creates approved install requests in scoped directories", () => {
    const request = db.createRequest({
      guildId: "guild-1",
      repoId: 1,
      channelId: "channel-1",
      threadId: "thread-1",
      userId: "user-1",
      prompt: "install rust",
      status: "queued"
    });

    const install = service.createApprovedInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      threadId: "thread-1",
      requestId: request.id,
      packageId: "rustup-default-stable",
      scope: "request",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1"
    });

    expect(install).toMatchObject({
      package_id: "rustup-default-stable",
      package_version: "stable",
      scope: "request",
      status: "approved",
      install_root: "/data/tool-installs/request/thread-1/rustup-default-stable"
    });
    expect(db.getRequestByThreadId("thread-1")?.status).toBe("install_approved");
  });

  it("builds execution env from repo and request scoped successful installs", () => {
    const request = db.createRequest({
      guildId: "guild-1",
      repoId: 1,
      channelId: "channel-1",
      threadId: "thread-1",
      userId: "user-1",
      prompt: "install rust",
      status: "queued"
    });

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
      completedAt: "2026-03-31T00:00:00.000Z"
    });

    const requestInstall = db.createInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      requestId: request.id,
      threadId: "thread-1",
      packageId: "rustup-default-stable",
      packageVersion: "stable",
      scope: "request",
      status: "approved",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1",
      installRoot: "/data/tool-installs/request/thread-1/rustup-default-stable"
    });
    db.updateInstallRequest({
      installRequestId: requestInstall.id,
      status: "succeeded",
      binPath: "/data/tool-installs/request/thread-1/rustup-default-stable/bin",
      envJson: "{\"RUSTUP_TOOLCHAIN\":\"stable\"}",
      completedAt: "2026-03-31T00:00:00.000Z"
    });

    const execution = service.buildExecutionEnvironment({ repoId: 1, threadId: "thread-1" });
    expect(execution.packages).toEqual(["npm-prettier", "rustup-default-stable"]);
    expect(execution.pathEntries).toEqual([
      "/data/tool-installs/repo/1/npm-prettier/bin",
      "/data/tool-installs/request/thread-1/rustup-default-stable/bin"
    ]);
    expect(execution.env.RUSTUP_TOOLCHAIN).toBe("stable");
    expect(execution.env.PATH).toContain("/data/tool-installs/repo/1/npm-prettier/bin");
    expect(execution.env.PATH).toContain("/data/tool-installs/request/thread-1/rustup-default-stable/bin");
  });

  it("updates request lifecycle states while running a request-scoped install", async () => {
    const request = db.createRequest({
      guildId: "guild-1",
      repoId: 1,
      channelId: "channel-1",
      threadId: "thread-run",
      userId: "user-1",
      prompt: "install prettier",
      status: "queued"
    });

    const install = service.createApprovedInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      threadId: "thread-run",
      requestId: request.id,
      packageId: "npm-prettier",
      scope: "request",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1"
    });

    mockSpawnCollect.mockResolvedValue({ stdout: "ok", stderr: "" });

    await service.runInstall(install.id);

    expect(db.getRequestByThreadId("thread-run")?.status).toBe("install_succeeded");
    expect(mockSpawnCollect).toHaveBeenCalledWith(
      expect.stringContaining("/data/tool-installs/request/thread-run/npm-prettier/bin/prettier"),
      ["--version"],
      expect.any(Object)
    );
  });

  it("marks the install as failed when the install step process rejects", async () => {
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

    mockSpawnCollect.mockRejectedValueOnce(new Error("npm exploded"));

    await expect(service.runInstall(install.id)).rejects.toMatchObject({
      code: "INSTALL_FAILED",
      message: expect.stringContaining("npm exploded")
    });
    expect(db.getInstallRequestById(install.id)).toMatchObject({
      status: "failed",
      error_message: expect.stringContaining("npm exploded")
    });
  });

  it("wraps wrapper verification failures with VERIFY_FAILED and records the failure", async () => {
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

    mockSpawnCollect
      .mockResolvedValueOnce({ stdout: "installed", stderr: "" })
      .mockRejectedValueOnce(new Error("wrapper verify exploded"));

    await expect(service.runInstall(install.id)).rejects.toMatchObject({
      code: "VERIFY_FAILED",
      message: expect.stringContaining("wrapper verify exploded")
    });
    expect(db.getInstallRequestById(install.id)).toMatchObject({
      status: "failed",
      error_message: expect.stringContaining("wrapper verify exploded")
    });
  });

  it("rejects unknown packages before creating an install request", () => {
    expect(() =>
      service.createApprovedInstallRequest({
        guildId: "guild-1",
        repoId: 1,
        packageId: "unknown-tool",
        scope: "repo",
        requestedByUserId: "user-1",
        approvedByUserId: "admin-1"
      })
    ).toThrowError(expect.objectContaining({ code: "UNKNOWN_PACKAGE" }));
  });

  it("rejects request-scoped installs without a thread id", () => {
    expect(() =>
      service.createApprovedInstallRequest({
        guildId: "guild-1",
        repoId: 1,
        packageId: "npm-prettier",
        scope: "request",
        requestedByUserId: "user-1",
        approvedByUserId: "admin-1"
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_SCOPE" }));
  });
});
