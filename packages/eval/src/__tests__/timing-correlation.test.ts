import { describe, expect, it } from 'vitest';
import { pairByTimestamp, scoreTimingCorrelation } from '../timing-correlation.js';

describe('timestamp-only observer', () => {
  it('matches preserved temporal order even when input arrays arrive in another order', () => {
    expect(pairByTimestamp([30, 10, 20], [120, 130, 110])).toEqual([2, 0, 1]);
    expect(scoreTimingCorrelation(
      [{ truth: 'c', atMs: 30 }, { truth: 'a', atMs: 10 }, { truth: 'b', atMs: 20 }],
      [{ truth: 'b', atMs: 120 }, { truth: 'c', atMs: 130 }, { truth: 'a', atMs: 110 }],
    )).toEqual({ correct: 3, total: 3, accuracy: 1, randomPairingAccuracy: 1 / 3 });
  });

  it('loses matches when transit reorders events; truth labels do not change its guesses', () => {
    expect(scoreTimingCorrelation(
      [{ truth: 'a', atMs: 10 }, { truth: 'b', atMs: 20 }, { truth: 'c', atMs: 30 }],
      [{ truth: 'b', atMs: 110 }, { truth: 'c', atMs: 120 }, { truth: 'a', atMs: 130 }],
    ).correct).toBe(0);
    expect(scoreTimingCorrelation(
      [{ truth: 'a', atMs: 10 }, { truth: 'b', atMs: 20 }, { truth: 'c', atMs: 30 }],
      [{ truth: 'a', atMs: 110 }, { truth: 'b', atMs: 120 }, { truth: 'c', atMs: 130 }],
    ).correct).toBe(3);
  });

  it('rejects incomplete traces instead of excluding failed observations from the denominator', () => {
    expect(() => pairByTimestamp([1, 2], [3])).toThrow();
    expect(() => pairByTimestamp([NaN], [3])).toThrow();
    expect(() => scoreTimingCorrelation([{ truth: 'a', atMs: 1 }], [{ truth: 'b', atMs: 2 }])).toThrow();
    expect(() => scoreTimingCorrelation(
      [{ truth: 'a', atMs: 1 }, { truth: 'a', atMs: 2 }],
      [{ truth: 'a', atMs: 3 }, { truth: 'a', atMs: 4 }],
    )).toThrow();
  });
});
