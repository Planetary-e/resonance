import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalize } from '@resonance/core';
import { HnswIndex, MatchingIndex } from '../hnsw.js';

function randomUnitVector(dims = 768): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = Math.random() - 0.5;
  return normalize(v);
}

describe('HnswIndex persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'resonance-hnsw-test-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('saveWithMetadata/loadWithMetadata preserves vectors and metadata', () => {
    const index = new HnswIndex({ maxElements: 100 });
    index.initialize();

    const vectors: Float32Array[] = [];
    for (let i = 0; i < 10; i++) {
      const v = randomUnitVector();
      vectors.push(v);
      index.addVector(v, { did: `did:key:z6Mk${i}`, itemType: i % 2 === 0 ? 'need' : 'offer', itemId: `item-${i}` });
    }

    index.saveWithMetadata(tempDir, 'test');

    // Load into a fresh index
    const loaded = new HnswIndex({ maxElements: 100 });
    loaded.initialize();
    loaded.loadWithMetadata(tempDir, 'test');

    expect(loaded.getCount()).toBe(10);
    expect(loaded.getLabelCount()).toBe(10);

    // Metadata preserved
    for (let i = 0; i < 10; i++) {
      const meta = loaded.getMetadata(i);
      expect(meta).toBeDefined();
      expect(meta!.did).toBe(`did:key:z6Mk${i}`);
      expect(meta!.itemId).toBe(`item-${i}`);
    }

    // Search still works — query with first vector should find itself
    const results = loaded.search(vectors[0], 3, 0.5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].similarity).toBeGreaterThan(0.9);
  });

  it('loadWithMetadata on missing files is a no-op', () => {
    const index = new HnswIndex({ maxElements: 100 });
    index.initialize();
    index.loadWithMetadata(tempDir, 'nonexistent');
    expect(index.getCount()).toBe(0);
  });
});

describe('MatchingIndex persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'resonance-matching-test-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('save/load preserves both sub-indexes', () => {
    const index = new MatchingIndex({ maxElements: 100 });
    index.initialize();

    // Add multiple vectors to each index for reliable search
    const needVecs: Float32Array[] = [];
    const offerVecs: Float32Array[] = [];
    for (let i = 0; i < 5; i++) {
      const nv = randomUnitVector();
      const ov = randomUnitVector();
      needVecs.push(nv);
      offerVecs.push(ov);
      index.addVector(nv, { did: `did:key:need-${i}`, itemType: 'need', itemId: `need-${i}` });
      index.addVector(ov, { did: `did:key:offer-${i}`, itemType: 'offer', itemId: `offer-${i}` });
    }

    expect(index.getCount()).toEqual({ needs: 5, offers: 5, total: 10 });

    index.save(tempDir);

    // Load into fresh index
    const loaded = new MatchingIndex({ maxElements: 100 });
    loaded.initialize();
    loaded.load(tempDir);

    expect(loaded.getCount()).toEqual({ needs: 5, offers: 5, total: 10 });

    // Metadata preserved
    expect(loaded.getMetadata(0, 'need')!.did).toBe('did:key:need-0');
    expect(loaded.getMetadata(0, 'offer')!.did).toBe('did:key:offer-0');

    // Search still works — need searches offers
    const results = loaded.search(offerVecs[0], 'need', 5, 0.0);
    expect(results.length).toBeGreaterThan(0);
  });

  it('new vectors can be added after load', () => {
    const index = new MatchingIndex({ maxElements: 100 });
    index.initialize();

    index.addVector(randomUnitVector(), { did: 'did:key:a', itemType: 'need', itemId: 'n1' });
    index.save(tempDir);

    const loaded = new MatchingIndex({ maxElements: 100 });
    loaded.initialize();
    loaded.load(tempDir);

    // Add more vectors after loading
    loaded.addVector(randomUnitVector(), { did: 'did:key:b', itemType: 'offer', itemId: 'o1' });
    expect(loaded.getCount()).toEqual({ needs: 1, offers: 1, total: 2 });
  });
});
