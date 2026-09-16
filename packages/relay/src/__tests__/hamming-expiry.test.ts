import { describe, expect, it } from 'vitest';
import { ComplementaryHammingIndex } from '../hamming-index.js';

describe('publication expiry in the Hamming index', () => {
  it('excludes each expired publication before result limiting and removes it independently', () => {
    const now = Date.now();
    const index = new ComplementaryHammingIndex();
    const hash = new Uint8Array(64).fill(0xa5);
    index.addHash(hash, {
      did: 'expired', itemId: 'expired', itemType: 'offer', scope: 'group', expiresAt: now - 1,
    });
    index.addHash(hash, {
      did: 'active', itemId: 'active', itemType: 'offer', scope: 'group', expiresAt: now + 60_000,
    });

    expect(index.search(hash, 'need', 1, 0.7, 'group').map(result => result.metadata.did))
      .toEqual(['active']);
    expect(index.getCount().total).toBe(2);
    expect(index.expireAtOrBefore(now)).toBe(1);
    expect(index.getCount().total).toBe(1);
  });

  it('keeps legacy entries without a signed expiry for non-v2 benchmarks', () => {
    const index = new ComplementaryHammingIndex();
    const hash = new Uint8Array(64);
    index.addHash(hash, { did: 'legacy', itemId: 'legacy', itemType: 'offer' });
    expect(index.expireAtOrBefore(Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(index.search(hash, 'need', 1, 0)).toHaveLength(1);
  });
});
