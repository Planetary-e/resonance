/** In-process delivery to an explicitly pinned co-located member. The same
 * signed protocol and shared operation/buffer budgets apply as on the wire. */
import { HISTORY_ROLE_LIMITS, HistoryLinkBudget, type HistoryRoleHandler, type HistoryRoleMethod } from './history-relay-link.js';

export class HistoryLocalExchange {
  private closed = false;
  private readonly active = new Set<AbortController>();
  constructor(private readonly budget: HistoryLinkBudget, private readonly handler: HistoryRoleHandler, private readonly timeoutMs: number) {}

  request(method: HistoryRoleMethod, value: unknown, signal: AbortSignal, maximumResponse: number, cutoff = Infinity): Promise<unknown> {
    const deadline = Math.min(performance.now() + this.timeoutMs, cutoff);
    if (this.closed || signal.aborted || deadline <= performance.now()) return Promise.reject(new Error('Local history exchange unavailable'));
    let release: () => void;
    try { release = this.budget.acquire(); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController(); this.active.add(controller);
    return new Promise((resolve, reject) => {
      let settled = false, releaseBytes: (() => void) | undefined;
      const finish = (error?: unknown, reply?: unknown) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', cancelled);
        controller.abort();
        if (error) reject(error); else resolve(reply);
      };
      const cancelled = () => finish(new Error('Local history exchange cancelled or timed out'));
      const abort = () => controller.abort();
      const timer = setTimeout(abort, Math.max(1, deadline - performance.now())); timer.unref?.();
      controller.signal.addEventListener('abort', cancelled, { once: true });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const live = () => { if (this.closed || controller.signal.aborted || performance.now() >= deadline) throw new Error('Local history exchange cancelled or timed out'); };
      const copy = (input: unknown, maximum: number) => {
        const encoded = JSON.stringify(input), bytes = typeof encoded === 'string' ? Buffer.byteLength(encoded) : 0;
        if (!bytes || bytes > maximum) throw new Error('Local history payload exceeds its bound');
        releaseBytes = this.budget.reserve(bytes);
        try { return JSON.parse(encoded); } finally { releaseBytes(); releaseBytes = undefined; }
      };
      // Capture the caller's exact value synchronously, before any scheduling or
      // handler await. Subsequent mutation cannot alter an admitted request.
      let request: unknown;
      try { live(); request = copy(value, HISTORY_ROLE_LIMITS[method][0]); }
      catch (error) { finish(error); this.active.delete(controller); release(); return; }
      Promise.resolve().then(() => { live(); return this.handler(method, request, { signal: controller.signal, deadline }); })
        .then(reply => { live(); const result = copy(reply, maximumResponse); live(); finish(undefined, result); })
        .catch(error => finish(error))
        .finally(() => {
          // A handler that ignores cancellation remains charged until it ends.
          releaseBytes?.(); release(); this.active.delete(controller);
        });
    });
  }
  close() { if (this.closed) return; this.closed = true; for (const controller of this.active) controller.abort(); }
}
