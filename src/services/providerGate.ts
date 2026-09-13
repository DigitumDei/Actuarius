/** One process-wide provider slot, also covering legacy/manual execution paths. */
class ProviderGate {
    private active = false;
    private pending: Array<{
        run: () => void;
        signal?: AbortSignal;
    }> = [];
    public async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        signal?.throwIfAborted();
        return new Promise<T>((resolve, reject) => {
            const entry = { run: (): void => {
                    if (signal?.aborted) {
                        reject(signal.reason);
                        this.pump();
                        return;
                    }
                    this.active = true;
                    signal?.removeEventListener("abort", onAbort);
                    void Promise.resolve().then(task).then(resolve, reject).finally(() => { this.active = false; this.pump(); });
                }, ...(signal ? { signal } : {}) };
            const onAbort = (): void => { this.pending = this.pending.filter(v => v !== entry); reject(signal?.reason); };
            signal?.addEventListener("abort", onAbort, { once: true });
            this.pending.push(entry);
            this.pump();
        });
    }
    private pump(): void { if (!this.active)
        this.pending.shift()?.run(); }
}
export const providerGate = new ProviderGate();
export let providerGateEnabled = false;
export function setProviderGateEnabled(enabled: boolean): void { providerGateEnabled = enabled; }
