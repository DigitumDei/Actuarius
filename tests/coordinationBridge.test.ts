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
import { PermissionFlagsBits } from "discord.js";
import {readFile} from "node:fs/promises";
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
    it.each(["cancel","review","revise","pr"])("rejects another member's /%s mutation",async(commandName)=>{
        const {bridge}=fixture();
        bridge.store.add({id:"prior",source:"discord",description:"",sender:"discord:owner",wing:"wing_repo",work_id:"shared",phase:"running"});
        const cancel=vi.spyOn(bridge.supervisor,"cancel").mockResolvedValue();
        const reply=vi.fn();
        const interaction={id:"event",commandName,guildId:"guild",channelId:"thread",channel:{id:"thread",parentId:"channel",isThread:()=>true},user:{id:"other"},options:{getString:()=>commandName==="cancel"?"prior":null},reply} as unknown as ChatInputCommandInteraction;
        expect(await bridge.command(interaction)).toBe(true);
        expect(reply.mock.calls[0]?.[0].content).toContain("original requester");
        expect(cancel).not.toHaveBeenCalled();expect(bridge.store.list()).toHaveLength(1);
    });
    it.each(["owner","manager"])("allows %s cancellation",async(user)=>{
        const {bridge}=fixture();bridge.store.add({id:"prior",source:"discord",description:"",sender:"discord:owner",wing:"wing_repo"});
        const cancel=vi.spyOn(bridge.supervisor,"cancel").mockResolvedValue();
        await bridge.command({commandName:"cancel",guildId:"guild",user:{id:user},memberPermissions:{has:(bit:bigint)=>user==="manager"&&bit===PermissionFlagsBits.ManageGuild},options:{getString:()=>"prior"},deferReply:vi.fn(),editReply:vi.fn()} as unknown as ChatInputCommandInteraction);
        expect(cancel).toHaveBeenCalledWith("prior");
    });
    it("queues thread followups even when prior work is running, preserving workspace and dependency", async () => {
        const { bridge } = fixture();
        bridge.store.add({ id: "prior", source: "background", description: "prior", sender: "discord:user", wing: "wing_coordination", work_id: "shared", phase: "running" });
        const reply = vi.fn();
        const message = { id: "event", author: { bot: false, id: "user" }, guildId: "guild", channelId: "thread", channel: { isThread: () => true, parentId: "channel" }, content: "Add tests", attachments: new Map(), reply } as unknown as Message;
        expect(await bridge.message(message)).toBe(true);
        expect(bridge.store.event("event")).toMatchObject({ source: "discord", wing: "wing_coordination", work_id: "shared", dependencies: ["prior"] });
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
        expect(msg.reply).toHaveBeenLastCalledWith(expect.stringContaining("no longer open"));
    });
    it("/tasks uses saved state without an LLM or a coordination request", async () => {
        const { bridge } = fixture();
        const reply = vi.fn();
        await bridge.command({ id: "view", commandName: "tasks", guildId: "guild", options: { getString: () => null, getInteger: () => null }, reply } as unknown as ChatInputCommandInteraction);
        expect(reply.mock.calls[0]?.[0].content).toContain("No matching tasks");
    });
    it.each(["status","cancel"])("falls through for legacy /%s without adopting work",async(commandName)=>{
        const {bridge}=fixture();const before=bridge.store.works();
        const interaction={commandName,guildId:"guild",channelId:"legacy",channel:{id:"legacy",parentId:"channel",isThread:()=>true},options:{getString:()=>null}} as unknown as ChatInputCommandInteraction;
        expect(await bridge.command(interaction)).toBe(false);expect(bridge.store.works()).toEqual(before);
    });
    it("refuses unauthorized question replies without changing the task",async()=>{
        const {bridge}=fixture();bridge.store.add({id:"waiting",source:"discord",sender:"discord:owner",wing:"wing_repo",description:"",phase:"input_required",question_message:"question"});
        const reply=vi.fn();await bridge.message({id:"answer",author:{bot:false,id:"other"},guildId:"guild",reference:{messageId:"question"},reply} as unknown as Message);
        expect(reply).toHaveBeenCalledWith(expect.stringContaining("original requester"));expect(bridge.store.get("waiting")?.phase).toBe("input_required");
    });
    it("downloads attachments before acknowledging intake and reuses the durable cache",async()=>{
        const {bridge}=fixture();const fetch=vi.fn().mockResolvedValue({ok:true,arrayBuffer:async()=>new TextEncoder().encode("saved content").buffer});vi.stubGlobal("fetch",fetch);
        const message={id:"attachment-event",author:{bot:false,id:"user"},guildId:"guild",channelId:"thread",channel:{isThread:()=>true,parentId:"channel"},content:"Read this",attachments:new Map([["file",{id:"file",name:"notes.txt",url:"https://cdn.discord.test/expiring",size:13,contentType:"text/plain"}]]),reply:vi.fn()} as unknown as Message;
        bridge.store.add({id:"owner",source:"discord",sender:"discord:user",wing:"wing_repo",description:"",work_id:"shared",phase:"completed"});
        try {
            await bridge.message(message);
            const cached=JSON.parse(bridge.store.meta("attachments:discord-attachment-event")!) as {processed:Array<{savedPath:string}>};
            expect(await readFile(cached.processed[0]!.savedPath,"utf8")).toBe("saved content");
            fetch.mockRejectedValue(new Error("expired"));await bridge.message(message);expect(fetch).toHaveBeenCalledTimes(1);
        } finally {vi.unstubAllGlobals();}
    });
    it("uses creation order for follow-ups even after an older task is requeued",async()=>{
        const {bridge}=fixture();const older=bridge.store.add({id:"older",source:"discord",sender:"discord:user",wing:"wing_repo",description:"",work_id:"shared",phase:"completed",created_at:"2026-01-01T00:00:00Z"});
        bridge.store.add({id:"newer",source:"discord",sender:"discord:user",wing:"wing_repo",description:"",work_id:"shared",phase:"completed",created_at:"2026-01-02T00:00:00Z"});bridge.store.moveToTail(older);
        await bridge.command({id:"next",commandName:"plan",guildId:"guild",channelId:"thread",channel:{id:"thread",parentId:"channel",isThread:()=>true},user:{id:"user"},options:{getString:()=>"Next",getBoolean:()=>false},deferReply:vi.fn(),editReply:vi.fn()} as unknown as ChatInputCommandInteraction);
        expect(bridge.store.event("next")?.dependencies).toEqual(["newer"]);
    });
});
