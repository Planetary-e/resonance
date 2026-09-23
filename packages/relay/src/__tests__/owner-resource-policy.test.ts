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
});
