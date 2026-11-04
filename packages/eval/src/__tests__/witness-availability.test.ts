import { expect, it } from 'vitest';
import { independentQuorumProbability, independentTrace, scheduledTrace, summarizeAvailability } from '../witness-availability.js';

it('matches exhaustive enumeration of five independent witnesses and a withheld witness', () => {
  for (const p of [0, 0.25, 0.5, 0.75, 0.9, 1]) {
    let enumerated = 0;
    for (let mask = 0; mask < 32; mask++) {
      const count = mask.toString(2).replaceAll('0', '').length;
      if (count >= 4) enumerated += p ** count * (1 - p) ** (5 - count);
    }
    expect(independentQuorumProbability(p)).toBeCloseTo(enumerated, 12);
    expect(independentQuorumProbability(p, 1)).toBe(p ** 4);
    expect(independentQuorumProbability(p, 2)).toBe(0);
  }
  expect(() => independentQuorumProbability(1.1)).toThrow();
});

it('is reproducible and distinguishes no quorum from cached-certificate semantics', () => {
  expect(independentTrace(0.75, 100, 42)).toEqual(independentTrace(0.75, 100, 42));
  expect(independentTrace(0.75, 100, 42)).not.toEqual(independentTrace(0.75, 100, 43));
  for (const p of [0, 1]) {
    const [row] = summarizeAvailability(independentTrace(p, 32, 42), 20);
    expect(row.availability).toBe(p);
    expect(row.acceptedWaitP95Minutes).toBe(p ? 0 : null);
  }
});

it('requires simultaneous votes, includes the retry deadline, and retains failures in denominators', () => {
  const trace = [
    [true, true, true, false, false],
    [false, false, false, true, true],
    [true, true, true, true, false],
    [false, false, false, false, false],
  ];
  const rows = summarizeAvailability(trace, 2, [0, 5, 10]);
  expect(rows.map(row => row.accepted)).toEqual([0, 1, 2]);
  expect(rows.map(row => row.refused)).toEqual([2, 1, 0]);
  expect(rows[2].acceptedWaitP95Minutes).toBe(10);
  expect(() => summarizeAvailability(trace.slice(0, 3), 2, [10])).toThrow('tail');
});

it('exposes correlated schedules and the lack of four-way overlap across staggered desktops', () => {
  const steps = 288 * 3 + 12;
  const shared = summarizeAvailability(scheduledTrace([17, 17, 17, 17, 17], steps), 288 * 3);
  expect(shared[0].availability).toBeCloseTo(1 / 3, 12);
  expect(shared[2].availability).toBeCloseTo(9 / 24, 12);
  const staggered = summarizeAvailability(scheduledTrace([0, 5, 10, 15, 20], steps), 288 * 3);
  expect(staggered.every(row => row.accepted === 0 && row.acceptedWaitP50Minutes === null)).toBe(true);
});
