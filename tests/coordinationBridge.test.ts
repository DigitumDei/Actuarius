import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import type { AppConfig } from "../src/config.js";
import type { AppDatabase } from "../src/db/database.js";
import type { MemPalaceClient } from "../src/services/memPalaceClient.js";
import type { Client, Message, ChatInputCommandInteraction } from "discord.js";
import { CoordinationBridge } from "../src/discord/coordinationBridge.js";
import { executionSchema } from "../src/services/coordination/contract.js";
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "coordbridge-"));
    const repo = { id: 1, guild_id: "guild", owner: "owner", repo: "repo", full_name: "owner/repo", channel_id: "channel" };
    const db = { listAllRepos: () => [repo], getRepoByChannelId: () => repo } as unknown as AppDatabase;
    const config = { databasePath: join(dir, "db"), reposRootPath: dir, attachmentMaxCount: 5, attachmentMaxFileSize: 10000, attachmentMaxTotalSize: 50000, attachmentMaxInlineText: 1000 } as AppConfig;
    const bridge = new CoordinationBridge({} as Client, config, db, {} as MemPalaceClient, pino({ level: "silent" }), { parsePlan: () => null, text: async () => "", review: async () => ({ ready: true, text: "ok", sha: "sha" }), prepare: async () => { } });
    const w = bridge.store.register({ work_id: "shared", repository: "owner/repo", base_ref: "main", integration_target: "main" });
    w.thread_id = "thread";
    bridge.store.saveWork(w);
    cleanup.push(() => { bridge.store.close(); rmSync(dir, { recursive: true, force: true }); });
    return { bridge };
}
describe("Discord coordination intake", () => {
    it("queues thread followups even when prior work is running, preserving workspace and dependency", async () => {
        const { bridge } = fixture();
        bridge.store.add({ id: "prior", source: "background", description: "prior", sender: "agent", wing: "wing_repo", work_id: "shared", phase: "running" });
        const reply = vi.fn();
        const message = { id: "event", author: { bot: false, id: "user" }, guildId: "guild", channelId: "thread", channel: { isThread: () => true, parentId: "channel" }, content: "Add tests", attachments: new Map(), reply } as unknown as Message;
        expect(await bridge.message(message)).toBe(true);
        expect(bridge.store.event("event")).toMatchObject({ source: "discord", work_id: "shared", dependencies: ["prior"] });
        await bridge.message(message);
        expect(bridge.store.list()).toHaveLength(2);
        expect(reply).toHaveBeenCalled();
    });
    it("routes /plan in a work thread into the same workspace with its iterative option", async () => {
        const { bridge } = fixture();
        const interaction = { id: "event", commandName: "plan", guildId: "guild", channelId: "thread", channel: { id: "thread", parentId: "channel", isThread: () => true }, user: { id: "user" }, options: { getString: (name: string) => name === "prompt" ? "Add queue" : null, getBoolean: () => false }, deferReply: vi.fn(), editReply: vi.fn() } as unknown as ChatInputCommandInteraction;
        await bridge.command(interaction);
        expect(bridge.store.event("event")?.spec).toMatchObject({ action: "plan", iterative: false, workspace: { work_id: "shared" } });
    });
    it("answers a correlated question without creating another task; stale replies remain answers", async () => {
        const { bridge } = fixture();
        const spec = executionSchema.parse({ version: 1, executor: "actuarius", action: "ask", workspace: { work_id: "shared" }, requirements: ["Add tests"], acceptance_criteria: ["Pass"], deliverable: "workspace_changes" });
        bridge.store.add({ id: "waiting", source: "discord", description: "", sender: "discord:user", wing: "wing_repo", work_id: "shared", phase: "input_required", question_message: "question", spec });
        bridge.store.setMeta("question:question", "waiting");
        const msg = { id: "answer", author: { bot: false, id: "user" }, guildId: "guild", channelId: "thread", channel: { isThread: () => true, parentId: "channel" }, reference: { messageId: "question" }, content: "Use Vitest", attachments: new Map(), reply: vi.fn() } as unknown as Message;
        await bridge.message(msg);
        expect(bridge.store.list()).toHaveLength(1);
        expect(bridge.store.get("waiting")?.phase).toBe("validate");
        await bridge.message(msg);
        expect(bridge.store.list()).toHaveLength(1);
    });
    it("/tasks uses saved state without an LLM or a coordination request", async () => {
        const { bridge } = fixture();
        const reply = vi.fn();
        await bridge.command({ id: "view", commandName: "tasks", guildId: "guild", options: { getString: () => null, getInteger: () => null }, reply } as unknown as ChatInputCommandInteraction);
        expect(reply.mock.calls[0]?.[0].content).toContain("No matching tasks");
    });
});
