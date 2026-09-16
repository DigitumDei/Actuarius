import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

vi.mock("../src/services/antigravityCli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/antigravityCli.js")>();
  return {
    ...actual,
    ensureAntigravityApiKeyConfig: vi.fn().mockResolvedValue(undefined),
    prefersAntigravityAccountAuth: vi.fn().mockResolvedValue(false),
    setAntigravityAccountAuthPreference: vi.fn().mockResolvedValue(undefined)
  };
});

vi.mock("../src/utils/spawnCollect.js", () => ({
  signalChildTree: vi.fn((child: { killed: boolean }) => {
    child.killed = true;
  })
}));

const { spawn } = await import("node:child_process");
const {
  ensureAntigravityApiKeyConfig,
  prefersAntigravityAccountAuth,
  setAntigravityAccountAuthPreference
} = await import("../src/services/antigravityCli.js");
const { signalChildTree } = await import("../src/utils/spawnCollect.js");
const {
  parseAntigravityGoogleAuthUrl,
  startAntigravityGoogleAuth
} = await import("../src/services/antigravityAuthService.js");

const logger = pino({ level: "silent" });

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 321;
  child.killed = false;
  child.kill = vi.fn();
  return child;
}

describe("parseAntigravityGoogleAuthUrl", () => {
  it("extracts an ANSI-decorated Google sign-in URL", () => {
    const output = "\u001b[36mOpen https://accounts.google.com/o/oauth2/auth?client_id=abc&state=xyz\u001b[0m";

    expect(parseAntigravityGoogleAuthUrl(output)).toBe(
      "https://accounts.google.com/o/oauth2/auth?client_id=abc&state=xyz"
    );
  });

  it("keeps cursor-separated OAuth URL redraws from merging their parameters", () => {
    const url = "https://accounts.google.com/oauth?client_id=abc&state=xyz";
    const output = url + "\u001b[1;1H\u001b[36m" + url + "\u001b[0m";

    expect(parseAntigravityGoogleAuthUrl(output)).toBe(url);
  });

  it("reads an OSC hyperlink target without joining it to its visible label", () => {
    const url = "https://accounts.google.com/oauth?client_id=abc&state=xyz";
    const output = "\u001b]8;;" + url + "\u001b\\" + url + "\u001b]8;;\u001b\\";

    expect(parseAntigravityGoogleAuthUrl(output)).toBe(url);
  });

  it("does not join adjacent copies of a rendered Google URI", () => {
    const url = "https://accounts.google.com/oauth?client_id=abc&state=xyz";

    expect(parseAntigravityGoogleAuthUrl(url + url)).toBe(url);
  });

  it("does not accept a lookalike host", () => {
    expect(
      parseAntigravityGoogleAuthUrl("https://accounts.google.com.evil.example/oauth")
    ).toBeUndefined();
  });
});

