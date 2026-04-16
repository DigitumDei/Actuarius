import { describe, expect, it } from "vitest";
import { spawnCollect } from "../src/utils/spawnCollect.js";

// Use the current node binary so these tests work without assuming PATH contents.
const node = process.execPath;
const cwd = process.cwd();
const timeoutMs = 10_000;

describe("spawnCollect — stderr trimming", () => {
  it("resolves cleanly with small stdout and stderr within limits", async () => {
    const result = await spawnCollect(
      node,
      ["-e", `process.stdout.write("hello stdout"); process.stderr.write("hello stderr");`],
      { cwd, timeoutMs, maxBuffer: 1024 }
    );
    expect(result.stdout).toBe("hello stdout");
    expect(result.stderr).toBe("hello stderr");
  });

  it("does not add prefix when stderr fits within maxStderrBuffer", async () => {
    const result = await spawnCollect(
      node,
      ["-e", `process.stderr.write("small");`],
      { cwd, timeoutMs, maxBuffer: 1024 * 1024, maxStderrBuffer: 1024 }
    );
    expect(result.stderr).toBe("small");
  });

  it("truncates stderr to the tail when it exceeds maxStderrBuffer", async () => {
    // 200 x's written, limit is 100 — tail should be the last 100 x's
    const result = await spawnCollect(
      node,
      ["-e", `process.stderr.write("x".repeat(200));`],
      { cwd, timeoutMs, maxBuffer: 1024 * 1024, maxStderrBuffer: 100 }
    );

    const prefix = "[stderr truncated]\n";
    expect(result.stderr.startsWith(prefix)).toBe(true);
    const tail = result.stderr.slice(prefix.length);
    expect(tail).toBe("x".repeat(100));
  });

  it("process is NOT killed when stderr exceeds maxStderrBuffer", async () => {
    // If the process were killed, stdout would be empty and the promise would reject.
    const result = await spawnCollect(
      node,
      ["-e", `process.stderr.write("x".repeat(200)); process.stdout.write("survived");`],
      { cwd, timeoutMs, maxBuffer: 1024 * 1024, maxStderrBuffer: 100 }
    );
    expect(result.stdout).toBe("survived");
  });

  it("uses the 64 KB default when maxStderrBuffer is omitted", async () => {
    // 70 KB > 64 KB default — should trigger truncation
    const result = await spawnCollect(
      node,
      ["-e", `process.stderr.write("y".repeat(70 * 1024));`],
      { cwd, timeoutMs, maxBuffer: 4 * 1024 * 1024 }
    );
    expect(result.stderr.startsWith("[stderr truncated]\n")).toBe(true);
    const tail = result.stderr.slice("[stderr truncated]\n".length);
    expect(tail.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("large stderr does not trigger EMSGSIZE (regression: old combined check)", async () => {
    // Old behaviour: stdout(0) + stderr(150KB) > maxBuffer(100KB) → EMSGSIZE → process killed.
    // New behaviour: stderr is trimmed independently, stdout never exceeds its limit → resolves.
    const result = await spawnCollect(
      node,
      ["-e", `process.stderr.write("z".repeat(150 * 1024)); process.stdout.write("ok");`],
      { cwd, timeoutMs, maxBuffer: 100 * 1024, maxStderrBuffer: 64 * 1024 }
    );
    expect(result.stdout).toBe("ok");
    expect(result.stderr.startsWith("[stderr truncated]\n")).toBe(true);
  });

  it("still throws EMSGSIZE when stdout alone exceeds maxBuffer", async () => {
    await expect(
      spawnCollect(
        node,
        ["-e", `process.stdout.write("x".repeat(200));`],
        { cwd, timeoutMs, maxBuffer: 100, maxStderrBuffer: 1024 * 1024 }
      )
    ).rejects.toMatchObject({ code: "EMSGSIZE" });
  });

  it("includes truncation prefix on the stderr field of a non-zero exit error", async () => {
    const error = await spawnCollect(
      node,
      ["-e", `process.stderr.write("e".repeat(200)); process.exit(1);`],
      { cwd, timeoutMs, maxBuffer: 1024 * 1024, maxStderrBuffer: 100 }
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({
      stderr: expect.stringMatching(/^\[stderr truncated\]\n/),
    });
  });

  it("includes truncation prefix on the stderr field of a timeout error", async () => {
    const error = await spawnCollect(
      node,
      ["-e", `process.stderr.write("t".repeat(200)); setTimeout(() => {}, 60_000);`],
      { cwd, timeoutMs: 200, maxBuffer: 1024 * 1024, maxStderrBuffer: 100 }
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: "ETIMEDOUT",
      stderr: expect.stringMatching(/^\[stderr truncated\]\n/),
    });
  });
});
