import { describe, expect, it, vi } from "vitest";
import { spawnCollect, spawnCollectWithTransport, decidePromptTransport } from "../src/utils/spawnCollect.js";

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
      { cwd, timeoutMs: 2000, maxBuffer: 1024 * 1024, maxStderrBuffer: 100 }
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: "ETIMEDOUT",
      stderr: expect.stringMatching(/^\[stderr truncated\]\n/),
    });
  });
});

describe("spawnCollectWithTransport — argv transport", () => {
  it("passes through when payload fits under the limit", async () => {
    const result = await spawnCollectWithTransport({
      file: node,
      args: ["-e", `process.stdout.write("hello from argv");`],
      promptArgIndices: [],
      cwd,
      timeoutMs,
      maxBuffer: 1024,
    });
    expect(result.stdout).toBe("hello from argv");
  });

  it("preserves stderr truncation behavior through the wrapper", async () => {
    const result = await spawnCollectWithTransport({
      file: node,
      args: ["-e", `process.stderr.write("x".repeat(200)); process.stdout.write("ok");`],
      promptArgIndices: [],
      cwd,
      timeoutMs,
      maxBuffer: 1024 * 1024,
      maxStderrBuffer: 100,
    });
    expect(result.stdout).toBe("ok");
    expect(result.stderr.startsWith("[stderr truncated]\n")).toBe(true);
  });

  it("rejects with EMSGSIZE when stdout exceeds maxBuffer", async () => {
    await expect(
      spawnCollectWithTransport({
        file: node,
        args: ["-e", `process.stdout.write("x".repeat(200));`],
        promptArgIndices: [],
        cwd,
        timeoutMs,
        maxBuffer: 100,
      })
    ).rejects.toMatchObject({ code: "EMSGSIZE" });
  });

  it("rejects with E2BIG when oversized but promptArgIndices is empty", async () => {
    const hugeArg = "x".repeat(2 * 1024 * 1024);
    await expect(
      spawnCollectWithTransport({
        file: node,
        args: ["-e", `process.stdout.write("ok");`, "--", hugeArg],
        promptArgIndices: [],
        cwd,
        timeoutMs,
        maxBuffer: 1024,
      })
    ).rejects.toMatchObject({ code: "E2BIG" });
  });
});

describe("decidePromptTransport — oversized with empty indices", () => {
  it("returns argv transport when payload exceeds limit and promptArgIndices is empty", () => {
    const hugeArg = "y".repeat(2 * 1024 * 1024);
    const decision = decidePromptTransport(
      ["-e", "script", "--", hugeArg],
      [],
    );
    expect(decision.transport).toBe("argv");
    expect(decision.args).toEqual(["-e", "script", "--", hugeArg]);
    expect(decision.totalBytes).toBeGreaterThan(1024 * 1024);
  });
});

