import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import {
  AGY_INSTALL_URL,
  antigravityMcpConfigPath,
  antigravitySettingsPath,
  buildAntigravityStreamPrompt,
  detectAntigravityResultFailure,
  ensureAntigravityApiKeyConfig,
  extractAntigravityStreamResponse,
  installOrUpdateAgy
} from "../src/services/antigravityCli.js";
import { spawnCollect } from "../src/utils/spawnCollect.js";

vi.mock("../src/utils/spawnCollect.js", () => ({ spawnCollect: vi.fn() }));

const silentLogger = pino({ level: "silent" });
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "antigravity-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

function createExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

describe("extractAntigravityStreamResponse", () => {
  it("extracts the response from the terminal result event", () => {
    const stdout = [
      '{"event":"init","conversation_id":"055a398f","init":{"cwd":"/tmp"}}',
      '{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"hello\\n"}}',
      '{"event":"result","result":{"conversation_id":"055a398f","status":"SUCCESS","response":"antigravity result\\n","num_turns":1}}'
    ].join("\n");
    expect(extractAntigravityStreamResponse(stdout)).toBe("antigravity result\n");
  });

  it("uses the last result event when several turns are present", () => {
    const stdout = [
      '{"event":"result","result":{"status":"SUCCESS","response":"first\\n","num_turns":1}}',
      '{"event":"result","result":{"status":"SUCCESS","response":"second\\n","num_turns":2}}'
    ].join("\n");
    expect(extractAntigravityStreamResponse(stdout)).toBe("second\n");
  });

  it("passes plain text output through untouched (argv transport)", () => {
    expect(extractAntigravityStreamResponse("some plain response text\n")).toBe("some plain response text\n");
  });

  it("skips malformed lines and errors without a result event", () => {
    const stdout = "not json\n{ bad json }\n";
    expect(extractAntigravityStreamResponse(stdout)).toBe(stdout);
  });
});

describe("detectAntigravityResultFailure", () => {
  it("returns undefined for a SUCCESS terminal result", () => {
    const stdout = '{"event":"result","result":{"status":"SUCCESS","response":"ok\\n"}}\n';
    expect(detectAntigravityResultFailure(stdout)).toBeUndefined();
  });

  it("returns undefined for plain text output with no result event", () => {
    expect(detectAntigravityResultFailure("plain agy output\n")).toBeUndefined();
  });

  it("flags a non-SUCCESS terminal status with its error message", () => {
    const stdout = '{"event":"result","result":{"status":"ERROR","response":"","error":"invalid model selection"}}\n';
    expect(detectAntigravityResultFailure(stdout)).toEqual({
      status: "ERROR",
      error: "invalid model selection"
    });
  });

  it("flags CANCELED and other non-success statuses", () => {
    expect(detectAntigravityResultFailure('{"event":"result","result":{"status":"CANCELED"}}\n')).toEqual({
      status: "CANCELED"
    });
  });

  it("uses the last result event when several turns are present", () => {
    const stdout = [
      '{"event":"result","result":{"status":"SUCCESS","response":"first\\n"}}',
      '{"event":"result","result":{"status":"INTERRUPTED","error":"^C"}}'
    ].join("\n");
    expect(detectAntigravityResultFailure(stdout)).toEqual({ status: "INTERRUPTED", error: "^C" });
  });
});

describe("buildAntigravityStreamPrompt", () => {
  it("renders a user event with the plain-text content", () => {
    const parsed = JSON.parse(buildAntigravityStreamPrompt("hello world")) as {
      event: string;
      message: { content: string };
    };
    expect(parsed.event).toBe("user");
    expect(parsed.message.content).toBe("hello world");
    expect(buildAntigravityStreamPrompt("x")).toMatch(/\n$/);
  });
});

