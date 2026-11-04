import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import { createPrivateEntryMix } from '../private-entry-mix.js';

vi.mock('node:crypto', () => ({ randomInt: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.mocked(randomInt).mockImplementation((() => 0) as typeof randomInt);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const input = (controller = new AbortController()) => ({ bytes: 100, expiresAt: 10_000, signal: controller.signal });

describe('shared private entry mix', () => {
  it('holds different clients through a window and releases a shuffled batch with correct replies', async () => {
    const mix = createPrivateEntryMix({ windowMs: 100 });
    const order: number[] = [];
    const requests = [1, 2, 3].map(id => mix.schedule(input(), async () => { order.push(id); return id; }));
    await vi.advanceTimersByTimeAsync(99);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual([2, 3, 1]);
    expect(await Promise.all(requests)).toEqual([1, 2, 3]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps held bytes including active work, and cancellation frees the allocation', async () => {
    const mix = createPrivateEntryMix({ windowMs: 100, maxBytes: 200 });
    const firstController = new AbortController();
    const first = mix.schedule(input(firstController), () => new Promise(() => {}));
    const firstOutcome = expect(first).rejects.toThrow('cancelled');
    const second = mix.schedule(input(), async () => 'second');
    await expect(mix.schedule(input(), async () => 'overflow')).rejects.toThrow('capacity');
    await vi.advanceTimersByTimeAsync(100);
    expect(await second).toBe('second');
    await expect(mix.schedule({ ...input(), bytes: 101 }, async () => 'too large')).rejects.toThrow('capacity');
    firstController.abort(); await firstOutcome;
    const recovered = mix.schedule({ ...input(), bytes: 200 }, async () => 'recovered');
    await vi.advanceTimersByTimeAsync(100);
    expect(await recovered).toBe('recovered');
  });

  it('enforces concurrent/count limits and expires waiting work without forwarding it', async () => {
    const mix = createPrivateEntryMix({ windowMs: 100, maxConcurrent: 1, maxWaitMs: 200, capacity: 2 });
    const active = mix.schedule(input(), () => new Promise(() => {}));
    const waitingWork = vi.fn(async () => {});
    const waiting = mix.schedule(input(), waitingWork);
    const outcomes = Promise.allSettled([active, waiting]);
    await expect(mix.schedule(input(), async () => {})).rejects.toThrow('capacity');
    await vi.advanceTimersByTimeAsync(201);
    expect(waitingWork).not.toHaveBeenCalled();
    mix.cancelAll();
    const result = await outcomes;
    expect(result[0].status).toBe('rejected');
    expect(result[1]).toMatchObject({ status: 'rejected', reason: new Error('Private mix queue wait expired') });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects expiring envelopes and aborts active work when its envelope expires', async () => {
    const mix = createPrivateEntryMix({ windowMs: 100 });
    await expect(mix.schedule({ ...input(), expiresAt: 1_100 }, async () => {})).rejects.toThrow('expiry');
    let activeSignal: AbortSignal | undefined;
    const active = mix.schedule({ ...input(), expiresAt: 1_500 }, signal => {
      activeSignal = signal; return new Promise(() => {});
    });
    const expired = expect(active).rejects.toThrow('expired');
    await vi.advanceTimersByTimeAsync(1_500);
    await expired;
    expect(activeSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never forwards cancelled waiting work and clears the queue on shutdown', async () => {
    const mix = createPrivateEntryMix({ windowMs: 100 });
    const controller = new AbortController();
    const work = vi.fn(async () => {});
    const cancelled = mix.schedule(input(controller), work);
    const stopped = mix.schedule(input(), work);
    const outcomes = Promise.allSettled([cancelled, stopped]);
    controller.abort(); mix.cancelAll();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await outcomes).every(result => result.status === 'rejected')).toBe(true);
    expect(work).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
