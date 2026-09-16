import { describe, it, expect, beforeEach } from 'vitest';
import { MatchingEngine } from '../matching-engine.js';

function randomHash(bytes = 64): Uint8Array {
  const hash = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) hash[i] = Math.floor(Math.random() * 256);
  return hash;
}

// Flip a small deterministic set of bits to keep Hamming similarity high.
function similarHash(base: Uint8Array, bitFlips = 8): Uint8Array {
  const hash = base.slice();
  for (let i = 0; i < bitFlips; i++) {
    const byte = i % hash.length;
    hash[byte] ^= 1 << (i % 8);
  }
  return hash;
}

describe('MatchingEngine', () => {
  let engine: MatchingEngine;

  beforeEach(() => {
    engine = new MatchingEngine();
    engine.initialize();
  });

  it('returns matches from complementary index', () => {
    const baseHash = randomHash();

    // Publish an offer
    engine.insertAndMatch(
      baseHash,
      { did: 'did:key:alice', itemType: 'offer', itemId: 'offer-1' },
      10, 0.3,
    );

    // Publish a similar need — should match the offer
    const needHash = similarHash(baseHash);
    const notifications = engine.insertAndMatch(
      needHash,
      { did: 'did:key:bob', itemType: 'need', itemId: 'need-1' },
      10, 0.3,
    );

    expect(notifications.length).toBe(1);
    expect(notifications[0].publisherDID).toBe('did:key:bob');
    expect(notifications[0].matchedDID).toBe('did:key:alice');
    expect(notifications[0].similarity).toBeGreaterThan(0.3);
    expect(notifications[0].matchId).toBeTruthy();
  });

  it('deduplicates DID pairs', () => {
    const baseHash = randomHash();

    engine.insertAndMatch(
      baseHash,
      { did: 'did:key:alice', itemType: 'offer', itemId: 'offer-1' },
      10, 0.3,
    );

    // First need from Bob matches
    const need1 = engine.insertAndMatch(
      similarHash(baseHash),
      { did: 'did:key:bob', itemType: 'need', itemId: 'need-1' },
      10, 0.3,
    );
    expect(need1.length).toBe(1);

    // Second need from Bob — same DID pair, should be deduped
    const need2 = engine.insertAndMatch(
      similarHash(baseHash),
      { did: 'did:key:bob', itemType: 'need', itemId: 'need-2' },
      10, 0.3,
    );
    expect(need2.length).toBe(0);
  });

  it('filters withdrawn items', () => {
    const baseHash = randomHash();

    engine.insertAndMatch(
      baseHash,
      { did: 'did:key:alice', itemType: 'offer', itemId: 'offer-1' },
      10, 0.3,
    );

    engine.withdraw('did:key:alice', 'offer-1');

    const notifications = engine.insertAndMatch(
      similarHash(baseHash),
      { did: 'did:key:bob', itemType: 'need', itemId: 'need-1' },
      10, 0.3,
    );
    expect(notifications.length).toBe(0);
  });

  it('ephemeral search does not index the query', () => {
    const baseHash = randomHash();

    engine.insertAndMatch(
      baseHash,
      { did: 'did:key:alice', itemType: 'offer', itemId: 'offer-1' },
      10, 0.0,
    );

    const results = engine.search(similarHash(baseHash), 'need', 10, 0.3);
    expect(results.length).toBe(1);
    expect(results[0].did).toBe('did:key:alice');

    // The search query was NOT indexed — needs count should still be 0
    const stats = engine.getStats();
    expect(stats.needs).toBe(0);
    expect(stats.offers).toBe(1);
  });

  it('tracks stats correctly', () => {
    const baseHash = randomHash();

    engine.insertAndMatch(
      baseHash,
      { did: 'did:key:alice', itemType: 'offer', itemId: 'offer-1' },
      10, 0.3,
    );

    engine.insertAndMatch(
      similarHash(baseHash),
      { did: 'did:key:bob', itemType: 'need', itemId: 'need-1' },
      10, 0.3,
    );

    const stats = engine.getStats();
    expect(stats.needs).toBe(1);
    expect(stats.offers).toBe(1);
    expect(stats.total).toBe(2);
    expect(stats.matchesToday).toBe(1);
  });
});
