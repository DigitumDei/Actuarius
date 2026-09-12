import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

type Metadata = Record<string, string | undefined>;
type Secrets = Record<string, string | undefined>;

type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  dockerLog: string;
  systemctlLog: string;
};

type DockerState = {
  /** `<image id> <repo>:<tag>` lines, newest first, the way `docker images` orders them. */
  images?: string[];
  /** Image references reported by `docker ps -a --format '{{.Image}}'`. */
  containerImages?: string[];
  /** Make every `docker rmi` fail, to prove pruning cannot break a deploy. */
  failRmi?: boolean;
};

type RunOptions = {
  unitsInstalled?: boolean;
  docker?: DockerState;
  /** MiB reported as available by `df -Pm` on the Docker data root. */
  freeSpaceMb?: number;
};

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, "scripts", "redeploy.sh");

const baseMetadata: Metadata = {
  "env-docker-image": "ghcr.io/digitumdei/actuarius:latest",
  "env-discord-client-id": "discord-client-id",
  "env-ask-concurrency": "3",
};

const baseSecrets: Secrets = {
  "actuarius-discord-token": "discord-token",
  "actuarius-claude-oauth-token": "claude-oauth-token",
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function toBashPath(path: string): string {
  if (process.platform !== "win32") return path;
  const normalized = path.replaceAll("\\", "/");
  return normalized.replace(/^([A-Za-z]):/u, (_match, drive: string) => `/${drive.toLowerCase()}`);
}

function createCurlMock(metadata: Metadata, secrets: Secrets): string {
  // Secret Manager returns the payload base64-encoded; precompute the encoded
  // values here so the bash mock stays a static lookup table.
  const secretCases: string[] = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (value === undefined) {
      continue;
    }
    const data = Buffer.from(value, "utf8").toString("base64");
    secretCases.push(
      `      ${name}) printf %s ${shellSingleQuote(`{"name":"projects/test-project/secrets/${name}/versions/1","payload":{"data":"${data}"}}`)} ;;`
    );
  }

  const metadataCases: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) {
      continue;
    }
    metadataCases.push(`      ${key}) printf %s ${shellSingleQuote(value)} ;;`);
  }

  const lines = [
    "#!/usr/bin/env bash",
    "url=${!#}",
    "case \"$url\" in",
    "  */project/project-id) printf %s 'test-project' ;;",
    "  */service-accounts/default/token) printf %s '{\"access_token\":\"test-access-token\",\"expires_in\":3599,\"token_type\":\"Bearer\"}' ;;",
    "  *secretmanager.googleapis.com*)",
    "    name=\"${url##*/secrets/}\"",
    "    name=\"${name%%/*}\"",
    "    case \"$name\" in",
    ...secretCases,
    "      *) exit 22 ;;",
    "    esac ;;",
    "  *)",
    "    key=${url##*/}",
    "    case \"$key\" in",
    ...metadataCases,
    "      *) exit 22 ;;",
    "    esac ;;",
    "esac",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function asBashFunction(name: string, script: string): string {
  const body = script
    .split("\n")
    .filter((line) => !line.startsWith("#!"))
    .join("\n")
    .replaceAll("exit 22", "return 22")
    .replaceAll("exit 0", "return 0");
  return `${name}() {\n${body}\n}\n`;
}

function printfLines(values: readonly string[]): string {
  if (values.length === 0) return "true";
  return `printf '%s\\n' ${values.map(shellSingleQuote).join(" ")}`;
}

function createDockerMock(logPath: string, state: DockerState = {}): string {
  const images = state.images ?? [];
  const containerImages = state.containerImages ?? [];
  // `docker image inspect --format '{{.Id}}' <ref>` resolves a tag or an id to
  // an image id; an unknown reference must fail so the script treats it as
  // absent rather than as something to protect.
  const inspectCases = images.map((line) => {
    const [id = "", ref = ""] = line.split(" ");
    return `      ${shellSingleQuote(ref)} | ${shellSingleQuote(id)}) printf '%s\\n' ${shellSingleQuote(id)} ;;`;
  });

  return `#!/usr/bin/env bash
printf 'CALL' >> ${shellSingleQuote(logPath)}
for arg in "$@"; do
  printf '\\n%q' "$arg" >> ${shellSingleQuote(logPath)}
done
printf '\\nEND\\n' >> ${shellSingleQuote(logPath)}
case "\${1:-}" in
  info) printf '%s\\n' '/mnt/stateful_partition/var/lib/docker' ;;
  images) ${printfLines(images)} ;;
  ps) ${printfLines(containerImages)} ;;
  rmi) ${state.failRmi ? "return 1" : "true"} ;;
  image)
    if [ "\${2:-}" = inspect ]; then
      ref=\${!#}
      case "$ref" in
${inspectCases.join("\n")}
        *) return 1 ;;
      esac
    fi ;;
esac
exit 0
`;
}

function createDfMock(freeSpaceMb: number): string {
  return `#!/usr/bin/env bash
printf '%s\\n' 'Filesystem 1M-blocks Used Available Use% Mounted on'
printf '%s\\n' '/dev/sda1 5714 100 ${freeSpaceMb} 20% /mnt/stateful_partition'
exit 0
`;
}

/** Split the docker mock log into one array of arguments per call. */
function dockerCalls(log: string): string[][] {
  return log
    .split("END\n")
    .filter((block) => block.trim().startsWith("CALL"))
    .map((block) =>
      block
        .trim()
        .split("\n")
        .slice(1)
        .map((arg) => arg.trim())
    );
}

/** Index of the first docker call whose leading arguments match `prefix`. */
function firstCallIndex(log: string, prefix: readonly string[]): number {
  return dockerCalls(log).findIndex((args) => prefix.every((value, index) => args[index] === value));
}

function createNoopMock(logPath: string, name: string): string {
  return `#!/usr/bin/env bash
printf '${name}\\n' >> ${shellSingleQuote(logPath)}
exit 0
`;
}

function createSystemctlMock(logPath: string, unitsInstalled: boolean): string {
  return `#!/usr/bin/env bash
for arg in "$@"; do
  printf '%s ' "$arg" >> ${shellSingleQuote(logPath)}
done
printf '\\n' >> ${shellSingleQuote(logPath)}
if [ "\${1:-}" = cat ] && [ ${unitsInstalled ? "true" : "false"} = false ]; then
  return 1
fi
exit 0
`;
}

function runRedeploy(metadata: Metadata, secrets: Secrets = baseSecrets, options: RunOptions = {}): RunResult {
  const tempDir = mkdtempSync(join(tmpdir(), "redeploy-test-"));
  tempDirs.push(tempDir);

  const binDir = join(tempDir, "bin");
  mkdirSync(binDir);
  const dockerLogPath = join(tempDir, "docker.log");
  const mkdirLogPath = join(tempDir, "mkdir.log");
  const chownLogPath = join(tempDir, "chown.log");
  const systemctlLogPath = join(tempDir, "systemctl.log");
  const bashEnvPath = join(tempDir, "bash-env.sh");
  writeFileSync(bashEnvPath, [
    asBashFunction("curl", createCurlMock(metadata, secrets)),
    asBashFunction("docker", createDockerMock(toBashPath(dockerLogPath), options.docker ?? {})),
    asBashFunction("df", createDfMock(options.freeSpaceMb ?? 4096)),
    asBashFunction("mkdir", createNoopMock(toBashPath(mkdirLogPath), "mkdir")),
    asBashFunction("chown", createNoopMock(toBashPath(chownLogPath), "chown")),
    asBashFunction("systemctl", createSystemctlMock(toBashPath(systemctlLogPath), options.unitsInstalled ?? true))
  ].join("\n"));

  const bashExecutable = process.platform === "win32"
    ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
    : "bash";
  const result = spawnSync(bashExecutable, [toBashPath(scriptPath), "test-tag"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BASH_ENV: toBashPath(bashEnvPath),
    },
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    dockerLog: readFileSync(dockerLogPath, { encoding: "utf8", flag: "a+" }),
    systemctlLog: readFileSync(systemctlLogPath, { encoding: "utf8", flag: "a+" }),
  };
}

describe("scripts/redeploy.sh auth validation", () => {
  it("creates the container without a restart policy and starts it through systemd", () => {
    const result = runRedeploy(baseMetadata, {
      ...baseSecrets,
      "actuarius-gh-token": "gh-token",
    });

    expect(result.status, result.stderr).toBe(0);
    // Container lifecycle belongs to actuarius-bot.service, which is ordered
    // after the metadata-isolation firewall unit — a docker restart policy
    // would race the firewall at boot.
    expect(result.dockerLog).toMatch(/\ncreate\n/);
    expect(result.dockerLog).not.toContain("--restart");
    expect(result.dockerLog).not.toMatch(/\nrun\n/);
    expect(result.systemctlLog).toContain("restart actuarius-bot.service");
  });

  it("fails before replacing the legacy container when the systemd units are not installed", () => {
    const result = runRedeploy(baseMetadata, {
      ...baseSecrets,
      "actuarius-gh-token": "gh-token",
    }, { unitsInstalled: false });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("complete the metadata-isolation cutover and reboot");
    expect(result.systemctlLog).toContain("cat --no-pager actuarius-firewall.service actuarius-bot.service");
    expect(result.dockerLog).toBe("");
  });

  it("passes --no-pager to the systemd unit guard", () => {
    // Under sudo, `systemctl cat` starts a pager; with stdout on /dev/null the
    // pager exits at once and systemctl dies of SIGPIPE (exit 141). That made
    // the guard abort real deploys while the units were perfectly healthy.
    const result = runRedeploy(baseMetadata, {
      ...baseSecrets,
      "actuarius-gh-token": "gh-token",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.systemctlLog).toContain("cat --no-pager");
    expect(result.systemctlLog).not.toMatch(/cat actuarius-firewall/u);
  });

  it("applies safe default container resource limits", () => {
    const result = runRedeploy(baseMetadata, {
      ...baseSecrets,
      "actuarius-gh-token": "gh-token",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.dockerLog).toContain("--memory\n700m");
    expect(result.dockerLog).toContain("--memory-swap\n2g");
    expect(result.dockerLog).toContain("--cpus\n0.8");
    expect(result.dockerLog).toContain("--pids-limit\n1024");
  });

  it("forwards configured container resource limits", () => {
    const result = runRedeploy({
      ...baseMetadata,
      "env-container-memory": "600m",
      "env-container-memory-swap": "600m",
      "env-container-cpus": "0.5",
      "env-container-pids-limit": "128",
    }, {
      ...baseSecrets,
      "actuarius-gh-token": "gh-token",
    });

    expect(result.status).toBe(0);
    expect(result.dockerLog).toContain("--memory\n600m");
    expect(result.dockerLog).toContain("--memory-swap\n600m");
    expect(result.dockerLog).toContain("--cpus\n0.5");
    expect(result.dockerLog).toContain("--pids-limit\n128");
  });

  it("raises memory-swap to match a larger memory override", () => {
    const result = runRedeploy({
      ...baseMetadata,
      "env-container-memory": "3g",
    }, {
      ...baseSecrets,
      "actuarius-gh-token": "gh-token",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("raising it to 3g");
    expect(result.dockerLog).toContain("--memory\n3g");
    expect(result.dockerLog).toContain("--memory-swap\n3g");
  });

  it("accepts GH_TOKEN-only auth and forwards only GH_TOKEN", () => {
    const result = runRedeploy(baseMetadata, {
      ...baseSecrets,
      "actuarius-gh-token": "gh-token",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.dockerLog).toContain("GH_TOKEN=gh-token");
    expect(result.dockerLog).not.toContain("GITHUB_APP_ID=");
    expect(result.dockerLog).not.toContain("GITHUB_APP_INSTALLATION_ID=");
    expect(result.dockerLog).not.toContain("GITHUB_APP_PRIVATE_KEY=");
    expect(result.dockerLog).not.toContain("GITHUB_APP_PRIVATE_KEY_B64=");
  });

  it("accepts a complete GitHub App config with a raw private key", () => {
    const result = runRedeploy({
      ...baseMetadata,
      "env-github-app-id": "123",
      "env-github-app-installation-id": "456",
    }, {
      ...baseSecrets,
      "actuarius-github-app-private-key": "-----BEGIN KEY-----\\nabc\\n-----END KEY-----",
    });

    expect(result.status).toBe(0);
    expect(result.dockerLog).toContain("GITHUB_APP_ID=123");
    expect(result.dockerLog).toContain("GITHUB_APP_INSTALLATION_ID=456");
    expect(result.dockerLog).toContain("GITHUB_APP_PRIVATE_KEY=");
    expect(result.dockerLog).toContain("abc\\\\n-----END");
    expect(result.dockerLog).not.toContain("GH_TOKEN=");
    expect(result.dockerLog).not.toContain("GITHUB_APP_PRIVATE_KEY_B64=");
  });

  it("accepts a complete GitHub App config with a base64 private key", () => {
    const result = runRedeploy({
      ...baseMetadata,
      "env-github-app-id": "123",
      "env-github-app-installation-id": "456",
    }, {
      ...baseSecrets,
      "actuarius-github-app-private-key-b64": "cGVtCg==",
    });

    expect(result.status).toBe(0);
    expect(result.dockerLog).toContain("GITHUB_APP_ID=123");
    expect(result.dockerLog).toContain("GITHUB_APP_INSTALLATION_ID=456");
    expect(result.dockerLog).toContain("GITHUB_APP_PRIVATE_KEY_B64=cGVtCg==");
    expect(result.dockerLog).not.toContain("GH_TOKEN=");
    expect(result.dockerLog).not.toContain("GITHUB_APP_PRIVATE_KEY=");
  });

  it("rejects missing GitHub auth", () => {
    const result = runRedeploy(baseMetadata);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("either the actuarius-gh-token secret or all GitHub App credentials");
    expect(result.dockerLog).toBe("");
  });

  it("rejects partial GitHub App config without GH_TOKEN", () => {
    const result = runRedeploy({
      ...baseMetadata,
      "env-github-app-id": "123",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GitHub App credentials must include");
    expect(result.dockerLog).toBe("");
  });

  it("rejects partial GitHub App config even when GH_TOKEN is set", () => {
    const result = runRedeploy({
      ...baseMetadata,
      "env-gh-token": "gh-token",
      "env-github-app-id": "123",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GitHub App credentials must include");
    expect(result.dockerLog).toBe("");
  });

  it("rejects configuring both private key formats", () => {
    const result = runRedeploy({
      ...baseMetadata,
      "env-github-app-id": "123",
      "env-github-app-installation-id": "456",
    }, {
      ...baseSecrets,
      "actuarius-github-app-private-key": "raw-key",
      "actuarius-github-app-private-key-b64": "cmF3LWtleQ==",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("set only one of secret actuarius-github-app-private-key or actuarius-github-app-private-key-b64");
    expect(result.dockerLog).toBe("");
  });

  it("fails fast when the discord token secret is missing", () => {
    const result = runRedeploy(baseMetadata, {
      "actuarius-claude-oauth-token": "claude-oauth-token",
      "actuarius-gh-token": "gh-token",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("secret actuarius-discord-token is not set");
    expect(result.dockerLog).toBe("");
  });

  it("forwards secret values fetched from Secret Manager to the container", () => {
    const result = runRedeploy(baseMetadata, {
      ...baseSecrets,
      "actuarius-gh-token": "gh-token",
      "actuarius-gemini-api-key": "gemini-key",
      "actuarius-mempalace-remote-token": "fed-token",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.dockerLog).toContain("DISCORD_TOKEN=discord-token");
    expect(result.dockerLog).toContain("CLAUDE_CODE_OAUTH_TOKEN=claude-oauth-token");
    expect(result.dockerLog).toContain("GEMINI_API_KEY=gemini-key");
    expect(result.dockerLog).toContain("MEMPALACE_REMOTE_TOKEN=fed-token");
  });

  it("forwards the MemPalace embedding profile from instance metadata", () => {
    const result = runRedeploy(
      { ...baseMetadata, "env-mempalace-embedding-profile": "low_cpu" },
      { ...baseSecrets, "actuarius-gh-token": "gh-token" }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.dockerLog).toContain("MEMPALACE_EMBEDDING_PROFILE=low_cpu");
  });

  it("enables coordination with its channel and required memory client", () => {
    const result = runRedeploy(
      { ...baseMetadata, "env-coordination-enabled": "true", "env-coordination-channel-id": "12345" },
      { ...baseSecrets, "actuarius-gh-token": "gh-token" }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.dockerLog).toContain("COORDINATION_ENABLED=true");
    expect(result.dockerLog).toContain("COORDINATION_CHANNEL_ID=12345");
    expect(result.dockerLog).toContain("MEMPALACE_ENABLED=true");
  });

  it("rejects coordination without an intake channel before replacing the container", () => {
    const result = runRedeploy(
      { ...baseMetadata, "env-coordination-enabled": "true" },
      { ...baseSecrets, "actuarius-gh-token": "gh-token" }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("coordination requires env-coordination-channel-id");
    expect(result.dockerLog).not.toContain("rm -f actuarius");
  });

  it("omits the embedding profile flag when the metadata key is absent", () => {
    const result = runRedeploy(baseMetadata, { ...baseSecrets, "actuarius-gh-token": "gh-token" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.dockerLog).not.toContain("MEMPALACE_EMBEDDING_PROFILE=");
  });
});

describe("scripts/redeploy.sh disk reclamation", () => {
  const repo = "ghcr.io/digitumdei/actuarius";
  const secrets: Secrets = { ...baseSecrets, "actuarius-gh-token": "gh-token" };

  // Newest first, matching the order `docker images` prints.
  const deployedFirst = [
    `sha256:new ${repo}:test-tag`,
    `sha256:prev ${repo}:latest`,
    `sha256:old1 ${repo}:aaa111`,
    `sha256:old2 ${repo}:bbb222`,
  ];

  function removedImages(log: string): string[] {
    return dockerCalls(log)
      .filter((args) => args[0] === "rmi")
      .map((args) => args[1] ?? "");
  }

  it("logs Docker data-root free space before pulling", () => {
    const result = runRedeploy(baseMetadata, secrets, { freeSpaceMb: 4096 });

    expect(result.status, result.stderr).toBe(0);
    // `df -h /` reports the read-only COS vroot, not the partition that holds
    // the images, so the script has to ask Docker where its data-root lives.
    expect(result.stdout).toContain("Docker data root /mnt/stateful_partition/var/lib/docker: 4096 MB free");
    const infoIndex = firstCallIndex(result.dockerLog, ["info"]);
    const pullIndex = firstCallIndex(result.dockerLog, ["pull"]);
    expect(infoIndex).toBeGreaterThanOrEqual(0);
    expect(pullIndex).toBeGreaterThan(infoIndex);
  });

  it("keeps the deployed image and one rollback image, removing older releases", () => {
    const result = runRedeploy(baseMetadata, secrets, {
      docker: { images: deployedFirst, containerImages: [`${repo}:test-tag`] },
    });

    expect(result.status, result.stderr).toBe(0);
    // `docker image prune -f` only drops dangling layers; these tagged release
    // images are what actually filled /mnt/stateful_partition.
    expect(removedImages(result.dockerLog)).toEqual([`${repo}:aaa111`, `${repo}:bbb222`]);
    expect(result.stdout).toContain(`Retaining ${repo}:latest for rollback`);
    const pullIndex = firstCallIndex(result.dockerLog, ["pull"]);
    const rmiIndex = firstCallIndex(result.dockerLog, ["rmi"]);
    expect(rmiIndex).toBeGreaterThan(pullIndex);
    expect(result.systemctlLog).toContain("restart actuarius-bot.service");
  });

  it("never removes an image that still backs a container", () => {
    const result = runRedeploy(baseMetadata, secrets, {
      docker: {
        images: deployedFirst,
        containerImages: [`${repo}:test-tag`, "sha256:old1"],
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(removedImages(result.dockerLog)).toEqual([`${repo}:bbb222`]);
    expect(result.stdout).toContain(`Keeping ${repo}:aaa111: still referenced by a container`);
  });

  it("prunes before the pull when free space is below the threshold", () => {
    // Pre-pull the new tag does not exist locally yet; the running container's
    // image must survive so a failed pull can still be rolled back.
    const result = runRedeploy(baseMetadata, secrets, {
      freeSpaceMb: 900,
      docker: {
        images: [`sha256:prev ${repo}:latest`, `sha256:old1 ${repo}:aaa111`, `sha256:old2 ${repo}:bbb222`],
        containerImages: [`${repo}:latest`],
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Free space is below 2560 MB");
    const pullIndex = firstCallIndex(result.dockerLog, ["pull"]);
    const rmiIndex = firstCallIndex(result.dockerLog, ["rmi"]);
    expect(rmiIndex).toBeGreaterThanOrEqual(0);
    expect(rmiIndex).toBeLessThan(pullIndex);
    expect(removedImages(result.dockerLog)).not.toContain(`${repo}:latest`);
  });

  it("does not prune before the pull when free space is comfortable", () => {
    const result = runRedeploy(baseMetadata, secrets, {
      freeSpaceMb: 4096,
      docker: { images: deployedFirst, containerImages: [`${repo}:test-tag`] },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("Free space is below");
    expect(firstCallIndex(result.dockerLog, ["rmi"])).toBeGreaterThan(
      firstCallIndex(result.dockerLog, ["pull"])
    );
  });

  it("completes the deploy when image removal fails", () => {
    const result = runRedeploy(baseMetadata, secrets, {
      docker: { images: deployedFirst, containerImages: [`${repo}:test-tag`], failRmi: true },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`WARN: could not remove old image ${repo}:aaa111`);
    expect(result.stdout).toContain("Done. Logs: docker logs -f actuarius");
    expect(result.systemctlLog).toContain("restart actuarius-bot.service");
  });

  it("warns instead of failing when free space cannot be determined", () => {
    const result = runRedeploy(baseMetadata, secrets, { freeSpaceMb: Number.NaN });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not determine free space on the Docker data root");
    expect(result.dockerLog).toMatch(/\npull\n/);
  });
});
