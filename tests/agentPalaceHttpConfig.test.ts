import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { configureAgentPalaceHttp, configureOpencodeSnapshot } from "../src/services/agentPalaceHttpConfig.js";

describe("shared HTTP MCP registrations", () => {
  it("replaces old stdio entries for all providers, preserves unrelated settings, and converges token rotation", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentpalace-http-config-"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "keep"\n[mcp_servers.mempalace]\ncommand = "old"\nargs = ["with[bracket]"]\n[mcp_servers.mempalace.env]\nSECRET = "old"\n[mcp_servers.other]\ncommand = "keep"\n');
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ theme: "keep", mcpServers: { mempalace: { command: "old" }, other: { command: "keep" } } }));
    const url = "http://127.0.0.1:8765/mcp";
    await configureAgentPalaceHttp(home, url, "first");
    await configureAgentPalaceHttp(home, url, "rotated");
    const paths = [".claude.json", ".gemini/settings.json", ".config/opencode/config.json", ".config/opencode/opencode.json"];
    for (const path of paths) {
      const data = JSON.parse(readFileSync(join(home, path), "utf8"));
      const servers = data.mcpServers ?? data.mcp;
      expect(servers.mempalace).toBeUndefined();
      expect(servers.agentpalace.headers).toEqual({ Authorization: "Bearer rotated" });
      expect(servers.agentpalace.command).toBeUndefined();
      expect(servers.agentpalace.url ?? servers.agentpalace.httpUrl).toBe(url);
      if (process.platform !== "win32") expect(statSync(join(home, path)).mode & 0o777).toBe(0o600);
    }
    const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    expect(claude.theme).toBe("keep");
    expect(claude.mcpServers.other.command).toBe("keep");
    const codex = readFileSync(join(home, ".codex/config.toml"), "utf8");
    expect(codex).toContain('[mcp_servers.other]\ncommand = "keep"');
    expect(codex).toContain('model = "keep"');
    expect(codex).not.toContain("mempalace");
    expect(codex).not.toContain("SECRET");
    expect(codex.match(/\[mcp_servers.agentpalace\]/g)).toHaveLength(1);
    expect(codex).toContain('Authorization = "Bearer rotated"');
    const snapshot = join(home, "snapshot.json");
    writeFileSync(snapshot, JSON.stringify({ agent: { planner: {} }, mcp: { mempalace: { command: "old" } } }));
    await configureOpencodeSnapshot(snapshot, join(home, ".config/opencode/opencode.json"));
    const plan = JSON.parse(readFileSync(snapshot, "utf8"));
    expect(plan.agent).toEqual({ planner: {} });
    expect(plan.mcp.mempalace).toBeUndefined();
    expect(plan.mcp.agentpalace).toMatchObject({ type: "remote", url, oauth: false });
  });

  it("refuses to overwrite malformed operator configuration", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentpalace-http-invalid-"));
    writeFileSync(join(home, ".claude.json"), "invalid json");
    await expect(configureAgentPalaceHttp(home, "http://localhost/mcp", "secret")).rejects.toThrow();
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe("invalid json");
  });
});
