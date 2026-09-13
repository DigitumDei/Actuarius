import { expect, it } from "vitest";
import { providerGate } from "../src/services/providerGate.js";
it("serializes provider invocations and removes cancelled waiters", async () => {
    let release!: () => void;
    let active = 0;
    let peak = 0;
    const calls: string[] = [];
    const first = providerGate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        calls.push("first");
        await new Promise<void>(resolve => { release = resolve; });
        active--;
    });
    await Promise.resolve();
    const abort = new AbortController();
    const cancelled = providerGate.run(async () => { calls.push("cancelled"); }, abort.signal);
    const rejected = expect(cancelled).rejects.toThrow("cancel");
    const last = providerGate.run(async () => { active++; peak = Math.max(peak, active); calls.push("last"); active--; });
    abort.abort(new Error("cancel"));
    release();
    await Promise.all([first, last, rejected]);
    expect(calls).toEqual(["first", "last"]);
    expect(peak).toBe(1);
});
it("releases the slot after a provider failure", async () => {
    await expect(providerGate.run(async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(providerGate.run(async () => "next")).resolves.toBe("next");
});
