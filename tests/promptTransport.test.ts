import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  estimateArgvBytes,
  estimateEnvBytes,
  estimateSpawnPayloadBytes,
  DEFAULT_ARGV_TOTAL_LIMIT,
  decidePromptTransport,
  writeTempPromptFile,
  cleanupTempPromptFile,
  type TempPromptFile,
} from "../src/utils/spawnCollect.js";

describe("estimateArgvBytes", () => {
  it("returns 0 for an empty array", () => {
    expect(estimateArgvBytes([])).toBe(0);
  });

  it("counts each arg as UTF-8 bytes plus null terminator", () => {
    // "hello" = 5 bytes + 1 null = 6 per arg
    expect(estimateArgvBytes(["hello", "world"])).toBe(12);
  });

  it("handles multi-byte UTF-8 characters", () => {
    // "héllo" = 6 bytes + 1 null = 7
    // "café"  = 5 bytes + 1 null = 6
    // sum = 13
    expect(estimateArgvBytes(["héllo", "café"])).toBe(13);
  });

  it("handles CJK characters (3 bytes each in UTF-8)", () => {
    // "你好" = 6 bytes + 1 null = 7
    expect(estimateArgvBytes(["你好"])).toBe(7);
  });

  it("counts empty string arg as just null terminator", () => {
    expect(estimateArgvBytes([""])).toBe(1);
  });

  it("counts large args cumulatively", () => {
    const big = "x".repeat(1000);
    // 1000 ASCII bytes + 1 null = 1001
    expect(estimateArgvBytes([big])).toBe(1001);
    expect(estimateArgvBytes([big, big])).toBe(2002);
  });
});

describe("estimateEnvBytes", () => {
  it("returns 0 for undefined env", () => {
    expect(estimateEnvBytes(undefined)).toBe(0);
  });

  it("returns 0 for empty env", () => {
    expect(estimateEnvBytes({})).toBe(0);
  });

  it("counts key=value plus null for each entry", () => {
    const env = { FOO: "bar" };
    // "FOO" (3) + "=" (1) = 4, + "bar" (3) + null (1) = 4 → total 8
    expect(estimateEnvBytes(env)).toBe(8);
  });

  it("skips undefined values", () => {
    const env = { FOO: "bar", BAZ: undefined } as Record<string, string | undefined>;
    // Only FOO=bar counted: 8 bytes
    expect(estimateEnvBytes(env as NodeJS.ProcessEnv)).toBe(8);
  });

  it("handles multi-byte values", () => {
    const env = { PATH: "/usr/bin:/usr/local/bin" };
    // "PATH" (4) + "=" (1) = 5
    // "/usr/bin:/usr/local/bin" (23) + null (1) = 24
    // total = 29
    expect(estimateEnvBytes(env)).toBe(29);
  });

  it("accounts for multiple entries", () => {
    const env = { A: "1", B: "22", C: "333" };
    // A=1\n: 1+1+1+1=4,  B=22\n: 1+1+2+1=5,  C=333\n: 1+1+3+1=6  → total 15
    expect(estimateEnvBytes(env)).toBe(15);
  });
});

describe("estimateSpawnPayloadBytes", () => {
  it("sums argv and env bytes", () => {
    const args = ["-p", "hello"];
    const env = { HOME: "/root" };
    // args: "-p" (3) + "hello" (6) = 9
    // env: "HOME" (5) + "/root" (6) = 11
    // total: 20
    expect(estimateSpawnPayloadBytes(args, env)).toBe(20);
  });

  it("returns just argv bytes when env is undefined", () => {
    expect(estimateSpawnPayloadBytes(["hello"])).toBe(6);
  });
});

describe("DEFAULT_ARGV_TOTAL_LIMIT", () => {
  it("is 1.5 MB (1_572_864 bytes)", () => {
    expect(DEFAULT_ARGV_TOTAL_LIMIT).toBe(1_572_864);
  });
});

