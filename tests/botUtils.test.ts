import { describe, expect, it, vi } from "vitest";
import { splitPlainTextForDiscord, isProviderTimeout, buildTimeoutReportInner } from "../src/discord/bot.js";
import { ClaudeExecutionError } from "../src/services/claudeExecutionService.js";
import { CodexExecutionError } from "../src/services/codexExecutionService.js";
import { GeminiExecutionError } from "../src/services/geminiExecutionService.js";
import { OpencodeExecutionError } from "../src/services/opencodeExecutionService.js";

vi.mock("../src/services/gitWorkspaceService.js", () => ({
  getDefaultBranchBaseRef: vi.fn().mockResolvedValue("origin/main"),
  getCommitsSinceBaseRef: vi.fn().mockResolvedValue(["abc123 first commit", "def456 second commit"]),
  getShortStatus: vi.fn().mockResolvedValue(" M src/index.ts"),
  getUnstagedDiffSummary: vi.fn().mockResolvedValue("diff --git a/src/index.ts b/src/index.ts\n+change"),
  getStagedDiffSummary: vi.fn().mockResolvedValue("diff --git a/src/staged.ts b/src/staged.ts\n+staged"),
}));

describe("splitPlainTextForDiscord", () => {
  it("returns ['(no content)'] for empty input", () => {
    expect(splitPlainTextForDiscord("")).toEqual(["(no content)"]);
  });

  it("returns the text as a single chunk when it fits in the first message limit", () => {
    const text = "hello world";
    const chunks = splitPlainTextForDiscord(text);
    expect(chunks).toEqual(["hello world"]);
  });

  it("includes a header in the first chunk when provided", () => {
    const chunks = splitPlainTextForDiscord("body", "**Header**");
    expect(chunks).toEqual(["**Header**\n\nbody"]);
  });

  it("only emits the header when the body is empty", () => {
    const chunks = splitPlainTextForDiscord("", "**Header**");
    expect(chunks).toEqual(["**Header**"]);
  });

  it("splits at a newline boundary for text exceeding the first message limit", () => {
    const longLine = "a".repeat(500);
    const text = `${longLine}\n${"b".repeat(100)}`;
    const chunks = splitPlainTextForDiscord(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("preserves balanced fence markers across chunks (the regression case)", () => {
    const text = "```\nfenced content\n```\ntrailing text";
    const chunks = splitPlainTextForDiscord(text);
    const totalMarkers = chunks.reduce((sum, c) => {
      let count = 0;
      let idx = 0;
      while (true) {
        const pos = c.indexOf("```", idx);
        if (pos === -1) break;
        count++;
        idx = pos + 3;
      }
      return sum + count;
    }, 0);
    expect(totalMarkers % 2 === 0).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("handles multiple fenced blocks", () => {
    const text = "```\nblock 1\n```\n\n```\nblock 2\n```";
    const chunks = splitPlainTextForDiscord(text);
    const totalMarkers = chunks.reduce((sum, c) => {
      let count = 0;
      let idx = 0;
      while (true) {
        const pos = c.indexOf("```", idx);
        if (pos === -1) break;
        count++;
        idx = pos + 3;
      }
      return sum + count;
    }, 0);
    expect(totalMarkers % 2 === 0).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("handles fence at offset zero (no leading newline)", () => {
    const text = "```\nfence at start\n```";
    const chunks = splitPlainTextForDiscord(text);
    const totalMarkers = chunks.reduce((sum, c) => {
      let count = 0;
      let idx = 0;
      while (true) {
        const pos = c.indexOf("```", idx);
        if (pos === -1) break;
        count++;
        idx = pos + 3;
      }
      return sum + count;
    }, 0);
    expect(totalMarkers % 2 === 0).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("splits a very long message into multiple non-empty chunks", () => {
    const longBody = "word ".repeat(5000);
    const chunks = splitPlainTextForDiscord(longBody, "**Header**");
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("handles oversized single fenced block opening at offset 0 (no chunk has unbalanced fence)", () => {
    const longFence = "```\n" + "a".repeat(2500) + "\n```";
    const chunks = splitPlainTextForDiscord(longFence);
    for (const chunk of chunks) {
      let count = 0;
      let idx = 0;
      while (true) {
        const pos = chunk.indexOf("```", idx);
        if (pos === -1) break;
        count++;
        idx = pos + 3;
      }
      expect(count % 2 === 0).toBe(true);
    }
  });
});

describe("isProviderTimeout", () => {
  it("returns true for ClaudeExecutionError with TIMEOUT code", () => {
    const error = new ClaudeExecutionError("TIMEOUT", "timed out");
    expect(isProviderTimeout(error)).toBe(true);
  });

  it("returns true for CodexExecutionError with TIMEOUT code", () => {
    const error = new CodexExecutionError("TIMEOUT", "timed out");
    expect(isProviderTimeout(error)).toBe(true);
  });

  it("returns true for GeminiExecutionError with TIMEOUT code", () => {
    const error = new GeminiExecutionError("TIMEOUT", "timed out");
    expect(isProviderTimeout(error)).toBe(true);
  });

  it("returns true for OpencodeExecutionError with TIMEOUT code", () => {
    const error = new OpencodeExecutionError("TIMEOUT", "timed out");
    expect(isProviderTimeout(error)).toBe(true);
  });

  it("returns false for ClaudeExecutionError with non-TIMEOUT code", () => {
    const error = new ClaudeExecutionError("FAILED", "failed");
    expect(isProviderTimeout(error)).toBe(false);
  });

  it("returns false for CodexExecutionError with non-TIMEOUT code", () => {
    const error = new CodexExecutionError("EMPTY_OUTPUT", "empty");
    expect(isProviderTimeout(error)).toBe(false);
  });

  it("returns false for GeminiExecutionError with non-TIMEOUT code", () => {
    const error = new GeminiExecutionError("NOT_AUTHENTICATED", "not auth");
    expect(isProviderTimeout(error)).toBe(false);
  });

  it("returns false for OpencodeExecutionError with non-TIMEOUT code", () => {
    const error = new OpencodeExecutionError("FAILED", "failed");
    expect(isProviderTimeout(error)).toBe(false);
  });

  it("returns false for a plain Error", () => {
    const error = new Error("something else");
    expect(isProviderTimeout(error)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isProviderTimeout(null)).toBe(false);
  });
});

describe("buildTimeoutReportInner", () => {
  it("returns fallback string when no partial output or workspace info", async () => {
    const report = await buildTimeoutReportInner(
      { partialStdout: undefined, partialStderr: undefined },
      null,
      null,
      "Codex"
    );
    expect(report).toBe("Codex execution timed out. No partial output or worktree changes were captured.");
  });

  it("includes partial stdout and stderr in fenced code blocks", async () => {
    const err = { partialStdout: "some output", partialStderr: "some error" };
    const report = await buildTimeoutReportInner(err, null, null, "Codex");
    expect(report).toContain("**Partial output (stdout):**");
    expect(report).toContain("```");
    expect(report).toContain("some output");
    expect(report).toContain("**Partial error output (stderr):**");
    expect(report).toContain("some error");
  });

  it("includes staged and unstaged diff sections when worktreePath is given", async () => {
    const report = await buildTimeoutReportInner(
      {},
      "/tmp/worktree",
      "ask/1-123",
      "Codex"
    );
    expect(report).toContain("**Working tree status:**");
    expect(report).toContain("**Unstaged changes:**");
    expect(report).toContain("**Staged changes:**");
    expect(report).toContain("**Commits on `ask/1-123` (since origin/main):**");
  });

  it("skips commits section when branchName is null (detached worktree)", async () => {
    const report = await buildTimeoutReportInner(
      {},
      "/tmp/worktree",
      null,
      "Codex"
    );
    expect(report).toContain("**Working tree status:**");
    expect(report).toContain("**Unstaged changes:**");
    expect(report).toContain("**Staged changes:**");
    expect(report).not.toContain("**Commits on");
  });

  it("returns fallback when worktreePath is null and no partial output", async () => {
    const report = await buildTimeoutReportInner({}, null, null, "Codex");
    expect(report).toBe("Codex execution timed out. No partial output or worktree changes were captured.");
  });

  it("escapes embedded triple backticks in partial output", async () => {
    const err = { partialStdout: "some text with ``` in it", partialStderr: "" };
    const report = await buildTimeoutReportInner(err, null, null, "Codex");
    expect(report).toContain("`\u200B``");
    const openCount = (report.match(/```/gu) || []).length;
    expect(openCount % 2 === 0).toBe(true);
  });

  it("escapes embedded triple backticks in status section", async () => {
    const getShortStatus = (await import("../src/services/gitWorkspaceService.js")).getShortStatus;
    vi.mocked(getShortStatus).mockResolvedValueOnce(" M src/```dangerous```.ts");
    const report = await buildTimeoutReportInner({}, "/tmp/worktree", null, "Codex");
    expect(report).toContain("`\u200B``");
    const openCount = (report.match(/```/gu) || []).length;
    expect(openCount % 2 === 0).toBe(true);
  });

  it("uses tail-truncation for stderr (latest lines preserved)", async () => {
    const longStderr = "line1\nline2\n" + "middle\n".repeat(400) + "last-significant-line";
    const err = { partialStdout: "stdout content", partialStderr: longStderr };
    const report = await buildTimeoutReportInner(err, null, null, "Codex");
    const stderrSection = report.slice(report.indexOf("**Partial error output (stderr):**"));
    expect(stderrSection).toContain("last-significant-line");
    expect(stderrSection).toContain("(truncated)");
    expect(stderrSection).not.toContain("line1");
  });

  it("renders only partial output sections when git helpers return empty", async () => {
    const getDefaultBranchBaseRef = (await import("../src/services/gitWorkspaceService.js")).getDefaultBranchBaseRef;
    const getCommitsSinceBaseRef = (await import("../src/services/gitWorkspaceService.js")).getCommitsSinceBaseRef;
    const getShortStatus = (await import("../src/services/gitWorkspaceService.js")).getShortStatus;
    const getUnstagedDiffSummary = (await import("../src/services/gitWorkspaceService.js")).getUnstagedDiffSummary;
    const getStagedDiffSummary = (await import("../src/services/gitWorkspaceService.js")).getStagedDiffSummary;
    vi.mocked(getDefaultBranchBaseRef).mockResolvedValueOnce("origin/main");
    vi.mocked(getCommitsSinceBaseRef).mockResolvedValueOnce([]);
    vi.mocked(getShortStatus).mockResolvedValueOnce("");
    vi.mocked(getUnstagedDiffSummary).mockResolvedValueOnce("");
    vi.mocked(getStagedDiffSummary).mockResolvedValueOnce("");
    const err = { partialStdout: "some stdout output", partialStderr: "some stderr output" };
    const report = await buildTimeoutReportInner(err, "/tmp/worktree", "ask/1-123", "Codex");
    expect(report).toContain("**Partial output (stdout):**");
    expect(report).toContain("**Partial error output (stderr):**");
    expect(report).not.toContain("**Working tree status:**");
    expect(report).not.toContain("**Unstaged changes:**");
    expect(report).not.toContain("**Staged changes:**");
    expect(report).not.toContain("**Commits on");
  });

  it("passes worktreePath to git helpers", async () => {
    const getDefaultBranchBaseRef = (await import("../src/services/gitWorkspaceService.js")).getDefaultBranchBaseRef;
    const getShortStatus = (await import("../src/services/gitWorkspaceService.js")).getShortStatus;
    const getUnstagedDiffSummary = (await import("../src/services/gitWorkspaceService.js")).getUnstagedDiffSummary;
    const getStagedDiffSummary = (await import("../src/services/gitWorkspaceService.js")).getStagedDiffSummary;
    await buildTimeoutReportInner({}, "/my/worktree", "ask/1-123", "Codex");
    expect(vi.mocked(getDefaultBranchBaseRef)).toHaveBeenCalledWith("/my/worktree", undefined);
    expect(vi.mocked(getShortStatus)).toHaveBeenCalledWith("/my/worktree", undefined);
    expect(vi.mocked(getUnstagedDiffSummary)).toHaveBeenCalledWith("/my/worktree", undefined);
    expect(vi.mocked(getStagedDiffSummary)).toHaveBeenCalledWith("/my/worktree", undefined);
  });
});
