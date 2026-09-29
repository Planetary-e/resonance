/** Shared bounded entry queue, used independently for requests and replies. */
import { randomInt } from 'node:crypto';

export interface PrivateEntryMixOptions {
  windowMs?: number;
  maxBatchSize?: number;
  maxConcurrent?: number;
  capacity?: number;
  maxBytes?: number;
  maxWaitMs?: number;
}

interface Entry {
  bytes: number;
  expiresAt: number;
  controller: AbortController;
  start(): void;
  reject(error: Error): void;
  dispose(): void;
  timer?: ReturnType<typeof setTimeout>;
  done: boolean;
}

export function createPrivateEntryMix(options: PrivateEntryMixOptions = {}) {
  const windowMs = bounded(options.windowMs ?? 750, 10, 2_000);
  const maxBatchSize = bounded(options.maxBatchSize ?? 16, 1, 64);
  const maxConcurrent = bounded(options.maxConcurrent ?? 16, 1, 64);
  const capacity = bounded(options.capacity ?? 64, 1, 256);
  const maxBytes = bounded(options.maxBytes ?? 8 * 1024 * 1024, 1, 64 * 1024 * 1024);
  const maxWaitMs = bounded(options.maxWaitMs ?? 3_000, windowMs + 1, 5_000);
  const pending: Entry[] = [];
  const all = new Set<Entry>();
  const running = new Set<Entry>();
  let bytesHeld = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function arm(): void {
    if (timer || !pending.length || running.size >= maxConcurrent) return;
    timer = setTimeout(flush, windowMs);
  }
  function remove(entry: Entry): void {
    entry.done = true;
    clearTimeout(entry.timer);
    entry.dispose();
    all.delete(entry);
    running.delete(entry);
    bytesHeld -= entry.bytes;
    const index = pending.indexOf(entry);
    if (index >= 0) pending.splice(index, 1);
    if (!pending.length) { clearTimeout(timer); timer = undefined; }
    arm();
  }
  function fail(entry: Entry, error: Error): void {
    if (entry.done) return;
    remove(entry);
    entry.reject(error);
    entry.controller.abort(error);
  }
  function flush(): void {
    timer = undefined;
    const batch = pending.splice(0, Math.min(maxBatchSize, maxConcurrent - running.size));
    for (let index = batch.length - 1; index > 0; index--) {
      const swap = randomInt(index + 1);
      [batch[index], batch[swap]] = [batch[swap], batch[index]];
    }
    for (const entry of batch) {
      if (entry.expiresAt - Date.now() <= 1_000) {
        fail(entry, new Error('Private mix request is too close to expiry'));
        continue;
      }
      clearTimeout(entry.timer);
      running.add(entry);
      entry.timer = setTimeout(() => fail(entry, new Error('Private mix request expired')),
        entry.expiresAt - Date.now());
      entry.start();
    }
    arm();
  }

  return {
    schedule<T>(input: { bytes: number; expiresAt: number; signal: AbortSignal },
      work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (input.signal.aborted) return Promise.reject(new Error('Private mix request cancelled'));
      if (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || !Number.isSafeInteger(input.expiresAt)) {
        return Promise.reject(new Error('Invalid private mix input'));
      }
      if (all.size >= capacity || input.bytes > maxBytes - bytesHeld) {
        return Promise.reject(new Error('Private mix capacity exhausted'));
      }
      const wait = Math.min(maxWaitMs, input.expiresAt - Date.now() - 1_000);
      if (wait <= windowMs) return Promise.reject(new Error('Private mix request is too close to expiry'));
      return new Promise<T>((resolve, reject) => {
        const cancel = () => fail(entry, new Error('Private mix request cancelled'));
        const entry: Entry = {
          bytes: input.bytes, expiresAt: input.expiresAt, controller: new AbortController(), done: false, reject,
          dispose() { input.signal.removeEventListener('abort', cancel); },
          start() {
            void Promise.resolve().then(() => {
              entry.controller.signal.throwIfAborted();
              return work(entry.controller.signal);
            }).then(value => {
              if (entry.done) return;
              remove(entry); resolve(value);
            }, error => fail(entry, error instanceof Error ? error : new Error(String(error))));
          },
        };
        all.add(entry); pending.push(entry); bytesHeld += entry.bytes;
        input.signal.addEventListener('abort', cancel, { once: true });
        entry.timer = setTimeout(() => fail(entry, new Error('Private mix queue wait expired')), wait);
        arm();
      });
    },
    cancelAll(): void {
      for (const entry of [...all]) fail(entry, new Error('Private mix stopped'));
      clearTimeout(timer); timer = undefined; arm();
    },
  };
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('Invalid private mix limits');
  return value;
}
