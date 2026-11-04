import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrivateOperation, PRIVATE_OPERATION_DEADLINE_MS } from '../private-operation.js';
import { createPrivateTrafficScheduler } from '../private-traffic-scheduler.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('shared private operation budget', () => {
  it('counts queueing and jitter, cancels stalled work, and leaves another operation running', async () => {
    const scheduler = createPrivateTrafficScheduler({ batchWindowMs: 1_000, jitterMs: 1_000 });
    const first = createPrivateOperation();
    let activeSignal: AbortSignal | undefined;
    const result = scheduler.schedule(signal => {
      activeSignal = signal;
      return new Promise(() => {}); // Native work need not cooperate for the caller to settle.
    }, first.signal);
    const expired = expect(result).rejects.toMatchObject({ code: 'PRIVATE_OPERATION_TIMEOUT', outcome: 'not-sent' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(activeSignal?.aborted).toBe(false);
    const second = createPrivateOperation();
    let resolveSecond!: (value: string) => void;
    const other = scheduler.schedule(() => new Promise<string>(resolve => { resolveSecond = resolve; }), second.signal);
    await vi.advanceTimersByTimeAsync(5_000);
    await expired;
    expect(activeSignal?.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    resolveSecond('ok');
    expect(await other).toBe('ok');
    first.dispose(); second.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes an expired queued operation before work or token reservation can start', async () => {
    const scheduler = createPrivateTrafficScheduler({ batchWindowMs: 10, jitterMs: 0, maxConcurrent: 1, maxQueueWaitMs: 10_000 });
    const blocker = scheduler.schedule(() => new Promise(() => {}));
    const blocked = expect(blocker).rejects.toThrow('disconnected');
    const operation = createPrivateOperation();
    const work = vi.fn(async () => 'must not start');
    const queued = expect(scheduler.schedule(work, operation.signal)).rejects.toMatchObject({
      code: 'PRIVATE_OPERATION_TIMEOUT', outcome: 'not-sent',
    });
    await vi.advanceTimersByTimeAsync(PRIVATE_OPERATION_DEADLINE_MS);
    await queued;
    expect(work).not.toHaveBeenCalled();
    scheduler.cancelAll(); await blocked; operation.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a new stage when elapsed time exceeds the budget even before the timer callback runs', () => {
    const operation = createPrivateOperation();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(PRIVATE_OPERATION_DEADLINE_MS + 1);
    try {
      expect(() => operation.check()).toThrow('ten-second deadline');
      expect(() => operation.markSent()).toThrow('ten-second deadline');
      expect(operation.signal.reason.outcome).toBe('not-sent');
    } finally { clock.mockRestore(); operation.dispose(); }
  });

  it('preserves uncertainty after sending, including a later fallback rejection', async () => {
    const operation = createPrivateOperation();
    operation.markSent();
    expect(operation.transportError(new Error('Connection lost'))).toMatchObject({ outcome: 'unknown' });
    expect(operation.failure(new Error('Other destination rejected request'))).toMatchObject({ outcome: 'unknown' });
    await vi.advanceTimersByTimeAsync(PRIVATE_OPERATION_DEADLINE_MS);
    expect(operation.signal.reason).toMatchObject({ code: 'PRIVATE_OPERATION_TIMEOUT', outcome: 'unknown' });
    operation.dispose();
  });
});
