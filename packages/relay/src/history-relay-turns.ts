/** Bounded FIFO turns for several member requests sharing one history socket.
 * The router retains the shared operation reservation while a turn is queued. */
export class HistoryRelayTurns {
  private readonly active = new Set<string>();
  private readonly pending = new Map<string, Set<{ start(): void; cancel(): void }>>();
  private count = 0;
  private closed = false;

  enter(relayId: string, signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (this.closed || signal.aborted || this.count >= 8) { reject(new Error('History send queue unavailable')); return; }
      this.count++;
      let settled = false;
      const remove = () => {
        signal.removeEventListener('abort', entry.cancel);
        const queue = this.pending.get(relayId); queue?.delete(entry);
        if (!queue?.size) this.pending.delete(relayId);
      };
      const entry = {
        start: () => {
          if (settled) return;
          if (this.closed || signal.aborted) { entry.cancel(); return; }
          settled = true; remove(); this.active.add(relayId); let released = false;
          resolve(() => {
            if (released) return; released = true; this.count--; this.active.delete(relayId);
            if (!this.closed) this.pending.get(relayId)?.values().next().value?.start();
          });
        },
        cancel: () => {
          if (settled) return;
          settled = true; remove(); this.count--; reject(new Error('History send queue cancelled or closed'));
        },
      };
      if (!this.active.has(relayId)) entry.start();
      else {
        const queue = this.pending.get(relayId) ?? new Set(); queue.add(entry); this.pending.set(relayId, queue);
        signal.addEventListener('abort', entry.cancel, { once: true });
        if (signal.aborted) entry.cancel();
      }
    });
  }

  close() {
    if (this.closed) return; this.closed = true;
    for (const queue of this.pending.values()) for (const entry of queue) entry.cancel();
  }
}
