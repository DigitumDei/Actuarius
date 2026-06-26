import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import {
  buildRepoMemoryWing,
  MemPalaceRemoteService,
  parseProjectConfigWing,
  type RepoMemoryIdentity
} from "../src/services/memPalaceRemoteService.js";

vi.mock("../src/utils/spawnCollect.js", () => ({
  spawnCollect: vi.fn()
}));

const { spawnCollect } = await import("../src/utils/spawnCollect.js");
const mockSpawnCollect = vi.mocked(spawnCollect);
const logger = pino({ level: "silent" });

function makeConfig(root: string): AppConfig {
  return {
    discordToken: "discord-token",
    discordClientId: "discord-client",
    discordGuildId: undefined,
    ghToken: undefined,
    githubAppId: undefined,
    githubAppPrivateKey: undefined,
    githubAppPrivateKeyB64: undefined,
    githubAppInstallationId: undefined,
    gitUserName: undefined,
    gitUserEmail: undefined,
    geminiApiKey: undefined,
    databasePath: join(root, "app.db"),
    reposRootPath: join(root, "repos"),
    installsRootPath: join(root, "tool-installs"),
    githubCliConfigPath: join(root, ".gh"),
    logLevel: "info",
    threadAutoArchiveMinutes: 1440,
    askConcurrencyPerGuild: 1,
    askExecutionTimeoutMs: 1000,
    installStepTimeoutMs: 1000,
    aptInstallHelperPath: undefined,
    enableCodexExecution: false,
    enableGeminiExecution: false,
    enableOpencodeExecution: false,
    deepseekApiKey: undefined,
    attachmentMaxCount: 5,
    attachmentMaxFileSize: 1024,
    attachmentMaxTotalSize: 2048,
    attachmentMaxInlineText: 512,
    mempalaceEnabled: true,
    mempalacePalacePath: join(root, "local-palace"),
    mempalaceBinaryPath: "/usr/local/bin/mempalace-mcp",
    mempalaceCliPath: "/usr/local/bin/mempalace-cli",
    mempalaceRemoteEnabled: true,
    mempalaceRemotePalacePath: join(root, "remote-palace"),
    mempalaceRemoteBind: "127.0.0.1:9876",
    mempalaceRemoteUrl: "http://127.0.0.1:9876",
    mempalaceRemoteName: "actuarius",
    mempalaceRemoteToken: "test-token",
    mempalaceRemoteTokenFile: join(root, "server_tokens.json"),
    mempalaceRemoteTimeoutMs: 5000,
    mempalaceRemoteMineOnSync: false,
    mempalaceRemoteMineTimeoutMs: 1000,
    mempalaceRemoteMineBatchSize: 0
  };
}

function makeRepo(): RepoMemoryIdentity {
  return { owner: "DigitumDei", repo: "Actuarius", fullName: "DigitumDei/Actuarius" };
}

