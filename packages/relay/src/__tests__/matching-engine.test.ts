import { describe, it, expect, beforeEach } from 'vitest';
import { normalize } from '@resonance/core';
import { MatchingEngine } from '../matching-engine.js';

function randomUnitVector(dims = 768): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = Math.random() - 0.5;
  return normalize(v);
}

// Create a vector close to another (high similarity)
function similarVector(base: Float32Array, noise = 0.1): Float32Array {
  const v = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) v[i] = base[i] + (Math.random() - 0.5) * noise;
  return normalize(v);
}

describe('MatchingEngine', () => {
  let engine: MatchingEngine;

  beforeEach(() => {
    engine = new MatchingEngine({ maxElements: 1000 });
    engine.initialize();
  });

  it('returns matches from complementary index', () => {
    const baseVec = randomUnitVector();

    // Publish an offer
    engine.insertAndMatch(
      Array.from(baseVec),
      { did: 'did:key:alice', itemType: 'offer', itemId: 'offer-1' },
      10, 0.3,
    );

    // Publish a similar need — should match the offer
    const needVec = similarVector(baseVec, 0.05);
    const notifications = engine.insertAndMatch(
      Array.from(needVec),
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
    const baseVec = randomUnitVector();

    engine.insertAndMatch(
      Array.from(baseVec),
      { did: 'did:key:alice', itemType: 'offer', itemId: 'offer-1' },
      10, 0.3,
    );

    // First need from Bob matches
    const need1 = engine.insertAndMatch(
      Array.from(similarVector(baseVec, 0.05)),
      { did: 'did:key:bob', itemType: 'need', itemId: 'need-1' },
      10, 0.3,
    );
    expect(need1.length).toBe(1);

    // Second need from Bob — same DID pair, should be deduped
    const need2 = engine.insertAndMatch(
      Array.from(similarVector(baseVec, 0.05)),
      { did: 'did:key:bob', itemType: 'need', itemId: 'need-2' },
      10, 0.3,
    );
    expect(need2.length).toBe(0);
  });

  it('filters withdrawn items', () => {
    const baseVec = randomUnitVector();

    engine.insertAndMatch(
      Array.from(baseVec),
      { did: 'did:key:alice', itemType: 'offer', itemId: 'offer-1' },
      10, 0.3,
    );

    engine.withdraw('did:key:alice', 'offer-1');

    const notifications = engine.insertAndMatch(
      Array.from(similarVector(baseVec, 0.05)),
      { did: 'did:key:bob', itemType: 'need', itemId: 'need-1' },
      10, 0.3,
    );
    expect(notifications.length).toBe(0);
  });

  it('ephemeral search does not index the query', () => {
    const baseVec = randomUnitVector();

    engine.insertAndMatch(
      Array.from(baseVec),
      { did: 'did:key:alice', itemType: 'offer', itemId: 'offer-1' },
      10, 0.0,
    );

    const results = engine.search(Array.from(similarVector(baseVec, 0.05)), 'need', 10, 0.3);
    expect(results.length).toBe(1);
    expect(results[0].did).toBe('did:key:alice');

    // The search query was NOT indexed — needs count should still be 0
    const stats = engine.getStats();
    expect(stats.needs).toBe(0);
    expect(stats.offers).toBe(1);
  });

  it('tracks stats correctly', () => {
    const baseVec = randomUnitVector();

    engine.insertAndMatch(
      Array.from(baseVec),
      { did: 'did:key:alice', itemType: 'offer', itemId: 'offer-1' },
      10, 0.3,
    );

    engine.insertAndMatch(
      Array.from(similarVector(baseVec, 0.05)),
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
