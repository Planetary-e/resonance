import { afterEach, expect, it, vi } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createAdmissionDecisionQueue } from '../admission-decision-queue.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(options: Parameters<typeof createAdmissionDecisionQueue>[0] = {}) {
  const queue = createAdmissionDecisionQueue(options); cleanup.push(() => queue.close()); return queue;
}
function preparedRun<P, T>(queue: ReturnType<typeof createAdmissionDecisionQueue>,
  prepare: (live: () => void, signal: AbortSignal) => Promise<P>,
  operation: (prepared: P, live: () => void, signal: AbortSignal) => Promise<T>) {
  return queue.runPrepared((live, signal) => {
    const ready = prepare(live, signal); return { ready, drained: ready.then(() => {}, () => {}) };
  }, operation);
}
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); cleanup.push(release); return { promise, release }; }

it('overlaps only one FIFO preparation with the preceding writer and preserves writer order', async () => {
  const queue = fixture(), firstPrepare = held(), secondPrepare = held(), thirdPrepare = held(), firstWriter = held();
  const events: string[] = []; let preparing = 0, writing = 0, peakPreparing = 0, peakWriting = 0;
  const jobs = [firstPrepare, secondPrepare, thirdPrepare].map((gate, i) => preparedRun(queue, async (live, signal) => {
    live(); expect(signal.aborted).toBe(false); peakPreparing = Math.max(peakPreparing, ++preparing); events.push(`prepare${i}`);
    await gate.promise; live(); preparing--; return `prepared${i}`;
  }, async (prepared, live) => {
    live(); expect(prepared).toBe(`prepared${i}`); peakWriting = Math.max(peakWriting, ++writing); events.push(`write${i}`);
    if (!i) await firstWriter.promise; live(); writing--; return i;
  }));
  await nextTurn(); expect(events).toEqual(['prepare0']); firstPrepare.release(); await nextTurn();
  expect(events).toEqual(['prepare0', 'write0', 'prepare1']);
  secondPrepare.release(); await nextTurn(); expect(events).toEqual(['prepare0', 'write0', 'prepare1', 'prepare2']);
  thirdPrepare.release(); await nextTurn(); expect(events.filter(event => event.startsWith('write'))).toEqual(['write0']);
  firstWriter.release(); expect(await Promise.all(jobs)).toEqual([0, 1, 2]);
  expect(events.filter(event => event.startsWith('write'))).toEqual(['write0', 'write1', 'write2']);
  expect(peakPreparing).toBe(1); expect(peakWriting).toBe(1); await nextTurn(); expect(queue.health().operations).toBe(0);
});

it('shares the same eight intake slots and FIFO writer lane between run and runPrepared', async () => {
  const queue = fixture(), writer = held(), preparation = held(), events: string[] = [];
  const jobs: Promise<number>[] = [queue.run(async () => { events.push('write0'); await writer.promise; return 0; })];
  jobs.push(preparedRun(queue, async () => { events.push('prepare1'); await preparation.promise; return 1; }, async value => { events.push('write1'); return value; }));
  for (let i = 2; i < 8; i++) jobs.push(i % 2 ? preparedRun(queue, async () => i, async value => { events.push(`write${i}`); return value; })
    : queue.run(async () => { events.push(`write${i}`); return i; }));
  expect(queue.health()).toEqual({ operations: 8, maximumOperations: 8 });
  const forbidden = vi.fn(async () => 9);
  await expect(queue.run(forbidden)).rejects.toThrow('capacity');
  await expect(preparedRun(queue, forbidden, async value => value)).rejects.toThrow('capacity');
  expect(forbidden).not.toHaveBeenCalled(); await nextTurn(); expect(events).toEqual(['write0', 'prepare1']);
  preparation.release(); writer.release(); expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(events.filter(event => event.startsWith('write'))).toEqual(Array.from({ length: 8 }, (_, i) => `write${i}`));
  await nextTurn(); expect(queue.health().operations).toBe(0);
});

it('observes a preparation failure promptly behind a held writer and recovers each lane without starting its operation', async () => {
  const queue = fixture(), writer = held(), operation = vi.fn(async () => 'forbidden');
  const first = queue.run(async () => { await writer.promise; return 'first'; });
  const failed = preparedRun(queue, async () => { throw new Error('preparation unavailable'); }, operation);
  await expect(failed).rejects.toThrow('preparation unavailable'); expect(queue.health().operations).toBe(2);
  let laterPrepared = false;
  const later = preparedRun(queue, async () => { laterPrepared = true; return 'later'; }, async value => value);
  await nextTurn(); expect(laterPrepared).toBe(true); expect(operation).not.toHaveBeenCalled();
  writer.release(); expect(await first).toBe('first'); expect(await later).toBe('later'); await nextTurn(); expect(queue.health().operations).toBe(0);
});

