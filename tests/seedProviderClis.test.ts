import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type SeedResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  npmLog: string;
};

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, "docker", "seed-provider-clis.sh");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createExecutable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function runSeedProviderClis(existingBinaries: string[]): SeedResult {
  const tempDir = mkdtempSync(join(tmpdir(), "seed-provider-clis-"));
  tempDirs.push(tempDir);

  const npmLogPath = join(tempDir, "npm.log");
  const binDir = join(tempDir, "mock-bin");
  const prefixDir = join(tempDir, "npm-global");
  const prefixBinDir = join(prefixDir, "bin");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(prefixBinDir, { recursive: true });

  for (const binary of existingBinaries) {
    createExecutable(join(prefixBinDir, binary), "#!/bin/sh\nexit 0\n");
  }

  createExecutable(
    join(binDir, "npm"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(npmLogPath)}
exit 0
`
  );

  const result = spawnSync("sh", [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NPM_CONFIG_PREFIX: prefixDir,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    npmLog: readFileSync(npmLogPath, { encoding: "utf8", flag: "a+" }),
  };
}

describe("seed-provider-clis.sh", () => {
  it("skips npm when all provider binaries are already present", () => {
    const result = runSeedProviderClis(["claude", "codex", "gemini"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.npmLog).toBe("");
  });

  it("installs only the missing provider package", () => {
    const result = runSeedProviderClis(["claude", "gemini"]);

    expect(result.status).toBe(0);
    expect(result.npmLog).toBe("install -g @openai/codex\n");
  });

  it("installs every provider package on a fresh volume", () => {
    const result = runSeedProviderClis([]);

    expect(result.status).toBe(0);
    expect(result.npmLog).toBe(
      "install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli\n"
    );
  });
});
