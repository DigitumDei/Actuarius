import { describe, expect, it } from "vitest";
import { CodexExecutionError } from "../src/services/codexExecutionService.js";

describe("CodexExecutionError", () => {
  it("constructs with CODEX_UNAVAILABLE code", () => {
    const error = new CodexExecutionError("CODEX_UNAVAILABLE", "not found");
    expect(error.code).toBe("CODEX_UNAVAILABLE");
    expect(error.message).toBe("not found");
    expect(error.name).toBe("CodexExecutionError");
    expect(error).toBeInstanceOf(Error);
  });

  it("constructs with CODEX_DISABLED code", () => {
    const error = new CodexExecutionError("CODEX_DISABLED", "disabled");
    expect(error.code).toBe("CODEX_DISABLED");
    expect(error.message).toBe("disabled");
  });

  it("constructs with TIMEOUT code", () => {
    const error = new CodexExecutionError("TIMEOUT", "timed out");
    expect(error.code).toBe("TIMEOUT");
  });

  it("constructs with FAILED code", () => {
    const error = new CodexExecutionError("FAILED", "failed");
    expect(error.code).toBe("FAILED");
  });

  it("constructs with EMPTY_OUTPUT code", () => {
    const error = new CodexExecutionError("EMPTY_OUTPUT", "empty");
    expect(error.code).toBe("EMPTY_OUTPUT");
  });
});
