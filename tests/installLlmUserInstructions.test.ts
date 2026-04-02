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
  it("installs the managed instruction files into the runtime home directory", () => {
    const homeDir = makeTempDir("llm-home-");
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    mkdirSync(join(homeDir, ".gemini"), { recursive: true });

    const result = spawnSync("bash", [scriptPath, sourceRoot, homeDir], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(join(homeDir, ".claude", "CLAUDE.md"), "utf8")).toBe(
      readFileSync(join(sourceRoot, ".claude", "CLAUDE.md"), "utf8")
    );
    expect(readFileSync(join(homeDir, ".codex", "AGENTS.md"), "utf8")).toBe(
      readFileSync(join(sourceRoot, ".codex", "AGENTS.md"), "utf8")
    );
    expect(readFileSync(join(homeDir, ".gemini", "GEMINI.md"), "utf8")).toBe(
      readFileSync(join(sourceRoot, ".gemini", "GEMINI.md"), "utf8")
    );
  });

  it("overwrites stale files with the managed repo version", () => {
    const homeDir = makeTempDir("llm-home-stale-");
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    mkdirSync(join(homeDir, ".gemini"), { recursive: true });
    const stalePath = join(homeDir, ".codex", "AGENTS.md");
    writeFileSync(stalePath, "stale\n");

    const result = spawnSync("bash", [scriptPath, sourceRoot, homeDir], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(stalePath, "utf8")).toBe(
      readFileSync(join(sourceRoot, ".codex", "AGENTS.md"), "utf8")
    );
  });
});
