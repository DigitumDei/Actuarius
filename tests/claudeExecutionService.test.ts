import { describe, expect, it } from "vitest";
import { extractTextFromClaudeJson } from "../src/services/claudeExecutionService.js";

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

