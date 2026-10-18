/** Serialize a protected owner's spend transaction, including policy observation,
 * witness authorization and journal commit. Call only after token verification. */
export function createAdmissionDecisionQueue(options: { timeoutMs?: number; maximumOperations?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 3000, maximumOperations = options.maximumOperations ?? 8;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000
    || !Number.isSafeInteger(maximumOperations) || maximumOperations < 1 || maximumOperations > 8) {
    throw new Error('Invalid admission decision queue bounds');
  }
  const jobs = new Set<{ abort(): void; drained: Promise<void> }>();
  let closed = false, tail = Promise.resolve();
  return {
    health: () => ({ operations: jobs.size, maximumOperations }),
    run<T>(operation: (assertLive: () => void, signal: AbortSignal) => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error('Admission decision queue is closed'));
      if (jobs.size >= maximumOperations) return Promise.reject(new Error('Admission decision queue capacity exhausted'));
      const began = performance.now(), issuedAt = Date.now(), controller = new AbortController();
      const assertLive = () => {
        if (closed || controller.signal.aborted || performance.now() - began >= timeoutMs
          || Date.now() < issuedAt || Date.now() >= issuedAt + timeoutMs) throw new Error('Admission decision cancelled or timed out');
      };
      let rejectCancelled!: (reason: Error) => void;
      const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
      const abort = () => { controller.abort(); rejectCancelled(new Error('Admission decision cancelled or timed out')); };
      const job = { abort, drained: Promise.resolve() }; jobs.add(job);
      const timer = setTimeout(abort, timeoutMs);
      const work = tail.then(async () => {
        assertLive(); const value = await operation(assertLive, controller.signal); assertLive(); return value;
      }).finally(() => { clearTimeout(timer); controller.abort(); jobs.delete(job); });
      // Timeout may return to the caller before an uncooperative transport
      // settles. Keep its slot charged and the writer serialized until it does.
      job.drained = tail = work.then(() => {}, () => {});
      return Promise.race([work, cancelled]);
    },
    close(): Promise<void> {
      closed = true; const pending = [...jobs]; pending.forEach(job => job.abort());
      return Promise.all(pending.map(job => job.drained)).then(() => {});
    },
  };
}
