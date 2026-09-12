import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { encodeSpec, executionSchema, parseSpec, type PalaceTask } from "../src/services/coordination/contract.js";
import { CoordinationStore } from "../src/services/coordination/store.js";
import { CoordinationClient } from "../src/services/coordination/client.js";
import { CoordinationSupervisor, type CoordinationHooks } from "../src/services/coordination/supervisor.js";
const spec = executionSchema.parse({ version: 1, executor: "actuarius", action: "implement", workspace: { work_id: "shared", repository: "owner/repo", base_ref: "main", integration_target: "main" }, requirements: ["Implement queue"], acceptance_criteria: ["Only one LLM"], deliverable: "workspace_changes" });
const stores: CoordinationStore[] = [];
const dirs: string[] = [];
function store() { const dir = mkdtempSync(join(tmpdir(), "coordination-")); dirs.push(dir); const s = new CoordinationStore(join(dir, "db.sqlite")); stores.push(s); return s; }
afterEach(() => { for (const s of stores.splice(0))
    s.close(); for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true }); });
describe("execution contract and persistent work registration", () => {
    it("rejects typo fields and duplicate JSON blocks; ignores other executors", () => {
        expect(() => parseSpec(encodeSpec(spec) + "\n" + encodeSpec(spec))).toThrow();
        expect(() => parseSpec(encodeSpec({ ...spec, typo: true } as typeof spec))).toThrow();
        expect(parseSpec(encodeSpec(spec).replace('"actuarius"', '"another"'))).toBeNull();
    });
    it("requires setup once, reuses it, and never overwrites conflicting branch intent", () => {
        const s = store();
        expect(() => s.register({ work_id: "shared" })).toThrow(/requires/);
        const w = s.register(spec.workspace!);
        expect(s.register({ work_id: "shared" })).toEqual(w);
        expect(() => s.register({ ...spec.workspace!, base_ref: "release" })).toThrow(/conflicts/);
        expect(s.work("shared")?.base_ref).toBe("main");
        w.closed = true;
        s.saveWork(w);
        expect(() => s.register(spec.workspace!)).toThrow(/closed/);
    });
    it("deduplicates intake events and delivery across reopening", () => {
        const s = store();
        const first = s.add({ id: "one", event_id: "event", source: "discord", description: "x", sender: "user", wing: "wing_repo" });
        expect(s.add({ id: "two", event_id: "event", source: "discord", description: "y", sender: "user", wing: "wing_repo" }).id).toBe(first.id);
        s.enqueue({ key: "out", kind: "notice", entry: "one", payload: { content: "test" } });
        s.delivered("out");
        s.enqueue({ key: "out", kind: "notice", entry: "one", payload: { content: "test" } });
        expect(s.outbox()).toEqual([]);
    });
});
function harness() {
    const s = store();
    const tasks = new Map<string, PalaceTask>();
    const messages: unknown[] = [];
    const executed: string[] = [];
    let count = 0;
    const fault = vi.fn<(name: string, args: Record<string, unknown>) => void>();
    const inbox: unknown[] = [];
    const api = new CoordinationClient({ coordinationCall: async (name, args) => {
            fault(name, args);
            if (name.endsWith("task_create")) {
                const t: PalaceTask = { task_id: `t${++count}`, title: String(args.title), description: String(args.description), state: "pending", revision: 1, created_by: String(args.created_by), wing: String(args.wing), owner: null, lease_expires_at: null, dependencies: args.dependencies as string[], parent_id: null };
                tasks.set(t.task_id, t);
                return t;
            }
            if (name.endsWith("task_get"))
                return { found: tasks.has(String(args.task_id)), value: tasks.get(String(args.task_id)) };
            if (name.endsWith("inbox_read"))
                return { messages: inbox };
            if (name.endsWith("message_acknowledge"))
                return {};
            if (name.endsWith("message_send")) {
                messages.push(args);
                return {};
            }
            if (name.endsWith("result_put")) {
                expect((args.payload as {
                    summary: string;
                }).summary).toBeTruthy();
                return {};
            }
            if (/task_(claim|renew|transition)$/.test(name)) {
                const t = tasks.get(String(args.task_id))!;
                if (t.revision !== args.expected_revision)
                    return { success: false };
                if (name.endsWith("transition")) {
                    if (t.state === "pending" && args.state === "input_required")
                        throw new Error("invalid native transition");
                    t.state = args.state as PalaceTask["state"];
                }
                else {
                    t.state = "running";
                    t.owner = String(args.worker);
                    t.lease_expires_at = new Date(Date.now() + 120000).toISOString();
                }
                t.revision++;
                return { success: true, task: { ...t } };
            }
            throw new Error(name);
        } });
    const hooks: CoordinationHooks = { wings: () => [], check: async () => { }, validate: async () => ({ ready: true, questions: [] }), execute: async (e) => { executed.push(e.id); return { result: "done" }; }, notice: async () => "message", gate: async () => true };
    const sup = new CoordinationSupervisor(s, api, hooks, pino({ level: "silent" }));
    const tick = async () => { await sup.tick(); await new Promise(r => setTimeout(r, 10)); };
    return { s, tasks, messages, executed, hooks, sup, tick, fault, inbox };
}
describe("durable supervisor", () => {
    it("aborts an active invocation after lease loss and retains it for inspection", async () => {
        const h = harness();
        h.s.add({ id: "one", source: "discord", description: encodeSpec(spec), sender: "sender", wing: "wing_repo", spec });
        await h.tick();
        await h.tick();
        let aborted = false;
        h.hooks.execute = async (_e, _w, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true }));
        h.fault.mockImplementation(name => { if (name.endsWith("task_renew"))
            throw new Error("lease lost"); });
        vi.useFakeTimers();
        try {
            await h.sup.tick();
            await vi.advanceTimersByTimeAsync(30001);
            expect(aborted).toBe(true);
            expect(h.s.get("one")?.phase).toBe("interrupted");
            expect(h.s.get("one")?.result).toBeNull();
        }
        finally {
            vi.useRealTimers();
            await h.sup.stop();
        }
    });
    it("operator repair resumes the existing task and preserves its workspace ownership", async () => {
        const h = harness();
        const e = h.s.add({ id: "one", source: "background", description: encodeSpec(spec), sender: "sender", wing: "wing_repo", spec, phase: "input_required", work_id: "shared", checkpoint: "old verification", validation_id: "old" });
        h.s.setMeta("workspace-owner:shared", e.id);
        const repaired = h.sup.repair(e.id, "Fix the failed test");
        expect(repaired).toMatchObject({ id: "one", source: "discord", phase: "validate", checkpoint: null, validation_id: null });
        expect(repaired.spec?.requirements).toContain("Fix the failed test");
        expect(h.s.meta("workspace-owner:shared")).toBe("one");
    });
    it("retries publication and Discord delivery without rerunning implementation", async () => {
        const h = harness();
        let fail = true;
        h.fault.mockImplementation(name => { if (fail && name.endsWith("result_put"))
            throw new Error("offline"); });
        h.hooks.notice = async () => { if (fail)
            throw new Error("Discord offline"); return "delivered"; };
        h.s.add({ id: "one", source: "discord", description: encodeSpec(spec), sender: "sender", wing: "wing_repo", spec });
        for (let i = 0; i < 4; i++)
            await h.tick();
        expect(h.s.get("one")?.phase).toBe("publishing");
        expect(h.executed).toEqual(["one"]);
        fail = false;
        const e = h.s.get("one")!;
        e.next_at = 0;
        h.s.save(e);
        for (let i = 0; i < 3; i++)
            await h.tick();
        expect(h.s.get("one")?.phase).toBe("completed");
        expect(h.executed).toEqual(["one"]);
        expect(h.s.outbox()).toEqual([]);
    });
    it("retains a workspace between continuation steps while other repos can run", async () => {
        const h = harness();
        const calls: string[] = [];
        h.hooks.execute = async (e) => { calls.push(e.id); return e.id === "first" && e.step === 0 ? { result: "checkpoint", next: "verify", checkpoint: "saved" } : { result: "done" }; };
        for (const id of ["first", "same", "other"]) {
            const own = { ...spec, workspace: { ...spec.workspace!, work_id: id === "other" ? "other" : "shared" } };
            h.s.add({ id, source: "discord", description: encodeSpec(own), sender: "sender", wing: "wing_repo", spec: own });
        }
        for (let i = 0; i < 14; i++)
            await h.tick();
        expect(calls).toEqual(["first", "other", "first", "same"]);
    });
    it("does not let an unavailable dependency authority stall unrelated tasks", async () => {
        const h = harness();
        h.fault.mockImplementation((name, args) => { if (name.endsWith("task_get") && args.task_id === "unavailable")
            throw new Error("offline"); });
        h.s.add({ id: "blocked", source: "discord", description: encodeSpec(spec), sender: "sender", wing: "wing_repo", spec, dependencies: ["unavailable"] });
        h.s.add({ id: "other", source: "background", description: encodeSpec(spec), sender: "sender", wing: "wing_repo", spec });
        for (let i = 0; i < 9; i++)
            await h.tick();
        expect(h.executed).toEqual(["other"]);
        expect(h.s.get("blocked")?.reason).toContain("unavailable");
    });
    it("revalidates a human clarification and creates a fresh answerable question", async () => {
        const h = harness();
        h.hooks.validate = async () => ({ ready: false, questions: ["Which behavior?"] });
        h.s.add({ id: "one", source: "discord", description: encodeSpec(spec), sender: "sender", wing: "wing_repo", spec });
        for (let i = 0; i < 3; i++)
            await h.tick();
        const first = h.s.get("one")!;
        await h.sup.answer(first.question_message!, "Use FIFO", "answer");
        for (let i = 0; i < 3; i++)
            await h.tick();
        const second = h.s.get("one")!;
        expect(second.phase).toBe("input_required");
        expect(second.human_answered).toBe(false);
        expect(second.validation_id).not.toBe(first.validation_id);
    });
    it("runs Discord ahead of older background, then FIFO, without bypassing dependencies", async () => {
        const h = harness();
        for (const [id, source] of [["background", "background"], ["discord", "discord"]] as const)
            h.s.add({ id, source, description: encodeSpec(spec), sender: "sender", wing: "wing_repo", spec });
        for (let i = 0; i < 8; i++)
            await h.tick();
        expect(h.executed).toEqual(["discord", "background"]);
        expect(h.s.list().every(e => e.phase === "completed")).toBe(true);
    });
    it("claims before returning malformed submissions through standard coordination", async () => {
        const h = harness();
        h.s.add({ id: "bad", source: "background", description: "```actuarius-task\n{\n```", sender: "sender", wing: "wing_repo" });
        for (let i = 0; i < 4; i++)
            await h.tick();
        expect(h.s.get("bad")?.phase).toBe("input_required");
        expect(h.executed).toEqual([]);
        expect(h.messages).toHaveLength(1);
        expect(h.messages[0]).toMatchObject({ recipient: "sender", kind: "validation_required" });
    });
    it("skips blocked Discord tasks and retains their queue order", async () => {
        const h = harness();
        h.s.add({ id: "blocked", source: "discord", description: encodeSpec(spec), sender: "sender", wing: "wing_repo", spec, dependencies: ["missing"] });
        h.s.add({ id: "ready", source: "background", description: encodeSpec(spec), sender: "sender", wing: "wing_repo", spec });
        for (let i = 0; i < 8; i++)
            await h.tick();
        expect(h.executed).toEqual(["ready"]);
        expect(h.s.get("blocked")?.reason).toContain("missing");
    });
});