it.each(['resolve', 'reject'] as const)('retains an expired ignored-abort preparation until it actually %ss even after its writer turn arrives', async settlement => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); vi.spyOn(Date, 'now').mockReturnValue(1000);
  const queue = fixture({ timeoutMs: 50, maximumOperations: 3 }), writer = held(), preparation = held();
  let laterPrepared = false; const operation = vi.fn(async () => 'forbidden');
  const first = queue.run(async live => { await writer.promise; live(); });
  const second = preparedRun(queue, async () => { await preparation.promise; if (settlement === 'reject') throw new Error('late preparation failure'); return 2; }, operation);
  const third = preparedRun(queue, async () => { laterPrepared = true; return 3; }, operation);
  const refusals = [first, second, third].map(job => expect(job).rejects.toThrow('cancelled or timed out'));
  await nextTurn(); await vi.advanceTimersByTimeAsync(51); await Promise.all(refusals);
  expect(queue.health().operations).toBe(3); expect(laterPrepared).toBe(false);
  await expect(queue.run(async () => {})).rejects.toThrow('capacity');
  writer.release(); await nextTurn();
  expect(queue.health().operations).toBe(2); expect(laterPrepared).toBe(false); expect(operation).not.toHaveBeenCalled();
  let drained = false; const closing = queue.close().then(() => { drained = true; });
  await nextTurn(); expect(drained).toBe(false); expect(queue.health().operations).toBe(2);
  preparation.release(); await closing;
  expect(drained).toBe(true); expect(laterPrepared).toBe(false); expect(operation).not.toHaveBeenCalled(); await nextTurn(); expect(queue.health().operations).toBe(0);
});

it('does not reset the original controller or timer when a prepared job enters its writer turn', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); vi.spyOn(Date, 'now').mockReturnValue(1000);
  const queue = fixture({ timeoutMs: 50 }), firstWriter = held(), secondWriter = held();
  let originalSignal: AbortSignal | undefined, secondStarted = false;
  const first = queue.run(async () => { await firstWriter.promise; });
  const second = preparedRun(queue, async (_live, signal) => { originalSignal = signal; return 2; }, async (value, live, signal) => {
    expect(signal).toBe(originalSignal); expect(value).toBe(2); secondStarted = true; await secondWriter.promise; live();
  });
  const refusal = expect(second).rejects.toThrow('timed out'); await nextTurn();
  await vi.advanceTimersByTimeAsync(30); firstWriter.release(); await first; await nextTurn(); expect(secondStarted).toBe(true);
  await vi.advanceTimersByTimeAsync(21); await refusal; expect(originalSignal!.aborted).toBe(true); expect(queue.health().operations).toBe(1);
  secondWriter.release(); await nextTurn(); await nextTurn(); expect(queue.health().operations).toBe(0);
});

it('closes callers promptly while retaining a prepared operation that ignores cancellation and its queued successor', async () => {
  const queue = fixture(), blocked = held(), entered = held(), operation = vi.fn(async () => 'forbidden');
  const first = preparedRun(queue, async () => 1, async () => { entered.release(); await blocked.promise; return 'late'; });
  const second = preparedRun(queue, async () => 2, operation);
  const refusals = [first, second].map(job => expect(job).rejects.toThrow('cancelled')); await entered.promise;
  let drained = false; const closing = queue.close().then(() => { drained = true; }); await Promise.all(refusals); await nextTurn();
  expect(drained).toBe(false); expect(queue.health().operations).toBe(2); expect(operation).not.toHaveBeenCalled();
  await expect(preparedRun(queue, async () => 3, async value => value)).rejects.toThrow('closed');
  blocked.release(); await closing; await nextTurn(); expect(queue.health().operations).toBe(0); expect(operation).not.toHaveBeenCalled();
});

it.each([900, 4000])('rejects preparation and writer work after the original wall clock changes to %s', async changed => {
  const wall = vi.spyOn(Date, 'now').mockReturnValue(1000), queue = fixture(), preparation = held();
  const operation = vi.fn(async () => 'forbidden'), laterPrepare = vi.fn(async () => 2);
  const first = preparedRun(queue, async () => { await preparation.promise; return 1; }, operation);
  const second = preparedRun(queue, laterPrepare, operation);
  const refusals = [first, second].map(job => expect(job).rejects.toThrow('timed out'));
  await nextTurn(); wall.mockReturnValue(changed); preparation.release(); await Promise.all(refusals);
  await queue.close(); expect(laterPrepare).not.toHaveBeenCalled(); expect(operation).not.toHaveBeenCalled(); await nextTurn(); expect(queue.health().operations).toBe(0);
});

it('checks the original monotonic budget before starting the operation with a frozen wall clock', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const monotonic = performance.now.bind(performance); let elapsed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic() + elapsed);
  const queue = fixture(), blocked = held(), operation = vi.fn(async () => 'forbidden');
  const first = queue.run(async live => { await blocked.promise; live(); });
  const second = preparedRun(queue, async () => 'ready', operation);
  const refusals = [first, second].map(job => expect(job).rejects.toThrow('timed out'));
  await nextTurn(); elapsed = 3001; blocked.release(); await Promise.all(refusals);
  expect(operation).not.toHaveBeenCalled(); await nextTurn(); expect(queue.health().operations).toBe(0);
});


