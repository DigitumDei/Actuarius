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
        GEMINI_API_KEY: "fallback-key"
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
    expect(written.join("")).toBe("4/authorization-code\n");
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
      "stty cols 4096 2>/dev/null || true; exec agy",
      "/dev/null"
    ]);
    expect(spawnOptions?.env?.GEMINI_API_KEY).toBeUndefined();
    expect(spawnOptions?.env?.SSH_CONNECTION).toBeDefined();
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