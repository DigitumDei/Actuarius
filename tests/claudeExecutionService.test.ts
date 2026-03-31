import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";

vi.mock("../src/utils/spawnCollect.js");

const { spawnCollect } = await import("../src/utils/spawnCollect.js");
const mockSpawnCollect = vi.mocked(spawnCollect);
const { extractTextFromClaudeJson, runClaudeRequest } = await import("../src/services/claudeExecutionService.js");

const logger = pino({ level: "silent" });

describe("extractTextFromClaudeJson", () => {
  it("extracts direct result field", () => {
    expect(extractTextFromClaudeJson({ result: "done" })).toBe("done");
  });

  it("extracts text blocks from content array", () => {
    const value = extractTextFromClaudeJson({
      content: [{ text: "line1" }, { type: "tool" }, { text: "line2" }]
    });
    expect(value).toBe("line1\nline2");
  });

  it("returns null for unsupported payload", () => {
    expect(extractTextFromClaudeJson({})).toBeNull();
  });
});

describe("runClaudeRequest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("passes scoped env vars to the Claude CLI", async () => {
    mockSpawnCollect.mockResolvedValueOnce({ stdout: "{\"result\":\"ok\"}", stderr: "" });

    await runClaudeRequest({ prompt: "hello", cwd: "/tmp", timeoutMs: 5000, env: { PATH: "/scoped/bin" } }, logger);

    expect(mockSpawnCollect).toHaveBeenCalledWith(
      "claude",
      ["-p", "hello", "--output-format", "json", "--permission-mode", "bypassPermissions"],
      expect.objectContaining({
        env: { PATH: "/scoped/bin" }
      })
    );
  });
});
