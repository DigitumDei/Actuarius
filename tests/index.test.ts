import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { MemPalaceRemoteService } from "../src/services/memPalaceRemoteService.js";
import { startMemPalaceRemoteWithRetry } from "../src/index.js";

const logger = pino({ level: "silent" });

function createMockService(startImpl: () => Promise<void>): MemPalaceRemoteService {
  return {
    start: vi.fn(startImpl),
    stop: vi.fn().mockResolvedValue(undefined)
  } as unknown as MemPalaceRemoteService;
}

describe("startMemPalaceRemoteWithRetry", () => {
  it("returns true on first-attempt success without retrying", async () => {
    const service = createMockService(() => Promise.resolve());

    const result = await startMemPalaceRemoteWithRetry(service, [], logger, { maxAttempts: 4, retryDelayMs: 1 });

    expect(result).toBe(true);
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(service.stop).not.toHaveBeenCalled();
  });

  it("retries after a failure and succeeds once the server comes up", async () => {
    let calls = 0;
    const service = createMockService(() => {
      calls += 1;
      return calls < 3 ? Promise.reject(new Error("not healthy yet")) : Promise.resolve();
    });

    const result = await startMemPalaceRemoteWithRetry(service, [], logger, { maxAttempts: 4, retryDelayMs: 1 });

    expect(result).toBe(true);
    expect(service.start).toHaveBeenCalledTimes(3);
    expect(service.stop).not.toHaveBeenCalled();
  });

  it("gives up and cleans up after exhausting all attempts", async () => {
    const service = createMockService(() => Promise.reject(new Error("never healthy")));

    const result = await startMemPalaceRemoteWithRetry(service, [], logger, { maxAttempts: 3, retryDelayMs: 1 });

    expect(result).toBe(false);
    expect(service.start).toHaveBeenCalledTimes(3);
    expect(service.stop).toHaveBeenCalledTimes(1);
  });

  it("defaults to 4 attempts and a 20s delay when no options are given", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const service = createMockService(() => {
        calls += 1;
        return calls < 2 ? Promise.reject(new Error("not healthy yet")) : Promise.resolve();
      });

      const resultPromise = startMemPalaceRemoteWithRetry(service, [], logger);
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await resultPromise;

      expect(result).toBe(true);
      expect(service.start).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
