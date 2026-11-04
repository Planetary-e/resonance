import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import { createPrivateTrafficScheduler } from '../private-traffic-scheduler.js';

vi.mock('node:crypto', () => ({ randomInt: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(randomInt).mockImplementation(((maximum: number) => maximum - 1) as typeof randomInt);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('private traffic scheduling', () => {
  it('honors an already aborted operation and detaches its listener after success', async () => {
    const scheduler = createPrivateTrafficScheduler({ batchWindowMs: 10, jitterMs: 0 });
    const cancelled = new AbortController();
    const reason = new Error('Operation deadline');
    cancelled.abort(reason);
    const work = vi.fn(async () => 'done');
    await expect(scheduler.schedule(work, cancelled.signal)).rejects.toBe(reason);
    expect(work).not.toHaveBeenCalled();
    const active = new AbortController();
    const remove = vi.spyOn(active.signal, 'removeEventListener');
    const result = scheduler.schedule(work, active.signal);
    await vi.advanceTimersByTimeAsync(11);
    expect(await result).toBe('done');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('collects a batch before release and applies bounded jitter before starting work', async () => {
    const scheduler = createPrivateTrafficScheduler({ batchWindowMs: 100, jitterMs: 100 });
    const calls: number[] = [];
    const first = scheduler.schedule(async () => { calls.push(1); return 'first'; });
    await vi.advanceTimersByTimeAsync(50);
    const second = scheduler.schedule(async () => { calls.push(2); return 'second'; });
    await vi.advanceTimersByTimeAsync(149);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([1, 2]);
    expect(await Promise.all([first, second])).toEqual(['first', 'second']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shuffles release order without changing which result belongs to each caller', async () => {
    vi.mocked(randomInt).mockImplementation((() => 0) as typeof randomInt);
    const scheduler = createPrivateTrafficScheduler({ batchWindowMs: 100, jitterMs: 0 });
    const calls: number[] = [];
    const requests = [1, 2, 3].map(id => scheduler.schedule(async () => { calls.push(id); return id; }));
    await vi.advanceTimersByTimeAsync(101);
    expect(calls).toEqual([2, 3, 1]);
    expect(await Promise.all(requests)).toEqual([1, 2, 3]);
  });

  it('bounds outstanding work and expires queued work while the active slot is occupied', async () => {
    const scheduler = createPrivateTrafficScheduler({
      batchWindowMs: 100, jitterMs: 0, capacity: 2, maxConcurrent: 1, maxQueueWaitMs: 500,
    });
    let finishActive!: (value: string) => void;
    const active = scheduler.schedule(() => new Promise<string>(resolve => { finishActive = resolve; }));
    const waiting = scheduler.schedule(async () => { throw new Error('must not start'); });
    const expired = expect(waiting).rejects.toThrow('wait expired');
    await expect(scheduler.schedule(async () => 'overflow')).rejects.toThrow('queue is full');
    await vi.advanceTimersByTimeAsync(501);
    await expired;
    finishActive('done');
    expect(await active).toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('limits release batches even when more concurrent slots are available', async () => {
    const scheduler = createPrivateTrafficScheduler({
      batchWindowMs: 100, jitterMs: 0, maxBatchSize: 1, maxConcurrent: 4,
    });
    const calls: number[] = [];
    const requests = [1, 2, 3].map(id => scheduler.schedule(async () => { calls.push(id); }));
    await vi.advanceTimersByTimeAsync(101);
    expect(calls).toEqual([1]);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(requests);
    expect(calls).toEqual([1, 2, 3]);
  });

  it('cancels pending and active requests, aborts active work, and accepts fresh work afterward', async () => {
    const scheduler = createPrivateTrafficScheduler({ batchWindowMs: 100, jitterMs: 0, maxConcurrent: 1 });
    let signal: AbortSignal | undefined;
    const active = scheduler.schedule(next => { signal = next; return new Promise(() => {}); });
    const pendingWork = vi.fn(async () => 'never');
    const pending = scheduler.schedule(pendingWork);
    const outcomes = Promise.allSettled([active, pending]);
    await vi.advanceTimersByTimeAsync(101);
    scheduler.cancelAll();
    expect(signal?.aborted).toBe(true);
    expect((await outcomes).every(result => result.status === 'rejected')).toBe(true);
    expect(pendingWork).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const fresh = scheduler.schedule(async () => 'fresh');
    await vi.advanceTimersByTimeAsync(101);
    expect(await fresh).toBe('fresh');
  });
});
