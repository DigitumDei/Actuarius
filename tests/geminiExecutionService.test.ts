import { describe, expect, it } from "vitest";
import { GeminiExecutionError } from "../src/services/geminiExecutionService.js";

describe("GeminiExecutionError", () => {
  it("constructs with GEMINI_UNAVAILABLE code", () => {
    const error = new GeminiExecutionError("GEMINI_UNAVAILABLE", "not found");
    expect(error.code).toBe("GEMINI_UNAVAILABLE");
    expect(error.message).toBe("not found");
    expect(error.name).toBe("GeminiExecutionError");
    expect(error).toBeInstanceOf(Error);
  });

  it("constructs with GEMINI_DISABLED code", () => {
    const error = new GeminiExecutionError("GEMINI_DISABLED", "disabled");
    expect(error.code).toBe("GEMINI_DISABLED");
    expect(error.message).toBe("disabled");
  });

  it("constructs with TIMEOUT code", () => {
    const error = new GeminiExecutionError("TIMEOUT", "timed out");
    expect(error.code).toBe("TIMEOUT");
  });

  it("constructs with FAILED code", () => {
    const error = new GeminiExecutionError("FAILED", "failed");
    expect(error.code).toBe("FAILED");
  });

  it("constructs with EMPTY_OUTPUT code", () => {
    const error = new GeminiExecutionError("EMPTY_OUTPUT", "empty");
    expect(error.code).toBe("EMPTY_OUTPUT");
  });
});