describe("spawnCollectWithTransport — stdin transport", () => {
  it("pipes large prompt via stdin when argv exceeds threshold", async () => {
    const bigPrompt = "x".repeat(2 * 1024 * 1024);
    const script = `
      let data = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => { data += chunk; });
      process.stdin.on("end", () => {
        process.stdout.write("received " + data.length + " bytes");
      });
    `;
    const result = await spawnCollectWithTransport({
      file: node,
      args: ["-e", script, bigPrompt],
      promptArgIndices: [2],
      cwd,
      timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.stdout).toBe(`received ${bigPrompt.length} bytes`);
  });

  it("preserves non-prompt args when using stdin transport", async () => {
    const bigPrompt = "y".repeat(2 * 1024 * 1024);
    // Use "--" separator so Node doesn't parse extra args as its own flags
    const result = await spawnCollectWithTransport({
      file: node,
      args: ["-e", `process.stdout.write(JSON.stringify(process.argv.slice(1)));`, "--", bigPrompt, "--extra-flag"],
      // bigPrompt is at index 3 (after -e, script, --)
      promptArgIndices: [3],
      cwd,
      timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    // The big prompt is removed from argv, but --extra-flag remains
    expect(result.stdout).not.toContain(bigPrompt);
    expect(result.stdout).toContain("--extra-flag");
  });

  it("rejects on non-zero exit with stdin transport", async () => {
    const bigPrompt = "z".repeat(2 * 1024 * 1024);
    await expect(
      spawnCollectWithTransport({
        file: node,
        args: ["-e", `process.exit(1);`, bigPrompt],
        promptArgIndices: [2],
        cwd,
        timeoutMs: 5000,
        maxBuffer: 1024,
      })
    ).rejects.toMatchObject({ killed: false });
  });
});

describe("spawnCollectWithTransport — tempfile transport", () => {
  it("writes prompt to temp file and passes path via flag", async () => {
    const bigPrompt = "w".repeat(2 * 1024 * 1024);
    // Use "--" separator so Node does not parse --prompt-file as its own flag
    // process.argv[2] is the file path (after node, --prompt-file)
    const result = await spawnCollectWithTransport({
      file: node,
      args: ["-e", `process.stdout.write(process.argv[2] || "none");`, "--", bigPrompt],
      // bigPrompt is at index 3 (after -e, script, --)
      promptArgIndices: [3],
      cwd,
      timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      supportsStdinFallback: false,
      tempfileFlag: ["--prompt-file", "<path>"],
    });
    // The output should be the temp file path (placeholder was replaced)
    expect(result.stdout).toContain("prompt.txt");
  });

  it("cleans up temp dir after successful spawn", async () => {
    const bigPrompt = "v".repeat(2 * 1024 * 1024);
    await spawnCollectWithTransport({
      file: node,
      args: ["-e", `process.stdout.write("ok");`, "--", bigPrompt],
      promptArgIndices: [3],
      cwd,
      timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      supportsStdinFallback: false,
      tempfileFlag: ["--prompt-file", "<path>"],
    });

    const { tmpdir } = await import("node:os");
    const { readdirSync } = await import("node:fs");
    const leftovers = readdirSync(tmpdir()).filter((n: string) =>
      n.startsWith("actuarius-prompt-")
    );
    expect(leftovers).toEqual([]);
  });

  it("cleans up temp dir on non-zero exit", async () => {
    const bigPrompt = "u".repeat(2 * 1024 * 1024);
    const { tmpdir } = await import("node:os");
    const { readdirSync } = await import("node:fs");

    await expect(
      spawnCollectWithTransport({
        file: node,
        args: ["-e", `process.exit(1);`, "--", bigPrompt],
        promptArgIndices: [3],
        cwd,
        timeoutMs: 500,
        maxBuffer: 1024,
        supportsStdinFallback: false,
        tempfileFlag: ["--prompt-file", "<path>"],
      })
    ).rejects.toBeTruthy();

    const leftovers = readdirSync(tmpdir()).filter((n: string) =>
      n.startsWith("actuarius-prompt-")
    );
    expect(leftovers).toEqual([]);
  });

  it("calls reshapeArgsForTempfile callback with prompt text, adjusted args, and file path", async () => {
    const bigPrompt = "t".repeat(2 * 1024 * 1024);
    const reshapeFn = vi.fn(
      (_promptText: string, adjustedArgs: string[], filePath: string) =>
        [...adjustedArgs, filePath],
    );
    const result = await spawnCollectWithTransport({
      file: node,
      args: ["-e", `process.stdout.write(process.argv.slice(1).join(","));`, "--", bigPrompt],
      promptArgIndices: [3],
      cwd,
      timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      supportsStdinFallback: false,
      reshapeArgsForTempfile: reshapeFn,
    });
    expect(result.stdout).toContain("prompt.txt");
    expect(reshapeFn).toHaveBeenCalledTimes(1);
    const callArgs = reshapeFn.mock.calls[0]!;
    expect(callArgs[0]).toBe(bigPrompt);
    // adjustedArgs: no tempfileFlag insertion, just prompt removed
    expect(callArgs[1]).toEqual(["-e", `process.stdout.write(process.argv.slice(1).join(","));`, "--"]);
    expect(callArgs[2]).toContain("prompt.txt");
  });

  it("calls reshapeArgsForTempfile callback for positional prompt and preserves extra args", async () => {
    const bigPrompt = "p".repeat(2 * 1024 * 1024);
    const reshapeFn = vi.fn(
      (_promptText: string, adjustedArgs: string[], filePath: string) =>
        [...adjustedArgs, filePath],
    );
    const result = await spawnCollectWithTransport({
      file: node,
      args: ["-e", `process.stdout.write(process.argv.slice(1).join(","));`, "--", bigPrompt, "--extra"],
      promptArgIndices: [3],
      cwd,
      timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      supportsStdinFallback: false,
      reshapeArgsForTempfile: reshapeFn,
    });
    expect(result.stdout).toContain("prompt.txt");
    expect(result.stdout).toContain("--extra");
    expect(reshapeFn).toHaveBeenCalledTimes(1);
    const callArgs = reshapeFn.mock.calls[0]!;
    expect(callArgs[0]).toBe(bigPrompt);
    expect(callArgs[1]).toEqual(["-e", `process.stdout.write(process.argv.slice(1).join(","));`, "--", "--extra"]);
  });

  it("preserves non-prompt args with reshapeArgsForTempfile tempfile transport", async () => {
    const bigPrompt = "o".repeat(2 * 1024 * 1024);
    const reshapeFn = (_promptText: string, adjustedArgs: string[], filePath: string) =>
      [...adjustedArgs, filePath];
    const result = await spawnCollectWithTransport({
      file: node,
      args: ["-e", `process.stdout.write(JSON.stringify(process.argv.slice(1)));`, "--", bigPrompt, "--keep-me"],
      promptArgIndices: [3],
      cwd,
      timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      supportsStdinFallback: false,
      reshapeArgsForTempfile: reshapeFn,
    });
    expect(result.stdout).not.toContain(bigPrompt);
    expect(result.stdout).toContain("--keep-me");
  });

  it("cleans up temp dir when using reshapeArgsForTempfile", async () => {
    const bigPrompt = "n".repeat(2 * 1024 * 1024);
    const reshapeFn = (_promptText: string, adjustedArgs: string[], filePath: string) =>
      [...adjustedArgs, filePath];
    await spawnCollectWithTransport({
      file: node,
      args: ["-e", `process.stdout.write("ok");`, "--", bigPrompt],
      promptArgIndices: [3],
      cwd,
      timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      supportsStdinFallback: false,
      reshapeArgsForTempfile: reshapeFn,
    });

    const { tmpdir } = await import("node:os");
    const { readdirSync } = await import("node:fs");
    const leftovers = readdirSync(tmpdir()).filter((n: string) =>
      n.startsWith("actuarius-prompt-")
    );
    expect(leftovers).toEqual([]);
  });

  it("inserts --file flag via reshapeArgsForTempfile matching OpenCode CLI shape", async () => {
    const bigPrompt = "m".repeat(2 * 1024 * 1024);
    const reshapeFn = (promptText: string, adjustedArgs: string[], filePath: string) => {
      const skipIdx = adjustedArgs.indexOf("--dangerously-skip-permissions");
      if (skipIdx === -1) return [...adjustedArgs, "--file", filePath];
      return [
        ...adjustedArgs.slice(0, skipIdx),
        "--file", filePath,
        ...adjustedArgs.slice(skipIdx),
      ];
    };
    const result = await spawnCollectWithTransport({
      file: node,
      // Simulate opencode `run --dir <cwd> <prompt> --dangerously-skip-permissions`
      args: ["-e", `process.stdout.write(process.argv.slice(1).join(","));`, "--", bigPrompt, "--dangerously-skip-permissions"],
      promptArgIndices: [3],
      cwd,
      timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      supportsStdinFallback: false,
      reshapeArgsForTempfile: reshapeFn,
    });
    // The output should contain --file and the temp file path
    expect(result.stdout).toContain("--file");
    expect(result.stdout).toContain("prompt.txt");
    // The --dangerously-skip-permissions flag should still be present
    expect(result.stdout).toContain("--dangerously-skip-permissions");
    // The prompt text should NOT be in argv
    expect(result.stdout).not.toContain(bigPrompt);
  });

  it("reshapes OpenCode-style positional prompt with cwdFlag and extraArgs", async () => {
    const bigPrompt = "k".repeat(2 * 1024 * 1024);
    const reshapeFn = (promptText: string, adjustedArgs: string[], filePath: string) => {
      const skipIdx = adjustedArgs.indexOf("--dangerously-skip-permissions");
      if (skipIdx === -1) return [...adjustedArgs, "--file", filePath];
      return [
        ...adjustedArgs.slice(0, skipIdx),
        "--file", filePath,
        ...adjustedArgs.slice(skipIdx),
      ];
    };
    // Simulate opencode with cwdFlag using -- separator so Node doesn't
    // interpret --dir as a Node flag: node -e <script> -- --dir /work <prompt> --dangerously-skip-permissions
    const result = await spawnCollectWithTransport({
      file: node,
      args: ["-e", `process.stdout.write(process.argv.slice(1).join(","));`, "--", "--dir", "/work", bigPrompt, "--dangerously-skip-permissions"],
      promptArgIndices: [5],
      cwd,
      timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      supportsStdinFallback: false,
      reshapeArgsForTempfile: reshapeFn,
    });
    expect(result.stdout).toContain("--dir");
    expect(result.stdout).toContain("/work");
    expect(result.stdout).toContain("--file");
    expect(result.stdout).toContain("prompt.txt");
    expect(result.stdout).toContain("--dangerously-skip-permissions");
  });
});
