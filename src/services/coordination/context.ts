export const MAX_TASK_CONTEXT_BYTES = 32 * 1024;

export function contextText(value: string, bytes: number): string {
    if (Buffer.byteLength(value, "utf8") <= bytes) return value;
    return Buffer.from(value, "utf8").subarray(0, bytes - 16).toString("utf8").replace(/\uFFFD$/u, "") + " [truncated]";
}

export function contextValue(value: unknown, bytes: number): unknown {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") <= bytes) return value;
    return { truncated: true, preview: contextText(encoded, bytes) };
}

/** Measure the final JSON too: escaping can expand otherwise bounded previews. */
export function serializeTaskContext(context: { tasks: unknown[]; omitted_tasks: number; [key: string]: unknown }): string {
    const bounded = { ...context, tasks: [...context.tasks] };
    while (Buffer.byteLength(JSON.stringify(bounded), "utf8") > MAX_TASK_CONTEXT_BYTES && bounded.tasks.length) {
        bounded.tasks.pop();
        bounded.omitted_tasks++;
    }
    const encoded = JSON.stringify(bounded);
    if (Buffer.byteLength(encoded, "utf8") > MAX_TASK_CONTEXT_BYTES) throw new Error("Task context metadata exceeds its byte budget");
    return encoded;
}
