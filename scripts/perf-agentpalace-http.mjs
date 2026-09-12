// Performance harness for the shared AgentPalace HTTP MCP. Run it from a built
// checkout (`npm run build`) or inside the runtime image, where dist/ exists.
//
// Measuring an already-running server is the production path:
//
//   PERF_BASE_URL=http://127.0.0.1:8765 \
//   PERF_TOKEN_FILE=/data/mempalace/server_tokens.json \
//   PERF_PALACE_PATH=/data/mempalace/remote-palace \
//   node scripts/perf-agentpalace-http.mjs
//
// Booting a disposable /tmp palace is for local development and CI only and
// requires explicit opt-in, because a second server competes for the deployed
// container's shared CPU and memory quota:
//
//   PERF_ALLOW_BOOT=1 node scripts/perf-agentpalace-http.mjs
//
// Knobs (environment):
//   PERF_BASE_URL=URL         measure an existing server instead of booting one (production path)
//   PERF_TOKEN / PERF_TOKEN_FILE / MEMPALACE_REMOTE_TOKEN  token for that server
//   PERF_PALACE_PATH=PATH     palace path of a target server, for RSS/process sampling
//   PERF_ALLOW_BOOT=1         opt in to spawning a disposable /tmp palace (never /data)
//   PERF_WING=wing_actuarius  wing for searches and writes (default: wing_perf)
//   PERF_QUERY=...            search query (default: a synthetic probe string)
//   PERF_CLIENTS=4            concurrent MCP clients (live target defaults to 1)
//   PERF_ITERATIONS=3         measured iterations per client per phase
//   PERF_BASELINE_ITERATIONS=3  sequential (1-client) baseline iterations; 0 disables
//   PERF_WARMUP=1             warm-up iterations per client (not recorded)
//   PERF_OPERATIONS=...       comma-separated subset of the known tools
//   PERF_SAMPLE_INTERVAL_MS=250  RSS sampling interval for peak/mean memory
//   PERF_REAL_EMBEDDINGS=1    use the real model (default: stub embeddings)
//   PERF_BIND=127.0.0.1:PORT  fixed bind (default: an ephemeral free port)
//   PERF_MAX_P95_MS=0         fail if any operation p95 exceeds this (0 = off)
//   PERF_MAX_ERROR_RATE=0     fail if the error fraction exceeds this
//   PERF_JSON=/path.json      also write the report as JSON
//   PERF_LOG_LEVEL=silent     pino level for a booted service
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import pino from "pino";

const DEFAULT_WING = "wing_perf";
const ROOM = "perf";
const DEFAULT_QUERY = "shared violet telescope calibration record";

/** Below this sample count, p95/p99 are reported but are not statistically stable. */
export const ROBUST_MIN_SAMPLES = 20;

const OPERATION_NAMES = [
  "status",
  "list_wings",
  "taxonomy",
  "wake_up",
  "search",
  "check_duplicate",
  "add_drawer",
  "kg_add",
  "diary_write",
];

const DEFAULTS = {
  clients: 4,
  liveClients: 1,
  iterations: 3,
  warmup: 1,
  sampleIntervalMs: 250,
  operations: ["status", "search", "wake_up", "add_drawer", "kg_add", "diary_write"],
  liveOperations: ["status", "search", "wake_up"],
  maxP95Ms: 0,
  maxErrorRate: 0,
};

export function parseOperations(raw) {
  const requested = raw.split(",").map((value) => value.trim()).filter(Boolean);
  const unknown = requested.filter((name) => !OPERATION_NAMES.includes(name));
  if (unknown.length > 0) throw new Error(`Unknown PERF_OPERATIONS entries: ${unknown.join(", ")}. Known: ${OPERATION_NAMES.join(", ")}`);
  if (requested.length === 0) throw new Error("PERF_OPERATIONS selected no operations");
  return requested;
}

