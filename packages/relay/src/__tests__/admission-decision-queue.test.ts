import { afterEach, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdmissionDecisionQueue } from '../admission-decision-queue.js';

afterEach(() => vi.restoreAllMocks());
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

it('serializes complete transactions and does not poison later work after a rejection', async () => {
  const queue = createAdmissionDecisionQueue(), blocked = held(), events: string[] = [];
  const first = queue.run(async assertLive => { events.push('start'); await blocked.promise; assertLive(); events.push('end'); throw new Error('injected'); });
  const failure = expect(first).rejects.toThrow('injected');
  const second = queue.run(async assertLive => { assertLive(); events.push('next'); return 2; });
  await delay(0); expect(events).toEqual(['start']); blocked.release(); await failure;
  expect(await second).toBe(2); expect(events).toEqual(['start', 'end', 'next']);
  expect(queue.health().operations).toBe(0); await queue.close();
});

it('expires queued work under a frozen wall clock and charges slots until ignored cancellation drains', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const queue = createAdmissionDecisionQueue({ timeoutMs: 50, maximumOperations: 2 }), blocked = held();
  const first = queue.run(async assertLive => { await blocked.promise; assertLive(); return 'late'; });
  const failure = expect(first).rejects.toThrow('timed out');
  let began = false;
  const second = queue.run(async () => { began = true; return 'must not start'; });
  const expired = expect(second).rejects.toThrow('timed out');
  await expect(queue.run(async () => 'overflow')).rejects.toThrow('capacity');
  await delay(70); await failure; await expired;
  expect(began).toBe(false); expect(queue.health().operations).toBe(2);
  await expect(queue.run(async () => 'still full')).rejects.toThrow('capacity');
  blocked.release(); await delay(0); expect(queue.health().operations).toBe(0);
  expect(await queue.run(async () => 'recovered')).toBe('recovered'); await queue.close();
});

it('cancels callers promptly on close while draining the active writer before completing shutdown', async () => {
  const queue = createAdmissionDecisionQueue(), blocked = held(); let secondStarted = false;
  const first = queue.run(async assertLive => { await blocked.promise; assertLive(); });
  const second = queue.run(async () => { secondStarted = true; });
  const firstFailure = expect(first).rejects.toThrow('cancelled'), secondFailure = expect(second).rejects.toThrow('cancelled');
  await delay(0); let drained = false; const closing = queue.close().then(() => { drained = true; });
  await firstFailure; await secondFailure; expect(drained).toBe(false); expect(secondStarted).toBe(false);
  await expect(queue.run(async () => {})).rejects.toThrow('closed');
  blocked.release(); await closing; expect(drained).toBe(true); expect(queue.health().operations).toBe(0);
});

it.each([900, 4000])('refuses queued work when the wall clock changes to %s', async time => {
  const wall = vi.spyOn(Date, 'now').mockReturnValue(1000), queue = createAdmissionDecisionQueue(), blocked = held();
  const first = queue.run(async () => { await blocked.promise; });
  const second = queue.run(async () => { throw new Error('must not start'); });
  const failures = Promise.all([expect(first).rejects.toThrow('timed out'), expect(second).rejects.toThrow('timed out')]);
  await delay(0); wall.mockReturnValue(time); blocked.release(); await failures; await queue.close();
});
