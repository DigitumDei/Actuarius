import { describe, expect, it, vi } from "vitest";
import { spawnCollect, spawnCollectWithTransport, decidePromptTransport } from "../src/utils/spawnCollect.js";

// Use the current node binary so these tests work without assuming PATH contents.
const node = process.execPath;
const cwd = process.cwd();
const timeoutMs = 10_000;

describe("spawnCollect — cancellation", () => {
  it("terminates the child when its AbortSignal is aborted", async () => {
    const controller = new AbortController();
    const running = spawnCollect(
      node,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd, timeoutMs, maxBuffer: 1024, signal: controller.signal }
    );

    setTimeout(() => controller.abort(), 25);

    await expect(running).rejects.toMatchObject({
      code: "ABORT_ERR",
      killed: true
    });
  });
});

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
      { cwd, timeoutMs: 2000, killGraceMs: 100, maxBuffer: 1024 * 1024, maxStderrBuffer: 100 }
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: "ETIMEDOUT",
      stderr: expect.stringMatching(/^\[stderr truncated\]\n/),
    });
  });

  it("kills a silent process when its inactivity timeout expires before its absolute timeout", async () => {
    const error = await spawnCollect(
      node,
      ["-e", "setTimeout(() => {}, 60_000);"],
      { cwd, timeoutMs: 1_000, idleTimeoutMs: 100, killGraceMs: 100, maxBuffer: 1024 },
    ).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "ETIMEDOUT", timeoutReason: "idle" });
  });

  it("records which output stream produced the latest chunk before timeout", async () => {
    const error = await spawnCollect(
      node,
      [
        "-e",
        `process.stderr.write("startup warning\\n"); setTimeout(() => process.stdout.write("latest progress\\n"), 50); setInterval(() => {}, 60_000);`,
      ],
      { cwd, timeoutMs: 5_000, idleTimeoutMs: 1_000, killGraceMs: 100, maxBuffer: 1024 },
    ).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      code: "ETIMEDOUT",
      timeoutReason: "idle",
      lastOutput: { stream: "stdout", text: "latest progress\n" },
    });
  });

  it("forwards an explicit grace period and force-terminates a timed-out process tree", async () => {
    const startedAt = Date.now();
    const script = [
      `const { spawn } = require("node:child_process");`,
      `spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000);"], { stdio: ["ignore", "inherit", "inherit"] });`,
      `process.stdout.write("ready");`,
      `process.on("SIGTERM", () => {});`,
      `setInterval(() => {}, 60_000);`,
    ].join(" ");

    const error = await spawnCollectWithTransport({
      file: node,
      args: ["-e", script],
      promptArgIndices: [],
      cwd,
      timeoutMs: 5_000,
      idleTimeoutMs: 1_000,
      killGraceMs: 100,
      maxBuffer: 1024,
    }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "ETIMEDOUT", timeoutReason: "idle" });
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  }, 10_000);

  it.skipIf(process.platform === "win32")(
    "lets a SIGTERM handler finish cleanup when force-kill escalation is omitted",
    async () => {
      const cleanupDelayMs = 300;
      const startedAt = Date.now();
      const script = [
        `let stopping = false;`,
        `process.on("SIGTERM", () => {`,
        `  if (stopping) return;`,
        `  stopping = true;`,
        `  setTimeout(() => process.exit(0), ${cleanupDelayMs});`,
        `});`,
        `process.stdout.write("ready");`,
        `setInterval(() => {}, 60_000);`,
      ].join(" ");

      const error = await spawnCollect(
        node,
        ["-e", script],
        { cwd, timeoutMs: 5_000, idleTimeoutMs: 200, maxBuffer: 1024 },
      ).catch((reason: unknown) => reason);

      expect(error).toMatchObject({
        code: "ETIMEDOUT",
        timeoutReason: "idle",
        killed: false,
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(cleanupDelayMs + 150);
      expect(Date.now() - startedAt).toBeLessThan(4_000);
    },
    10_000,
  );

  // The two timing tests below race a real child process against real timers,
  // so their durations are chosen as ratios rather than tight absolute values.
  // spawnCollect arms both timers at spawn() time, but the child's first byte
  // only arrives after Node's cold start — under a parallel `npm test` run that
  // startup, and any single interval tick, can be stretched by scheduler load.
  // Each duration below therefore has a stated safety factor; keep them if you
  // retune. Total wall-clock cost is ~2s per test, which is the price of not
  // being flaky.
  //
  // Both also pass an explicit per-test timeout that sits ABOVE the spawnCollect
  // budget they exercise. vitest's default is 5000ms, which these would approach
  // under load — and a generic "Test timed out in 5000ms" would preempt the
  // ETIMEDOUT assertion, reintroducing the exact flake this file is fixing.
  const WRITE_INTERVAL_MS = 50;

  it("resets the inactivity timeout when either output stream produces data", async () => {
    // The child writes 40 times at 50ms => ~2000ms of activity, well past the
    // 900ms idle budget: if the idle timer did NOT reset on output it would fire
    // at 900ms and this would reject instead of resolving. 900ms also gives 18x
    // headroom over the write cadence and ~900ms of slack for Node's startup.
    const writes = 40;
    const idleTimeoutMs = 900;

    const result = await spawnCollect(
      node,
      [
        "-e",
        `let count = 0; const timer = setInterval(() => { (count++ % 2 ? process.stderr : process.stdout).write('x'); if (count === ${writes}) { clearInterval(timer); } }, ${WRITE_INTERVAL_MS});`,
      ],
      { cwd, timeoutMs: 30_000, idleTimeoutMs, maxBuffer: 1024 },
    );

    // Writes alternate stdout/stderr starting with stdout, so each gets half.
    expect(result.stdout).toBe("x".repeat(writes / 2));
    expect(result.stderr).toBe("x".repeat(writes / 2));
  }, 35_000); // above the 30s spawnCollect absolute budget above

  it("still enforces the absolute timeout while a process keeps producing output", async () => {
    // The child never stops writing, so only a timeout can end it. The idle
    // budget (1000ms, 20x the write cadence) must lose the race to the absolute
    // budget (2000ms) — that is what `timeoutReason: "absolute"` proves. It also
    // leaves ~1000ms for Node's startup before the first write lands.
    const error = await spawnCollect(
      node,
      ["-e", `setInterval(() => process.stdout.write('x'), ${WRITE_INTERVAL_MS});`],
      { cwd, timeoutMs: 2_000, idleTimeoutMs: 1_000, killGraceMs: 100, maxBuffer: 1024 * 1024 },
    ).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "ETIMEDOUT", timeoutReason: "absolute" });
  }, 15_000); // above the 2s spawnCollect absolute budget above

  it.each(["stdout", "stderr"] as const)(
    "rejects and terminates the child when an onOutput callback throws from %s",
    async (stream) => {
      const callbackError = new Error(`failed while handling ${stream}`);
      const onOutput = vi.fn(() => { throw callbackError; });
      const script = `${stream === "stdout" ? "process.stdout" : "process.stderr"}.write("chunk"); setInterval(() => {}, 60_000);`;

      await expect(spawnCollect(
        node,
        ["-e", script],
        { cwd, timeoutMs, killGraceMs: 100, maxBuffer: 1024, onOutput }
      )).rejects.toBe(callbackError);

      expect(onOutput).toHaveBeenCalledOnce();
    }
  );
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

  it("rejects with a command-line-too-long error when oversized but promptArgIndices is empty", async () => {
    const hugeArg = "x".repeat(2 * 1024 * 1024);
    // The OS rejects the over-long argv before the process starts. The errno
    // differs by platform: E2BIG on Linux (execve), ENAMETOOLONG on Windows
    // (CreateProcess via libuv). Both signal the same unrecoverable condition.
    await expect(
      spawnCollectWithTransport({
        file: node,
        args: ["-e", `process.stdout.write("ok");`, "--", hugeArg],
        promptArgIndices: [],
        cwd,
        timeoutMs,
        maxBuffer: 1024,
      })
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(E2BIG|ENAMETOOLONG)$/) });
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
