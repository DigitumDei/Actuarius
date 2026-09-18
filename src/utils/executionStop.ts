export type ExecutionStopKind = "operator" | "shutdown" | "lease_loss" | "cancelled" | "quota";

/** Carries the reason an owning workflow stopped its subprocess. */
export class ExecutionStopError extends Error {
    public constructor(public readonly stopKind: ExecutionStopKind, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ExecutionStopError";
    }
}

export function stopDetails(reason: unknown): { stopKind: ExecutionStopKind; stopReason: string } {
    return {
        stopKind: reason instanceof ExecutionStopError ? reason.stopKind : "cancelled",
        stopReason: reason instanceof Error ? reason.message : reason === undefined ? "Execution was cancelled" : String(reason)
    };
}

export function isExecutionInterruption(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const detail = error as { stopKind?: string; code?: string; timeoutKind?: string };
    return Boolean(detail.stopKind || detail.timeoutKind) || ["ABORT_ERR", "TIMEOUT", "ETIMEDOUT"].includes(detail.code ?? "");
}
