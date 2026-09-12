import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ExecutionSpec, PalaceTask } from "./contract.js";
export interface Work {
    work_id: string;
    repository: string;
    base_ref: string;
    integration_target: string;
    branch: string;
    path: string | null;
    base_sha: string | null;
    thread_id: string | null;
    request_id: number | null;
    closed: boolean;
}
export interface Entry {
    id: string;
    task: PalaceTask | null;
    source: "discord" | "background";
    phase: string;
    description: string;
    spec: ExecutionSpec | null;
    work_id: string | null;
    sequence: number;
    step: number;
    attempts: number;
    next_at: number;
    reason: string;
    validation_id: string | null;
    question_message: string | null;
    human_answered: boolean;
    result: string | null;
    checkpoint: string | null;
    sender: string;
    wing: string;
    dependencies: string[];
    event_id: string | null;
    thread_id: string | null;
    attachments: unknown[];
    action: string;
    created_at: string;
}
export interface Outgoing {
    key: string;
    kind: "message" | "notice";
    entry: string;
    payload: Record<string, unknown>;
}
/** Queue data is separate from legacy request status, in the same durable database. */
export class CoordinationStore {
    private readonly db: DatabaseSync;
    public constructor(path: string) {
        this.db = new DatabaseSync(path);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS coordination_local_entries (sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,event_id TEXT UNIQUE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coordination_local_work (id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coordination_local_meta (id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coordination_local_outbox (id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coordination_local_inbox (id TEXT PRIMARY KEY);
    `);
    }
    public close(): void { this.db.close(); }
    public meta(key: string): string | null { return (this.db.prepare("SELECT value FROM coordination_local_meta WHERE id=?").get(key) as {
        value: string;
    } | undefined)?.value ?? null; }
    public setMeta(key: string, value: string): void { this.db.prepare("INSERT OR REPLACE INTO coordination_local_meta VALUES (?,?)").run(key, value); }
    public worker(): string { const old = this.meta("worker"); if (old)
        return old; const id = `actuarius-${randomUUID()}`; this.setMeta("worker", id); return id; }
    public list(): Entry[] { return (this.db.prepare("SELECT data,sequence FROM coordination_local_entries ORDER BY sequence").all() as {
        data: string;
        sequence: number;
    }[]).map(r => ({ ...JSON.parse(r.data) as Entry, sequence: r.sequence })); }
    public get(id: string): Entry | null { return this.list().find(e => e.id === id || e.task?.task_id === id) ?? null; }
    public event(id: string): Entry | null { return this.list().find(e => e.event_id === id) ?? null; }
    public save(entry: Entry): void { this.db.prepare("UPDATE coordination_local_entries SET data=? WHERE id=?").run(JSON.stringify(entry), entry.id); }
    public moveToTail(entry: Entry): void {
        this.db.prepare("UPDATE coordination_local_entries SET sequence=(SELECT COALESCE(MAX(sequence),0)+1 FROM coordination_local_entries) WHERE id=?").run(entry.id);
    }
    public add(input: Partial<Entry> & Pick<Entry, "id" | "source" | "description" | "sender" | "wing">): Entry {
        const prior = input.event_id ? this.event(input.event_id) : this.get(input.id);
        if (prior)
            return prior;
        const entry: Entry = { task: null, phase: "registering", spec: null, work_id: null, sequence: 0, step: 0, attempts: 0, next_at: 0, reason: "", validation_id: null, question_message: null, human_answered: false, result: null, checkpoint: null, dependencies: [], event_id: null, thread_id: null, attachments: [], action: "ask", created_at: new Date().toISOString(), ...input };
        const result = this.db.prepare("INSERT INTO coordination_local_entries(id,event_id,data) VALUES(?,?,?)").run(entry.id, entry.event_id, JSON.stringify(entry));
        entry.sequence = Number(result.lastInsertRowid);
        return entry;
    }
    public works(): Work[] { return (this.db.prepare("SELECT data FROM coordination_local_work").all() as {
        data: string;
    }[]).map(r => JSON.parse(r.data) as Work); }
    public work(id: string): Work | null { return this.works().find(w => w.work_id === id) ?? null; }
    public saveWork(work: Work): void { this.db.prepare("INSERT OR REPLACE INTO coordination_local_work VALUES (?,?)").run(work.work_id, JSON.stringify(work)); }
    public register(spec: NonNullable<ExecutionSpec["workspace"]>): Work {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const existing = this.work(spec.work_id);
            if (existing) {
                if (existing.closed)
                    throw new Error("Work ID is closed; use a new work_id");
                for (const field of ["repository", "base_ref", "integration_target"] as const)
                    if (spec[field] !== undefined && spec[field] !== existing[field])
                        throw new Error(`workspace.${field} conflicts with registered work ${spec.work_id}`);
                this.db.exec("COMMIT");
                return existing;
            }
            if (!spec.repository || !spec.base_ref || !spec.integration_target)
                throw new Error("Unknown work_id requires repository, base_ref, and integration_target");
            const work: Work = { work_id: spec.work_id, repository: spec.repository, base_ref: spec.base_ref, integration_target: spec.integration_target, branch: `actuarius/${randomUUID()}`, path: null, base_sha: null, thread_id: null, request_id: null, closed: false };
            this.saveWork(work);
            this.db.exec("COMMIT");
            return work;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    public enqueue(out: Outgoing): void { if (!this.meta(`sent:${out.key}`))
        this.db.prepare("INSERT OR IGNORE INTO coordination_local_outbox VALUES (?,?)").run(out.key, JSON.stringify(out)); }
    public outbox(): Outgoing[] { return (this.db.prepare("SELECT data FROM coordination_local_outbox ORDER BY rowid").all() as {
        data: string;
    }[]).map(r => JSON.parse(r.data) as Outgoing); }
    public delivered(key: string): void {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.setMeta(`sent:${key}`, "1");
            this.db.prepare("DELETE FROM coordination_local_outbox WHERE id=?").run(key);
            this.db.exec("COMMIT");
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    public seen(id: string): boolean { return !!this.db.prepare("SELECT id FROM coordination_local_inbox WHERE id=?").get(id); }
    public acknowledge(id: string): void { this.db.prepare("INSERT OR IGNORE INTO coordination_local_inbox VALUES (?)").run(id); }
}
