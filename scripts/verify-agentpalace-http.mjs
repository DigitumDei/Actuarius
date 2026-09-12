// Run inside the built runtime image with this file mounted at /app/scripts/.
// Uses only disposable /tmp stores; never opens the deployed /data palaces.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { MemPalaceRemoteService } from "../dist/services/memPalaceRemoteService.js";
import { MemPalaceClient } from "../dist/services/memPalaceClient.js";

const root = await mkdtemp(join(tmpdir(), "actuarius-http-smoke-"));
const home = join(root, "home");
const logger = pino({ level: process.env.AGENTPALACE_SMOKE_REAL_EMBEDDINGS === "1" ? "info" : "silent" });
process.env.AGENTPALACE_STUB_EMBEDDINGS = process.env.AGENTPALACE_SMOKE_REAL_EMBEDDINGS === "1" ? "0" : "1";
process.env.XDG_CACHE_HOME = join(root, "cache");
const config = {
  mempalaceEnabled: true, mempalaceRemoteEnabled: true,
  mempalaceCliPath: "/usr/local/bin/agentpalace", mempalaceEmbeddingProfile: "low_cpu",
  mempalacePalacePath: join(root, "old-local"), mempalaceRemotePalacePath: join(root, "remote-palace"),
  mempalaceRemoteBind: "127.0.0.1:8765", mempalaceRemoteUrl: "http://127.0.0.1:8765",
  mempalaceRemoteName: "actuarius", mempalaceRemoteToken: "isolated-smoke-token",
  mempalaceRemoteTokenFile: join(root, "tokens.json"), mempalaceRemoteMineOnSync: false,
  reposRootPath: join(root, "repos")
};
await mkdir(config.mempalacePalacePath);
await writeFile(join(config.mempalacePalacePath, "archive-marker"), "preserved");
const service = new MemPalaceRemoteService(config, logger, { homeDir: home });
const clients = Array.from({ length: 4 }, () => new MemPalaceClient(service.mcpUrl, config.mempalaceRemoteToken, logger));
try {
  await service.start();
  await Promise.all(clients.map(client => client.start()));
  await Promise.all(clients.map(client => client.status()));
  const response = await fetch(service.mcpUrl, {
    method: "POST", headers: { Authorization: "Bearer " + config.mempalaceRemoteToken, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/call", params: {
      name: "agentpalace_add_drawer", arguments: { wing: "wing_smoke", room: "general", content: "Shared violet telescope calibration record." }
    } })
  });
  assert.equal(response.status, 200);
  const rpc = await response.json();
  assert.notEqual(rpc.result.isError, true, JSON.stringify(rpc));
  const added = JSON.parse(rpc.result.content.find(c => c.type === "text").text);
  assert.equal(added.success, true, JSON.stringify(added));
  const stored = await fetch(config.mempalaceRemoteUrl + "/v1/drawers/" + added.drawer_id, {
    headers: { Authorization: "Bearer " + config.mempalaceRemoteToken }
  });
  assert.equal(stored.status, 200);
  assert.equal((await stored.json()).content, "Shared violet telescope calibration record.");
  await clients[0].diaryWrite("HTTP diary schema works", "smoke");
  await clients[1].search("violet telescope", { wing: "wing_smoke" });
  for (const path of [".claude.json", ".gemini/settings.json", ".config/opencode/opencode.json"]) {
    const data = JSON.parse(await readFile(join(home, path), "utf8"));
    const entry = (data.mcpServers ?? data.mcp).agentpalace;
    assert.equal(entry.url ?? entry.httpUrl, service.mcpUrl);
    assert.equal(entry.command, undefined);
  }
  assert.match(await readFile(join(home, ".codex/config.toml"), "utf8"), /\[mcp_servers.agentpalace\]/);
  await service.stop();
  await service.start();
  await Promise.all(clients.map(client => client.status()));
  assert.equal(await readFile(join(config.mempalacePalacePath, "archive-marker"), "utf8"), "preserved");
  await service.stop();
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(service.start([], cancelled.signal));
  console.log("PASS: four concurrent HTTP clients, renamed tools, diary schema, REST visibility, registrations, restart recovery, archive preservation");
} finally {
  await Promise.all(clients.map(client => client.stop()));
  await service.stop();
}
