/**
 * Pure vector math utilities for embedding operations.
 * All functions work with Float32Array for memory efficiency.
 */

/** Compute the dot product of two vectors */
export function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/** Compute L2 (Euclidean) norm of a vector */
export function l2Norm(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i] * v[i];
  }
  return Math.sqrt(sum);
}

/** Normalize a vector to unit length (L2 norm = 1.0). Returns a new vector. */
export function normalize(v: Float32Array): Float32Array {
  const norm = l2Norm(v);
  if (norm === 0) {
    throw new Error('Cannot normalize zero vector');
  }
  const result = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    result[i] = v[i] / norm;
  }
  return result;
}

/** Compute cosine similarity between two vectors. Assumes unit-normalized inputs for speed. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  return dotProduct(a, b);
}

/** Compute cosine similarity with normalization (for non-unit vectors) */
export function cosineSimilaritySafe(a: Float32Array, b: Float32Array): number {
  const normA = l2Norm(a);
  const normB = l2Norm(b);
  if (normA === 0 || normB === 0) return 0;
  return dotProduct(a, b) / (normA * normB);
}
