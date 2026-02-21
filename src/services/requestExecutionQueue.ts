type QueueTask = () => Promise<void>;

export class RequestExecutionQueue {
  private readonly maxConcurrencyPerGuild: number;
  private readonly runningByGuild = new Map<string, number>();
  private readonly pendingByGuild = new Map<string, QueueTask[]>();

  public constructor(maxConcurrencyPerGuild: number) {
    this.maxConcurrencyPerGuild = Math.max(1, maxConcurrencyPerGuild);
  }

  public enqueue(guildId: string, task: QueueTask): void {
    const pending = this.pendingByGuild.get(guildId) ?? [];
    pending.push(task);
    this.pendingByGuild.set(guildId, pending);
    this.pump(guildId);
  }

  private pump(guildId: string): void {
    const running = this.runningByGuild.get(guildId) ?? 0;
    const pending = this.pendingByGuild.get(guildId) ?? [];

    if (running >= this.maxConcurrencyPerGuild || pending.length === 0) {
      return;
    }

    const nextTask = pending.shift();
    if (!nextTask) {
      return;
    }

    this.pendingByGuild.set(guildId, pending);
    this.runningByGuild.set(guildId, running + 1);

    void nextTask()
      .catch(() => undefined)
      .finally(() => {
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

        this.pump(guildId);
      });

    this.pump(guildId);
  }
}

