import { createHash } from "node:crypto";
import { z } from "zod";
const text = z.string().trim().min(1).max(16000);
export const workIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const ref = z.string().min(1).max(256).refine(v => !v.startsWith("-") && !/[\s~^:?*\[\\]|\.\.|@\{|\/\//u.test(v), "Expected a branch name or commit SHA");
export const workspaceSchema = z.object({
    work_id: workIdSchema,
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).transform(v => v.toLowerCase()).optional(),
    base_ref: ref.optional(), integration_target: ref.optional()
}).strict();
export const executionSchema = z.object({
    version: z.literal(1), executor: z.literal("actuarius"),
    action: z.enum(["ask", "implement", "plan", "plan-oc", "review", "revise", "pr", "report", "workflow"]),
    workspace: workspaceSchema.optional(),
    requirements: z.array(text).min(1).max(100),
    acceptance_criteria: z.array(text).min(1).max(100),
    deliverable: z.enum(["workspace_changes", "report", "draft_pr"]),
    iterative: z.boolean().optional(),
    gates: z.array(z.object({ task_id: text, kind: z.enum(["merged", "release", "stacked"]), ref: ref.optional() }).strict()).max(100).optional()
}).strict().superRefine((v, ctx) => {
    if (v.action === "workflow" && v.workspace)
        ctx.addIssue({ code: "custom", path: ["workspace"], message: "Workflow summaries do not allocate a repository workspace" });
    if (v.action === "pr" && v.deliverable !== "draft_pr")
        ctx.addIssue({ code: "custom", path: ["deliverable"], message: "PR publication requires draft_pr delivery" });
    if (v.action !== "workflow" && !v.workspace)
        ctx.addIssue({ code: "custom", path: ["workspace"], message: "Repository work requires workspace.work_id" });
    if ((v.action === "report" || v.action === "workflow") && v.deliverable !== "report")
        ctx.addIssue({ code: "custom", path: ["deliverable"], message: "Report/workflow tasks must deliver a report" });
    if (v.gates?.some(g => g.kind === "release" && !g.ref))
        ctx.addIssue({ code: "custom", path: ["gates"], message: "Release gates require an explicit release tag in ref" });
});
export type ExecutionSpec = z.infer<typeof executionSchema>;
export const verdictSchema = z.object({ ready: z.boolean(), questions: z.array(text).max(20) }).strict()
    .refine(v => v.ready ? v.questions.length === 0 : v.questions.length > 0, "Rejected validation needs questions; ready verdict must have none");
export type Verdict = z.infer<typeof verdictSchema>;
export function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function encodeSpec(spec: ExecutionSpec): string { return "```actuarius-task\n" + JSON.stringify(spec, null, 2) + "\n```"; }
export function parseSpec(description: string): ExecutionSpec | null {
    if (!description.includes("```actuarius-task"))
        return null;
    if (Buffer.byteLength(description) > 128 * 1024)
        throw new Error("Task description exceeds 128 KiB");
    const blocks = [...description.matchAll(/^```actuarius-task[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/gm)];
    if (blocks.length !== 1 || description.split("```actuarius-task").length !== 2)
        throw new Error("Supply exactly one complete actuarius-task JSON block");
    const raw: unknown = JSON.parse(blocks[0]![1]!);
    if (raw && typeof raw === "object" && "executor" in raw && raw.executor !== "actuarius")
        return null;
    return executionSchema.parse(raw);
}
export const taskSchema = z.object({ task_id: text, title: text, description: z.string(),
    state: z.enum(["pending", "running", "input_required", "completed", "cancelled", "failed", "expired"]),
    revision: z.number().int(), created_by: text, wing: text, owner: z.string().nullable(),
    lease_expires_at: z.string().nullable(), dependencies: z.array(z.string()), parent_id: z.string().nullable()
});
export type PalaceTask = z.infer<typeof taskSchema>;
export const messageSchema = z.object({ message_id: text, task_id: text, sender: text, recipient: text, kind: text, payload: z.unknown() });
export type PalaceMessage = z.infer<typeof messageSchema>;
export const correctionSchema = z.object({ version: z.literal(1), validation_id: text, spec: executionSchema }).strict();
export const humanQuestionSchema = z.object({ version: z.literal(1), validation_id: text, question: text, reason: text, choices: z.array(text).max(10).optional() }).strict();
