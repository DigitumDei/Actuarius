import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { CoordinationClient } from "./client.js";
import { CoordinationStore, type Entry, type Work } from "./store.js";
import { correctionSchema, encodeSpec, executionSchema, humanQuestionSchema, parseSpec, type ExecutionSpec, type PalaceTask, type Verdict } from "./contract.js";
export interface CoordinationHooks {
    wings(): string[];
    check(spec: ExecutionSpec): Promise<void>;
    validate(entry: Entry, signal: AbortSignal): Promise<Verdict>;
    execute(entry: Entry, work: Work | null, signal: AbortSignal): Promise<{
        result: string;
        next?: string;
        checkpoint?: string;
    }>;
    notice(entry: Entry, content: string, key: string): Promise<string | null>;
    gate(entry: Entry, dependency: Entry, kind: "merged" | "release" | "stacked"): Promise<boolean>;
}
const terminal = new Set(["completed", "cancelled", "failed", "expired"]);
export class CoordinationSupervisor {
    public readonly worker: string;
    private timer: NodeJS.Timeout | null = null;
    private syncing = false;
    private active: Promise<void> | null = null;
    private controller: AbortController | null = null;
    private stopping = false;
    public activeEntryId: string | null = null;
    public constructor(public readonly store: CoordinationStore, private readonly api: CoordinationClient, private readonly hooks: CoordinationHooks, private readonly logger: Logger) { this.worker = store.worker(); }
    public start(): void {
        // Interrupted invocations are never blindly replayed against possibly dirty work.
        for (const e of this.store.list())
            if (e.phase === "running") {
                e.phase = "interrupted";
                e.reason = "Server restarted during execution; inspect retained workspace and explicitly retry";
                this.store.save(e);
            }
        this.timer = setInterval(() => { void this.tick(); }, 5000);
        this.timer.unref();
        void this.tick();
    }
    public async stop(): Promise<void> {
        this.stopping = true;
        if (this.timer)
            clearInterval(this.timer);
        this.controller?.abort();
        while (this.syncing)
            await new Promise(resolve => setTimeout(resolve, 10));
        await this.active;
    }
    public async tick(): Promise<void> {
        if (this.syncing || this.stopping)
            return;
        this.syncing = true;
        try {
            this.store.setMeta("source_error", "");
            for (const operation of [() => this.discover(), () => this.reconcile(), () => this.messages()]) {
                try {
                    await operation();
                }
                catch (error) {
                    this.store.setMeta("source_error", String(error));
                    this.logger.warn({ error }, "Coordination source temporarily unavailable");
                }
            }
            for (const e of this.store.list()) {
                if (e.phase === "input_required" && e.validation_id && e.reason && !e.human_answered)
                    this.feedback(e, [e.reason]);
                if (e.phase === "completed" && e.result !== null)
                    this.notice(e, `Task ${e.task!.task_id} completed.\n${e.result}`, "result");
            }
            await this.flush();
            this.store.setMeta("last_refresh", new Date().toISOString());
            if (!this.active && !this.stopping) {
                const entries = this.store.list().filter(e => ["registering", "validate", "execute", "publishing", "interrupted", "input_transition"].includes(e.phase) && e.next_at <= Date.now());
                entries.sort((a, b) => (a.source === "discord" ? 0 : 1) - (b.source === "discord" ? 0 : 1) || a.sequence - b.sequence);
                for (const e of entries) {
                    try {
                        if (e.phase === "execute" && !await this.ready(e))
                            continue;
                    }
                    catch (error) {
                        e.reason = `Dependency check unavailable: ${String(error)}`;
                        e.next_at = Date.now() + 15000;
                        this.store.save(e);
                        continue;
                    }
                    this.activeEntryId = e.id;
                    this.active = this.run(e).catch(error => this.logger.error({ error, task: e.id }, "Coordination step failed")).finally(() => { this.active = null; this.activeEntryId = null; });
                    break;
                }
            }
        }
        catch (error) {
            this.store.setMeta("source_error", error instanceof Error ? error.message : String(error));
            this.logger.warn({ error }, "Coordination reconciliation delayed");
        }
        finally {
            this.syncing = false;
        }
    }
    private async discover(): Promise<void> {
        for (const wing of this.hooks.wings()) {
            const key = `cursor:${wing}`;
            const page = await this.api.page(wing, this.store.meta(key) ?? undefined, JSON.parse(this.store.meta(`remote:${wing}`) ?? "{}") as Record<string, string>);
            if (page.errors.length)
                this.store.setMeta("source_error", page.errors.join("; "));
            for (const [id, authority] of Object.entries(page.authorities)) this.store.setMeta(`authority:${id}`, authority);
            const retryKey = `discovery-retries:${wing}`;
            const retries = new Set<string>(JSON.parse(this.store.meta(retryKey) ?? "[]"));
            for (const id of new Set([...page.ids, ...[...retries].slice(0, 100)])) {
                if (this.store.get(id))
                    { retries.delete(id); continue; }
                let task: PalaceTask | null;
                try { task = await this.api.get(id); retries.delete(id); }
                catch (error) {
                    retries.add(id);
                    this.store.setMeta("source_error", `Task ${id}: ${String(error)}`);
                    continue;
                }
                if (!task || terminal.has(task.state) || (task.state !== "pending" && task.owner !== this.worker) || !task.description.includes("```actuarius-task"))
                    continue;
                let spec: ExecutionSpec | null = null;
                try {
                    spec = parseSpec(task.description);
                    if (!spec)
                        continue;
                }
                catch { /* malformed intended submissions receive feedback */ }
                this.store.add({ id, source: "background", description: task.description, sender: task.created_by, wing: task.wing, task, phase: task.state === "pending" ? "validate" : "interrupted", reason: task.state === "pending" ? "" : "Recovered an owned task without local execution state; inspect before continuing", spec, work_id: spec?.workspace?.work_id ?? null });
            }
            // A completed sweep restarts at creation-order beginning: old state changes cannot be missed.
            this.store.setMeta(key, page.next ?? "");
            this.store.setMeta(`remote:${wing}`, JSON.stringify(page.remoteCursors));
            this.store.setMeta(retryKey, JSON.stringify([...retries]));
        }
    }
    private async reconcile(): Promise<void> {
        const entries = this.store.list().filter(e => e.task && !terminal.has(e.phase) && e.id !== this.activeEntryId);
        const offset = Number(this.store.meta("reconcile-offset") ?? "0");
        for (const e of entries.slice(offset, offset + 20)) {
            let task: PalaceTask | null;
            try { task = await this.api.get(e.task!.task_id); }
            catch (error) { this.store.setMeta("source_error", `Task ${e.id}: ${String(error)}`); continue; }
            if (!task)
                continue;
            // Discord callbacks can update this entry while the request is in flight.
            const latest = this.store.get(e.id);
            if (!latest || (latest.task && latest.task.revision > task.revision)) continue;
            latest.task = task;
            if (terminal.has(task.state))
                latest.phase = task.state;
            this.store.save(latest);
        }
        this.store.setMeta("reconcile-offset", String(offset + 20 >= entries.length ? 0 : offset + 20));
    }
    public submit(input: {
        eventId: string;
        sender: string;
        wing: string;
        spec: ExecutionSpec;
        dependencies?: string[];
        threadId?: string;
        attachments?: unknown[];
    }): Entry {
        return this.store.add({ id: `discord-${input.eventId}`, source: "discord", event_id: input.eventId, sender: input.sender, wing: input.wing,
            description: encodeSpec(input.spec), spec: input.spec, work_id: input.spec.workspace?.work_id ?? null, action: input.spec.action,
            dependencies: input.dependencies ?? [], thread_id: input.threadId ?? null, attachments: input.attachments ?? [] });
    }
    private async ready(e: Entry): Promise<boolean> {
        if (!e.task)
            return false;
        const owner = e.work_id ? this.store.meta(`workspace-owner:${e.work_id}`) : null;
        const owningTask = owner ? this.store.get(owner) : null;
        if (owningTask && owningTask.id !== e.id && !terminal.has(owningTask.phase)) {
            e.reason = `Workspace retained by ${owningTask.task?.task_id ?? owner}; complete or cancel it first`;
            this.store.save(e);
            return false;
        }
        for (const id of e.task.dependencies) {
            const dep = await this.api.get(id);
            if (!dep || dep.state !== "completed") {
                e.reason = `Waiting for dependency ${id} (${dep?.state ?? "missing"})`;
                this.store.save(e);
                return false;
            }
            const local = this.store.get(id);
            const explicit = e.spec?.gates?.find(g => g.task_id === id);
            const ownWork = e.work_id ? this.store.work(e.work_id) : null;
            const depWork = local?.work_id ? this.store.work(local.work_id) : null;
            const kind = explicit?.kind ?? (ownWork && depWork && ownWork.repository === depWork.repository && ownWork.work_id !== depWork.work_id ? "merged" : null);
            if (kind && (!local || !await this.hooks.gate(e, local, kind))) {
                e.reason = `Waiting for ${kind} artifact from ${id}${kind === "merged" && ownWork?.path ? "; integrate the dependency into this retained branch before resuming" : ""}`;
                this.store.save(e);
                return false;
            }
        }
        e.reason = "";
        this.store.save(e);
        return true;
    }
    private notice(e: Entry, content: string, suffix: string): void {
        this.store.enqueue({ key: `${e.id}:${suffix}`, kind: "notice", entry: e.id, payload: { content } });
    }
    private feedback(e: Entry, questions: string[]): void {
        const validation = e.validation_id!;
        this.store.enqueue({ key: `${validation}:feedback`, kind: "message", entry: e.id, payload: {
                task_id: e.task!.task_id, sender: this.worker, recipient: e.sender, kind: "validation_required",
                payload: { version: 1, validation_id: validation, questions, instructions: "Reply with task_correction {version:1,validation_id,spec:<complete JSON>} or human_input_required {version:1,validation_id,question,reason}." }
            } });
        this.notice(e, `Task ${e.task!.task_id} needs correction:\n${questions.join("\n")}\nReply to this message to provide input.`, `question:${validation}`);
    }
    private async run(e: Entry): Promise<void> {
        let lease: PalaceTask | null = null;
        let renewTimer: NodeJS.Timeout | null = null;
        let renewing: Promise<void> = Promise.resolve();
        const abort = new AbortController();
        this.controller = abort;
        const transition = async (state: string, details: unknown): Promise<void> => {
            if (renewTimer) {
                clearInterval(renewTimer);
                renewTimer = null;
            }
            await renewing;
            abort.signal.throwIfAborted();
            lease = await this.api.mutate("transition", { task_id: lease!.task_id, actor: this.worker, expected_revision: lease!.revision, state, details });
            e.task = lease;
            this.store.save(e);
        };
        try {
            if (e.phase === "registering") {
                const deps: string[] = [];
                for (const id of this.store.meta(`cancel:${e.id}`) ? [] : e.dependencies) {
                    const local = this.store.get(id);
                    if (local && !local.task) {
                        e.next_at = Date.now() + 5000;
                        this.store.save(e);
                        return;
                    }
                    deps.push(local?.task?.task_id ?? id);
                }
                const authorities = new Set(deps.map(id => this.store.meta(`authority:${id}`)).filter((v): v is string => !!v));
                if (authorities.size > 1) throw new Error("Dependencies span coordination authorities; keep the workflow at one authority");
                const authority = [...authorities][0];
                if (authority) {
                    e.wing = await this.api.creationWing(e.wing, authority);
                    this.store.save(e);
                }
                e.task = await this.api.create({ created_by: e.sender, idempotency_key: e.id, wing: e.wing, title: e.spec?.requirements[0]?.slice(0, 200) ?? "Discord task", description: e.description, dependencies: deps });
                if (authority) this.store.setMeta(`authority:${e.task.task_id}`, authority);
                if (this.store.meta(`cancel:${e.id}`)) {
                    e.task = await this.api.mutate("transition", { task_id: e.task.task_id, actor: this.worker, expected_revision: e.task.revision, state: "cancelled" });
                    e.phase = "cancelled";
                    this.store.save(e);
                    return;
                }
                e.phase = "validate";
                this.store.save(e);
                return;
            }
            const current = await this.api.get(e.task!.task_id);
            if (!current)
                throw new Error("Authoritative task is missing");
            if (terminal.has(current.state)) {
                e.task = current;
                e.phase = current.state;
                this.store.save(e);
                return;
            }
            if (e.phase === "input_transition" && current.state === "input_required") {
                e.task = current; e.phase = "input_required"; e.attempts = 0;
                this.store.save(e); this.feedback(e, [e.reason]); return;
            }
            if (current.owner && current.owner !== this.worker && current.lease_expires_at && Date.parse(current.lease_expires_at) > Date.now()) {
                e.reason = "Claimed by another worker";
                e.next_at = Date.now() + 15000;
                this.store.save(e);
                return;
            }
            lease = await this.api.mutate("claim", { task_id: current.task_id, worker: this.worker, expected_revision: current.revision, lease_seconds: 120 });
            e.task = lease;
            this.store.save(e);
            renewTimer = setInterval(() => {
                renewing = renewing.then(async () => { lease = await this.api.mutate("renew", { task_id: lease!.task_id, worker: this.worker, expected_revision: lease!.revision, lease_seconds: 120 }); })
                    .catch(error => { abort.abort(error); });
            }, 30000);
            renewTimer.unref();
            if (e.phase === "interrupted") {
                e.validation_id = randomUUID();
                e.human_answered = false; e.question_message = null;
                e.phase = "input_transition";
                this.store.save(e);
            }
            if (e.phase === "input_transition") {
                await transition("input_required", { reason: e.reason });
                e.phase = "input_required"; e.attempts = 0; this.store.save(e);
                this.feedback(e, [e.reason]);
                return;
            }
            if (e.phase === "validate") {
                if (!e.validation_id) {
                    e.validation_id = randomUUID();
                    e.human_answered = false;
                    e.question_message = null;
                }
                this.store.save(e);
                let questions: string[] = [];
                try {
                    e.spec = parseSpec(e.description);
                    if (!e.spec)
                        throw new Error("Supply a version 1 actuarius-task block");
                    e.work_id = e.spec.workspace?.work_id ?? null;
                    await this.hooks.check(e.spec);
                    if (e.spec.gates?.some(g => !e.task!.dependencies.includes(g.task_id)))
                        throw new Error("Every gate must reference a native dependency");
                }
                catch (error) {
                    questions = [error instanceof Error ? error.message : String(error)];
                }
                if (questions.length === 0) {
                    const verdict = await this.hooks.validate(e, abort.signal);
                    if (!verdict.ready)
                        questions = verdict.questions;
                }
                abort.signal.throwIfAborted();
                if (questions.length) {
                    e.phase = "input_transition";
                    e.reason = questions.join("\n");
                    this.store.save(e);
                    await transition("input_required", { validation_id: e.validation_id, questions });
                    e.phase = "input_required"; e.attempts = 0; this.store.save(e);
                    this.feedback(e, questions);
                    return;
                }
                if (e.spec!.workspace) {
                    const work = this.store.register(e.spec!.workspace);
                    if (!work.thread_id && e.thread_id) {
                        work.thread_id = e.thread_id;
                        this.store.saveWork(work);
                    }
                }
                e.phase = "execute";
                e.attempts = 0;
                e.reason = "";
                this.store.save(e);
                this.notice(e, `Task ${e.task!.task_id} validated and queued (${e.source} priority).`, `validated:${e.validation_id}`);
                // The native lifecycle has no running -> pending edge. Yield through input_required.
                await transition("input_required", { scheduling: "validated; awaiting execution slot" });
                await transition("pending", { scheduling: "ready" });
                return;
            }
            if (e.phase === "execute") {
                await this.hooks.check(e.spec!);
                abort.signal.throwIfAborted();
                if (e.work_id)
                    this.store.setMeta(`workspace-owner:${e.work_id}`, e.id);
                e.phase = "running";
                this.store.save(e);
                this.notice(e, `Task ${e.task!.task_id}: ${e.checkpoint ? "continuing" : e.spec!.action} started.`, `start:${e.step}`);
                const output = await this.hooks.execute(e, e.work_id ? this.store.work(e.work_id) : null, abort.signal);
                abort.signal.throwIfAborted();
                if (output.next) {
                    e.checkpoint = output.checkpoint ?? output.result;
                    e.action = output.next;
                    e.phase = "execute";
                    e.step++;
                    this.store.save(e);
                    this.store.moveToTail(e);
                    await transition("input_required", { scheduling: "step complete" });
                    await transition("pending", { scheduling: "continuation" });
                    return;
                }
                e.result = output.result;
                e.phase = "publishing";
                this.store.save(e);
            }
            if (e.phase === "publishing") {
                await this.api.call("result_put", { task_id: e.task!.task_id, created_by: this.worker, payload: { status: "completed", summary: (e.result ?? "Completed").slice(0, 60000), summary_truncated: (e.result?.length ?? 0) > 60000, work_id: e.work_id }, idempotency_key: `${e.id}:result` });
                await transition("completed", { result_key: `${e.id}:result` });
                e.phase = "completed";
                this.store.save(e);
                this.notice(e, `Task ${e.task!.task_id} completed.\n${e.result}`, "result");
            }
        }
        catch (error) {
            if (e.phase !== "input_transition") e.reason = error instanceof Error ? error.message : String(error);
            if (e.phase === "running") {
                e.phase = "interrupted";
                e.reason = `Execution stopped; retained workspace needs inspection: ${e.reason}`;
            }
            e.attempts++;
            e.next_at = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(6, e.attempts));
            this.store.moveToTail(e);
            if (e.attempts >= 3 && e.phase === "validate") {
                e.phase = "interrupted";
            }
            const latest = this.store.get(e.id);
            if (latest?.phase === "cancelled") {
                e.phase = "cancelled";
            }
            this.store.save(e);
            this.logger.warn({ error, task: e.id }, "Coordination step will reconcile");
        }
        finally {
            if (renewTimer)
                clearInterval(renewTimer);
            await renewing;
            this.controller = null;
        }
    }
    private async messages(): Promise<void> {
        for (const msg of await this.api.inbox(this.worker)) {
            if (!this.store.seen(msg.message_id)) {
                const e = this.store.get(msg.task_id);
                if (e && e.phase === "input_required" && msg.sender === e.sender) {
                    if (msg.kind === "task_correction") {
                        const correction = correctionSchema.safeParse(msg.payload);
                        if (correction.success && correction.data.validation_id === e.validation_id) {
                            if (e.work_id && correction.data.spec.workspace?.work_id !== e.work_id && this.store.work(e.work_id)) {
                                this.store.enqueue({ key: `reject:${msg.message_id}`, kind: "message", entry: e.id, payload: { task_id: e.task!.task_id, sender: this.worker, recipient: e.sender, kind: "correction_rejected", payload: { version: 1, validation_id: e.validation_id, reason: "Correction cannot change registered work_id" } } });
                                this.store.acknowledge(msg.message_id);
                                await this.api.call("message_acknowledge", { message_id: msg.message_id, actor: this.worker });
                                continue;
                            }
                            e.spec = correction.data.spec;
                            e.description = encodeSpec(e.spec);
                            e.checkpoint = null;
                            e.action = e.spec.action;
                            e.phase = "validate";
                            e.validation_id = null;
                            e.question_message = null;
                            e.human_answered = false;
                            e.next_at = 0;
                            e.attempts = 0;
                            this.store.save(e);
                            this.notice(e, `Correction received for ${e.task!.task_id}; revalidation queued.`, `correction:${msg.message_id}`);
                        }
                        else {
                            this.store.enqueue({ key: `reject:${msg.message_id}`, kind: "message", entry: e.id, payload: { task_id: e.task!.task_id, sender: this.worker, recipient: e.sender, kind: "correction_rejected", payload: { version: 1, validation_id: e.validation_id, reason: correction.success ? "Stale validation attempt" : correction.error.message } } });
                        }
                    }
                    else if (msg.kind === "human_input_required") {
                        const human = humanQuestionSchema.safeParse(msg.payload);
                        if (human.success && human.data.validation_id === e.validation_id && !e.human_answered) {
                            e.reason = `Human input required: ${human.data.question}`;
                            this.store.save(e);
                            this.notice(e, `${e.reason}\n${human.data.reason}\n${human.data.choices?.join("\n") ?? ""}\nReply to this message to answer.`, `question:${e.validation_id}:human`);
                        }
                    }
                }
                this.store.acknowledge(msg.message_id);
            }
            await this.api.call("message_acknowledge", { message_id: msg.message_id, actor: this.worker });
        }
    }
    public async answer(messageId: string, answer: string, eventId: string): Promise<boolean> {
        const e = this.store.list().find(v => v.question_message === messageId && v.phase === "input_required");
        if (!e)
            return !!this.store.meta(`question:${messageId}`);
        if (e.human_answered)
            return true;
        e.checkpoint = null;
        e.action = e.spec?.action ?? "ask";
        e.human_answered = true;
        let replacement: ExecutionSpec | null = null;
        try {
            replacement = parseSpec(answer);
        }
        catch { /* ordinary human answer is sent to the submitting agent */ }
        if (replacement) {
            if (e.work_id && this.store.work(e.work_id) && replacement.workspace?.work_id !== e.work_id)
                throw new Error("A correction cannot change the registered work_id");
            e.spec = replacement;
            e.description = encodeSpec(replacement);
            e.phase = "validate";
            e.validation_id = null;
            e.next_at = 0;
            e.attempts = 0;
            this.store.save(e);
        }
        else if (e.source === "discord") {
            // The next validation receives the human clarification as context; structured setup remains fixed.
            e.spec = executionSchema.parse({ ...e.spec, requirements: [...(e.spec?.requirements ?? []), `Human clarification: ${answer}`] });
            e.description = encodeSpec(e.spec);
            e.phase = "validate";
            e.validation_id = null;
            e.next_at = 0;
            this.store.save(e);
        }
        else {
            this.store.enqueue({ key: `answer:${eventId}`, kind: "message", entry: e.id, payload: { task_id: e.task!.task_id, sender: this.worker, recipient: e.sender, kind: "human_input_answer", payload: { version: 1, validation_id: e.validation_id, answer } } });
            e.reason = "Human answered; awaiting submitting agent's corrected JSON";
            this.store.save(e);
        }
        return true;
    }
    public repair(id: string, clarification: string): Entry {
        const e = this.store.get(id);
        if (!e?.spec || !["input_required", "interrupted"].includes(e.phase) || this.activeEntryId === e.id)
            throw new Error("Task is not awaiting recovery");
        e.spec = executionSchema.parse({ ...e.spec, action: "revise", requirements: [...e.spec.requirements, ...(e.reason ? [`Recovery context: ${e.reason.slice(0, 15000)}`] : []), clarification] });
        e.description = encodeSpec(e.spec);
        e.checkpoint = null;
        e.action = "revise";
        e.source = "discord";
        e.phase = "validate";
        e.validation_id = null;
        e.question_message = null;
        e.human_answered = false;
        e.next_at = 0;
        e.attempts = 0;
        e.reason = "Operator revision queued";
        this.store.save(e);
        this.store.moveToTail(e);
        return e;
    }
    public async cancel(id: string): Promise<void> {
        const e = this.store.get(id);
        if (!e)
            throw new Error("Unknown task");
        if (!e.task) {
            this.store.setMeta(`cancel:${e.id}`, "1");
            e.reason = "Cancellation requested; confirming registration outcome";
            this.store.save(e);
            return;
        }
        const task = await this.api.get(e.task.task_id);
        if (!task || terminal.has(task.state))
            return;
        await this.api.mutate("transition", { task_id: task.task_id, actor: this.worker, expected_revision: task.revision, state: "cancelled" });
        if (e.id === this.activeEntryId)
            this.controller?.abort();
        e.phase = "cancelled";
        this.store.save(e);
    }
    private async flush(): Promise<void> {
        for (const out of this.store.outbox()) {
            const e = this.store.get(out.entry);
            if (!e)
                continue;
            try {
                if (out.kind === "message")
                    await this.api.call("message_send", { ...out.payload, idempotency_key: out.key });
                else {
                    const message = await this.hooks.notice(e, String(out.payload.content), out.key);
                    if (message)
                        this.store.setMeta(`message-task:${message}`, e.id);
                    const latest = this.store.get(e.id);
                    if (out.key.includes(":question:") && message && latest?.phase === "input_required" && latest.validation_id === e.validation_id) {
                        latest.question_message = message;
                        this.store.save(latest);
                        this.store.setMeta(`question:${message}`, e.id);
                    }
                }
                this.store.delivered(out.key);
            }
            catch (error) {
                this.logger.warn({ error, delivery: out.key }, "Coordination delivery retained for retry");
            }
        }
    }
}
