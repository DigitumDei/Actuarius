import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, "docker", "install-llm-user-instructions.sh");
const sourceRoot = join(repoRoot, "docker", "llm-user-instructions");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("install-llm-user-instructions.sh", () => {
  const managedFiles = [
    { dir: ".claude", file: "CLAUDE.md" },
    { dir: ".codex", file: "AGENTS.md" },
    { dir: ".gemini", file: "GEMINI.md" },
  ] as const;

  it("installs the managed instruction files into the runtime home directory", () => {
    const homeDir = makeTempDir("llm-home-");
    for (const { dir } of managedFiles) {
      mkdirSync(join(homeDir, dir), { recursive: true });
    }

    const result = spawnSync("bash", [scriptPath, sourceRoot, homeDir], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    for (const { dir, file } of managedFiles) {
      expect(readFileSync(join(homeDir, dir, file), "utf8")).toBe(
        readFileSync(join(sourceRoot, dir, file), "utf8")
      );
    }
  });

  it("overwrites stale files with the managed repo version for every tool", () => {
    const homeDir = makeTempDir("llm-home-stale-");
    for (const { dir, file } of managedFiles) {
      mkdirSync(join(homeDir, dir), { recursive: true });
      writeFileSync(join(homeDir, dir, file), `stale ${file}\n`);
    }

    const result = spawnSync("bash", [scriptPath, sourceRoot, homeDir], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    for (const { dir, file } of managedFiles) {
      expect(readFileSync(join(homeDir, dir, file), "utf8")).toBe(
        readFileSync(join(sourceRoot, dir, file), "utf8")
      );
    }
  });
});
