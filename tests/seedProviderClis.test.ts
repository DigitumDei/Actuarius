import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type SeedResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  npmLog: string;
  agyContent: string;
};

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, "docker", "seed-provider-clis.sh");
const entrypointPath = join(repoRoot, "docker", "entrypoint.sh");
const tempDirs: string[] = [];

function toBashPath(path: string): string {
  if (process.platform !== "win32") return path;
  return path
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/u, (_match, drive: string) => `/${drive.toLowerCase()}`);
}

const shellExecutable = process.platform === "win32"
  ? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
  : "sh";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createExecutable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function runSeedProviderClis(
  existingBinaries: string[],
  failPackages: string[] = [],
  options: { curlFailsFirst?: boolean; installerFails?: boolean } = {}
): SeedResult {
  const tempDir = mkdtempSync(join(tmpdir(), "seed-provider-clis-"));
  tempDirs.push(tempDir);

  const npmLogPath = join(tempDir, "npm.log");
  const curlStatePath = join(tempDir, "curl.state");
  const prefixDir = join(tempDir, "npm-global");
  const prefixBinDir = join(prefixDir, "bin");
  const homeDir = join(tempDir, "home");
  const agyPath = join(homeDir, ".local", "bin", "agy");

  mkdirSync(prefixBinDir, { recursive: true });

  for (const binary of existingBinaries.filter((name) => name !== "agy")) {
    createExecutable(join(prefixBinDir, binary), "#!/bin/sh\nexit 0\n");
  }
  if (existingBinaries.includes("agy")) {
    mkdirSync(join(homeDir, ".local", "bin"), { recursive: true });
    createExecutable(agyPath, "#!/bin/sh\necho old\n");
  }

  // Mock npm logs each invocation's args. It exits 1 when the args mention any
  // package listed in failPackages, so tests can exercise the best-effort path.
  //
  // The mock is a real executable on a PATH prefix dir rather than a shell
  // function injected via BASH_ENV: BASH_ENV is bash-only, so under Debian's
  // /bin/sh (dash) the function never loaded and the script shelled out to the
  // real npm, hitting the network. PATH shadowing works under any shell.
  const failCases = failPackages
    .map((pkg) => `  *${pkg}*) exit 1 ;;`)
    .join("\n");
  const mockBinDir = join(tempDir, "mock-bin");
  mkdirSync(mockBinDir, { recursive: true });
  createExecutable(
    join(mockBinDir, "npm"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(toBashPath(npmLogPath))}
case "$*" in
${failCases}
esac
exit 0
`
  );
  // The Antigravity CLI (agy) is installed via Google's official installer,
  // downloaded to a temp file with `curl -o` (not piped, so a failed download
  // is detectable). Mock curl so tests never hit the network: it writes an
  // installer script that writes a versioned agy binary into --dir.
  const curlScript = `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ] || exit 0
${options.curlFailsFirst ? `if [ ! -f ${JSON.stringify(toBashPath(curlStatePath))} ]; then
  : > ${JSON.stringify(toBashPath(curlStatePath))}
  exit 1
fi
` : ""}cat > "$out" <<'INSTALLER'
#!/bin/sh
${options.installerFails ? "exit 1\n" : ""}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) dir="$2"; shift 2 ;;
    *) exit 1 ;;
  esac
