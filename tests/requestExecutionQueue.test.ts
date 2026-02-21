import { describe, expect, it } from "vitest";
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
});

