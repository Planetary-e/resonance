import { describe, expect, it } from 'vitest';
import {
  currentFingerprintEpochV2,
  getScopedProjectionMatrixV2,
  hashEmbedding,
  hammingSimilarity,
} from '../index.js';

describe('experimental group and epoch scoped fingerprints', () => {
  it('uses deterministic monthly scopes and prevents direct cross-scope equality', () => {
    expect(currentFingerprintEpochV2(Date.UTC(2026, 8, 30))).toBe('2026-09');
    expect(currentFingerprintEpochV2(Date.UTC(2026, 9, 1))).toBe('2026-10');
    const vector = Float32Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.23));
    const first = hashEmbedding(vector, getScopedProjectionMatrixV2('community-a', '2026-09'));
    const same = hashEmbedding(vector, getScopedProjectionMatrixV2('community-a', '2026-09'));
    const nextMonth = hashEmbedding(vector, getScopedProjectionMatrixV2('community-a', '2026-10'));
    const otherGroup = hashEmbedding(vector, getScopedProjectionMatrixV2('community-b', '2026-09'));
    expect(same).toEqual(first);
    expect(hammingSimilarity(first, nextMonth)).toBeLessThan(0.6);
    expect(hammingSimilarity(first, otherGroup)).toBeLessThan(0.6);
  });

  it('retains high similarity for neighboring vectors within a scope', () => {
    const matrix = getScopedProjectionMatrixV2('community-a', '2026-09');
    const first = Float32Array.from({ length: 768 }, (_, i) => Math.cos(i * 0.19));
    const neighbor = Float32Array.from(first, (value, i) => value + 0.05 * Math.sin(i * 0.37));
    const unrelated = Float32Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.43));
    const hash = hashEmbedding(first, matrix);
    expect(hammingSimilarity(hash, hashEmbedding(neighbor, matrix))).toBeGreaterThan(0.9);
    expect(hammingSimilarity(hash, hashEmbedding(unrelated, matrix))).toBeLessThan(0.6);
  });
});