/** Per-operation call definitions for the configured wing and query. `uid` is unique per call, so writes never short-circuit as duplicates. */
function createOperationDefs({ wing, query }) {
  return {
    status: { tool: "agentpalace_status", args: () => ({}) },
    list_wings: { tool: "agentpalace_list_wings", args: () => ({}) },
    taxonomy: { tool: "agentpalace_get_taxonomy", args: () => ({}) },
    wake_up: { tool: "agentpalace_wake_up", args: ({ client }) => ({ agent_name: `perf-${client}`, wing }) },
    search: { tool: "agentpalace_search", args: () => ({ query, wing }) },
    check_duplicate: { tool: "agentpalace_check_duplicate", args: ({ uid }) => ({ content: `perf probe ${uid}` }) },
    add_drawer: { tool: "agentpalace_add_drawer", args: ({ uid }) => ({ wing, room: ROOM, content: `perf drawer ${uid}` }) },
    kg_add: { tool: "agentpalace_kg_add", args: ({ uid }) => ({ subject: `perf_entity_${uid}`, predicate: "measured_by", object: "actuarius_perf" }) },
    diary_write: {
      tool: "agentpalace_diary_write",
      args: ({ client, uid }) => ({
        agent_name: `perf-${client}`,
        entry: `perf diary ${uid}`,
        summary: `perf diary ${uid}`,
        topic: "perf",
        scope: "project",
        wing,
      }),
    },
  };
}

export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const rank = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (rank - lower);
}

export function summarize(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? 0,
    meanMs: sorted.length > 0 ? total / sorted.length : 0,
    p50Ms: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

/** Peak/mean/first/last of a sampled series (e.g. RSS bytes), independent of the end-only snapshot. */
export function summarizeSeries(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { count: 0, firstBytes: null, lastBytes: null, minBytes: null, meanBytes: null, peakBytes: null };
  }
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    count: samples.length,
    firstBytes: samples[0],
    lastBytes: samples[samples.length - 1],
    minBytes: Math.min(...samples),
    meanBytes: total / samples.length,
    peakBytes: Math.max(...samples),
  };
}

/** Parse whitespace-separated `name value` counter files such as cgroup cpu.stat and memory.events. */
export function parseCounterLines(text) {
  const counters = {};
  for (const line of String(text ?? "").split("\n")) {
    const match = /^([^\s]+)\s+(-?\d+)\s*$/.exec(line.trim());
    if (match) counters[match[1]] = Number(match[2]);
  }
  return counters;
}

/** Parse a Linux PSI file (/proc/pressure/*) into `{ some: {...}, full: {...} }`. */
export function parsePsi(text) {
  const result = {};
  for (const line of String(text ?? "").split("\n")) {
    const match = /^(some|full)\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const entry = {};
    for (const token of match[2].split(/\s+/)) {
      const [key, value] = token.split("=");
      if (key && value !== undefined && value !== "") entry[key] = Number(value);
    }
    result[match[1]] = entry;
  }
  return result;
}

/** Parse /proc/meminfo, converting kB values to bytes. */
export function parseMeminfo(text) {
  const result = {};
  for (const line of String(text ?? "").split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line.trim());
    if (match) result[match[1]] = Number(match[2]) * 1024;
  }
  return result;
}

/** Element-wise `after - before` over numeric flat counter snapshots. */
export function computeCounterDeltas(before, after) {
  const delta = {};
  for (const key of Object.keys(after ?? {})) {
    const start = before?.[key];
    const end = after?.[key];
    delta[key] = typeof start === "number" && typeof end === "number" ? end - start : null;
  }
  return delta;
}

function envInt(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
  return value;
}

