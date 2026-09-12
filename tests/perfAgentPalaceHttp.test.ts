import { describe, expect, it } from "vitest";
// @ts-expect-error - the perf harness is a plain .mjs script with no type declarations
import { parseOperations, percentile, summarize } from "../scripts/perf-agentpalace-http.mjs";

describe("AgentPalace perf harness statistics", () => {
  it("computes percentiles with linear interpolation", () => {
    const sorted = [10, 20, 30, 40];
    expect(percentile(sorted, 0)).toBe(10);
    expect(percentile(sorted, 50)).toBe(25);
    expect(percentile(sorted, 100)).toBe(40);
    expect(percentile([], 50)).toBe(0);
  });

  it("summarizes a sample set without mutating the input", () => {
    const samples = [40, 10, 30, 20];
    const stats = summarize(samples);
    expect(samples).toEqual([40, 10, 30, 20]);
    expect(stats.count).toBe(4);
    expect(stats.minMs).toBe(10);
    expect(stats.maxMs).toBe(40);
    expect(stats.meanMs).toBe(25);
    expect(stats.p50Ms).toBe(25);
    expect(stats.p95Ms).toBeCloseTo(38.5, 5);
  });

  it("returns an empty summary for no samples", () => {
    expect(summarize([])).toMatchObject({ count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
  });

  it("parses and validates operation selections", () => {
    expect(parseOperations("status, search ,add_drawer")).toEqual(["status", "search", "add_drawer"]);
    expect(() => parseOperations("status,nope")).toThrow(/Unknown PERF_OPERATIONS/);
    expect(() => parseOperations(" , ")).toThrow(/selected no operations/);
  });
});
