import { describe, expect, it } from 'vitest';
import {
  attemptsInFixedWindow,
  fixedWindowRetryDelayMs,
  FixedWindowOfferScheduler,
  quietWindowRetryDelayMs,
  waitForFixedWindowRetryCapacity,
  waitForQuietWindowRetryCapacity,
  type FixedWindowAttempt,
} from '../client-held-retry-capacity.js';

const bucket = 'loopback:127.0.0.1';
function attempts(first: number[], second: number[], secondBucket = bucket): FixedWindowAttempt[] {
  return [
    ...first.map(timestamp => ({ bucket, timestamp })),
    ...second.map(timestamp => ({ bucket: secondBucket, timestamp })),
  ];
}

describe('client-held exact-retry fixed-window capacity', () => {
  it('aggregates both coordinators in the shared source-IP bucket', () => {
    const shared = attempts([0, 2_000, 4_000, 6_000, 8_000], [1_000, 3_000, 5_000, 7_000, 9_000]);
    expect(fixedWindowRetryDelayMs(shared, bucket, 30_000)).toBe(30_000);
    expect(attemptsInFixedWindow(shared, bucket, 30_000)).toHaveLength(10);
  });

  it('uses the actual fixed-window reset boundary rather than failing at capacity', () => {
    const shared = attempts([0, 1_000, 2_000, 3_000, 4_000], [500, 1_500, 2_500, 3_500, 4_500]);
    expect(fixedWindowRetryDelayMs(shared, bucket, 59_999)).toBe(1);
    expect(fixedWindowRetryDelayMs(shared, bucket, 60_000)).toBe(1);
    expect(fixedWindowRetryDelayMs(shared, bucket, 60_001)).toBe(0);
    expect(attemptsInFixedWindow(shared, bucket, 60_001)).toHaveLength(0);
  });

  it('leaves capacity available below ten attempts and does not conflate independent buckets', () => {
    const available = attempts([0, 1_000, 2_000, 3_000], [500, 1_500, 2_500, 3_500, 4_500]);
    expect(fixedWindowRetryDelayMs(available, bucket, 10_000)).toBe(0);
    const other = attempts(
      [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000],
      [500, 1_500, 2_500, 3_500, 4_500],
      'loopback:other',
    );
    expect(fixedWindowRetryDelayMs(other, bucket, 30_000)).toBe(30_000);
    expect(fixedWindowRetryDelayMs(other, 'loopback:other', 30_000)).toBe(0);
  });

  it('uses staggered relay-specific quiet windows and waits for every relay', async () => {
    const staggered: FixedWindowAttempt[] = [
      { bucket: `${bucket}:relay-0`, timestamp: 0 },
      { bucket: `${bucket}:relay-0`, timestamp: 10_000 },
      { bucket: `${bucket}:relay-1`, timestamp: 5_000 },
      { bucket: `${bucket}:relay-1`, timestamp: 15_000 },
    ];
    expect(quietWindowRetryDelayMs(staggered, `${bucket}:relay-0`, 30_000)).toBe(40_000);
    expect(quietWindowRetryDelayMs(staggered, `${bucket}:relay-1`, 30_000)).toBe(45_000);
    const now = Date.now();
    const actual = [
      { bucket: `${bucket}:relay-0`, timestamp: now - 5 },
      { bucket: `${bucket}:relay-1`, timestamp: now - 2 },
    ];
    const waits = await Promise.all([0, 1].map(relayIndex => waitForQuietWindowRetryCapacity(
      actual, `${bucket}:relay-${relayIndex}`, { windowMs: 10 },
    )));
    expect(waits).toHaveLength(2);
    expect(waits.every(wait => wait >= 0)).toBe(true);
    expect(quietWindowRetryDelayMs(actual, `${bucket}:relay-0`, Date.now(), { windowMs: 10 })).toBe(0);
    expect(quietWindowRetryDelayMs(actual, `${bucket}:relay-1`, Date.now(), { windowMs: 10 })).toBe(0);
  });

  it('does not infer capacity from a later request when the first relay request is missing', () => {
    const missingFirst: FixedWindowAttempt[] = [
      { bucket: `${bucket}:relay-1`, timestamp: 50_000 },
    ];
    expect(attemptsInFixedWindow(missingFirst, `${bucket}:relay-1`, 60_000)).toHaveLength(1);
    expect(quietWindowRetryDelayMs(missingFirst, `${bucket}:relay-1`, 60_000)).toBe(50_000);
    expect(quietWindowRetryDelayMs(missingFirst, `${bucket}:relay-1`, 110_000)).toBe(1);
    expect(quietWindowRetryDelayMs(missingFirst, `${bucket}:relay-1`, 110_001)).toBe(0);
  });

  it('waits for a short real reset and then reports available capacity', async () => {
    const now = Date.now();
    const shared = attempts([now], [now]);
    const waited = await waitForFixedWindowRetryCapacity(shared, bucket, { limit: 2, windowMs: 10 });
    expect(waited).toBeGreaterThanOrEqual(0);
    expect(fixedWindowRetryDelayMs(shared, bucket, Date.now(), { limit: 2, windowMs: 10 })).toBe(0);
  });

  it('serializes concurrent coordinators without overfilling any relay source bucket', async () => {
    const scheduler = new FixedWindowOfferScheduler({ limit: 2, windowMs: 20 });
    const buckets = [`${bucket}:relay-0`, `${bucket}:relay-1`];
    const scheduled = await Promise.all(Array.from({ length: 6 }, async () => {
      const offer = await scheduler.schedule(buckets);
      offer.complete();
      return offer;
    }));
    const reservations = scheduler.snapshot();
    expect(reservations).toHaveLength(12);
    for (const relayBucket of buckets) {
      const selected = reservations.filter(attempt => attempt.bucket === relayBucket);
      expect(selected).toHaveLength(6);
      for (let index = 0; index < selected.length; index++) {
        expect(attemptsInFixedWindow(
          selected.slice(0, index + 1), relayBucket, scheduled[index].scheduledAt,
          { limit: 2, windowMs: 20 },
        ).length).toBeLessThanOrEqual(2);
      }
    }
    expect(scheduled.some(value => value.waitedMs > 0)).toBe(true);
  });

  it('holds a full source window until its in-flight offered publish completes', async () => {
    const scheduler = new FixedWindowOfferScheduler({ limit: 1, windowMs: 20 });
    const first = await scheduler.schedule([bucket]);
    let secondScheduled = false;
    const secondPromise = scheduler.schedule([bucket]).then(offer => {
      secondScheduled = true;
      offer.complete();
      return offer;
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(secondScheduled).toBe(false);
    expect(scheduler.snapshot()).toHaveLength(1);
    first.complete();
    await secondPromise;
    expect(scheduler.snapshot()).toHaveLength(2);
  });
});