done
mkdir -p "$dir"
cat > "$dir/agy" <<'AGY'
#!/bin/sh
echo "agy test version"
AGY
chmod 755 "$dir/agy"
INSTALLER
exit 0
`;
  createExecutable(join(mockBinDir, "curl"), curlScript);

  // Windows spells it "Path"; leaving both casings in the child env makes which
  // one wins undefined, so drop every existing spelling before setting ours.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  const inheritedPath = process.env.PATH ?? "";
  for (const key of Object.keys(childEnv)) {
    if (key.toLowerCase() === "path") delete childEnv[key];
  }
  childEnv.PATH = `${mockBinDir}${delimiter}${inheritedPath}`;
  childEnv.NPM_CONFIG_PREFIX = toBashPath(prefixDir);
  childEnv.HOME = toBashPath(homeDir);

  const result = spawnSync(shellExecutable, [toBashPath(scriptPath)], {
    cwd: repoRoot,
    env: childEnv,
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    npmLog: readFileSync(npmLogPath, { encoding: "utf8", flag: "a+" }),
    agyContent: existsSync(agyPath) ? readFileSync(agyPath, "utf8") : "",
  };
}

function runEntrypointWithFailingSeed(): { status: number | null; stdout: string; stderr: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "entrypoint-seed-failure-"));
  tempDirs.push(tempDir);

  const homeDir = join(tempDir, "home");
  const xdgConfigHome = join(tempDir, "xdg-config");
  const xdgCacheHome = join(tempDir, "xdg-cache");
  const xdgDataHome = join(tempDir, "xdg-data");
  const xdgStateHome = join(tempDir, "xdg-state");
  const npmPrefixDir = join(tempDir, "npm-global");
  const palacePath = join(tempDir, "mempalace", "palace");
  const binDir = join(tempDir, "mock-bin");
  const installScriptPath = join(tempDir, "install-llm-user-instructions.sh");
  const seedScriptPath = join(tempDir, "seed-provider-clis.sh");
  const patchedEntrypointPath = join(tempDir, "entrypoint.sh");

  mkdirSync(binDir, { recursive: true });

  createExecutable(join(binDir, "git"), "#!/bin/sh\nexit 0\n");
  createExecutable(join(binDir, "run-target"), "#!/bin/sh\nprintf 'ready\\n'\n");
  createExecutable(installScriptPath, "#!/bin/sh\nmkdir -p \"$HOME/.gemini\"\nexit 0\n");
  createExecutable(seedScriptPath, "#!/bin/sh\nexit 1\n");

  const patchedEntrypoint = readFileSync(entrypointPath, "utf8")
    .replace("/app/install-llm-user-instructions.sh", installScriptPath)
    .replace("/app/seed-provider-clis.sh", seedScriptPath);
  writeFileSync(patchedEntrypointPath, patchedEntrypoint);
  chmodSync(patchedEntrypointPath, 0o755);

  const result = spawnSync("sh", [patchedEntrypointPath, "run-target"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_STATE_HOME: xdgStateHome,
      NPM_CONFIG_PREFIX: npmPrefixDir,
      // Without this the entrypoint falls back to mkdir /data/mempalace/palace,
      // which fails with EACCES for any non-root user (e.g. a CI runner) and
      // aborts the whole script under `set -e`.
      MEMPALACE_PALACE_PATH: palacePath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runEntrypointCacheRotation(skipCacheRotation: boolean): { status: number | null; markers: Record<string, boolean> } {
  const tempDir = mkdtempSync(join(tmpdir(), "entrypoint-cache-rotation-"));
  tempDirs.push(tempDir);

  const homeDir = join(tempDir, "home");
  const xdgConfigHome = join(tempDir, "xdg-config");
  const xdgCacheHome = join(homeDir, ".cache");
  const xdgDataHome = join(tempDir, "xdg-data");
  const xdgStateHome = join(tempDir, "xdg-state");
  const npmPrefixDir = join(tempDir, "npm-global");
  const palacePath = join(tempDir, "mempalace", "palace");
  const binDir = join(tempDir, "mock-bin");
  const installScriptPath = join(tempDir, "install-llm-user-instructions.sh");
  const seedScriptPath = join(tempDir, "seed-provider-clis.sh");
  const patchedEntrypointPath = join(tempDir, "entrypoint.sh");

  mkdirSync(binDir, { recursive: true });
  createExecutable(join(binDir, "git"), "#!/bin/sh\nexit 0\n");
  createExecutable(join(binDir, "run-target"), "#!/bin/sh\nprintf 'ready\\n'\n");
  createExecutable(installScriptPath, "#!/bin/sh\nmkdir -p \"$HOME/.gemini\"\nexit 0\n");
  createExecutable(seedScriptPath, "#!/bin/sh\nexit 0\n");

  const markers = {
    npmCache: join(homeDir, ".npm", "_cacache", "marker"),
    genericCache: join(homeDir, ".cache", "marker"),
    genericCacheSubdir: join(homeDir, ".cache", "opencode", "marker"),
    // MemPalace's downloaded ONNX embedding model — expensive to refetch, so
    // the rotation must leave it alone even on a normal boot.
    mempalaceModel: join(homeDir, ".cache", "mempalace", "embeddings", "model.onnx"),
    cargoCache: join(homeDir, ".cargo", "registry", "cache", "marker"),
    opencodeDb: join(homeDir, ".local", "share", "opencode", "opencode.db"),
    codexTmp: join(homeDir, ".codex", "tmp", "marker"),
  };
  for (const markerPath of Object.values(markers)) {
    mkdirSync(join(markerPath, ".."), { recursive: true });
    writeFileSync(markerPath, "marker");
  }

  const patchedEntrypoint = readFileSync(entrypointPath, "utf8")
    .replace("/app/install-llm-user-instructions.sh", installScriptPath)
    .replace("/app/seed-provider-clis.sh", seedScriptPath);
  writeFileSync(patchedEntrypointPath, patchedEntrypoint);
  chmodSync(patchedEntrypointPath, 0o755);

  const result = spawnSync("sh", [patchedEntrypointPath, "run-target"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_STATE_HOME: xdgStateHome,
      NPM_CONFIG_PREFIX: npmPrefixDir,
      MEMPALACE_PALACE_PATH: palacePath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ...(skipCacheRotation ? { SKIP_CACHE_ROTATION: "true" } : {}),
    },
    encoding: "utf8",
  });

  return {
    status: result.status,
    markers: Object.fromEntries(Object.entries(markers).map(([key, path]) => [key, existsSync(key === "mempalaceModel" ? join(homeDir, ".cache", "agentpalace", "embeddings", "model.onnx") : path)])),
  };
}

const EXPECTED_INSTALLS = [
  "install -g @anthropic-ai/claude-code@latest",
  "install -g @openai/codex@latest",
  "install -g opencode-ai@latest",
].join("\n") + "\n";

describe("seed-provider-clis.sh", () => {
  it("bounds every Antigravity boot install stage and keeps staged replacement semantics", () => {
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain('AGY_INSTALL_TIMEOUT_SECONDS="${AGY_INSTALL_TIMEOUT_SECONDS:-120}"');
    expect(script.match(/timeout --kill-after=5s/g)).toHaveLength(3);
    expect(script).not.toContain("timeout --foreground");
    expect(script).toContain("preserving the existing binary");
  });

  it("installs the latest of every provider package on a fresh volume", () => {
    const result = runSeedProviderClis([]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.npmLog).toBe(EXPECTED_INSTALLS);
  });

  it("re-installs the latest even when the binaries already exist (no stale CLIs)", () => {
    const result = runSeedProviderClis(["claude", "codex", "agy", "opencode"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.npmLog).toBe(EXPECTED_INSTALLS);
  });

  it("reports a failed package install and keeps going", () => {
    const result = runSeedProviderClis([], ["@openai/codex"]);

    // A failed npm install is retried after cleanup; the others still install,
    // and agy installs independently via the official installer.
    expect(result.npmLog).toBe(
      [
        "install -g @anthropic-ai/claude-code@latest",
        "install -g @openai/codex@latest",
        "install -g @openai/codex@latest",
        "install -g opencode-ai@latest",
      ].join("\n") + "\n"
    );
    // After both attempts fail it surfaces as a non-zero exit + warning.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cleaning package dir and retrying");
    expect(result.stderr).toContain("@openai/codex");
  });

  it("reports a failed Antigravity download", () => {
    const result = runSeedProviderClis([], [], { curlFailsFirst: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("agy install/update failed; preserving the existing binary");
    expect(result.npmLog).toBe(EXPECTED_INSTALLS);
  });

  it("replaces an existing agy binary only after a successful staged update", () => {
    const result = runSeedProviderClis(["agy"]);

    expect(result.status).toBe(0);
    expect(result.agyContent).toContain("agy test version");
    expect(result.stderr).toBe("");
  });

  it("preserves an existing agy binary when the staged installer fails", () => {
    const result = runSeedProviderClis(["agy"], [], { installerFails: true });

    expect(result.status).toBe(1);
    expect(result.agyContent).toContain("echo old");
    expect(result.stderr).toContain("preserving the existing binary");
  });

  // Runs the real container entrypoint via `sh`, which invokes Linux-only commands
  // (returns 127 "command not found" on a Windows shell). Covered by the Linux
  // `test` job in .github/workflows/ci.yml; skipped on win32 so local `npm test`
  // reports it skipped, not failed.
  it("keeps account auth from being replaced by the API-key boot marker", () => {
    const entrypoint = readFileSync(entrypointPath, "utf8");

    expect(entrypoint).toContain(
      '[ ! -f "$HOME/.gemini/antigravity-cli/.actuarius-account-auth" ]'
    );
  });

  it.skipIf(process.platform === "win32")("continues container startup when provider seeding fails", () => {
    const result = runEntrypointWithFailingSeed();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ready\n");
    expect(result.stderr).toContain(
      "WARNING: provider CLI seeding failed; continuing startup with currently installed CLIs"
    );
  });

  it.skipIf(process.platform === "win32")("wipes caches on a normal boot but keeps the MemPalace model", () => {
    const result = runEntrypointCacheRotation(false);

    expect(result.status).toBe(0);
    expect(result.markers).toEqual({
      npmCache: false,
      genericCache: false,
      genericCacheSubdir: false,
      mempalaceModel: true,
      cargoCache: false,
      opencodeDb: false,
      codexTmp: false,
    });
  });

  it.skipIf(process.platform === "win32")("skips the cache wipe when SKIP_CACHE_ROTATION=true", () => {
    const result = runEntrypointCacheRotation(true);

    expect(result.status).toBe(0);
    expect(result.markers).toEqual({
      npmCache: true,
      genericCache: true,
      genericCacheSubdir: true,
      mempalaceModel: true,
      cargoCache: true,
      opencodeDb: true,
      codexTmp: true,
    });
  });
});