it('uses ready evidence before late transport drainage, returns the real result and retains its charged slot', async () => {
  const queue = fixture({ maximumOperations: 3 }), drain = held(), events: string[] = [];
  const first = queue.runPrepared(() => ({ ready: Promise.resolve('four fresh votes'), drained: drain.promise }),
    async evidence => { events.push('write1'); expect(evidence).toBe('four fresh votes'); return 'committed'; });
  expect(await first).toBe('committed'); expect(queue.health().operations).toBe(1);
  const second = queue.runPrepared(() => { events.push('prepare2'); return { ready: Promise.resolve(2), drained: Promise.resolve() }; },
    async value => { events.push('write2'); return value; });
  await nextTurn(); expect(events).toEqual(['write1']); expect(queue.health().operations).toBe(2);
  drain.release(); expect(await second).toBe(2); await nextTurn();
  expect(events).toEqual(['write1', 'prepare2', 'write2']); expect(queue.health().operations).toBe(0);
});

it('releases the writer while a successful preparation remains charged and close still waits for its drain', async () => {
  const queue = fixture(), drain = held();
  expect(await queue.runPrepared(() => ({ ready: Promise.resolve(1), drained: drain.promise }), async value => value)).toBe(1);
  expect(await queue.run(async () => 'next writer')).toBe('next writer'); expect(queue.health().operations).toBe(1);
  let closed = false; const closing = queue.close().then(() => { closed = true; }); await nextTurn(); expect(closed).toBe(false);
  drain.release(); await closing; expect(queue.health().operations).toBe(0);
});

it('normalizes an early drain so unresolved ready work blocks the next preparation and remains charged on close', async () => {
  const queue = fixture(), ready = held(), forbidden = vi.fn(async () => 2), laterPrepare = vi.fn(() => ({ ready: Promise.resolve(2), drained: Promise.resolve() }));
  const first = queue.runPrepared(() => ({ ready: ready.promise, drained: Promise.resolve() }), forbidden);
  const second = queue.runPrepared(laterPrepare, forbidden);
  const refusals = [first, second].map(job => expect(job).rejects.toThrow('cancelled'));
  await nextTurn(); expect(laterPrepare).not.toHaveBeenCalled();
  let closed = false; const closing = queue.close().then(() => { closed = true; }); await Promise.all(refusals); await nextTurn();
  expect(closed).toBe(false); expect(queue.health().operations).toBe(2); ready.release(); await closing;
  expect(laterPrepare).not.toHaveBeenCalled(); expect(forbidden).not.toHaveBeenCalled(); expect(queue.health().operations).toBe(0);
});

it('retains expired ready and drain work independently before a writer turn without starting a late operation', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); vi.spyOn(Date, 'now').mockReturnValue(1000);
  const queue = fixture({ timeoutMs: 50 }), writer = held(), ready = held(), drain = held();
  const operation = vi.fn(async () => 'forbidden'), laterPrepare = vi.fn(() => ({ ready: Promise.resolve(3), drained: Promise.resolve() }));
  const first = queue.run(async () => { await writer.promise; });
  const second = queue.runPrepared(() => ({ ready: ready.promise, drained: drain.promise }), operation);
  const third = queue.runPrepared(laterPrepare, operation);
  const refusals = [first, second, third].map(job => expect(job).rejects.toThrow('timed out'));
  await nextTurn(); await vi.advanceTimersByTimeAsync(51); await Promise.all(refusals);
  expect(queue.health().operations).toBe(3); writer.release(); await nextTurn(); expect(queue.health().operations).toBe(2);
  ready.release(); await nextTurn(); expect(queue.health().operations).toBe(2); expect(laterPrepare).not.toHaveBeenCalled();
  let closed = false; const closing = queue.close().then(() => { closed = true; }); await nextTurn(); expect(closed).toBe(false);
  drain.release(); await closing; expect(operation).not.toHaveBeenCalled(); expect(laterPrepare).not.toHaveBeenCalled(); expect(queue.health().operations).toBe(0);
});

it('observes rejected ready and drain promises immediately while their writer position is blocked', async () => {
  const queue = fixture(), writer = held(), operation = vi.fn(async () => 'forbidden');
  const first = queue.run(async () => { await writer.promise; });
  const second = queue.runPrepared(() => ({ ready: Promise.reject(new Error('no quorum')), drained: Promise.reject(new Error('transport ended')) }), operation);
  await expect(second).rejects.toThrow('no quorum'); await nextTurn(); expect(queue.health().operations).toBe(2);
  writer.release(); await first; await nextTurn(); expect(operation).not.toHaveBeenCalled(); expect(queue.health().operations).toBe(0);
});
