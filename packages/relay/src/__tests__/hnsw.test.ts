import { describe, it, expect, beforeEach } from 'vitest';
import { HnswIndex } from '../hnsw.js';
import { normalize } from '@resonance/core';

function randomUnitVector(dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random() - 0.5;
  return normalize(v);
}

describe('HnswIndex', () => {
  let index: HnswIndex;

  beforeEach(() => {
    index = new HnswIndex({ maxElements: 10_000 });
    index.initialize();
  });

  it('initializes without error', () => {
    expect(index.getCount()).toBe(0);
  });

  it('inserts and retrieves a vector with high similarity', () => {
    const vec = randomUnitVector(768);
    const label = index.addVector(vec, { did: 'did:test:1', itemType: 'offer', itemId: 'item-1' });
    expect(label).toBe(0);
    expect(index.getCount()).toBe(1);

    const results = index.search(vec, 1, 0.5);
    expect(results.length).toBe(1);
    expect(results[0].similarity).toBeGreaterThan(0.99);
  });

  it('returns correct k results', () => {
    for (let i = 0; i < 100; i++) {
      index.addVector(randomUnitVector(768), {
        did: `did:test:${i}`,
        itemType: 'offer',
        itemId: `item-${i}`,
      });
    }
    expect(index.getCount()).toBe(100);

    const query = randomUnitVector(768);
    const results = index.search(query, 5, 0.0); // low threshold to get results
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('filters by similarity threshold', () => {
    for (let i = 0; i < 50; i++) {
      index.addVector(randomUnitVector(768), {
        did: `did:test:${i}`,
        itemType: 'offer',
        itemId: `item-${i}`,
      });
    }

    const query = randomUnitVector(768);
    const highThreshold = index.search(query, 50, 0.99);
    const lowThreshold = index.search(query, 50, 0.0);
    expect(highThreshold.length).toBeLessThanOrEqual(lowThreshold.length);
  });

  it('results are sorted by similarity descending', () => {
    for (let i = 0; i < 100; i++) {
      index.addVector(randomUnitVector(768), {
        did: `did:test:${i}`,
        itemType: 'offer',
        itemId: `item-${i}`,
      });
    }

    const results = index.search(randomUnitVector(768), 10, 0.0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
    }
  });

  it('stores and retrieves metadata', () => {
    const meta = { did: 'did:test:abc', itemType: 'need' as const, itemId: 'item-xyz' };
    const label = index.addVector(randomUnitVector(768), meta);
    expect(index.getMetadata(label)).toEqual(meta);
  });

  it('returns empty results on empty index', () => {
    const results = index.search(randomUnitVector(768), 5);
    expect(results).toEqual([]);
  });

  it('throws if not initialized', () => {
    const fresh = new HnswIndex();
    expect(() => fresh.addVector(randomUnitVector(768), {
      did: 'x', itemType: 'offer', itemId: 'y'
    })).toThrow('not initialized');
  });
});
