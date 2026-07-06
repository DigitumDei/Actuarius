type QueueTask = () => Promise<void>;
interface QueueEntry {
  task: QueueTask;
  resourceKey?: string;
}
type QueueTaskErrorHandler = (input: { guildId: string; error: unknown }) => void;
type QueueStateHandler = (input: {
  guildId: string;
  event: "enqueued" | "started" | "finished";
  running: number;
  pending: number;
}) => void;

export class RequestExecutionQueue {
  private readonly maxConcurrencyPerGuild: number;
  private readonly onTaskError: QueueTaskErrorHandler | undefined;
  private readonly onStateChange: QueueStateHandler | undefined;
  private readonly runningByGuild = new Map<string, number>();
  private readonly runningResourceKeysByGuild = new Map<string, Set<string>>();
  private readonly pendingByGuild = new Map<string, QueueEntry[]>();

  public constructor(maxConcurrencyPerGuild: number, onTaskError?: QueueTaskErrorHandler, onStateChange?: QueueStateHandler) {
    this.maxConcurrencyPerGuild = Math.max(1, maxConcurrencyPerGuild);
    this.onTaskError = onTaskError;
    this.onStateChange = onStateChange;
  }

  public enqueue(guildId: string, task: QueueTask, resourceKey?: string): void {
    const pending = this.pendingByGuild.get(guildId) ?? [];
    pending.push({ task, ...(resourceKey ? { resourceKey } : {}) });
    this.pendingByGuild.set(guildId, pending);
    this.onStateChange?.({
      guildId,
      event: "enqueued",
      running: this.runningByGuild.get(guildId) ?? 0,
      pending: pending.length
    });
    this.pump(guildId);
  }

  public hasResourceWork(guildId: string, resourceKey: string): boolean {
    if (this.runningResourceKeysByGuild.get(guildId)?.has(resourceKey)) {
      return true;
    }

    return (this.pendingByGuild.get(guildId) ?? []).some((entry) => entry.resourceKey === resourceKey);
  }

  private pump(guildId: string): void {
    const running = this.runningByGuild.get(guildId) ?? 0;
    const pending = this.pendingByGuild.get(guildId) ?? [];

    if (running >= this.maxConcurrencyPerGuild || pending.length === 0) {
      return;
    }

    const runningResourceKeys = this.runningResourceKeysByGuild.get(guildId) ?? new Set<string>();
    const nextTaskIndex = pending.findIndex((entry) => !entry.resourceKey || !runningResourceKeys.has(entry.resourceKey));
    if (nextTaskIndex === -1) {
      return;
    }
    const [nextEntry] = pending.splice(nextTaskIndex, 1);
    if (!nextEntry) return;

    this.pendingByGuild.set(guildId, pending);
    this.runningByGuild.set(guildId, running + 1);
    if (nextEntry.resourceKey) {
      runningResourceKeys.add(nextEntry.resourceKey);
      this.runningResourceKeysByGuild.set(guildId, runningResourceKeys);
    }
    this.onStateChange?.({
      guildId,
      event: "started",
      running: running + 1,
      pending: pending.length
    });

    void nextEntry.task()
      .catch((error) => {
        this.onTaskError?.({
          guildId,
          error
        });
      })
      .finally(() => {
        if (nextEntry.resourceKey) {
          const activeKeys = this.runningResourceKeysByGuild.get(guildId);
          activeKeys?.delete(nextEntry.resourceKey);
          if (activeKeys?.size === 0) {
            this.runningResourceKeysByGuild.delete(guildId);
          }
        }
        const active = this.runningByGuild.get(guildId) ?? 1;
        const nextActive = Math.max(0, active - 1);
        if (nextActive === 0) {
          this.runningByGuild.delete(guildId);
        } else {
          this.runningByGuild.set(guildId, nextActive);
        }

        const remaining = this.pendingByGuild.get(guildId) ?? [];
        if (remaining.length === 0 && nextActive === 0) {
          this.pendingByGuild.delete(guildId);
        }

        this.onStateChange?.({
          guildId,
          event: "finished",
          running: nextActive,
          pending: remaining.length
        });

        this.pump(guildId);
      });

    this.pump(guildId);
  }
}