describe("decidePromptTransport", () => {
  it("returns argv transport when payload fits under threshold", () => {
    const args = ["-p", "short prompt"];
    const decision = decidePromptTransport(args, [0, 1]);
    expect(decision.transport).toBe("argv");
    expect(decision.args).toBe(args); // same identity — unmodified
    expect(decision.stdinPayload).toBeUndefined();
    expect(decision.totalBytes).toBeLessThanOrEqual(DEFAULT_ARGV_TOTAL_LIMIT);
  });

  it("returns argv transport for empty args", () => {
    const decision = decidePromptTransport([], []);
    expect(decision.transport).toBe("argv");
    expect(decision.args).toEqual([]);
  });

  it("returns stdin transport when payload exceeds threshold (default stdin support)", () => {
    const bigPrompt = "x".repeat(2 * 1024 * 1024); // 2 MB ASCII text
    const args = ["-p", bigPrompt];
    const decision = decidePromptTransport(args, [0, 1]);
    expect(decision.transport).toBe("stdin");
    expect(decision.args).toEqual([]); // both "-p" and prompt removed
    expect(decision.stdinPayload).toBe(bigPrompt);
    expect(decision.totalBytes).toBeGreaterThan(DEFAULT_ARGV_TOTAL_LIMIT);
  });

  it("returns stdin transport for a large positional prompt", () => {
    const bigPrompt = "y".repeat(2 * 1024 * 1024);
    const args = ["exec", bigPrompt, "--flag"];
    const decision = decidePromptTransport(args, [1]);
    expect(decision.transport).toBe("stdin");
    expect(decision.args).toEqual(["exec", "--flag"]); // only prompt removed
    expect(decision.stdinPayload).toBe(bigPrompt);
  });

  it("returns tempfile transport when stdin is unsupported and tempfileFlag is given", () => {
    const bigPrompt = "z".repeat(2 * 1024 * 1024);
    const args = ["-p", bigPrompt];
    const decision = decidePromptTransport(args, [0, 1], undefined, false, ["--file", "<path>"]);
    expect(decision.transport).toBe("tempfile");
    expect(decision.args).toEqual(["--file", "<path>"]);
    expect(decision.stdinPayload).toBe(bigPrompt);
    expect(decision.totalBytes).toBeGreaterThan(DEFAULT_ARGV_TOTAL_LIMIT);
  });

  it("returns argv transport when payload exceeds threshold but no fallback is available", () => {
    const bigPrompt = "w".repeat(2 * 1024 * 1024);
    const args = ["-p", bigPrompt];
    // supportsStdinFallback = false, no tempfileFlag → must keep argv
    const decision = decidePromptTransport(args, [0, 1], undefined, false);
    expect(decision.transport).toBe("argv");
    expect(decision.args).toBe(args); // unmodified
    expect(decision.stdinPayload).toBeUndefined();
    expect(decision.totalBytes).toBeGreaterThan(DEFAULT_ARGV_TOTAL_LIMIT);
  });

  it("preserves extra args in stdin transport", () => {
    const bigPrompt = "v".repeat(2 * 1024 * 1024);
    const args = ["-p", bigPrompt, "--output-format", "json", "--model", "claude-sonnet-4"];
    const decision = decidePromptTransport(args, [0, 1]);
    expect(decision.transport).toBe("stdin");
    expect(decision.args).toEqual(["--output-format", "json", "--model", "claude-sonnet-4"]);
    expect(decision.stdinPayload).toBe(bigPrompt);
  });

  it("preserves extra args in tempfile transport", () => {
    const bigPrompt = "u".repeat(2 * 1024 * 1024);
    const args = ["-p", bigPrompt, "--flag"];
    const decision = decidePromptTransport(args, [0, 1], undefined, false, ["--prompt-file", "/tmp/p.txt"]);
    expect(decision.transport).toBe("tempfile");
    expect(decision.args).toEqual(["--prompt-file", "/tmp/p.txt", "--flag"]);
    expect(decision.stdinPayload).toBe(bigPrompt);
  });

  it("handles promptArgIndices in any order", () => {
    const bigPrompt = "t".repeat(2 * 1024 * 1024);
    const args = ["-p", bigPrompt];
    // Indices given in reverse order [1, 0] instead of [0, 1]
    const decision = decidePromptTransport(args, [1, 0]);
    expect(decision.transport).toBe("stdin");
    expect(decision.args).toEqual([]);
    expect(decision.stdinPayload).toBe(bigPrompt);
  });

  it("reports correct totalBytes for mixed ASCII and multi-byte", () => {
    const args = ["-p", "héllo café"];
    const env = { LANG: "en_US.UTF-8" };
    // argv: "-p"=2+1, "héllo café"=12+1 → 3+13 = 16
    // env: "LANG" (4+1), "en_US.UTF-8" (11+1) → 5+12 = 17
    // total: 33
    const decision = decidePromptTransport(args, [0, 1], env);
    expect(decision.transport).toBe("argv");
    expect(decision.totalBytes).toBe(33);
  });

  it("throws on duplicate promptArgIndices", () => {
    const args = ["-p", "prompt"];
    expect(() => decidePromptTransport(args, [0, 0])).toThrow(RangeError);
    expect(() => decidePromptTransport(args, [0, 0])).toThrow(/duplicate.*0/i);
  });

  it("throws on out-of-bounds promptArgIndex (negative)", () => {
    const args = ["-p", "prompt"];
    expect(() => decidePromptTransport(args, [-1])).toThrow(RangeError);
    expect(() => decidePromptTransport(args, [-1])).toThrow(/out of bounds/i);
  });

  it("throws on out-of-bounds promptArgIndex (too large)", () => {
    const args = ["-p", "prompt"];
    expect(() => decidePromptTransport(args, [5])).toThrow(RangeError);
    expect(() => decidePromptTransport(args, [5])).toThrow(/out of bounds/i);
  });

  it("throws on non-integer promptArgIndex", () => {
    const args = ["-p", "prompt"];
    expect(() => decidePromptTransport(args, [0.5])).toThrow(RangeError);
    expect(() => decidePromptTransport(args, [0.5])).toThrow(/must be integers/i);
  });

  it("throws on empty args with non-empty promptArgIndices", () => {
    expect(() => decidePromptTransport([], [0])).toThrow(RangeError);
    expect(() => decidePromptTransport([], [0])).toThrow(/out of bounds/i);
  });

  it("inserts tempfile flags at the prompt position for a positional prompt", () => {
    const bigPrompt = "s".repeat(2 * 1024 * 1024);
    // Positional prompt at index 1, like opencode: [prefix, prompt, extraArgs...]
    const args = ["run", bigPrompt, "--model", "claude"];
    const decision = decidePromptTransport(args, [1], undefined, false, ["--prompt-file", "/tmp/p.txt"]);
    expect(decision.transport).toBe("tempfile");
    // Flags inserted at index 1 (the prompt position), not appended at end
    expect(decision.args).toEqual(["run", "--prompt-file", "/tmp/p.txt", "--model", "claude"]);
    expect(decision.stdinPayload).toBe(bigPrompt);
  });
});

