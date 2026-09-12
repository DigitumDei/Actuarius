import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { MemPalaceClient } from "../src/services/memPalaceClient.js";

describe("AgentPalace HTTP client", () => {
  it("authenticates, initializes, uses renamed tools and diary schema, and surfaces tool errors", async () => {
    const requests: any[] = [];
    const server = createServer(async (req, res) => {
      if (req.headers.authorization !== "Bearer test") { res.writeHead(401).end(); return; }
      expect(req.url).toBe("/mcp");
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      requests.push(body);
      if (!body.id) { res.writeHead(202).end(); return; }
      const result = body.method === "initialize" ? { protocolVersion: "2025-03-26" }
        : { content: [{ type: "text", text: "tool result" }], isError: body.params.name === "agentpalace_search" };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const client = new MemPalaceClient(url, "test", pino({ level: "silent" }));
    try {
      await client.start();
      expect(client.isReady()).toBe(true);
      expect(await client.wakeUp("wing_test")).toBe("tool result");
      await client.diaryWrite("new entry", "test");
      expect(requests.find(r => r.params?.name === "agentpalace_diary_write").params.arguments).toMatchObject({ entry: "new entry", summary: "new entry", scope: "project" });
      await expect(client.search("bad")).rejects.toThrow("tool result");
      const wrong = new MemPalaceClient(url, "wrong", pino({ level: "silent" }));
      await expect(wrong.start()).rejects.toThrow("HTTP 401");
      await wrong.stop();
    } finally {
      await client.stop();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
