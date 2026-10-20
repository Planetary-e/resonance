/** Bounded local timing variation; this is not a multi-user mix network. */
import { randomInt } from 'node:crypto';

export interface PrivateTrafficScheduleOptions {
  batchWindowMs?: number;
  jitterMs?: number;
  maxBatchSize?: number;
  maxConcurrent?: number;
  capacity?: number;
  maxQueueWaitMs?: number;
}

interface Entry {
  controller: AbortController;
  start(): void;
  reject(error: Error): void;
  expiry?: ReturnType<typeof setTimeout>;
  dispatch?: ReturnType<typeof setTimeout>;
  done: boolean;
  detach?: () => void;
}

export function createPrivateTrafficScheduler(options: PrivateTrafficScheduleOptions = {}) {
  const batchWindowMs = bounded(options.batchWindowMs ?? 250, 10, 1_000);
  const jitterMs = bounded(options.jitterMs ?? 250, 0, 1_000);
  const maxBatchSize = bounded(options.maxBatchSize ?? 4, 1, 16);
  const maxConcurrent = bounded(options.maxConcurrent ?? 4, 1, 16);
  const capacity = bounded(options.capacity ?? 64, 1, 256);
  const maxQueueWaitMs = bounded(options.maxQueueWaitMs ?? 5_000, batchWindowMs + jitterMs + 1, 10_000);
  const pending: Entry[] = [];
  const all = new Set<Entry>();
  // Reserved slots include the randomized delay before work begins.
  const slots = new Set<Entry>();
  let batchTimer: ReturnType<typeof setTimeout> | undefined;

  function arm(): void {
    if (batchTimer || !pending.length || slots.size >= maxConcurrent) return;
    batchTimer = setTimeout(flush, batchWindowMs);
  }

  function remove(entry: Entry): void {
    entry.done = true;
    clearTimeout(entry.expiry);
    clearTimeout(entry.dispatch);
    entry.detach?.();
    all.delete(entry);
    slots.delete(entry);
    const index = pending.indexOf(entry);
    if (index >= 0) pending.splice(index, 1);
    if (!pending.length) { clearTimeout(batchTimer); batchTimer = undefined; }
    arm();
  }

  function fail(entry: Entry, error: Error): void {
    if (entry.done) return;
    remove(entry);
    entry.reject(error);
    entry.controller.abort(error);
  }

  function flush(): void {
    batchTimer = undefined;
    // Take the oldest requests first, then shuffle their release order.
    const batch = pending.splice(0, Math.min(maxBatchSize, maxConcurrent - slots.size));
    for (let index = batch.length - 1; index > 0; index--) {
      const swap = randomInt(index + 1);
      [batch[index], batch[swap]] = [batch[swap], batch[index]];
    }
    for (const entry of batch) {
      slots.add(entry);
      entry.dispatch = setTimeout(() => {
        if (entry.done) return;
        clearTimeout(entry.expiry);
        entry.start();
      }, randomInt(jitterMs + 1));
    }
    arm();
  }

  return {
    schedule<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (all.size >= capacity) return Promise.reject(new Error('Private traffic queue is full'));
      return new Promise<T>((resolve, reject) => {
        const entry: Entry = {
          controller: new AbortController(), done: false, reject,
          start() {
            void Promise.resolve().then(() => {
              entry.controller.signal.throwIfAborted();
              return work(entry.controller.signal);
            }).then(value => {
              if (entry.done) return;
              remove(entry);
              resolve(value);
            }, error => fail(entry, error instanceof Error ? error : new Error(String(error))));
          },
        };
        all.add(entry);
        pending.push(entry);
        const onAbort = () => fail(entry, signal!.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        entry.detach = () => signal?.removeEventListener('abort', onAbort);
        entry.expiry = setTimeout(() => fail(entry, new Error('Private traffic queue wait expired')), maxQueueWaitMs);
        arm();
      });
    },
    /** Cancel current work; the client can schedule fresh requests afterward. */
    cancelAll(): void {
      for (const entry of [...all]) fail(entry, new Error('Private client disconnected'));
      clearTimeout(batchTimer);
      batchTimer = undefined;
      arm();
    },
  };
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('Invalid private traffic scheduling limits');
  }
  return value;
}