describe("writeTempPromptFile / cleanupTempPromptFile", () => {
  it("creates a file with the given content and cleans it up", async () => {
    const content = "test prompt content";
    const result = await writeTempPromptFile(content);
    expect(result.filePath).toBeTruthy();
    expect(result.filePath.endsWith("prompt.txt")).toBe(true);
    expect(result.tempDir).toBeTruthy();

    // Verify content was written
    const { readFile } = await import("node:fs/promises");
    const written = await readFile(result.filePath, "utf-8");
    expect(written).toBe(content);

    // Cleanup
    await cleanupTempPromptFile(result.tempDir);

    // Verify file is gone
    const { existsSync } = await import("node:fs");
    expect(existsSync(result.filePath)).toBe(false);
  });

  it("cleanupTempPromptFile does not throw on non-existent path", async () => {
    const nonExistentDir = join(tmpdir(), `actuarius-prompt-${randomBytes(8).toString("hex")}`);
    await expect(cleanupTempPromptFile(nonExistentDir)).resolves.toBeUndefined();
  });

  it("creates temp files with unique directories per call", async () => {
    const a = await writeTempPromptFile("A");
    const b = await writeTempPromptFile("B");
    try {
      // Different parent directories
      expect(a.filePath).not.toBe(b.filePath);
      expect(a.tempDir).not.toBe(b.tempDir);
      // Both readable
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(a.filePath, "utf-8")).toBe("A");
      expect(await readFile(b.filePath, "utf-8")).toBe("B");
    } finally {
      await cleanupTempPromptFile(a.tempDir);
      await cleanupTempPromptFile(b.tempDir);
    }
  });
});
