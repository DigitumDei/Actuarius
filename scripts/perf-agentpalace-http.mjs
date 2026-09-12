// Performance harness for the shared AgentPalace HTTP MCP. Run it from a built
// checkout (`npm run build`) or inside the runtime image, where dist/ exists.
// By default it boots a disposable /tmp palace; set PERF_BASE_URL to measure an
// already-running server instead. It never opens a deployed /data palace.
//
//   node scripts/perf-agentpalace-http.mjs
//   PERF_BASE_URL=http://127.0.0.1:8765 MEMPALACE_REMOTE_TOKEN=... node scripts/perf-agentpalace-http.mjs
//
// Knobs (environment):
//   PERF_CLIENTS=4            concurrent MCP clients (live target defaults to 1)
//   PERF_ITERATIONS=3         measured iterations per client
//   PERF_WARMUP=1             warm-up iterations per client (not recorded)
//   PERF_OPERATIONS=...       comma-separated subset of the known tools
//   PERF_REAL_EMBEDDINGS=1    use the real model (default: stub embeddings)
//   PERF_BIND=127.0.0.1:PORT  fixed bind (default: an ephemeral free port)
//   PERF_BASE_URL=URL         measure an existing server instead of booting one
//   PERF_TOKEN / PERF_TOKEN_FILE / MEMPALACE_REMOTE_TOKEN  token for that server
//   PERF_PALACE_PATH=PATH     palace path of a target server, for RSS sampling
//   PERF_MAX_P95_MS=0         fail if any operation p95 exceeds this (0 = off)
//   PERF_MAX_ERROR_RATE=0     fail if the error fraction exceeds this
//   PERF_JSON=/path.json      also write the report as JSON
//   PERF_LOG_LEVEL=silent     pino level for a booted service
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import pino from "pino";

const WING = "wing_perf";
const ROOM = "perf";
const SEARCH_QUERY = "shared violet telescope calibration record";

const DEFAULTS = {
  clients: 4,
  liveClients: 1,
  iterations: 3,
  warmup: 1,
  operations: ["status", "search", "wake_up", "add_drawer", "kg_add", "diary_write"],
  liveOperations: ["status", "search", "wake_up"],
  maxP95Ms: 0,
  maxErrorRate: 0,
};

/** Per-operation call definitions. `uid` is unique per call, so writes never hit duplicate short-circuits. */
const OPERATION_DEFS = {
  status: { tool: "agentpalace_status", args: () => ({}) },
  list_wings: { tool: "agentpalace_list_wings", args: () => ({}) },
  taxonomy: { tool: "agentpalace_get_taxonomy", args: () => ({}) },
  wake_up: { tool: "agentpalace_wake_up", args: ({ client }) => ({ agent_name: `perf-${client}`, wing: WING }) },
  search: { tool: "agentpalace_search", args: () => ({ query: SEARCH_QUERY, wing: WING }) },
  check_duplicate: { tool: "agentpalace_check_duplicate", args: ({ uid }) => ({ content: `perf probe ${uid}` }) },
  add_drawer: { tool: "agentpalace_add_drawer", args: ({ uid }) => ({ wing: WING, room: ROOM, content: `perf drawer ${uid}` }) },
  kg_add: { tool: "agentpalace_kg_add", args: ({ uid }) => ({ subject: `perf_entity_${uid}`, predicate: "measured_by", object: "actuarius_perf" }) },
  diary_write: {
    tool: "agentpalace_diary_write",
    args: ({ client, uid }) => ({
      agent_name: `perf-${client}`,
      entry: `perf diary ${uid}`,
      summary: `perf diary ${uid}`,
      topic: "perf",
      scope: "project",
      wing: WING,
    }),
  },
};

