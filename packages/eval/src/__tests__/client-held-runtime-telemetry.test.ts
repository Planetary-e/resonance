import { describe, expect, it } from 'vitest';
import {
  memorySample,
  RpcTelemetry,
  RuntimeTelemetry,
} from '../client-held-runtime-telemetry.js';

describe('client-held runtime telemetry', () => {
  it('tracks RPC occupancy and bounds retained completion history', async () => {
    const telemetry = new RpcTelemetry();
    const releases: Array<() => void> = [];
    const operations = [0, 1].map(() => telemetry.measure(0, 'publish', () => (
      new Promise<void>(resolve => { releases.push(resolve); })
    )));
    await Promise.resolve();
    expect(telemetry.snapshot(0)).toMatchObject({
      active: { '0:publish': 2 },
      maximumActive: { '0:publish': 2 },
    });
    for (const release of releases.splice(0)) release();
    await Promise.all(operations);
    for (let index = 0; index < 300; index++) await telemetry.measure(0, 'publish', async () => {});
    const snapshot = telemetry.snapshot(0);
    expect(snapshot.active['0:publish']).toBe(0);
    expect(snapshot.maximumActive['0:publish']).toBe(2);
    expect(snapshot.totals['0:publish']!.count).toBe(302);
    expect(snapshot.completed).toHaveLength(256);
    expect(snapshot.completed.every(entry => entry.relayIndex === 0 && entry.phase === 'publish')).toBe(true);
  });

  it('exposes built-in event-loop and bounded GC telemetry without forcing collection', () => {
    const telemetry = new RuntimeTelemetry();
    const sample = telemetry.sample();
    telemetry.stop();
    expect(sample.eventLoopDelay.meanMs).toBeGreaterThanOrEqual(0);
    expect(sample.eventLoopDelay.p95Ms).toBeGreaterThanOrEqual(0);
    expect(sample.gc.entries.length).toBeLessThanOrEqual(128);
    expect(sample.gc.count).toBeGreaterThanOrEqual(sample.gc.entries.length);
    expect(memorySample()).toMatchObject({
      rssBytes: expect.any(Number),
      heapUsedBytes: expect.any(Number),
      heapTotalBytes: expect.any(Number),
      externalBytes: expect.any(Number),
      arrayBuffersBytes: expect.any(Number),
    });
  });
});
