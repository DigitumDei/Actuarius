import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CoordinationClient } from "../src/services/coordination/client.js";
it.skipIf(!process.env.AGENTPALACE_TEST_BINARY)("uses native claim, input_required, corrected-message, pending, result and completion contracts", async () => {
    const root = mkdtempSync(join(tmpdir(), "actuarius-protocol-"));
    const config = join(root, "config");
    mkdirSync(config);
    const child = spawn(process.env.AGENTPALACE_TEST_BINARY!, ["--palace", join(root, "palace"), "serve", "--stdio"], { cwd: root, env: { ...process.env, AGENTPALACE_CONFIG_DIR: config, AGENTPALACE_STUB_EMBEDDINGS: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const pending = new Map<number, {
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
    }>();
    let next = 1;
    const reader = createInterface({ input: child.stdout });
    reader.on("line", line => { try {
        const msg = JSON.parse(line) as {
            id: number;
            result: unknown;
            error?: {
                message: string;
            };
        };
        const p = pending.get(msg.id);
        if (p) {
            pending.delete(msg.id);
            if (msg.error)
                p.reject(new Error(msg.error.message));
            else
                p.resolve(msg.result);
        }
    }
    catch { /* logs are not protocol messages */ } });
    child.stderr.resume();
    child.on("exit", () => { for (const p of pending.values())
        p.reject(new Error("AgentPalace exited")); });
    function call(method: string, params: unknown): Promise<unknown> { return new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }); }
    try {
        await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "integration-test", version: "1" } });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        const api = new CoordinationClient({ coordinationCall: async (name, args) => { const r = await call("tools/call", { name, arguments: args }) as {
                isError?: boolean;
                content: Array<{
                    text: string;
                }>;
            }; const text = r.content.map(c => c.text).join("\n"); if (r.isError)
                throw new Error(text); return JSON.parse(text) as unknown; } });
        const task = await api.create({ created_by: "sender", idempotency_key: "first", wing: "wing_test", title: "test", description: "test", dependencies: [] });
        expect((await api.page("wing_test")).ids).toContain(task.task_id);
        expect(await api.creationWing("wing_test", "local")).toBe("wing_test");
        expect((await api.get(task.task_id))?.state).toBe("pending");
        const claimed = await api.mutate("claim", { task_id: task.task_id, worker: "worker", expected_revision: task.revision, lease_seconds: 120 });
        const waiting = await api.mutate("transition", { task_id: task.task_id, actor: "worker", expected_revision: claimed.revision, state: "input_required" });
        await api.call("message_send", { task_id: task.task_id, sender: "sender", recipient: "worker", kind: "task_correction", payload: { version: 1 }, idempotency_key: "correction" });
        const messages = await api.inbox("worker");
        expect(messages).toHaveLength(1);
        await api.call("message_acknowledge", { message_id: messages[0]!.message_id, actor: "worker" });
        expect(await api.inbox("worker")).toHaveLength(0);
        const resumed = await api.mutate("transition", { task_id: task.task_id, actor: "worker", expected_revision: waiting.revision, state: "pending" });
        const run = await api.mutate("claim", { task_id: task.task_id, worker: "worker", expected_revision: resumed.revision, lease_seconds: 120 });
        await api.call("result_put", { task_id: task.task_id, created_by: "worker", payload: { summary: "done" }, idempotency_key: "result" });
        const completed = await api.mutate("transition", { task_id: task.task_id, actor: "worker", expected_revision: run.revision, state: "completed" });
        expect(completed.state).toBe("completed");
    }
    finally {
        child.stdin.end();
        child.kill();
        reader.close();
        await new Promise<void>(resolve => child.exitCode !== null ? resolve() : child.once("exit", () => resolve()));
        rmSync(root, { recursive: true, force: true });
    }
}, 30000);