function envFloat(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a number >= ${min}`);
  return value;
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

async function resolveTarget() {
  let token = process.env.PERF_TOKEN;
  if (!token && process.env.PERF_TOKEN_FILE) {
    const parsed = JSON.parse(await readFile(process.env.PERF_TOKEN_FILE, "utf8"));
    const entries = Array.isArray(parsed) ? parsed : [];
    const entry = entries.find((candidate) => candidate && typeof candidate.token === "string" && candidate.enabled !== false);
    token = entry?.token;
  }
  if (!token) token = process.env.MEMPALACE_REMOTE_TOKEN;
  if (!token) throw new Error("PERF_BASE_URL requires PERF_TOKEN, PERF_TOKEN_FILE, or MEMPALACE_REMOTE_TOKEN");
  return { baseUrl: process.env.PERF_BASE_URL, token };
}

async function fetchServerInfo(baseUrl, token) {
  try {
    const response = await fetch(new URL("/v1/info", baseUrl), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return {};
    const info = await response.json();
    return {
      version: typeof info.server_version === "string" ? info.server_version : "unknown",
      embeddingProfile: typeof info.embedding_profile === "string" ? info.embedding_profile : undefined,
    };
  } catch {
    return {};
  }
}

function extractText(result) {
  if (!result || typeof result !== "object") return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function createTransport(url, token) {
  let sessionId = null;
  let nextId = 1;

  async function post(body) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "MCP-Protocol-Version": "2025-03-26",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const assigned = response.headers.get("mcp-session-id");
    if (assigned) sessionId = assigned;
    if (!response.ok) throw new Error(`AgentPalace HTTP MCP returned HTTP ${response.status}`);
    return response;
  }

  return {
    async initialize() {
      const id = nextId++;
      const response = await post({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "actuarius-perf", version: "1.0.0" } },
      });
      await response.json();
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
    },
    async callTool(tool, args) {
      const id = nextId++;
      const response = await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } });
      const message = await response.json();
      if (message.error) throw new Error(`MCP error ${message.error.code}: ${message.error.message}`);
      if (message.result && message.result.isError) throw new Error(extractText(message.result) || "AgentPalace tool error");
      return message.result;
    },
  };
}

function readTextFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readFirstPath(paths) {
  for (const path of paths) {
    const text = readTextFile(path);
    if (text !== null) return text;
  }
  return null;
}

/** All readable processes with their argv and resident set size. Linux only. */
function readProcesses() {
  if (process.platform !== "linux") return [];
  let entries;
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const processes = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const cmdline = readTextFile(`/proc/${entry}/cmdline`);
    if (!cmdline) continue;
    let rssBytes = null;
    const status = readTextFile(`/proc/${entry}/status`);
    if (status) {
      const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
      if (match) rssBytes = Number(match[1]) * 1024;
    }
    processes.push({ pid: Number(entry), argv: cmdline.split("\0").filter(Boolean), rssBytes });
  }
  return processes;
}

function isAgentPalaceBinary(arg) {
  return /(^|[\\/])agentpalace(\.exe)?$/.test(arg);
}

/** AgentPalace `serve` processes, optionally filtered to one palace path via an exact `--palace <path>` argument. */
function readAgentPalaceProcesses(palacePath) {
  const wanted = palacePath ? resolve(palacePath) : null;
  return readProcesses().filter((entry) => {
    if (!entry.argv.some(isAgentPalaceBinary) || !entry.argv.includes("serve")) return false;
    return wanted ? entry.argv.includes(wanted) : true;
  });
}

/** Best-effort flat snapshot of Linux cgroup, PSI, and host memory counters. */
export function snapshotSystemCounters() {
  if (process.platform !== "linux") return null;
  const counters = {};
  const cpuStat = readFirstPath(["/sys/fs/cgroup/cpu.stat", "/sys/fs/cgroup/cpu/cpu.stat"]);
  if (cpuStat) {
    const parsed = parseCounterLines(cpuStat);
    counters.cpuUsageUsec = parsed.usage_usec ?? null;
    counters.cpuPeriods = parsed.nr_periods ?? null;
    counters.cpuThrottled = parsed.nr_throttled ?? null;
    counters.cpuThrottledUsec = parsed.throttled_usec ?? null;
  }
  const memoryCurrent = readFirstPath(["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"]);
  if (memoryCurrent && /^\d+$/.test(memoryCurrent.trim())) counters.memoryCurrentBytes = Number(memoryCurrent.trim());
  const memoryMax = readFirstPath(["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]);
  if (memoryMax && /^\d+$/.test(memoryMax.trim())) counters.memoryMaxBytes = Number(memoryMax.trim());
  const memoryEvents = readTextFile("/sys/fs/cgroup/memory.events");
  if (memoryEvents) {
    const parsed = parseCounterLines(memoryEvents);
    counters.memoryEventsMax = parsed.max ?? null;
    counters.memoryEventsOom = parsed.oom ?? null;
    counters.memoryEventsOomKill = parsed.oom_kill ?? null;
  }
  const memorySwap = readTextFile("/sys/fs/cgroup/memory.swap.current");
  if (memorySwap && /^\d+$/.test(memorySwap.trim())) counters.memorySwapCurrentBytes = Number(memorySwap.trim());
  for (const [name, key] of [["cpu", "psiCpu"], ["memory", "psiMemory"], ["io", "psiIo"]]) {
    const text = readTextFile(`/proc/pressure/${name}`);
    if (!text) continue;
    const parsed = parsePsi(text);
    counters[`${key}SomeTotalUsec`] = parsed.some?.total ?? null;
    counters[`${key}FullTotalUsec`] = parsed.full?.total ?? null;
  }
  const meminfo = readTextFile("/proc/meminfo");
  if (meminfo) {
    const parsed = parseMeminfo(meminfo);
    counters.memAvailableBytes = parsed.MemAvailable ?? null;
    counters.memSwapFreeBytes = parsed.SwapFree ?? null;
    counters.memSwapTotalBytes = parsed.SwapTotal ?? null;
  }
  return counters;
}

/** Pre-existing AgentPalace/benchmark activity that would contend with a run. */
export function detectOverlappingActivity({ palacePath = null } = {}) {
  const selfPids = new Set([process.pid, process.ppid].filter((pid) => typeof pid === "number"));
  const processes = readProcesses().filter((entry) => !selfPids.has(entry.pid));
  const wantedPalace = palacePath ? resolve(palacePath) : null;
  const agentpalace = processes.filter((entry) => entry.argv.some(isAgentPalaceBinary));
  const serve = agentpalace.filter((entry) => entry.argv.includes("serve"));
  const target = wantedPalace ? serve.filter((entry) => entry.argv.includes(wantedPalace)) : serve;
  const others = wantedPalace ? serve.filter((entry) => !entry.argv.includes(wantedPalace)) : [];
  const mining = agentpalace.filter((entry) => entry.argv.includes("mine"));
  const harnesses = processes.filter((entry) => entry.argv.some((arg) => /(^|[\\/])perf-agentpalace-http\.mjs$/.test(arg)));
  const bots = processes.filter((entry) => entry.argv.some((arg) => /dist[\\/]index\.(js|ts)$/.test(arg)));
  let disposablePalaceDirs = [];
  try {
    disposablePalaceDirs = readdirSync(tmpdir())
      .filter((name) => name.startsWith("actuarius-agentpalace-perf-"))
      .sort();
  } catch {
    disposablePalaceDirs = [];
  }
  return {
    detectedAt: new Date().toISOString(),
    disposablePalaceDirs,
    agentpalaceServeProcesses: serve.length,
    agentpalaceMiningProcesses: mining.length,
    actuariusBotProcesses: bots.length,
    targetPalaceProcesses: target.length,
    otherPalaceProcesses: others.length,
    perfHarnessProcesses: harnesses.length,
    contentionSuspected: disposablePalaceDirs.length > 0 || others.length > 0 || mining.length > 0 || harnesses.length > 0,
  };
}

/** Samples target RSS (peak/mean) and system counters across a measured window. */
class SystemSampler {
  constructor({ palacePath, intervalMs, logger }) {
    this.palacePath = palacePath ? resolve(palacePath) : null;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.timer = null;
    this.before = null;
    this.after = null;
    this.targetSamples = [];
    this.allSamples = [];
    this.targetCounts = [];
    this.allCounts = [];
  }

  sampleOnce() {
    const all = readAgentPalaceProcesses();
    const target = this.palacePath ? all.filter((entry) => entry.argv.includes(this.palacePath)) : all;
    this.targetSamples.push(target.reduce((sum, entry) => sum + (entry.rssBytes ?? 0), 0));
    this.allSamples.push(all.reduce((sum, entry) => sum + (entry.rssBytes ?? 0), 0));
    this.targetCounts.push(target.length);
    this.allCounts.push(all.length);
  }

  start() {
    this.before = snapshotSystemCounters();
    this.sampleOnce();
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => {
        try {
          this.sampleOnce();
        } catch (error) {
          this.logger?.debug?.(`RSS sample failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sampleOnce();
    this.after = snapshotSystemCounters();
    const series = (samples, counts) => ({
      ...summarizeSeries(samples),
      processCountMin: counts.length > 0 ? Math.min(...counts) : null,
      processCountMax: counts.length > 0 ? Math.max(...counts) : null,
    });
    return {
      intervalMs: this.intervalMs,
      counters: {
        before: this.before,
        after: this.after,
        delta: this.before && this.after ? computeCounterDeltas(this.before, this.after) : null,
      },
      rss: {
        target: this.palacePath ? series(this.targetSamples, this.targetCounts) : null,
        allAgentPalace: series(this.allSamples, this.allCounts),
      },
    };
  }
}

