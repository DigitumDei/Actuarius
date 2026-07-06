import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

type Metadata = Record<string, string | undefined>;

type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  dockerLog: string;
};

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, "scripts", "redeploy.sh");

const baseMetadata: Metadata = {
  "env-docker-image": "ghcr.io/digitumdei/actuarius:latest",
  "env-discord-token": "discord-token",
  "env-discord-client-id": "discord-client-id",
  "env-claude-oauth-token": "claude-oauth-token",
  "env-ask-concurrency": "3",
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

function createCurlMock(metadata: Metadata): string {
  const lines = [
    "#!/usr/bin/env bash",
    "url=${!#}",
    "key=${url##*/}",
    "case \"$key\" in",
  ];

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) {
      continue;
    }
    lines.push(`  ${key}) printf %s ${shellSingleQuote(value)} ;;`);
  }

  lines.push("  *) exit 22 ;;");
  lines.push("esac");
  lines.push("");
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

function createDockerMock(logPath: string): string {
  return `#!/usr/bin/env bash
printf 'CALL' >> ${shellSingleQuote(logPath)}
for arg in "$@"; do
  printf '\\n%q' "$arg" >> ${shellSingleQuote(logPath)}
done
printf '\\nEND\\n' >> ${shellSingleQuote(logPath)}
exit 0
`;
}

function createNoopMock(logPath: string, name: string): string {
  return `#!/usr/bin/env bash
printf '${name}\\n' >> ${shellSingleQuote(logPath)}
exit 0
`;
}

function runRedeploy(metadata: Metadata): RunResult {
  const tempDir = mkdtempSync(join(tmpdir(), "redeploy-test-"));
  tempDirs.push(tempDir);

  const binDir = join(tempDir, "bin");
  mkdirSync(binDir);
  const dockerLogPath = join(tempDir, "docker.log");
  const mkdirLogPath = join(tempDir, "mkdir.log");
  const chownLogPath = join(tempDir, "chown.log");
  const bashEnvPath = join(tempDir, "bash-env.sh");
  writeFileSync(bashEnvPath, [
    asBashFunction("curl", createCurlMock(metadata)),
    asBashFunction("docker", createDockerMock(toBashPath(dockerLogPath))),
    asBashFunction("mkdir", createNoopMock(toBashPath(mkdirLogPath), "mkdir")),
    asBashFunction("chown", createNoopMock(toBashPath(chownLogPath), "chown"))
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
  };
}

describe("scripts/redeploy.sh auth validation", () => {
  it("applies safe default container resource limits", () => {
    const result = runRedeploy({
      ...baseMetadata,
      "env-gh-token": "gh-token",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.dockerLog).toContain("--memory\n700m");
    expect(result.dockerLog).toContain("--memory-swap\n700m");
    expect(result.dockerLog).toContain("--cpus\n0.8");
    expect(result.dockerLog).toContain("--pids-limit\n256");
  });

  it("forwards configured container resource limits", () => {
    const result = runRedeploy({
      ...baseMetadata,
      "env-gh-token": "gh-token",
      "env-container-memory": "600m",
      "env-container-cpus": "0.5",
      "env-container-pids-limit": "128",
    });

    expect(result.status).toBe(0);
    expect(result.dockerLog).toContain("--memory\n600m");
    expect(result.dockerLog).toContain("--memory-swap\n600m");
    expect(result.dockerLog).toContain("--cpus\n0.5");
    expect(result.dockerLog).toContain("--pids-limit\n128");
  });

  it("accepts GH_TOKEN-only auth and forwards only GH_TOKEN", () => {
    const result = runRedeploy({
      ...baseMetadata,
      "env-gh-token": "gh-token",
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
      "env-github-app-private-key": "-----BEGIN KEY-----\\nabc\\n-----END KEY-----",
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
      "env-github-app-private-key-b64": "cGVtCg==",
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
    expect(result.stderr).toContain("either env-gh-token or all GitHub App credentials");
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
      "env-github-app-private-key": "raw-key",
      "env-github-app-private-key-b64": "cmF3LWtleQ==",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("set only one of env-github-app-private-key or env-github-app-private-key-b64");
    expect(result.dockerLog).toBe("");
  });
});
