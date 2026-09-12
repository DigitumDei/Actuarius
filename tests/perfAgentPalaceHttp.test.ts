import { describe, expect, it } from "vitest";
// @ts-expect-error - the perf harness is a plain .mjs script with no type declarations
import {
  computeCounterDeltas,
  parseCounterLines,
  parseMeminfo,
  parseOperations,
  parsePsi,
  percentile,
  ROBUST_MIN_SAMPLES,
  summarize,
  summarizeSeries,
} from "../scripts/perf-agentpalace-http.mjs";

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

describe("AgentPalace perf harness system metrics", () => {
  it("summarizes a sampled series with peak and mean rather than a single endpoint", () => {
    expect(summarizeSeries([100, 300, 200])).toEqual({
      count: 3,
      firstBytes: 100,
      lastBytes: 200,
      minBytes: 100,
      meanBytes: 200,
      peakBytes: 300,
    });
    expect(summarizeSeries([])).toMatchObject({ count: 0, peakBytes: null, meanBytes: null });
  });

  it("parses cgroup-style counter lines", () => {
    const counters = parseCounterLines("usage_usec 2182564802\nnr_periods 35733\nnr_throttled 19526\n");
    expect(counters).toEqual({ usage_usec: 2182564802, nr_periods: 35733, nr_throttled: 19526 });
  });

  it("parses PSI pressure files", () => {
    const psi = parsePsi("some avg10=11.25 avg60=10.30 avg300=3.38 total=12553776947\nfull avg10=0.00 total=0\n");
    expect(psi.some.total).toBe(12553776947);
    expect(psi.some.avg10).toBe(11.25);
    expect(psi.full.total).toBe(0);
  });

  it("parses meminfo kB values into bytes", () => {
    const meminfo = parseMeminfo("MemTotal: 990016 kB\nMemAvailable: 147664 kB\n");
    expect(meminfo.MemTotal).toBe(990016 * 1024);
    expect(meminfo.MemAvailable).toBe(147664 * 1024);
  });

  it("computes before/after deltas and tolerates missing counters", () => {
    const delta = computeCounterDeltas({ cpuThrottled: 10, memoryEventsOom: null }, { cpuThrottled: 14, memoryEventsOom: null });
    expect(delta.cpuThrottled).toBe(4);
    expect(delta.memoryEventsOom).toBeNull();
  });

  it("defines the sample count below which percentiles are only indicative", () => {
    expect(ROBUST_MIN_SAMPLES).toBeGreaterThan(1);
  });
});