function formatBytes(value) {
  if (value === null || value === undefined) return "n/a";
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function formatDurationMs(value) {
  if (value === null || value === undefined) return "n/a";
  return `${value.toFixed(1)} ms`;
}

/** Run one measured phase and return per-operation stats and errors. */
async function runPhase({ transports, operationDefs, operations, iterations, phase }) {
  const samples = new Map(operations.map((operation) => [operation, []]));
  const errorsByOperation = {};
  const errorSamples = [];
  let errorCount = 0;
  let uidCounter = 0;
  const startedAt = performance.now();
  await Promise.all(
    transports.map(async (transport, client) => {
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        for (const operation of operations) {
          const definition = operationDefs[operation];
          const uid = `${phase}-${uidCounter++}-c${client}-i${iteration}`;
          const callStartedAt = performance.now();
          try {
            await transport.callTool(definition.tool, definition.args({ client, iteration, uid }));
            samples.get(operation).push(performance.now() - callStartedAt);
          } catch (error) {
            errorCount += 1;
            errorsByOperation[operation] = (errorsByOperation[operation] ?? 0) + 1;
            if (errorSamples.length < 10) errorSamples.push({ operation, message: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    })
  );
  const wallMs = performance.now() - startedAt;
  const operationStats = {};
  for (const operation of operations) operationStats[operation] = summarize(samples.get(operation));
  const totalCalls = transports.length * iterations * operations.length;
  return {
    clients: transports.length,
    iterations,
    wallMs,
    totalCalls,
    throughputPerSec: wallMs > 0 ? (totalCalls / wallMs) * 1000 : 0,
    errorCount,
    errorRate: totalCalls > 0 ? errorCount / totalCalls : 0,
    errorsByOperation,
    errorSamples,
    operations: operationStats,
  };
}

const OPERATION_HEADER = ["operation", "n", "mean", "p50", "p90", "p95", "p99", "max", "errors"];

function operationRows(phase) {
  return Object.entries(phase.operations).map(([name, stats]) => [
    name,
    String(stats.count),
    stats.meanMs.toFixed(1),
    stats.p50Ms.toFixed(1),
    stats.p90Ms.toFixed(1),
    stats.p95Ms.toFixed(1),
    stats.p99Ms.toFixed(1),
    stats.maxMs.toFixed(1),
    String(phase.errorsByOperation[name] ?? 0),
  ]);
}

function printPhaseTable(phase) {
  const rows = operationRows(phase);
  const widths = OPERATION_HEADER.map((cell, index) => Math.max(cell.length, ...rows.map((row) => row[index].length)));
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  console.log(line(OPERATION_HEADER));
  console.log(line(widths.map((width) => "-".repeat(width))));
  for (const row of rows) console.log(line(row));
}

function printPhaseSummary(label, phase) {
  console.log(`${label}: clients=${phase.clients} calls=${phase.totalCalls} wall=${phase.wallMs.toFixed(1)}ms throughput=${phase.throughputPerSec.toFixed(1)}/s errors=${phase.errorCount} (${(phase.errorRate * 100).toFixed(2)}%)`);
}

function printSystemReport(system) {
  const counters = system.counters;
  const delta = counters?.delta;
  if (delta && counters.before && counters.after) {
    const before = counters.before;
    const after = counters.after;
    console.log(
      `system/cpu: throttled=${delta.cpuThrottled ?? 0}/${delta.cpuPeriods ?? 0} periods, throttledUs=${formatDurationMs((delta.cpuThrottledUsec ?? 0) / 1000)}, usageUs=${formatDurationMs((delta.cpuUsageUsec ?? 0) / 1000)}`
    );
    console.log(
      `system/memory (gauge before -> after): current ${formatBytes(before.memoryCurrentBytes)} -> ${formatBytes(after.memoryCurrentBytes)}, max=${formatBytes(after.memoryMaxBytes ?? before.memoryMaxBytes)}, swap ${formatBytes(before.memorySwapCurrentBytes)} -> ${formatBytes(after.memorySwapCurrentBytes)}, events delta (max=${delta.memoryEventsMax ?? "n/a"}, oom=${delta.memoryEventsOom ?? "n/a"}, oom_kill=${delta.memoryEventsOomKill ?? "n/a"})`
    );
    console.log(
      `system/host (gauge before -> after): MemAvailable ${formatBytes(before.memAvailableBytes)} -> ${formatBytes(after.memAvailableBytes)}, SwapFree ${formatBytes(before.memSwapFreeBytes)} -> ${formatBytes(after.memSwapFreeBytes)}`
    );
    console.log(
      `system/psi (delta): cpuSome=${formatDurationMs((delta.psiCpuSomeTotalUsec ?? 0) / 1000)} memorySome=${formatDurationMs((delta.psiMemorySomeTotalUsec ?? 0) / 1000)} memoryFull=${formatDurationMs((delta.psiMemoryFullTotalUsec ?? 0) / 1000)} ioSome=${formatDurationMs((delta.psiIoSomeTotalUsec ?? 0) / 1000)}`
    );
  } else {
    console.log("system: counters unavailable on this platform");
  }
  const rss = system.rss;
  if (rss?.target) {
    console.log(
      `rss/target (every ${system.intervalMs}ms, n=${rss.target.count}): peak=${formatBytes(rss.target.peakBytes)} mean=${formatBytes(rss.target.meanBytes)} last=${formatBytes(rss.target.lastBytes)} processes=${rss.target.processCountMin}..${rss.target.processCountMax}`
    );
  }
  if (rss?.allAgentPalace) {
    console.log(
      `rss/all-agentpalace (n=${rss.allAgentPalace.count}): peak=${formatBytes(rss.allAgentPalace.peakBytes)} mean=${formatBytes(rss.allAgentPalace.meanBytes)} last=${formatBytes(rss.allAgentPalace.lastBytes)} processes=${rss.allAgentPalace.processCountMin}..${rss.allAgentPalace.processCountMax}`
    );
  }
}

function printReport(report) {
  const embeddings = report.agentpalace.stubEmbeddings === null ? "unknown" : report.agentpalace.stubEmbeddings ? "stub" : "real";
  console.log("");
  console.log(`AgentPalace ${report.agentpalace.version} | profile=${report.agentpalace.embeddingProfile} | embeddings=${embeddings} | target=${report.agentpalace.target}`);
  console.log(`wing=${report.config.wing} query=${JSON.stringify(report.config.query)} warmup=${report.config.warmup} baselineIterations=${report.config.baselineIterations}`);
  console.log("");
  if (report.baseline) {
    printPhaseSummary("baseline (sequential)", report.baseline);
    printPhaseTable(report.baseline);
    console.log("");
  }
  printPhaseSummary("concurrent", report.concurrent);
  printPhaseTable(report.concurrent);
  console.log("");
  printSystemReport(report.system);
  const overlap = report.overlappingActivity;
  console.log(
    `overlap: disposablePalaceDirs=${overlap.disposablePalaceDirs.length} otherPalaces=${overlap.otherPalaceProcesses} mining=${overlap.agentpalaceMiningProcesses} bots=${overlap.actuariusBotProcesses} harnessProcesses=${overlap.perfHarnessProcesses} contentionSuspected=${overlap.contentionSuspected}`
  );
  if (report.caveats.length > 0) {
    console.log("");
    console.log("caveats:");
    for (const caveat of report.caveats) console.log(`  - ${caveat}`);
  }
  console.log("");
}

async function seedSearchCorpus(transport, { wing, query }) {
  for (let index = 0; index < 5; index += 1) {
    await transport.callTool("agentpalace_add_drawer", { wing, room: ROOM, content: `${query} seed ${index}` });
  }
}

async function main() {
  let MemPalaceRemoteService;
  try {
    ({ MemPalaceRemoteService } = await import("../dist/services/memPalaceRemoteService.js"));
  } catch (error) {
    if (error && error.code === "ERR_MODULE_NOT_FOUND") throw new Error("dist/ is missing — run `npm run build` before the perf harness");
    throw error;
  }

  const targetingLive = typeof process.env.PERF_BASE_URL === "string" && process.env.PERF_BASE_URL.trim() !== "";
  if (!targetingLive && process.env.PERF_ALLOW_BOOT !== "1") {
    throw new Error(
      "Refusing to spawn a disposable AgentPalace server. Measure an existing server with PERF_BASE_URL (the production path), " +
        "or set PERF_ALLOW_BOOT=1 to boot a throwaway /tmp palace for local development or CI."
    );
  }

  const settings = {
    clients: envInt("PERF_CLIENTS", targetingLive ? DEFAULTS.liveClients : DEFAULTS.clients, { min: 1 }),
    iterations: envInt("PERF_ITERATIONS", DEFAULTS.iterations, { min: 1 }),
    warmup: envInt("PERF_WARMUP", DEFAULTS.warmup, { min: 0 }),
    baselineIterations: envInt("PERF_BASELINE_ITERATIONS", DEFAULTS.iterations, { min: 0 }),
    sampleIntervalMs: envInt("PERF_SAMPLE_INTERVAL_MS", DEFAULTS.sampleIntervalMs, { min: 0 }),
    maxP95Ms: envFloat("PERF_MAX_P95_MS", DEFAULTS.maxP95Ms, { min: 0 }),
    maxErrorRate: envFloat("PERF_MAX_ERROR_RATE", DEFAULTS.maxErrorRate, { min: 0 }),
    operations: process.env.PERF_OPERATIONS ? parseOperations(process.env.PERF_OPERATIONS) : [...(targetingLive ? DEFAULTS.liveOperations : DEFAULTS.operations)],
    realEmbeddings: process.env.PERF_REAL_EMBEDDINGS === "1",
    wing: process.env.PERF_WING || DEFAULT_WING,
    query: process.env.PERF_QUERY || DEFAULT_QUERY,
  };
  const operationDefs = createOperationDefs({ wing: settings.wing, query: settings.query });

  const logger = pino({ level: process.env.PERF_LOG_LEVEL ?? "silent" });
  const stopCallbacks = [];
  const cleanupPaths = [];
  const requestedPalacePath = process.env.PERF_PALACE_PATH ? resolve(process.env.PERF_PALACE_PATH) : null;
  const overlappingActivity = detectOverlappingActivity({ palacePath: requestedPalacePath });
  let endpoint;
  if (targetingLive) {
    const { baseUrl, token } = await resolveTarget();
    const info = await fetchServerInfo(baseUrl, token);
    endpoint = {
      mcpUrl: new URL("/mcp", baseUrl).toString(),
      token,
      target: baseUrl,
      palacePath: requestedPalacePath,
      version: info.version ?? "unknown",
      embeddingProfile: info.embeddingProfile ?? process.env.PERF_EMBEDDING_PROFILE ?? "unknown",
      stubEmbeddings: null,
      startupMs: 0,
    };
    console.log(`Targeting existing AgentPalace at ${baseUrl} with ${settings.clients} client(s); this drives the live server.`);
  } else {
    if (readTextFile("/data/mempalace/server_tokens.json") !== null) {
      console.warn("Warning: a deployed palace token file exists; booting a second server on this VM contends for the shared CPU and memory quota.");
    }
    const root = await mkdtemp(join(tmpdir(), "actuarius-agentpalace-perf-"));
    cleanupPaths.push(root);
    const home = join(root, "home");
    const bind = process.env.PERF_BIND || `127.0.0.1:${await freePort()}`;
    const palacePath = join(root, "remote-palace");
    process.env.AGENTPALACE_STUB_EMBEDDINGS = settings.realEmbeddings ? "0" : "1";
    if (!settings.realEmbeddings) process.env.XDG_CACHE_HOME = join(root, "cache");
    const config = {
      mempalaceEnabled: true,
      mempalaceRemoteEnabled: true,
      mempalaceCliPath: process.env.PERF_AGENTPALACE_BIN ?? "/usr/local/bin/agentpalace",
      mempalaceEmbeddingProfile: process.env.PERF_EMBEDDING_PROFILE ?? "low_cpu",
      mempalacePalacePath: join(root, "old-local"),
      mempalaceRemotePalacePath: palacePath,
      mempalaceRemoteBind: bind,
      mempalaceRemoteUrl: `http://${bind}`,
      mempalaceRemoteName: "actuarius",
      mempalaceRemoteToken: "actuarius-perf-token",
      mempalaceRemoteTokenFile: join(root, "tokens.json"),
      mempalaceRemoteMineOnSync: false,
      reposRootPath: join(root, "repos"),
    };
    await mkdir(config.mempalacePalacePath, { recursive: true });
    let version = "unknown";
    try {
      version = execFileSync(config.mempalaceCliPath, ["--version"], { encoding: "utf8" }).trim();
    } catch {
      version = "unknown";
    }
    const service = new MemPalaceRemoteService(config, logger, { homeDir: home });
    const startedAt = performance.now();
    await service.start();
    endpoint = {
      mcpUrl: service.mcpUrl,
      token: await service.getMcpToken(),
      target: bind,
      palacePath,
      version,
      embeddingProfile: config.mempalaceEmbeddingProfile,
      stubEmbeddings: !settings.realEmbeddings,
      startupMs: performance.now() - startedAt,
    };
    stopCallbacks.push(() => service.stop());
  }

  try {
    const transports = Array.from({ length: settings.clients }, () => createTransport(endpoint.mcpUrl, endpoint.token));
    for (const transport of transports) await transport.initialize();

    if (!targetingLive) await seedSearchCorpus(transports[0], { wing: settings.wing, query: settings.query });
    for (let round = 0; round < settings.warmup; round += 1) {
      await Promise.all(
        transports.map(async (transport, client) => {
          for (const [index, operation] of settings.operations.entries()) {
            const definition = operationDefs[operation];
            await transport.callTool(definition.tool, definition.args({ client, iteration: round, uid: `warm-${client}-${round}-${index}` }));
          }
        })
      );
    }

    const sampler = new SystemSampler({ palacePath: endpoint.palacePath, intervalMs: settings.sampleIntervalMs, logger });
    sampler.start();
    let baseline = null;
    if (settings.baselineIterations > 0) {
      baseline = await runPhase({ transports: transports.slice(0, 1), operationDefs, operations: settings.operations, iterations: settings.baselineIterations, phase: "base" });
    }
    const concurrent = await runPhase({ transports, operationDefs, operations: settings.operations, iterations: settings.iterations, phase: "conc" });
    const system = sampler.stop();

    const minSamples = Math.min(...settings.operations.map((operation) => concurrent.operations[operation].count));
    const caveats = [];
    if (minSamples < ROBUST_MIN_SAMPLES) {
      caveats.push(`Percentiles are indicative only: the smallest per-operation sample is n=${minSamples}; p95/p99 need n>=${ROBUST_MIN_SAMPLES} to be stable.`);
    }
    if (overlappingActivity.contentionSuspected) {
      caveats.push("Overlapping AgentPalace/benchmark activity was detected at startup; treat latency as contended, not a clean baseline.");
    }
    if (!targetingLive) {
      caveats.push("Disposable stub-embedding palace: this does not represent the deployed server's embeddings, data volume, or shared load.");
    }
    if (targetingLive && !process.env.PERF_WING) {
      caveats.push("Live search used the default wing_perf and a synthetic query; set PERF_WING and PERF_QUERY for a representative project search.");
    }
    const delta = system.counters?.delta;
    if (delta && (delta.cpuThrottled ?? 0) > 0) {
      caveats.push(`CPU throttling occurred during the run (${delta.cpuThrottled} throttled periods of ${delta.cpuPeriods ?? "n/a"}); latency includes throttling.`);
    }
    if (delta && ((delta.memoryEventsMax ?? 0) > 0 || (delta.memoryEventsOom ?? 0) > 0 || (delta.memoryEventsOomKill ?? 0) > 0)) {
      caveats.push("Memory cgroup pressure events increased during the run; the workload may have hit the memory limit.");
    }

    const report = {
      generatedAt: new Date().toISOString(),
      agentpalace: {
        version: endpoint.version,
        embeddingProfile: endpoint.embeddingProfile,
        stubEmbeddings: endpoint.stubEmbeddings,
        target: endpoint.target,
      },
      config: {
        clients: settings.clients,
        iterations: settings.iterations,
        warmup: settings.warmup,
        baselineIterations: settings.baselineIterations,
        sampleIntervalMs: settings.sampleIntervalMs,
        operations: settings.operations,
        realEmbeddings: settings.realEmbeddings,
        wing: settings.wing,
        query: settings.query,
      },
      startupMs: endpoint.startupMs,
      baseline,
      concurrent,
      system,
      overlappingActivity,
      caveats,
    };

    printReport(report);
    if (process.env.PERF_JSON) {
      await writeFile(process.env.PERF_JSON, JSON.stringify(report, null, 2) + "\n", "utf8");
      console.log(`Wrote ${process.env.PERF_JSON}`);
    }

    const failures = [];
    if (concurrent.errorRate > settings.maxErrorRate) failures.push(`error rate ${(concurrent.errorRate * 100).toFixed(2)}% exceeds ${(settings.maxErrorRate * 100).toFixed(2)}%`);
    if (settings.maxP95Ms > 0) {
      for (const [operation, stats] of Object.entries(concurrent.operations)) {
        if (stats.p95Ms > settings.maxP95Ms) failures.push(`${operation} p95 ${stats.p95Ms.toFixed(1)}ms exceeds ${settings.maxP95Ms}ms`);
      }
    }
    if (failures.length > 0) {
      console.error(`FAIL: ${failures.join("; ")}`);
      process.exitCode = 1;
    } else {
      console.log(`PASS: ${concurrent.totalCalls} concurrent calls across ${settings.clients} clients, ${concurrent.throughputPerSec.toFixed(1)} ops/s, error rate ${(concurrent.errorRate * 100).toFixed(2)}%`);
    }
  } finally {
    for (const stop of stopCallbacks) await stop().catch(() => undefined);
    for (const path of cleanupPaths) await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(2);
  });
}
