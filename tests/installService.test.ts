import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { AppDatabase } from "../src/db/database.js";
import { InstallService } from "../src/services/installService.js";
import { buildRustupInitDownloadUrl } from "../src/services/installerRegistry.js";

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
  let reposRootPath: string;
  let repoCheckoutPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    db = createInMemoryDb();
    reposRootPath = mkdtempSync(join(tmpdir(), "actuarius-install-repos-"));
    repoCheckoutPath = join(reposRootPath, "octocat", "hello-world");
    mkdirSync(repoCheckoutPath, { recursive: true });
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
        reposRootPath,
        installsRootPath: "/data/tool-installs",
        githubCliConfigPath: "/data/.gh",
        logLevel: "info",
        threadAutoArchiveMinutes: 1440,
        askConcurrencyPerGuild: 1,
        askExecutionTimeoutMs: 1000,
        installStepTimeoutMs: 1000,
        aptInstallHelperPath: undefined,
        enableCodexExecution: false,
        enableGeminiExecution: false
      },
      pino({ level: "silent" }),
      db
    );
  });

  function writeRepoFile(relativePath: string, content: string): void {
    const filePath = join(repoCheckoutPath, relativePath);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  }

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
    db.updateRequestWorkspace(request.id, "/tmp/worktree-thread-1", "ask/1-123");

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
    db.updateRequestWorkspace(request.id, "/tmp/worktree-thread-run", "ask/2-123");

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

  it("bootstraps rustup inside the scoped install root instead of requiring a system rustup", async () => {
    const install = db.createInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      packageId: "rustup-default-stable",
      packageVersion: "stable",
      scope: "repo",
      status: "approved",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1",
      installRoot: "/data/tool-installs/repo/1/rustup-default-stable"
    });

    mockSpawnCollect.mockResolvedValue({ stdout: "ok", stderr: "" });

    await service.runInstall(install.id);

    expect(mockSpawnCollect).toHaveBeenCalledWith(
      "python3",
      expect.arrayContaining([
        "-c",
        buildRustupInitDownloadUrl(),
        "/data/tool-installs/repo/1/rustup-default-stable/downloads/rustup-init",
        "755"
      ]),
      expect.objectContaining({
        env: expect.objectContaining({
          CARGO_HOME: "/data/tool-installs/repo/1/rustup-default-stable/cargo",
          RUSTUP_HOME: "/data/tool-installs/repo/1/rustup-default-stable/rustup",
          RUSTUP_TOOLCHAIN: "stable"
        })
      })
    );
    expect(mockSpawnCollect).toHaveBeenCalledWith(
      "/data/tool-installs/repo/1/rustup-default-stable/downloads/rustup-init",
      ["-y", "--profile", "minimal", "--default-toolchain", "stable", "--no-modify-path"],
      expect.objectContaining({
        env: expect.objectContaining({
          CARGO_HOME: "/data/tool-installs/repo/1/rustup-default-stable/cargo",
          RUSTUP_HOME: "/data/tool-installs/repo/1/rustup-default-stable/rustup",
          RUSTUP_TOOLCHAIN: "stable"
        })
      })
    );
  });

  it("builds the rustup-init download URL for supported Linux host architectures", () => {
    expect(buildRustupInitDownloadUrl("x64")).toBe(
      "https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init"
    );
    expect(buildRustupInitDownloadUrl("arm64")).toBe(
      "https://static.rust-lang.org/rustup/dist/aarch64-unknown-linux-gnu/rustup-init"
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

  it("accepts apt package requests and stores them in a shared system install root", () => {
    const install = service.createApprovedInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      packageId: "apt:libssl-dev",
      scope: "repo",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1"
    });

    expect(install).toMatchObject({
      package_id: "apt:libssl-dev",
      package_version: "libssl-dev",
      scope: "repo",
      status: "approved",
      install_root: expect.stringContaining("/data/tool-installs/system/apt-")
    });
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

  it("rejects creating a second active install for the same target root", () => {
    service.createApprovedInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      packageId: "npm-prettier",
      scope: "repo",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1"
    });

    expect(() =>
      service.createApprovedInstallRequest({
        guildId: "guild-1",
        repoId: 1,
        packageId: "npm-prettier",
        scope: "repo",
        requestedByUserId: "user-2",
        approvedByUserId: "admin-2"
      })
    ).toThrowError(
      expect.objectContaining({
        code: "INSTALL_ALREADY_ACTIVE",
        message: expect.stringContaining("already installing")
      })
    );
  });

  it("resolves java-temurin from .tool-versions before .java-version", () => {
    writeRepoFile(".tool-versions", "java temurin-21.0.3+9\n");
    writeRepoFile(".java-version", "17\n");

    const install = service.createApprovedInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      packageId: "java-temurin",
      scope: "repo",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1"
    });

    expect(install.package_version).toBe("21.0.3+9");
  });

  it("resolves gradle from wrapper metadata when .tool-versions is absent", () => {
    writeRepoFile(
      "gradle/wrapper/gradle-wrapper.properties",
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10-bin.zip\n"
    );

    const install = service.createApprovedInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      packageId: "gradle",
      scope: "repo",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1"
    });

    expect(install.package_version).toBe("8.10");
  });

  it("resolves request-scoped Kotlin installs from the tracked worktree", () => {
    const request = db.createRequest({
      guildId: "guild-1",
      repoId: 1,
      channelId: "channel-1",
      threadId: "thread-kotlin",
      userId: "user-1",
      prompt: "install kotlin",
      status: "queued"
    });
    const worktreePath = mkdtempSync(join(tmpdir(), "actuarius-install-worktree-"));
    writeFileSync(join(worktreePath, "gradle.properties"), "actuarius.kotlin.version=2.1.21\n", "utf8");
    db.updateRequestWorkspace(request.id, worktreePath, "ask/1-123");

    const install = service.createApprovedInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      requestId: request.id,
      threadId: "thread-kotlin",
      packageId: "kotlin-compiler",
      scope: "request",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1"
    });

    expect(install.package_version).toBe("2.1.21");
  });

  it("resolves android-sdk compileSdk from gradle.properties before build files", () => {
    writeRepoFile("gradle.properties", "actuarius.android.compileSdk=35\n");
    writeRepoFile("app/build.gradle.kts", "android { compileSdk = 34 }\n");

    const install = service.createApprovedInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      packageId: "android-sdk",
      scope: "repo",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1"
    });

    expect(install.package_version).toBe("35");
  });

  it("falls back to build.gradle compileSdk when android-sdk config is not explicit", () => {
    writeRepoFile("androidApp/build.gradle.kts", "android {\n  compileSdk = 34\n}\n");

    const install = service.createApprovedInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      packageId: "android-sdk",
      scope: "repo",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1"
    });

    expect(install.package_version).toBe("34");
  });

  it("passes prior repo-scope install env into later install steps", async () => {
    const priorInstall = db.createInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      packageId: "java-temurin",
      packageVersion: "21",
      scope: "repo",
      status: "approved",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1",
      installRoot: "/data/tool-installs/repo/1/java-temurin"
    });
    db.updateInstallRequest({
      installRequestId: priorInstall.id,
      status: "succeeded",
      binPath: "/data/tool-installs/repo/1/java-temurin/bin",
      envJson: JSON.stringify({ JAVA_HOME: "/data/tool-installs/repo/1/java-temurin/home" }),
      completedAt: "2026-03-31T00:00:00.000Z"
    });

    writeRepoFile("gradle.properties", "actuarius.android.compileSdk=34\n");
    const install = service.createApprovedInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      packageId: "android-sdk",
      scope: "repo",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1"
    });

    mockSpawnCollect.mockResolvedValue({ stdout: "ok", stderr: "" });

    await service.runInstall(install.id);

    expect(mockSpawnCollect).toHaveBeenCalledWith(
      expect.stringContaining("/data/tool-installs/repo/1/android-sdk/home/cmdline-tools/latest/bin/sdkmanager"),
      expect.arrayContaining(["platform-tools"]),
      expect.objectContaining({
        env: expect.objectContaining({
          JAVA_HOME: "/data/tool-installs/repo/1/java-temurin/home",
          ANDROID_HOME: "/data/tool-installs/repo/1/android-sdk/home",
          ANDROID_SDK_ROOT: "/data/tool-installs/repo/1/android-sdk/home",
          PATH: expect.stringContaining("/data/tool-installs/repo/1/android-sdk/bin:/data/tool-installs/repo/1/java-temurin/bin")
        })
      })
    );
  });

  it("fails with CONFIG_NOT_FOUND when repo-config-backed packages have no supported version source", () => {
    expect(() =>
      service.createApprovedInstallRequest({
        guildId: "guild-1",
        repoId: 1,
        packageId: "java-temurin",
        scope: "repo",
        requestedByUserId: "user-1",
        approvedByUserId: "admin-1"
      })
    ).toThrowError(expect.objectContaining({ code: "CONFIG_NOT_FOUND" }));
  });

  it("fails with CONFIG_INVALID when repo config contains an unsupported version shape", () => {
    writeRepoFile(".java-version", "latest\n");

    expect(() =>
      service.createApprovedInstallRequest({
        guildId: "guild-1",
        repoId: 1,
        packageId: "java-temurin",
        scope: "repo",
        requestedByUserId: "user-1",
        approvedByUserId: "admin-1"
      })
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("fails apt installs early when the process is not running as root", async () => {
    const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(1001);
    const install = db.createInstallRequest({
      guildId: "guild-1",
      repoId: 1,
      packageId: "apt:libssl-dev",
      packageVersion: "libssl-dev",
      scope: "repo",
      status: "approved",
      requestedByUserId: "user-1",
      approvedByUserId: "admin-1",
      installRoot: "/data/tool-installs/system/apt-test"
    });

    await expect(service.runInstall(install.id)).rejects.toMatchObject({
      code: "INSTALL_UNAVAILABLE",
      message: expect.stringContaining("no APT install helper is configured")
    });
    expect(mockSpawnCollect).not.toHaveBeenCalled();
    getuidSpy.mockRestore();
  });

  it("uses the configured apt helper via sudo when the process is not running as root", async () => {
    const helperPath = join(tmpdir(), "actuarius-apt-install-test-helper");
    writeFileSync(helperPath, "#!/usr/bin/env bash\nexit 0\n", { encoding: "utf8", mode: 0o755 });
    const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(1001);
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/local/bin:/usr/bin";
    try {
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
          reposRootPath,
          installsRootPath: "/data/tool-installs",
          githubCliConfigPath: "/data/.gh",
          logLevel: "info",
          threadAutoArchiveMinutes: 1440,
          askConcurrencyPerGuild: 1,
          askExecutionTimeoutMs: 1000,
          installStepTimeoutMs: 1000,
          aptInstallHelperPath: helperPath,
          enableCodexExecution: false,
          enableGeminiExecution: false
        },
        pino({ level: "silent" }),
        db
      );

      const install = db.createInstallRequest({
        guildId: "guild-1",
        repoId: 1,
        packageId: "apt:libssl-dev pkg-config",
        packageVersion: "libssl-dev pkg-config",
        scope: "repo",
        status: "approved",
        requestedByUserId: "user-1",
        approvedByUserId: "admin-1",
        installRoot: "/data/tool-installs/system/apt-test"
      });

      mockSpawnCollect.mockResolvedValue({ stdout: "ok", stderr: "" });

      await service.runInstall(install.id);

      expect(mockSpawnCollect).toHaveBeenCalledWith(
        "sudo",
        [helperPath, "libssl-dev", "pkg-config"],
        expect.objectContaining({
          cwd: "/data/tool-installs/system/apt-test",
          env: expect.objectContaining({
            PATH: "/usr/local/bin:/usr/bin"
          })
        })
      );
    } finally {
      process.env.PATH = originalPath;
      getuidSpy.mockRestore();
    }
  });
});