describe("startAntigravityGoogleAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prefersAntigravityAccountAuth).mockResolvedValue(false);
    vi.mocked(ensureAntigravityApiKeyConfig).mockResolvedValue(undefined);
    vi.mocked(setAntigravityAccountAuthPreference).mockResolvedValue(undefined);
  });

  it("relays the Google code through the same PTY session and persists account preference", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const pending = startAntigravityGoogleAuth({
      cwd: "/workspace",
      logger,
      env: {
        HOME: "/data/home/appuser",
        PATH: "/bin",
        GEMINI_API_KEY: "fallback-key",
        DISCORD_TOKEN: "discord-secret",
        GITHUB_APP_PRIVATE_KEY: "github-secret",
        OPENAI_API_KEY: "openai-secret",
        MEMPALACE_REMOTE_TOKEN: "palace-secret",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/bus",
        GNOME_KEYRING_CONTROL: "/run/user/keyring",
        XDG_DATA_HOME: "/data/home/appuser/.local/share",
        HTTPS_PROXY: "https://proxy.example:443"
      }
    });
    child.stdout.write(
      "Visit https://accounts.google.com/o/oauth2/auth?client_id=abc&state=xyz\r\n"
    );
    const session = await pending;

    const written: string[] = [];
    child.stdin.on("data", (chunk) => written.push(chunk.toString()));
    const completion = session.complete("4/authorization-code");
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write("Authentication successful\r\n");
    await completion;

    expect(session.url).toContain("https://accounts.google.com/");
    expect(written.join("")).toBe("4/authorization-code\r");
    expect(setAntigravityAccountAuthPreference).toHaveBeenCalledWith(
      true,
      "/data/home/appuser"
    );
    expect(ensureAntigravityApiKeyConfig).toHaveBeenLastCalledWith(
      logger,
      "/data/home/appuser",
      false
    );
    expect(signalChildTree).toHaveBeenCalledWith(child, "SIGTERM");

    const [file, args, spawnOptions] = vi.mocked(spawn).mock.calls[0]!;
    expect(file).toBe("script");
    expect(args).toEqual([
      "-qefc",
      "stty -echo -echonl rows 40 cols 4096 && exec agy",
      "/dev/null"
    ]);
    expect(spawnOptions?.env?.GEMINI_API_KEY).toBeUndefined();
    expect(spawnOptions?.env?.SSH_CONNECTION).toBeDefined();
    expect(spawnOptions?.env?.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/bus");
    expect(spawnOptions?.env?.GNOME_KEYRING_CONTROL).toBe("/run/user/keyring");
    expect(spawnOptions?.env?.HTTPS_PROXY).toBe("https://proxy.example:443");
    for (const key of [
      "DISCORD_TOKEN", "GITHUB_APP_PRIVATE_KEY", "OPENAI_API_KEY", "MEMPALACE_REMOTE_TOKEN"
    ]) {
      expect(spawnOptions?.env).not.toHaveProperty(key);
    }
  });

  it("selects the displayed Google OAuth method once before waiting for its URL", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const written: string[] = [];
    child.stdin.on("data", (chunk) => written.push(chunk.toString()));
    const pending = startAntigravityGoogleAuth({ cwd: "/workspace", logger });
    child.stdout.write("Select login method:\r\n > 1. Goo");
    await new Promise((resolve) => setImmediate(resolve));
    expect(written).toEqual([]);
    child.stdout.write("gle OAuth\r\n 2. Use a Google Cloud project\r\n");
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write("Select login method:\r\n > 1. Google OAuth\r\n");
    child.stdout.write("https://accounts.google.com/oauth?state=selected\r\n");
    const session = await pending;

    expect(written).toEqual(["\r"]);
    expect(setAntigravityAccountAuthPreference).not.toHaveBeenCalled();
    await session.cancel();
  });

  it.skipIf(process.platform === "win32")("uses a real PTY with rows and Enter to pass the OAuth menu and code prompt", async () => {
    const { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { signalChildTree: realSignal } = await vi.importActual<typeof import("../src/utils/spawnCollect.js")>("../src/utils/spawnCollect.js");
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "actuarius-auth-pty-"));
    let session: Awaited<ReturnType<typeof startAntigravityGoogleAuth>> | undefined;
    try {
      await writeFile(join(directory, "agy"), [
        "#!/bin/sh",
        "set -- $(stty size)",
        'if [ "$1" -eq 0 ]; then echo "TTY has no rows"; exit 1; fi',
        "stty raw -echo -echonl",
        "printf 'Select login method:\\n > 1. Google OAuth\\n'",
        "key=$(dd bs=1 count=1 2>/dev/null)",
        '[ "$key" = "$(printf \'\\r\')" ] || exit 2',
        "printf 'https://accounts.google.com/oauth?state=real-pty\\n'",
        "code=$(dd bs=1 count=11 2>/dev/null)",
        '[ "$code" = "$(printf \'valid-code\\r\')" ] || exit 3',
        "printf 'Welcome to Antigravity CLI!\\nChoose your color scheme:\\n'"
      ].join("\n"), { mode: 0o700 });
      vi.mocked(spawn).mockImplementation(realSpawn as typeof spawn);
      vi.mocked(signalChildTree).mockImplementation(realSignal);
      session = await startAntigravityGoogleAuth({
        cwd: directory, logger,
        env: { HOME: directory, PATH: directory + ":" + process.env.PATH },
        urlTimeoutMs: 2_000, completionTimeoutMs: 2_000
      });
      await session.complete("valid-code");

      expect(session.url).toContain("state=real-pty");
      expect(setAntigravityAccountAuthPreference).toHaveBeenCalledWith(true, directory);
    } finally {
      await session?.cancel();
      vi.mocked(spawn).mockReset();
      vi.mocked(signalChildTree).mockImplementation((child) => { child.killed = true; });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recognizes authenticated first-run setup after code submission in a wide redraw", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const pending = startAntigravityGoogleAuth({ cwd: "/workspace", logger });
    child.stdout.write("https://accounts.google.com/oauth?state=first-run\n");
    const session = await pending;
    const completion = session.complete("4/valid-code");
    child.stdout.write("\u001b[1;1HWelcome to Antigravity CLI!");
    child.stdout.write("\u001b[2;1HChoose your color scheme:" + "─".repeat(70_000));
    await completion;

    expect(session.alreadyAuthenticated).toBe(false);
    expect(setAntigravityAccountAuthPreference).toHaveBeenCalledWith(true, expect.any(String));
  });

  it("returns an authenticated account when cached login reaches first-run setup without an OAuth URL", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const pending = startAntigravityGoogleAuth({ cwd: "/workspace", logger });
    child.stdout.write("Welcome to the Antigravity CLI. You are currently not signed in.\nSigning in...\n");
    child.stdout.write("Welcome to Antigravity CLI!\nChoose your color scheme:\n");
    const session = await pending;

    expect(session.alreadyAuthenticated).toBe(true);
    expect(session.url).toBe("");
    expect(session.isActive()).toBe(false);
    expect(setAntigravityAccountAuthPreference).toHaveBeenCalledWith(true, expect.any(String));
    expect(signalChildTree).toHaveBeenCalledWith(child, "SIGTERM");
  });

  it("reports a failed Google code exchange immediately without persisting account preference", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const pending = startAntigravityGoogleAuth({ cwd: "/workspace", logger });
    child.stdout.write("https://accounts.google.com/oauth?state=rejected-code\n");
    const session = await pending;
    const completion = session.complete("4/invalid-code");
    const failure = expect(completion).rejects.toMatchObject({ code: "FAILED" });
    child.stdout.write('Got an error: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."\nPress any key to go back.');
    await failure;

    expect(session.isActive()).toBe(false);
    expect(setAntigravityAccountAuthPreference).not.toHaveBeenCalled();
    expect(signalChildTree).toHaveBeenCalledWith(child, "SIGTERM");
  });

  it("does not accept an unauthenticated welcome-screen redraw as login success", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const pending = startAntigravityGoogleAuth({ cwd: "/workspace", logger });
    child.stdout.write("https://accounts.google.com/oauth?state=negative-redraw\n");
    const session = await pending;
    const completion = session.complete("valid-code");
    const failure = expect(completion).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    child.stdout.write("Welcome to the Antigravity CLI. You are currently not signed in.\n");
    await new Promise((resolve) => setImmediate(resolve));

    expect(setAntigravityAccountAuthPreference).not.toHaveBeenCalled();
    await session.cancel();
    await failure;
  });

  it.each(["signed in", "\u001b[?1049h", "code\tvalue"])(
    "rejects input that could impersonate successful output: %j",
    async (code) => {
      const child = createMockChild();
      vi.mocked(spawn).mockReturnValue(child as never);
      const pending = startAntigravityGoogleAuth({ cwd: "/workspace", logger });
      child.stdout.write("https://accounts.google.com/oauth?state=invalid-input\n");
      const session = await pending;
      const write = vi.spyOn(child.stdin, "write");

      await expect(session.complete(code)).rejects.toThrow("authorization code is invalid");

      expect(write).not.toHaveBeenCalled();
      expect(setAntigravityAccountAuthPreference).not.toHaveBeenCalled();
      await session.cancel();
    }
  );

  it("terminates and restores a login cancelled before its URL arrives", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const controller = new AbortController();
    const pending = startAntigravityGoogleAuth({
      cwd: "/workspace",
      logger,
      env: { HOME: "/data/home/appuser", GEMINI_API_KEY: "fallback-key" },
      signal: controller.signal
    });
    const failure = expect(pending).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await new Promise((resolve) => setImmediate(resolve));

    controller.abort();
    await failure;

    expect(signalChildTree).toHaveBeenCalledWith(child, "SIGTERM");
    expect(ensureAntigravityApiKeyConfig).toHaveBeenLastCalledWith(
      logger, "/data/home/appuser", true
    );
    expect(setAntigravityAccountAuthPreference).not.toHaveBeenCalled();
  });

  it("does not spawn when shutdown has already cancelled the login", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(startAntigravityGoogleAuth({
      cwd: "/workspace", logger, signal: controller.signal
    })).rejects.toMatchObject({ code: "SESSION_EXPIRED" });

    expect(spawn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("keeps submitted input out of a real PTY's output", async () => {
    const { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
    const child = realSpawn("script", [
      "-qefc",
      "stty -echo -echonl cols 4096 && printf 'ready\n' && IFS= read -r code && printf 'validated\n'",
      "/dev/null"
    ], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let submitted = false;
    const result = await new Promise<string>((resolve, reject) => {
      const deadline = setTimeout(() => {
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
        reject(new Error("PTY echo test timed out"));
      }, 5_000);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (!submitted && output.includes("ready")) {
          submitted = true;
          child.stdin.write("signed in\n");
        }
      });
      child.stderr.on("data", (chunk) => { output += chunk.toString(); });
      child.once("error", (error) => { clearTimeout(deadline); reject(error); });
      child.once("close", (code) => {
        clearTimeout(deadline);
        if (code === 0) resolve(output);
        else reject(new Error("PTY echo test exited with code " + String(code)));
      });
    });

    expect(result).toContain("validated");
    expect(result).not.toContain("signed in");
  });

  it("restores API-key mode when an unfinished login is cancelled", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const pending = startAntigravityGoogleAuth({
      cwd: "/workspace",
      logger,
      env: {
        HOME: "/data/home/appuser",
        GEMINI_API_KEY: "fallback-key"
      }
    });
    child.stderr.write("https://accounts.google.com/o/oauth2/auth?state=abc\n");
    const session = await pending;

    await session.cancel();

    expect(ensureAntigravityApiKeyConfig).toHaveBeenLastCalledWith(
      logger,
      "/data/home/appuser",
      true
    );
    expect(setAntigravityAccountAuthPreference).not.toHaveBeenCalled();
  });
});