describe("ensureAntigravityApiKeyConfig", () => {
  it("bootstraps the settings file with modelProvider when absent", async () => {
    const home = makeHome();
    await ensureAntigravityApiKeyConfig(silentLogger, home);
    const settings = JSON.parse(readFileSync(antigravitySettingsPath(home), "utf8")) as {
      modelProvider?: string;
    };
    expect(settings.modelProvider).toBe("gemini");
  });

  it("preserves unrelated settings when merging modelProvider", async () => {
    const home = makeHome();
    mkdirSync(dirname(antigravitySettingsPath(home)), { recursive: true });
    writeFileSync(
      antigravitySettingsPath(home),
      JSON.stringify({ permissions: { allow: ["command(git)"] }, rendering: { theme: "dark" } })
    );
    await ensureAntigravityApiKeyConfig(silentLogger, home);
    const settings = JSON.parse(readFileSync(antigravitySettingsPath(home), "utf8")) as {
      modelProvider?: string;
      permissions: { allow: string[] };
      rendering: { theme: string };
    };
    expect(settings.modelProvider).toBe("gemini");
    expect(settings.permissions.allow).toEqual(["command(git)"]);
    expect(settings.rendering.theme).toBe("dark");
  });

  it("leaves a malformed existing file untouched", async () => {
    const home = makeHome();
    mkdirSync(dirname(antigravitySettingsPath(home)), { recursive: true });
    writeFileSync(antigravitySettingsPath(home), "not-json{");
    await ensureAntigravityApiKeyConfig(silentLogger, home);
    expect(readFileSync(antigravitySettingsPath(home), "utf8")).toBe("not-json{");
  });

  it("removes only a stale API-key selector for account auth", async () => {
    const home = makeHome();
    mkdirSync(dirname(antigravitySettingsPath(home)), { recursive: true });
    writeFileSync(antigravitySettingsPath(home), JSON.stringify({
      modelProvider: "gemini",
      permissions: { allow: ["command(git)"] }
    }));

    await ensureAntigravityApiKeyConfig(silentLogger, home, false);

    expect(JSON.parse(readFileSync(antigravitySettingsPath(home), "utf8"))).toEqual({
      permissions: { allow: ["command(git)"] }
    });
  });

  it("does not create settings for account auth when none exists", async () => {
    const home = makeHome();
    await ensureAntigravityApiKeyConfig(silentLogger, home, false);
    expect(() => readFileSync(antigravitySettingsPath(home), "utf8")).toThrow();
  });
});

describe("installOrUpdateAgy", () => {
  it("downloads the official installer and runs it with the documented skip flags", async () => {
    const home = makeHome();
    vi.mocked(spawnCollect).mockImplementation(async (file, args) => {
      if (file === "bash") {
        const dir = args[2];
        expect(args[1]).toBe("--dir");
        createExecutable(`${dir}/agy`, "#!/bin/sh\necho new\n");
        return { stdout: "installed", stderr: "" };
      }
      if (typeof file === "string" && file.includes(".agy-staging-")) {
        return { stdout: "agy 1.0.0", stderr: "" };
      }
      return { stdout: "downloaded", stderr: "" };
    });

    const result = await installOrUpdateAgy({ env: { HOME: home }, targetPath: join(home, ".local/bin/agy") });

    const [downloadFile, downloadArgs] = vi.mocked(spawnCollect).mock.calls[0]!;
    expect(downloadFile).toBe("curl");
    expect(downloadArgs).toContain(AGY_INSTALL_URL);
    expect(downloadArgs).toContain("-o");

    const [runnerFile, runnerArgs] = vi.mocked(spawnCollect).mock.calls[1]!;
    expect(runnerFile).toBe("bash");
    expect(runnerArgs).toEqual([expect.stringContaining("install.sh"), "--dir", expect.stringContaining(".agy-staging-")]);
    expect(vi.mocked(spawnCollect)).toHaveBeenCalledTimes(3);
    expect(result.stdout).toContain("installed");
  });

  it("preserves an existing binary when the installer fails", async () => {
    const home = makeHome();
    const targetPath = join(home, ".local/bin/agy");
    mkdirSync(dirname(targetPath), { recursive: true });
    createExecutable(targetPath, "#!/bin/sh\necho old\n");
    vi.mocked(spawnCollect)
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("installer failed"));

    await expect(installOrUpdateAgy({ env: { HOME: home }, targetPath })).rejects.toThrow("installer failed");
    expect(readFileSync(targetPath, "utf8")).toContain("old");
  });
});

describe("path helpers", () => {
  it("points at the dedicated settings and MCP config files", () => {
    const home = "/data/home/appuser";
    expect(antigravitySettingsPath(home)).toBe(join(home, ".gemini", "antigravity-cli", "settings.json"));
    expect(antigravityMcpConfigPath(home)).toBe(join(home, ".gemini", "config", "mcp_config.json"));
  });
});