describe("MemPalaceRemoteService", () => {
  beforeEach(() => {
    mockSpawnCollect.mockReset();
    mockSpawnCollect.mockResolvedValue({ stdout: ".git\n", stderr: "" });
  });

  it("builds stable repo wing names and parses project config wings", () => {
    expect(buildRepoMemoryWing({ owner: "Digitum Dei", repo: "Actuarius.NET", fullName: "Digitum Dei/Actuarius.NET" })).toBe(
      "wing_repo_digitum_dei_actuarius_net"
    );
    expect(parseProjectConfigWing("# comment\nwing: custom_wing # inline comment\n")).toBe("custom_wing");
    expect(parseProjectConfigWing("rooms: []\n")).toBeNull();
  });

  it("generates repo routing, token, global federation config, and git exclude", async () => {
    const root = mkdtempSync(join(tmpdir(), "actuarius-mempalace-"));
    const homeDir = join(root, "home");
    const config = makeConfig(root);
    const repo = makeRepo();
    const checkoutPath = join(config.reposRootPath, repo.owner, repo.repo);
    mkdirSync(join(checkoutPath, ".git", "info"), { recursive: true });

    const service = new MemPalaceRemoteService(config, logger, { homeDir });
    const wing = await service.registerRepository(repo, checkoutPath);

    expect(wing).toBe("wing_repo_digitumdei_actuarius");
    const projectConfig = readFileSync(join(checkoutPath, "mempalace.yaml"), "utf8");
    expect(projectConfig).toContain("wing: wing_repo_digitumdei_actuarius");
    expect(projectConfig).toContain("  mode: combined");
    expect(projectConfig).toContain("  remote: actuarius");
    expect(projectConfig).toContain("  write: remote");

    const globalConfig = JSON.parse(readFileSync(join(homeDir, ".mempalace", "config.json"), "utf8"));
    expect(globalConfig.palace_path).toBe(config.mempalacePalacePath);
    expect(globalConfig.server).toMatchObject({
      bind: config.mempalaceRemoteBind,
      token_file: config.mempalaceRemoteTokenFile
    });
    expect(globalConfig.server.checkouts[wing]).toBe(checkoutPath);
    expect(globalConfig.federation.remotes).toContainEqual(
      expect.objectContaining({
        name: "actuarius",
        url: config.mempalaceRemoteUrl,
        token_env: "MEMPALACE_REMOTE_TOKEN",
        timeout_ms: 5000
      })
    );
    expect(globalConfig.federation.wings[wing]).toEqual({ mode: "combined", remote: "actuarius", write: "remote" });
    expect(globalConfig.federation.remotes[0]).not.toHaveProperty("token");

    const tokenEntries = JSON.parse(readFileSync(config.mempalaceRemoteTokenFile, "utf8"));
    expect(tokenEntries[0]).toMatchObject({ name: "actuarius-local", token: "test-token", enabled: true });
    expect(readFileSync(join(checkoutPath, ".git", "info", "exclude"), "utf8")).toContain("mempalace.yaml");
  });

  it("honors an existing repo MemPalace wing instead of overwriting it", async () => {
    const root = mkdtempSync(join(tmpdir(), "actuarius-mempalace-existing-"));
    const homeDir = join(root, "home");
    const config = makeConfig(root);
    const repo = makeRepo();
    const checkoutPath = join(config.reposRootPath, repo.owner, repo.repo);
    mkdirSync(checkoutPath, { recursive: true });
    writeFileSync(join(checkoutPath, "mempalace.yaml"), "wing: repo_defined_wing\n", "utf8");

    const service = new MemPalaceRemoteService(config, logger, { homeDir });
    const wing = await service.registerRepository(repo, checkoutPath);

    expect(wing).toBe("repo_defined_wing");
    expect(readFileSync(join(checkoutPath, "mempalace.yaml"), "utf8")).toBe("wing: repo_defined_wing\n");
    const globalConfig = JSON.parse(readFileSync(join(homeDir, ".mempalace", "config.json"), "utf8"));
    expect(globalConfig.server.checkouts.repo_defined_wing).toBe(checkoutPath);
    expect(globalConfig.federation.wings.repo_defined_wing).toEqual({ mode: "combined", remote: "actuarius", write: "remote" });
    expect(mockSpawnCollect).not.toHaveBeenCalled();
  });

  it("recovers from corrupt global config while serializing concurrent registrations", async () => {
    const root = mkdtempSync(join(tmpdir(), "actuarius-mempalace-concurrent-"));
    const homeDir = join(root, "home");
    const config = makeConfig(root);
    const repoA = makeRepo();
    const repoB: RepoMemoryIdentity = { owner: "DigitumDei", repo: "MemPalace", fullName: "DigitumDei/MemPalace" };
    const checkoutA = join(config.reposRootPath, repoA.owner, repoA.repo);
    const checkoutB = join(config.reposRootPath, repoB.owner, repoB.repo);
    mkdirSync(join(checkoutA, ".git", "info"), { recursive: true });
    mkdirSync(join(checkoutB, ".git", "info"), { recursive: true });
    mkdirSync(join(homeDir, ".mempalace"), { recursive: true });
    writeFileSync(join(homeDir, ".mempalace", "config.json"), "not valid json", "utf8");

    const service = new MemPalaceRemoteService(config, logger, { homeDir });
    await Promise.all([service.registerRepository(repoA, checkoutA), service.registerRepository(repoB, checkoutB)]);

    const wingA = buildRepoMemoryWing(repoA);
    const wingB = buildRepoMemoryWing(repoB);
    const globalConfig = JSON.parse(readFileSync(join(homeDir, ".mempalace", "config.json"), "utf8"));
    expect(globalConfig.server.checkouts[wingA]).toBe(checkoutA);
    expect(globalConfig.server.checkouts[wingB]).toBe(checkoutB);
    expect(globalConfig.federation.wings[wingA]).toEqual({ mode: "combined", remote: "actuarius", write: "remote" });
    expect(globalConfig.federation.wings[wingB]).toEqual({ mode: "combined", remote: "actuarius", write: "remote" });

    const tokenEntries = JSON.parse(readFileSync(config.mempalaceRemoteTokenFile, "utf8"));
    expect(tokenEntries.filter((entry: { name?: string }) => entry.name === "actuarius-local")).toHaveLength(1);
  });

});