export function parseOperations(raw) {
  const requested = raw.split(",").map((value) => value.trim()).filter(Boolean);
  const unknown = requested.filter((name) => !(name in OPERATION_DEFS));
  if (unknown.length > 0) throw new Error(`Unknown PERF_OPERATIONS entries: ${unknown.join(", ")}. Known: ${Object.keys(OPERATION_DEFS).join(", ")}`);
  if (requested.length === 0) throw new Error("PERF_OPERATIONS selected no operations");
  return requested;
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

function readAgentPalaceRssBytes(palacePath) {
  if (!palacePath || process.platform !== "linux") return null;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let cmdline;
      try {
        cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      } catch {
        continue;
      }
      if (!cmdline.includes("agentpalace") || !cmdline.includes("serve") || !cmdline.includes(palacePath)) continue;
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
      if (match) return Number(match[1]) * 1024;
    }
  } catch {
    return null;
  }
  return null;
}

function formatBytes(value) {
  if (value === null || value === undefined) return "n/a";
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function printReport(report) {
  const header = ["operation", "n", "mean", "p50", "p90", "p95", "p99", "max", "errors"];
  const rows = Object.entries(report.operations).map(([name, stats]) => [
    name,
    String(stats.count),
    stats.meanMs.toFixed(1),
    stats.p50Ms.toFixed(1),
    stats.p90Ms.toFixed(1),
    stats.p95Ms.toFixed(1),
    stats.p99Ms.toFixed(1),
    stats.maxMs.toFixed(1),
    String(report.errorsByOperation[name] ?? 0),
  ]);
  const widths = header.map((_, index) => Math.max(header[index].length, ...rows.map((row) => row[index].length)));
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  const embeddings = report.agentpalace.stubEmbeddings === null ? "unknown" : report.agentpalace.stubEmbeddings ? "stub" : "real";
  console.log("");
  console.log(`AgentPalace ${report.agentpalace.version} | profile=${report.agentpalace.embeddingProfile} | embeddings=${embeddings} | target=${report.agentpalace.target}`);
  console.log(`clients=${report.config.clients} iterations=${report.config.iterations} warmup=${report.config.warmup}`);
  console.log(`startup=${report.startupMs.toFixed(1)}ms wall=${report.wallMs.toFixed(1)}ms calls=${report.totalCalls} throughput=${report.throughputPerSec.toFixed(1)}/s errors=${report.errorCount} (${(report.errorRate * 100).toFixed(2)}%) rss=${formatBytes(report.serverRssBytes)}`);
  console.log("");
  console.log(line(header));
  console.log(line(widths.map((width) => "-".repeat(width))));
  for (const row of rows) console.log(line(row));
  console.log("");
}

async function seedSearchCorpus(transport) {
  for (let index = 0; index < 5; index += 1) {
    await transport.callTool("agentpalace_add_drawer", { wing: WING, room: ROOM, content: `${SEARCH_QUERY} seed ${index}` });
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
  const settings = {
    clients: envInt("PERF_CLIENTS", targetingLive ? DEFAULTS.liveClients : DEFAULTS.clients, { min: 1 }),
    iterations: envInt("PERF_ITERATIONS", DEFAULTS.iterations, { min: 1 }),
    warmup: envInt("PERF_WARMUP", DEFAULTS.warmup, { min: 0 }),
    maxP95Ms: envFloat("PERF_MAX_P95_MS", DEFAULTS.maxP95Ms, { min: 0 }),
    maxErrorRate: envFloat("PERF_MAX_ERROR_RATE", DEFAULTS.maxErrorRate, { min: 0 }),
    operations: process.env.PERF_OPERATIONS ? parseOperations(process.env.PERF_OPERATIONS) : [...(targetingLive ? DEFAULTS.liveOperations : DEFAULTS.operations)],
    realEmbeddings: process.env.PERF_REAL_EMBEDDINGS === "1",
  };

  const logger = pino({ level: process.env.PERF_LOG_LEVEL ?? "silent" });
  const stopCallbacks = [];
  let endpoint;
  if (targetingLive) {
    const { baseUrl, token } = await resolveTarget();
    const info = await fetchServerInfo(baseUrl, token);
    endpoint = {
      mcpUrl: new URL("/mcp", baseUrl).toString(),
      token,
      target: baseUrl,
      palacePath: process.env.PERF_PALACE_PATH ? resolve(process.env.PERF_PALACE_PATH) : null,
      version: info.version ?? "unknown",
      embeddingProfile: info.embeddingProfile ?? process.env.PERF_EMBEDDING_PROFILE ?? "unknown",
      stubEmbeddings: null,
      startupMs: 0,
    };
    console.log(`Targeting existing AgentPalace at ${baseUrl} with ${settings.clients} client(s); this drives the live server.`);
  } else {
    const root = await mkdtemp(join(tmpdir(), "actuarius-agentpalace-perf-"));
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

    if (!targetingLive) await seedSearchCorpus(transports[0]);
    for (let round = 0; round < settings.warmup; round += 1) {
      await Promise.all(
        transports.map(async (transport, client) => {
          for (const [index, operation] of settings.operations.entries()) {
            const definition = OPERATION_DEFS[operation];
            await transport.callTool(definition.tool, definition.args({ client, iteration: round, uid: `warm-${client}-${round}-${index}` }));
          }
        })
      );
    }

    const samples = new Map(settings.operations.map((operation) => [operation, []]));
    const errorsByOperation = {};
    const errorSamples = [];
    let errorCount = 0;
    let uidCounter = 0;
    const measuredAt = performance.now();
    await Promise.all(
      transports.map(async (transport, client) => {
        for (let iteration = 0; iteration < settings.iterations; iteration += 1) {
          for (const operation of settings.operations) {
            const definition = OPERATION_DEFS[operation];
            const uid = `m${uidCounter++}-c${client}-i${iteration}`;
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
    const wallMs = performance.now() - measuredAt;

    const operations = {};
    for (const operation of settings.operations) operations[operation] = summarize(samples.get(operation));
    const totalCalls = settings.clients * settings.iterations * settings.operations.length;
    const errorRate = totalCalls > 0 ? errorCount / totalCalls : 0;

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
        operations: settings.operations,
        realEmbeddings: settings.realEmbeddings,
      },
      startupMs: endpoint.startupMs,
      wallMs,
      totalCalls,
      throughputPerSec: wallMs > 0 ? (totalCalls / wallMs) * 1000 : 0,
      errorCount,
      errorRate,
      errorsByOperation,
      errorSamples,
      serverRssBytes: readAgentPalaceRssBytes(endpoint.palacePath),
      operations,
    };

    printReport(report);
    if (process.env.PERF_JSON) {
      await writeFile(process.env.PERF_JSON, JSON.stringify(report, null, 2) + "\n", "utf8");
      console.log(`Wrote ${process.env.PERF_JSON}`);
    }

    const failures = [];
    if (errorRate > settings.maxErrorRate) failures.push(`error rate ${(errorRate * 100).toFixed(2)}% exceeds ${(settings.maxErrorRate * 100).toFixed(2)}%`);
    if (settings.maxP95Ms > 0) {
      for (const [operation, stats] of Object.entries(operations)) {
        if (stats.p95Ms > settings.maxP95Ms) failures.push(`${operation} p95 ${stats.p95Ms.toFixed(1)}ms exceeds ${settings.maxP95Ms}ms`);
      }
    }
    if (failures.length > 0) {
      console.error(`FAIL: ${failures.join("; ")}`);
      process.exitCode = 1;
    } else {
      console.log(`PASS: ${totalCalls} calls across ${settings.clients} clients, ${report.throughputPerSec.toFixed(1)} ops/s, error rate ${(errorRate * 100).toFixed(2)}%`);
    }
  } finally {
    for (const stop of stopCallbacks) await stop().catch(() => undefined);
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(2);
  });
}
