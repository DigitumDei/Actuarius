import { describe, expect, it, vi } from "vitest";
import { RequestExecutionQueue } from "../src/services/requestExecutionQueue.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("RequestExecutionQueue", () => {
  it("enforces per-guild concurrency", async () => {
    const queue = new RequestExecutionQueue(2);
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 5 }, (_, index) =>
      new Promise<void>((resolve) => {
        queue.enqueue("guild-1", async () => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          await delay(20 + index);
          running -= 1;
          resolve();
        });
      })
    );

    await Promise.all(tasks);
    expect(maxRunning).toBe(2);
  });

  it("keeps different guilds independent", async () => {
    const queue = new RequestExecutionQueue(1);
    const started: string[] = [];

    const a = new Promise<void>((resolve) => {
      queue.enqueue("guild-a", async () => {
        started.push("a");
        await delay(30);
        resolve();
      });
    });

    const b = new Promise<void>((resolve) => {
      queue.enqueue("guild-b", async () => {
        started.push("b");
        await delay(30);
        resolve();
      });
    });

    await Promise.all([a, b]);
    expect(new Set(started)).toEqual(new Set(["a", "b"]));
  });

  it("serializes tasks sharing a resource key while other resources use guild capacity", async () => {
    const queue = new RequestExecutionQueue(2);
    const runningByResource = new Map<string, number>();
    let maxSharedRunning = 0;
    let maxTotalRunning = 0;
    let totalRunning = 0;

    const enqueue = (resourceKey: string, durationMs: number) => new Promise<void>((resolve) => {
      queue.enqueue("guild-1", async () => {
        totalRunning += 1;
        maxTotalRunning = Math.max(maxTotalRunning, totalRunning);
        const resourceRunning = (runningByResource.get(resourceKey) ?? 0) + 1;
        runningByResource.set(resourceKey, resourceRunning);
        if (resourceKey === "thread-1") maxSharedRunning = Math.max(maxSharedRunning, resourceRunning);
        await delay(durationMs);
        runningByResource.set(resourceKey, resourceRunning - 1);
        totalRunning -= 1;
        resolve();
      }, resourceKey);
    });

    await Promise.all([
      enqueue("thread-1", 30),
      enqueue("thread-1", 10),
      enqueue("thread-2", 20)
    ]);

    expect(maxSharedRunning).toBe(1);
    expect(maxTotalRunning).toBe(2);
  });

  it("reports active and pending work for a resource key", async () => {
    const queue = new RequestExecutionQueue(1);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = new Promise<void>((resolve) => {
      queue.enqueue("guild-1", async () => {
        await firstGate;
        resolve();
      }, "thread-1");
    });
    const second = new Promise<void>((resolve) => {
      queue.enqueue("guild-1", async () => resolve(), "thread-2");
    });

    expect(queue.hasResourceWork("guild-1", "thread-1")).toBe(true);
    expect(queue.hasResourceWork("guild-1", "thread-2")).toBe(true);
    expect(queue.hasResourceWork("guild-1", "thread-3")).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    await delay(0);

    expect(queue.hasResourceWork("guild-1", "thread-1")).toBe(false);
    expect(queue.hasResourceWork("guild-1", "thread-2")).toBe(false);
  });

  it("reports uncaught task errors via callback", async () => {
    const error = new Error("boom");
    const onTaskError = vi.fn();
    const queue = new RequestExecutionQueue(1, onTaskError);

    queue.enqueue("guild-1", async () => {
      throw error;
    });

    await delay(10);

    expect(onTaskError).toHaveBeenCalledTimes(1);
    expect(onTaskError).toHaveBeenCalledWith({
      guildId: "guild-1",
      error
    });
  });
});
