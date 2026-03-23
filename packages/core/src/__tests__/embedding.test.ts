import { describe, it, expect, beforeAll } from 'vitest';
import { EmbeddingEngine } from '../embedding.js';
import { l2Norm, cosineSimilarity } from '../vectors.js';
import { EMBEDDING_CONFIG } from '../types.js';

describe('EmbeddingEngine', () => {
  const engine = new EmbeddingEngine();

  beforeAll(async () => {
    await engine.initialize();
  }, 120_000); // Allow up to 2 min for model download

  it('is initialized after init', () => {
    expect(engine.isInitialized()).toBe(true);
  });

  it('produces 768-dimensional vectors', async () => {
    const vec = await engine.embed('hello world');
    expect(vec.length).toBe(EMBEDDING_CONFIG.dimensions);
  }, 30_000);

  it('produces unit-normalized vectors', async () => {
    const vec = await engine.embed('test normalization');
    expect(l2Norm(vec)).toBeCloseTo(1.0, 2);
  }, 30_000);

  it('identical texts produce identical vectors', async () => {
    const a = await engine.embed('the quick brown fox');
    const b = await engine.embed('the quick brown fox');
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 3);
  }, 30_000);

  it('similar texts have high cosine similarity', async () => {
    const a = await engine.embed('I need a Python developer for a web project');
    const b = await engine.embed('Looking for a Python programmer to build a website');
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.7);
  }, 30_000);

  it('dissimilar texts have lower cosine similarity than similar texts', async () => {
    const a = await engine.embed('I need a plumber to fix a leaking pipe');
    const b = await engine.embed('Quantum chromodynamics and the strong nuclear force');
    const c = await engine.embed('Looking for someone to repair pipes and plumbing');
    const simDissimilar = cosineSimilarity(a, b);
    const simSimilar = cosineSimilarity(a, c);
    expect(simSimilar).toBeGreaterThan(simDissimilar);
  }, 30_000);

  it('embedBatch returns correct number of results', async () => {
    const texts = ['hello', 'world', 'test'];
    const results = await engine.embedBatch(texts);
    expect(results.length).toBe(3);
    results.forEach(vec => {
      expect(vec.length).toBe(EMBEDDING_CONFIG.dimensions);
      expect(l2Norm(vec)).toBeCloseTo(1.0, 2);
    });
  }, 60_000);

  it('throws if not initialized', async () => {
    const fresh = new EmbeddingEngine();
    await expect(fresh.embed('test')).rejects.toThrow('not initialized');
  });
});
