import { describe, it, expect } from 'vitest';
import { dotProduct, l2Norm, normalize, cosineSimilarity, cosineSimilaritySafe } from '../vectors.js';

describe('dotProduct', () => {
  it('computes dot product of two vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5, 6]);
    expect(dotProduct(a, b)).toBeCloseTo(32, 5); // 4+10+18
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(dotProduct(a, b)).toBeCloseTo(0, 5);
  });

  it('throws on dimension mismatch', () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(() => dotProduct(a, b)).toThrow('dimension mismatch');
  });
});

describe('l2Norm', () => {
  it('computes norm of unit vector', () => {
    const v = new Float32Array([1, 0, 0]);
    expect(l2Norm(v)).toBeCloseTo(1.0, 5);
  });

  it('computes norm of arbitrary vector', () => {
    const v = new Float32Array([3, 4]);
    expect(l2Norm(v)).toBeCloseTo(5.0, 5);
  });
});

describe('normalize', () => {
  it('produces unit norm vector', () => {
    const v = new Float32Array([3, 4, 0]);
    const n = normalize(v);
    expect(l2Norm(n)).toBeCloseTo(1.0, 3);
  });

  it('preserves direction', () => {
    const v = new Float32Array([2, 0, 0]);
    const n = normalize(v);
    expect(n[0]).toBeCloseTo(1.0, 5);
    expect(n[1]).toBeCloseTo(0.0, 5);
    expect(n[2]).toBeCloseTo(0.0, 5);
  });

  it('throws on zero vector', () => {
    const v = new Float32Array([0, 0, 0]);
    expect(() => normalize(v)).toThrow('zero vector');
  });

  it('normalizes 768-dim vectors correctly', () => {
    const v = new Float32Array(768);
    for (let i = 0; i < 768; i++) v[i] = Math.random() - 0.5;
    const n = normalize(v);
    expect(l2Norm(n)).toBeCloseTo(1.0, 3);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical unit vectors', () => {
    const v = normalize(new Float32Array([1, 2, 3]));
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 3);
  });

  it('returns 0.0 for orthogonal unit vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('returns -1.0 for opposite unit vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });
});

describe('cosineSimilaritySafe', () => {
  it('handles non-unit vectors', () => {
    const a = new Float32Array([3, 4]);
    const b = new Float32Array([3, 4]);
    expect(cosineSimilaritySafe(a, b)).toBeCloseTo(1.0, 3);
  });

  it('returns 0 for zero vectors', () => {
    const a = new Float32Array([0, 0]);
    const b = new Float32Array([1, 2]);
    expect(cosineSimilaritySafe(a, b)).toBe(0);
  });
});
