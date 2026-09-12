import { z } from "zod";
import { messageSchema, taskSchema, type PalaceTask, type PalaceMessage } from "./contract.js";
export interface CoordinationTransport {
    coordinationCall(name: string, args: Record<string, unknown>): Promise<unknown>;
}
export class CoordinationClient {
    public constructor(private readonly transport: CoordinationTransport) { }
    public call(name: string, args: Record<string, unknown>): Promise<unknown> { return this.transport.coordinationCall(`agentpalace_${name}`, args); }
    public async get(id: string): Promise<PalaceTask | null> {
        const data = z.object({ found: z.boolean(), value: taskSchema.optional() }).parse(await this.call("task_get", { task_id: id }));
        return data.found ? taskSchema.parse(data.value) : null;
    }
    public async mutate(name: "claim" | "renew" | "transition", args: Record<string, unknown>): Promise<PalaceTask> {
        const data = z.object({ success: z.boolean(), task: taskSchema.optional() }).parse(await this.call(`task_${name}`, args));
        if (!data.success)
            throw new Error("Coordination revision conflict; refresh before retrying");
        return taskSchema.parse(data.task);
    }
    public async create(args: Record<string, unknown>): Promise<PalaceTask> { return taskSchema.parse(await this.call("task_create", args)); }
    public async creationWing(preferred: string, authority: string): Promise<string> {
        const catalog = z.object({ wings: z.array(z.object({ wing: z.string(), destination: z.string() })) })
            .parse(await this.call("coordination_wings", {}));
        const matches = catalog.wings.filter(w => w.destination === authority);
        const chosen = matches.find(w => w.wing === preferred) ?? matches[0];
        if (!chosen) throw new Error(`No coordination write route to ${authority}; configure a wing at the predecessor's authority`);
        return chosen.wing;
    }
    public async page(wing: string, cursor?: string, remoteCursors: Record<string, string> = {}): Promise<{
        ids: string[];
        next: string | null;
        remoteCursors: Record<string, string>;
        errors: string[];
        authorities: Record<string, string>;
    }> {
        const page = z.object({ tasks: z.array(z.object({ task_id: z.string() })).optional(), next_cursor: z.string().nullable().optional(), error: z.string().optional() });
        const data = z.object({ tasks: z.array(z.object({ task_id: z.string() })), next_cursor: z.string().nullable(), remote_tasks: z.record(page).optional() }).parse(await this.call("task_list", { ...(wing ? { wing } : {}), include_local: true, remote_cursors: remoteCursors, limit: 100, ...(cursor ? { cursor } : {}) }));
        const nextRemotes = { ...remoteCursors };
        const ids = data.tasks.map(t => t.task_id);
        const authorities: Record<string, string> = Object.fromEntries(ids.map(id => [id, "local"]));
        const errors: string[] = [];
        for (const [origin, remote] of Object.entries(data.remote_tasks ?? {})) {
            if (!remote.tasks) {
                errors.push(`${origin}: ${remote.error ?? "coordination unavailable"}`);
                continue;
            }
            ids.push(...remote.tasks.map(t => t.task_id));
            for (const task of remote.tasks) authorities[task.task_id] ??= `remote:${origin}`;
            if (remote.next_cursor)
                nextRemotes[origin] = remote.next_cursor;
            else
                delete nextRemotes[origin];
        }
        return { ids, next: data.next_cursor, remoteCursors: nextRemotes, errors, authorities };
    }
    public async inbox(recipient: string): Promise<PalaceMessage[]> {
        const data = z.object({ messages: z.array(messageSchema), remote_messages: z.record(z.object({ messages: z.array(messageSchema).optional() }).passthrough()).optional() }).parse(await this.call("inbox_read", { recipient, unacknowledged_only: true, limit: 100 }));
        // Exact message mutations route through AgentPalace's authority lookup.
        return [...data.messages, ...Object.values(data.remote_messages ?? {}).flatMap(v => v.messages ?? [])];
    }
}
