import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { CoordinationClient, CoordinationRevisionConflict } from "./client.js";
import { CoordinationStore, type Entry, type Work } from "./store.js";
import { ExecutionStopError } from "../../utils/executionStop.js";
import { TaskValidationError, clarifiedBriefSchema, correctionSchema, encodeSpec, executionSchema, fingerprint, humanQuestionSchema, isDraftPrApproval, parseSpec, type ClarifiedBrief, type ExecutionSpec, type PalaceTask, type Verdict } from "./contract.js";
export interface CoordinationHooks {
    cleanupAttachments?(entryId:string):Promise<void>;
    syncRequests?(): void;
    wings(): string[];
    check(spec: ExecutionSpec): Promise<void>;
    validate(entry: Entry, signal: AbortSignal): Promise<Verdict>;
    observePublication?(entry: Entry): Promise<boolean>;
    reconcile?(entry: Entry, signal: AbortSignal): Promise<string | null>;
    clarify(entry: Entry, answer: string, signal: AbortSignal): Promise<ClarifiedBrief>;
    execute(entry: Entry, work: Work | null, signal: AbortSignal): Promise<{
        result: string;
        next?: string;
        checkpoint?: string;
        retryAfterMs?: number;
        pause?: string;
    }>;
    notice(entry: Entry, content: string, key: string): Promise<string | null>;
    gate(entry: Entry, dependency: Entry, kind: "merged" | "release" | "stacked"): Promise<boolean>;
}
const terminal = new Set(["completed", "cancelled", "failed", "expired"]);
const actionLabels: Record<string, string> = {
    revise: "revision planning",
    implement: "implementation",
    deliver: "adversarial review and draft PR delivery",
    "publish-draft": "draft checkpoint publication",
    "draft-ci": "draft CI verification",
    "ci-fix": "CI failure correction",
    handoff: "checkpoint publication and handoff",
    "reconcile-publication": "external publication reconciliation",
    "verify-result": "acceptance verification",
    "plan-implement": "planned task implementation",
    "plan-verify": "planned task verification",
    plan: "implementation planning",
    "plan-oc": "OpenCode implementation planning",
    review: "adversarial review",
    pr: "draft PR delivery",
    ask: "answering the request",
    report: "report generation"
};
function isResumeRequest(text: string): boolean {
    return /^(?:retry|resume|continue|carry on)(?: (?:please|the (?:review|task|stage)))?[.!]?$/iu.test(text.trim());
}
function actionLabel(action: string): string {
    return actionLabels[action] ?? action.replaceAll("-", " ");
}
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
        this.controller?.abort(new ExecutionStopError("shutdown", "Actuarius is shutting down"));
        while (this.syncing)
            await new Promise(resolve => setTimeout(resolve, 10));
        await this.active;
    }
    public async tick(): Promise<void> {
        if (this.syncing || this.stopping)
            return;
        this.syncing = true;
        try {
            if (Date.now() - Number(this.store.meta("last-archive") ?? 0) > 86400000) {
                this.store.archiveClosed(); this.store.setMeta("last-archive",String(Date.now()));
            }
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
                for (const e of this.store.list()) {
                    const waiting = this.store.meta(`dependency-wait:${e.id}`);
                    if (e.phase === "execute" && waiting && this.store.get(waiting)?.phase === "completed") {
                        e.next_at=0; this.store.setMeta(`dependency-delay:${e.id}`,"0");
                        this.store.setMeta(`dependency-wait:${e.id}`,"");this.store.save(e);
                    }
                }
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
            this.hooks.syncRequests?.();
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
                const revision = page.revisions[id];
                if (revision !== undefined && this.store.meta(`observed:${id}`) === String(revision)) continue;
                let task: PalaceTask | null;
                try { task = await this.api.get(id); retries.delete(id); }
                catch (error) {
                    retries.add(id);
                    this.store.setMeta("source_error", `Task ${id}: ${String(error)}`);
                    continue;
                }
                if (task) {
                    const registering = this.store.list().find(e => e.source === "discord" && e.phase === "registering" && task!.created_by === e.sender && task!.description === this.registrationDescription(e));
                    if (registering) {
                        if (this.activeEntryId !== registering.id) { registering.task = task; this.store.save(registering); }
                        continue;
                    }
                    this.store.setMeta(`observed:${id}`, String(task.revision));
                }
                if (!task || (task.executor_affinity && task.executor_affinity !== this.worker) || terminal.has(task.state) || (task.state !== "pending" && task.owner !== this.worker) || !task.description.includes("```actuarius-task"))
                    continue;
                let spec: ExecutionSpec | null = null;
                try {
                    spec = parseSpec(task.description);
                    if (!spec)
                        continue;
                }
                catch { /* malformed intended submissions receive feedback */ }
                this.store.add({ id, source: "background", description: task.description, sender: task.created_by, wing: task.wing, task, phase: task.state === "pending" && !task.executor_affinity ? "validate" : "interrupted", reason: task.state === "pending" && !task.executor_affinity ? "" : "Recovered an owned task without local execution state; inspect before continuing", spec, work_id: spec?.workspace?.work_id ?? null });
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
            if (!terminal.has(task.state) && this.hooks.observePublication && ["input_required", "interrupted", "execute"].includes(latest.phase) &&
                Date.now() - Number(this.store.meta(`publication-refresh:${latest.id}`) ?? 0) >= 60000) {
                this.store.setMeta(`publication-refresh:${latest.id}`, String(Date.now()));
                try {
                    const merged = await this.hooks.observePublication(latest);
                    const current = this.store.get(latest.id);
                    if (merged && current && current.phase === latest.phase && fingerprint(current.spec) === fingerprint(latest.spec)) {
                        current.action="reconcile-publication";
                        current.checkpoint ??= "Externally merged publication awaits leased reconciliation";
                        current.phase="execute";current.next_at=0;
                        this.store.save(current);
                    }
                } catch (error) { this.store.setMeta("source_error", `Publication reconciliation for ${latest.id}: ${String(error)}`); }
            }
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
                this.deferDependency(e, id);
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
                this.deferDependency(e);
                this.store.save(e);
                return false;
            }
        }
        e.reason = "";
        this.store.setMeta(`dependency-delay:${e.id}`, "0");
        this.store.save(e);
        return true;
    }
    private deferDependency(e: Entry, dependencyId=""): void {
        this.store.setMeta(`dependency-wait:${e.id}`, dependencyId);
        const delay = Math.min(600000, Math.max(60000, Number(this.store.meta(`dependency-delay:${e.id}`) ?? 0) * 2));
        this.store.setMeta(`dependency-delay:${e.id}`, String(delay)); e.next_at = Date.now() + delay;
    }
    private notice(e: Entry, content: string, suffix: string): void {
        this.store.enqueue({ key: `${e.id}:${suffix}`, kind: "notice", entry: e.id, payload: { content } });
    }
    private feedback(e: Entry, questions: string[]): void {
        const validation = e.validation_id!;
        if (this.store.meta(`handoff-awaiting:${e.id}`)) {
            this.store.enqueue({key:`${validation}:feedback`,kind:"message",entry:e.id,payload:{
                task_id:e.task!.task_id,sender:this.worker,recipient:e.sender,kind:"checkpoint_handoff",
                payload:{version:1,validation_id:validation,reason:e.reason,work_id:e.work_id,
                    publication:e.work_id ? this.store.work(e.work_id)?.publication : null,
                    instructions:"Checkpoint published; final review is not approved. Resume the retained stage or finish externally. A matching external merge will be reconciled under a task lease."}
            }});
            this.notice(e,`Task ${e.task!.task_id} checkpoint handed off.\n${e.reason}\nReply Resume to continue the retained stage.`,`question:${validation}`);
            return;
        }
        this.store.enqueue({ key: `${validation}:feedback`, kind: "message", entry: e.id, payload: {
                task_id: e.task!.task_id, sender: this.worker, recipient: e.sender, kind: "validation_required",
                payload: { version: 1, validation_id: validation, questions, instructions: "Reply with task_correction {version:1,validation_id,spec:<complete JSON>} or human_input_required {version:1,validation_id,question,reason}." }
            } });
        this.notice(e, `Task ${e.task!.task_id} needs correction:\n${questions.join("\n")}\nReply to this message to provide input.`, `question:${validation}`);
    }
    private registrationDescription(e: Entry): string { return `${e.description}\n<!-- actuarius:${this.worker}:${e.id} -->`; }
    private async run(e: Entry): Promise<void> {
        let lease: PalaceTask | null = null;
        let renewTimer: NodeJS.Timeout | null = null;
        let leaseDeadline: NodeJS.Timeout | null = null;
        let renewing: Promise<void> = Promise.resolve();
        const abort = new AbortController();
        this.controller = abort;
        const watchLease = (): void => {
            if(leaseDeadline) clearTimeout(leaseDeadline);
            const deadline=lease?.lease_expires_at ? Date.parse(lease.lease_expires_at)-15000 : Date.now();
            leaseDeadline=setTimeout(()=>abort.abort(new ExecutionStopError("lease_loss", "Lease could not be confirmed before its safety margin")),Math.max(0,deadline-Date.now()));
            leaseDeadline.unref();
        };
        const transition = async (state: string, details: unknown): Promise<void> => {
            if (renewTimer) {
                clearInterval(renewTimer);
                renewTimer = null;
            }
            await renewing;
            abort.signal.throwIfAborted();
            lease = await this.api.mutate("transition", { task_id: lease!.task_id, actor: this.worker, expected_revision: lease!.revision, state, details });
            if(leaseDeadline) {clearTimeout(leaseDeadline);leaseDeadline=null;}
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
                e.task = await this.api.create({ created_by: e.sender, idempotency_key: e.id, wing: e.wing, title: e.spec?.requirements[0]?.slice(0, 200) ?? "Discord task", description: this.registrationDescription(e), dependencies: deps });
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
            let current = await this.api.get(e.task!.task_id);
            if (!current)
                throw new Error("Authoritative task is missing");
            if (terminal.has(current.state)) {
                e.task = current;
                e.phase = current.state;
                this.store.save(e);
                return;
            }
            // Recover legacy two-transition yields and corrected tasks.
            // Corrected tasks also resume through pending before acquiring a lease.
            if (["execute", "validate", "publishing"].includes(e.phase) && current.state === "input_required") {
                current = await this.api.mutate("transition", { task_id: current.task_id, actor: this.worker, expected_revision: current.revision, state: "pending" });
                e.task = current;
                this.store.save(e);
            }
            if (e.phase === "input_transition" && current.state === "input_required") {
                e.task = current; e.phase = "input_required"; e.attempts = 0;
                this.store.save(e); this.feedback(e, [e.reason]); return;
            }
            if ((current.executor_affinity && current.executor_affinity !== this.worker) ||
                (current.owner && current.owner !== this.worker && current.lease_expires_at && Date.parse(current.lease_expires_at) > Date.now())) {
                e.reason = "Claimed by another worker";
                e.next_at = Date.now() + 15000;
                this.store.save(e);
                return;
            }
            lease = await this.api.mutate("claim", { task_id: current.task_id, worker: this.worker, expected_revision: current.revision, lease_seconds: 120 });
            watchLease();
            e.task = lease;
            this.store.save(e);
            renewTimer = setInterval(() => {
                renewing = renewing.then(async () => {
                    for (let attempt = 0; attempt < 2 && !abort.signal.aborted; attempt++) {
                        try {
                            lease = await this.api.mutate("renew", { task_id: lease!.task_id, worker: this.worker, expected_revision: lease!.revision, lease_seconds: 120 });
                            if (!abort.signal.aborted) watchLease();
                            return;
                        } catch (error) {
                            this.logger.warn({error, task:e.id}, "Lease renewal failed; refreshing authoritative ownership");
                            try {
                                const fresh = await this.api.get(lease!.task_id);
                                if (abort.signal.aborted) return;
                                if (!fresh || fresh.state !== "running" || fresh.owner !== this.worker ||
                                    (fresh.executor_affinity && fresh.executor_affinity !== this.worker) ||
                                    !fresh.lease_expires_at || !Number.isFinite(Date.parse(fresh.lease_expires_at)) ||
                                    Date.parse(fresh.lease_expires_at) <= Date.now() + 15000) {
                                    abort.abort(new ExecutionStopError("lease_loss", "Task lease was lost or expired during renewal", { cause: error }));
                                    return;
                                }
                                // A lost response may have committed. Only an authoritative,
                                // still-owned lease can advance the revision or safety deadline.
                                if (fresh.revision < lease!.revision) break;
                                const advanced = fresh.revision > lease!.revision;
                                lease = fresh;
                                watchLease();
                                if (!advanced) break;
                            } catch (refreshError) {
                                this.logger.warn({error:refreshError, task:e.id}, "Lease refresh unavailable; retaining confirmed deadline");
                                break;
                            }
                        }
                    }
                });
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
                    if (e.spec.gates?.some(g => !e.task!.dependencies.includes(g.task_id)))
                        throw new Error("Every gate must reference a native dependency");
                }
                catch (error) {
                    questions = [error instanceof Error ? error.message : String(error)];
                }
                if (!questions.length) {
                    try { await this.hooks.check(e.spec!); }
                    catch (error) { if (error instanceof TaskValidationError) questions = [error.message]; else throw error; }
                }
                if (questions.length === 0) {
                    const failureKey=`validator-failures:${e.validation_id}`;
                    try {
                        const clarification = this.store.meta(`clarification:${e.id}`);
                        if (clarification) {
                            const brief = clarifiedBriefSchema.parse(await this.hooks.clarify(e, clarification, abort.signal));
                            abort.signal.throwIfAborted();
                            if (brief.deliverable === "draft_pr" && e.spec?.deliverable !== "draft_pr" && !this.store.meta(`publication-approval:${e.id}`)) {
                                throw new TaskValidationError('The proposed correction would publish a draft PR without recorded approval. To authorize publication, reply "Create a draft PR"; otherwise clarify the requested work without publication.');
                            }
                            e.spec = executionSchema.parse({ ...e.spec, ...brief });
                            e.description = encodeSpec(e.spec);
                            e.action = e.spec.action;
                            this.store.save(e);
                            this.store.deleteMeta(`clarification:${e.id}`);
                            this.store.deleteMeta(`publication-approval:${e.id}`);
                        }
                        const verdict = await this.hooks.validate(e, abort.signal);
                        this.store.setMeta(failureKey,"0");
                        if (!verdict.ready) questions = verdict.questions;
                    } catch(error) {
                        abort.signal.throwIfAborted();
                        if (error instanceof TaskValidationError) {
                            questions = [error.message];
                        } else {
                            const failures=Number(this.store.meta(failureKey) ?? 0)+1;
                            this.store.setMeta(failureKey,String(failures));
                            if(failures<3) throw error;
                            questions=[`Validator failed after ${failures} attempts: ${error instanceof Error ? error.message : String(error)}. Check the provider/configuration or revise the task before retrying.`];
                        }
                    }
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
                await transition("pending", { reason: "validated; awaiting execution slot" });
                return;
            }
            if (e.phase === "execute") {
                await this.hooks.check(e.spec!);
                abort.signal.throwIfAborted();
                if (e.work_id)
                    this.store.setMeta(`workspace-owner:${e.work_id}`, e.id);
                const currentAction = e.checkpoint ? e.action : e.spec!.action;
                const currentLabel = actionLabel(currentAction);
                e.action = currentAction;
                e.phase = "running";
                this.store.save(e);
                this.notice(e, `Task ${e.task!.task_id} · step ${e.step + 1}: ${currentLabel} started.`, `start:${e.step}`);
                const reconciled = currentAction === "reconcile-publication" ? await this.hooks.reconcile?.(e, abort.signal) : null;
                if (currentAction === "reconcile-publication" && !reconciled) throw new Error("External completion could not be confirmed; retained workspace needs inspection");
                const output = reconciled ? {result:reconciled} : await this.hooks.execute(e, e.work_id ? this.store.work(e.work_id) : null, abort.signal);
                abort.signal.throwIfAborted();
                if (output.pause) {
                    e.checkpoint = output.checkpoint ?? output.result;
                    e.action = output.next ?? e.action;
                    e.reason = output.pause;
                    this.store.setMeta(`handoff-awaiting:${e.id}`,"1");
                    e.validation_id = randomUUID();
                    e.human_answered = false; e.question_message = null;
                    e.phase = "input_transition";
                    this.store.save(e);
                    await transition("input_required", {reason:output.pause});
                    e.phase = "input_required";
                    this.store.save(e);
                    this.notice(e, output.result, `handoff:${e.step}`);
                    this.feedback(e, [output.pause]);
                    return;
                }
                if (output.next) {
                    const completedStep = e.step;
                    e.checkpoint = output.checkpoint ?? output.result;
                    e.action = output.next;
                    e.phase = "execute";
                    e.step++;
                    e.next_at = output.retryAfterMs ? Date.now() + output.retryAfterMs : 0;
                    e.attempts = 0;
                    this.store.save(e);
                    this.store.moveToTail(e);
                    this.notice(e, `Task ${e.task!.task_id} · step ${completedStep + 1}: ${currentLabel} completed.\n${output.result}\nNext: ${actionLabel(output.next)} queued.`, `step-result:${completedStep}`);
                    await transition("pending", { reason: "step complete; continuation queued" });
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
            if (e.phase === "running") {
                const detail = error && typeof error === "object" ? error as Record<string,unknown> : {};
                const reason = abort.signal.aborted ? abort.signal.reason : error;
                const stop = {
                    action:e.action, step:e.step, time:new Date().toISOString(),
                    message:reason instanceof Error ? reason.message : String(reason),
                    stopKind: reason instanceof ExecutionStopError ? reason.stopKind : detail.stopKind,
                    stage:detail.reviewStage ?? (detail.diagnostics as {stage?:string}|undefined)?.stage ?? e.action,
                    provider:detail.provider, providerSessionId:detail.providerSessionId,
                    timeoutKind:detail.timeoutKind, timeoutMs:detail.timeoutMs, lastActivity:detail.lastActivity,
                    partialStdout:typeof (detail.partialStdout ?? detail.stdout) === "string" ? String(detail.partialStdout ?? detail.stdout).slice(-60000) : undefined,
                    partialStderr:typeof (detail.partialStderr ?? detail.stderr) === "string" ? String(detail.partialStderr ?? detail.stderr).slice(-10000) : undefined,
                    checkpointRetained:e.checkpoint !== null
                };
                this.store.setMeta(`last-stop:${e.id}`,JSON.stringify(stop));
                if (abort.signal.aborted) error = reason;
            }
            if (e.phase !== "input_transition") e.reason = error instanceof Error ? `${error.message}${"stderr" in error ? `: ${String(error.stderr).slice(-3000)}` : ""}` : String(error);
            if (e.phase === "running") {
                e.phase = "interrupted";
                e.reason = `Execution stopped; retained workspace needs inspection: ${e.reason}`;
            }
            e.attempts++;
            e.next_at = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(6, e.attempts));
            this.store.moveToTail(e);
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
            if(leaseDeadline)clearTimeout(leaseDeadline);
            this.controller = null;
            this.hooks.syncRequests?.();
        }
    }
    private async messages(): Promise<void> {
        for (const msg of await this.api.inbox(this.worker)) {
            if (!this.store.seen(msg.message_id)) {
                const e = this.store.get(msg.task_id);
                if (["task_correction","human_input_required"].includes(msg.kind)) {
                    const parsed = msg.kind === "task_correction" ? correctionSchema.safeParse(msg.payload) : humanQuestionSchema.safeParse(msg.payload);
                    const reason = !e ? "Task is not managed by this worker" : msg.sender !== e.sender ? "Sender is not the task submitter" : e.phase !== "input_required" ? "Task is not awaiting input" : !parsed.success ? parsed.error.message : parsed.data.validation_id !== e.validation_id ? "Stale validation attempt" : msg.kind === "human_input_required" && e.human_answered ? "Human already answered" : null;
                    if(reason) {
                        await this.api.call("message_send", {task_id:msg.task_id,sender:this.worker,recipient:msg.sender,kind:"correction_rejected",payload:{version:1,reason},idempotency_key:`reject:${msg.message_id}`});
                        this.store.acknowledge(msg.message_id); await this.api.call("message_acknowledge",{message_id:msg.message_id,actor:this.worker}); continue;
                    }
                }
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
                            this.store.deleteMeta(`clarification:${e.id}`);
                            this.store.deleteMeta(`publication-approval:${e.id}`);
                            this.store.deleteMeta(`handoff-awaiting:${e.id}`);
                            const sameIntent = fingerprint(e.spec) === fingerprint(correction.data.spec);
                            e.spec = correction.data.spec;
                            e.description = encodeSpec(e.spec);
                            if (!sameIntent) { e.checkpoint = null; e.action = e.spec.action; }
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
    public questionEntry(messageId:string): Entry|null {
        const id=this.store.meta(`question:${messageId}`);
        return id ? this.store.get(id) : this.store.list().find(e=>e.question_message===messageId) ?? null;
    }
    public async answer(messageId: string, answer: string, eventId: string): Promise<boolean> {
        const e = this.questionEntry(messageId);
        if (!e) return false;
        const validation=this.store.meta(`question-validation:${messageId}`);
        if (e.phase!=="input_required" || e.human_answered || (validation && validation!==e.validation_id)) throw new Error("This question is no longer open. Reply to the current task question.");
        if (isResumeRequest(answer) && e.checkpoint && (this.store.meta(`last-stop:${e.id}`) || this.store.meta(`handoff-awaiting:${e.id}`))) {
            this.resume(e.id);
            return true;
        }
        this.store.deleteMeta(`handoff-awaiting:${e.id}`);
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
            this.store.deleteMeta(`clarification:${e.id}`);
            this.store.deleteMeta(`publication-approval:${e.id}`);
            e.spec = replacement;
            e.description = encodeSpec(replacement);
            e.phase = "validate";
            e.validation_id = null;
            e.next_at = 0;
            e.attempts = 0;
            this.store.save(e);
        }
        else if (e.source === "discord") {
            // Reconcile superseded requirements and acceptance criteria before validation.
            this.recordPublicationApproval(e.id, answer);
            this.store.setMeta(`clarification:${e.id}`, answer);
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
    private recordPublicationApproval(id: string, answer: string): void {
        this.store.deleteMeta(`publication-approval:${id}`);
        if (isDraftPrApproval(answer)) this.store.setMeta(`publication-approval:${id}`, answer);
    }
    public resume(id: string): Entry {
        const e = this.store.get(id);
        if (!e?.spec || !["input_required", "interrupted"].includes(e.phase) || this.activeEntryId === e.id)
            throw new Error("Task is not awaiting recovery");
        this.store.deleteMeta(`handoff-awaiting:${e.id}`);
        if (e.action === "draft-ci" && e.checkpoint) {
            try {
                const checkpoint = JSON.parse(e.checkpoint) as { version?: number; polls?: number };
                if (checkpoint.version === 1 && typeof checkpoint.polls === "number") {
                    checkpoint.polls = 0;
                    e.checkpoint = JSON.stringify(checkpoint);
                }
            } catch { /* the execution stage reports malformed retained data */ }
        }
        e.phase = e.checkpoint ? "execute" : "validate";
        e.validation_id = null; e.question_message = null; e.human_answered = false;
        e.next_at = 0; e.attempts = 0; e.reason = "Operator resumed the retained stage";
        this.store.save(e);
        this.store.moveToTail(e);
        return e;
    }
    public repair(id: string, clarification: string): Entry {
        if (isResumeRequest(clarification)) return this.resume(id);
        const e = this.store.get(id);
        if (!e?.spec || !["input_required", "interrupted"].includes(e.phase) || this.activeEntryId === e.id)
            throw new Error("Task is not awaiting recovery");
        this.store.deleteMeta(`handoff-awaiting:${e.id}`);
        e.spec = executionSchema.parse({ ...e.spec, action: "revise", requirements: [...e.spec.requirements, ...(e.reason ? [`Recovery context: ${e.reason.slice(0, 15000)}`] : []), clarification] });
        this.recordPublicationApproval(e.id, clarification);
        this.store.setMeta(`clarification:${e.id}`, clarification);
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
    public async cancel(id: string): Promise<string> {
        const e = this.store.get(id);
        if (!e)
            throw new Error("Unknown task");
        if (!e.task) {
            this.store.setMeta(`cancel:${e.id}`, "1");
            e.reason = "Cancellation requested; confirming registration outcome";
            this.store.save(e);
            return "Cancellation requested; confirming registration outcome.";
        }
        for(let attempt=0;attempt<3;attempt++) {
            const task = await this.api.get(e.task.task_id);
            if(!task) return "Task was not found; cancellation could not be confirmed.";
            if(terminal.has(task.state)) {
                e.task=task;e.phase=task.state;this.store.save(e);this.hooks.syncRequests?.();
                return `Task is already ${task.state}.`;
            }
            try {
                e.task=await this.api.mutate("transition", { task_id: task.task_id, actor: this.worker, expected_revision: task.revision, state: "cancelled" });
                break;
            } catch(error) {
                if(!(error instanceof CoordinationRevisionConflict))throw error;
                if(attempt===2)return "Task changed while cancelling; please retry cancellation.";
            }
        }
        if (e.id === this.activeEntryId)
            this.controller?.abort(new ExecutionStopError("operator", "Task cancelled by the operator"));
        e.phase = "cancelled";
        this.store.save(e);
        this.hooks.syncRequests?.();
        return "Task cancelled.";
    }
    private async flush(): Promise<void> {
        for (const out of this.store.outbox()) {
            const e = this.store.get(out.entry);
            if (!e)
                continue;
            try {
                if (out.kind === "cache-cleanup") {
                    if(!this.hooks.cleanupAttachments) throw new Error("Attachment cleanup handler is unavailable");
                    await this.hooks.cleanupAttachments(e.id);
                    this.store.deleteMeta(`attachments:${e.id}`);
                }
                else if (out.kind === "message")
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
                        this.store.setMeta(`question-validation:${message}`, e.validation_id!);
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
