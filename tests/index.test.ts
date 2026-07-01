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
    // stop() runs after every failed attempt (not just the last) to clear the
    // service's own background retry timer before the next attempt.
    expect(service.stop).toHaveBeenCalledTimes(2);
  });

  it("gives up and cleans up after exhausting all attempts", async () => {
    const service = createMockService(() => Promise.reject(new Error("never healthy")));

    const result = await startMemPalaceRemoteWithRetry(service, [], logger, { maxAttempts: 3, retryDelayMs: 1 });

    expect(result).toBe(false);
    expect(service.start).toHaveBeenCalledTimes(3);
    expect(service.stop).toHaveBeenCalledTimes(3);
  });

  it("stops the service and clears its retry timer after every failure, not just the last", async () => {
    const service = createMockService(() => Promise.reject(new Error("not healthy yet")));

    await startMemPalaceRemoteWithRetry(service, [], logger, { maxAttempts: 2, retryDelayMs: 1 });

    const startOrder = vi.mocked(service.start).mock.invocationCallOrder[0]!;
    const stopOrder = vi.mocked(service.stop).mock.invocationCallOrder[0]!;
    expect(stopOrder).toBeGreaterThan(startOrder);
  });

  it("aborts the retry delay immediately when the signal fires, without another start attempt", async () => {
    const controller = new AbortController();
    const service = createMockService(() => Promise.reject(new Error("not healthy yet")));

    const resultPromise = startMemPalaceRemoteWithRetry(service, [], logger, {
      maxAttempts: 4,
      retryDelayMs: 60_000,
      signal: controller.signal
    });
    controller.abort();
    const result = await resultPromise;

    expect(result).toBe(false);
    expect(service.start).toHaveBeenCalledTimes(1);
  });

  it("returns false immediately if already aborted before the first attempt", async () => {
    const controller = new AbortController();
    controller.abort();
    const service = createMockService(() => Promise.resolve());

    const result = await startMemPalaceRemoteWithRetry(service, [], logger, { signal: controller.signal });

    expect(result).toBe(false);
    expect(service.start).not.toHaveBeenCalled();
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
