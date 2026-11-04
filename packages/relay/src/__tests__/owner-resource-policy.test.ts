import { describe, expect, it } from 'vitest';
import { OwnerResourcePolicy } from '../owner-resource-policy.js';

describe('owner discretionary-work limits', () => {
  it('stops new admissions at the byte or CPU budget and resumes after each window', () => {
    let now = new Date(2026, 8, 23, 10, 0).getTime();
    let cpuMicros = 0;
    const policy = new OwnerResourcePolicy({
      maxNewWorkIngressBytesPerHour: 100,
      maxCpuMillisecondsPerMinute: 5,
      now: () => now,
      cpuMicros: () => cpuMicros,
    });
    expect(policy.allowNewWork(60)).toBe(true);
    expect(policy.allowNewWork(41)).toBe(false);
    cpuMicros = 5_000;
    expect(policy.allowNewWork(1)).toBe(false);
    now += 60_000;
    expect(policy.allowNewWork(40)).toBe(true);
    expect(policy.allowNewWork(1)).toBe(false);
    now += 3_600_000;
    expect(policy.allowNewWork(100)).toBe(true);
  });

  it('limits new work to an overnight schedule and external power', () => {
    const date = new Date(2026, 8, 23, 23, 30);
    let externalPower = false;
    const policy = new OwnerResourcePolicy({
      activeHours: '22:00-06:00', requireExternalPower: true,
      now: () => date.getTime(), externalPower: () => externalPower,
    });
    expect(policy.allowNewWork(1)).toBe(false);
    externalPower = true;
    expect(policy.allowNewWork(1)).toBe(true);
    date.setHours(12, 0);
    expect(policy.allowNewWork(1)).toBe(false);
    expect(() => new OwnerResourcePolicy({ activeHours: '25:00-26:00' })).toThrow();
  });

  it('retains total traffic, CPU and ingress windows across a restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-owner-budget-'));
    let now = new Date(2026, 8, 23, 10, 0).getTime();
    let cpuMicros = 100_000;
    let totalBandwidthBytes = 1_000;
    const makePolicy = () => new OwnerResourcePolicy({
      maxNewWorkIngressBytesPerHour: 50,
      maxTotalBandwidthBytesPerHour: 100,
      maxCpuMillisecondsPerMinute: 5,
      now: () => now,
      cpuMicros: () => cpuMicros,
      totalBandwidthBytes: () => totalBandwidthBytes,
      persistDir: directory,
    });
    try {
      const first = makePolicy();
      expect(first.allowNewWork(40)).toBe(true);
      totalBandwidthBytes += 95; // Accepted work, repairs and LAN beacons all count.
      expect(makePolicy().allowNewWork(1)).toBe(true);
      now += 60_000;
      expect(makePolicy().allowNewWork(9)).toBe(true);
      expect(makePolicy().allowNewWork(1)).toBe(false); // Ingress window persisted.
      totalBandwidthBytes += 6;
      expect(makePolicy().allowNewWork(0)).toBe(false);
      now += 3_600_000;
      cpuMicros += 5_000;
      expect(makePolicy().allowNewWork(50)).toBe(true);
      cpuMicros += 5_000;
      expect(makePolicy().allowNewWork(0)).toBe(false);
      now += 60_000;
      expect(makePolicy().allowNewWork(0)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
