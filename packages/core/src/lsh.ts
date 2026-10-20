/**
 * Locality-Sensitive Hashing (LSH) for compact similarity search.
 *
 * Converts 768-dim embedding vectors into compact binary hashes using
 * random hyperplane projections. Similar vectors produce similar hashes
 * (measured by Hamming distance).
 *
 * The relay sees binary hashes rather than the original vectors. Public
 * projection matrices are not encryption: a relay can test guessed content
 * and correlate fingerprints that use the same matrix.
 */

import nacl from 'tweetnacl';

/**
 * Generate a random projection matrix of shape (hashBits, dimensions).
 * Each row is a random hyperplane. The dot product of a vector with each
 * row determines one bit of the hash.
 *
 * The matrix can be derived from a public seed for reproducibility across
 * all nodes, or generated randomly for additional security.
 */
export function generateProjectionMatrix(hashBits: number, dimensions: number, seed?: number): Float32Array[] {
  // Simple seeded PRNG (xorshift32) for reproducible matrices
  let state = seed ?? (Math.random() * 0xFFFFFFFF >>> 0);
  function rand(): number {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // Convert to float in [-1, 1]
    return ((state >>> 0) / 0xFFFFFFFF) * 2 - 1;
  }

  const matrix: Float32Array[] = [];
  for (let i = 0; i < hashBits; i++) {
    const row = new Float32Array(dimensions);
    for (let j = 0; j < dimensions; j++) {
      row[j] = rand();
    }
    // Normalize each hyperplane to unit length for consistent behavior
    let norm = 0;
    for (let j = 0; j < dimensions; j++) norm += row[j] * row[j];
    norm = Math.sqrt(norm);
    for (let j = 0; j < dimensions; j++) row[j] /= norm;
    matrix.push(row);
  }
  return matrix;
}

/**
 * Hash an embedding vector using the projection matrix.
 * Returns a compact binary hash as a Uint8Array.
 *
 * Each bit is 1 if dot(vector, hyperplane) >= 0, else 0.
 */
export function hashEmbedding(vector: Float32Array, matrix: Float32Array[]): Uint8Array {
  const hashBits = matrix.length;
  const hashBytes = Math.ceil(hashBits / 8);
  const hash = new Uint8Array(hashBytes);

  for (let i = 0; i < hashBits; i++) {
    // Compute dot product with the i-th hyperplane
    let dot = 0;
    const row = matrix[i];
    for (let j = 0; j < vector.length; j++) {
      dot += vector[j] * row[j];
    }
    // Set bit if dot product is positive
    if (dot >= 0) {
      hash[i >>> 3] |= (1 << (i & 7));
    }
  }

  return hash;
}

/**
 * Compute Hamming distance between two binary hashes.
 * Returns the number of differing bits.
 */
export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = a[i] ^ b[i];
    // Popcount (count set bits)
    while (xor) {
      dist += xor & 1;
      xor >>>= 1;
    }
  }
  return dist;
}

/**
 * Compute Hamming similarity as a fraction: 1 - (hammingDistance / totalBits).
 * Returns a value between 0 and 1, where 1 means identical hashes.
 */
export function hammingSimilarity(a: Uint8Array, b: Uint8Array): number {
  const totalBits = a.length * 8;
  return 1 - hammingDistance(a, b) / totalBits;
}

/**
 * Theoretical relationship between cosine similarity and expected
 * Hamming similarity for random hyperplane LSH:
 *
 *   P(bit match) = 1 - arccos(cosineSim) / pi
 *
 * This is the expected Hamming similarity for a given cosine similarity.
 */
export function expectedHammingSimilarity(cosineSimilarity: number): number {
  return 1 - Math.acos(Math.min(1, Math.max(-1, cosineSimilarity))) / Math.PI;
}

// --- Shared projection matrix ---

/** Default LSH parameters for the Resonance protocol. */
export const LSH_DEFAULTS = {
  hashBits: 512,
  dimensions: 768,
  seed: 20260326, // Fixed seed — all nodes use the same projection
} as const;

let _cachedMatrix: Float32Array[] | null = null;

/** Get the shared projection matrix (cached). All nodes must use the same matrix. */
export function getSharedProjectionMatrix(): Float32Array[] {
  if (!_cachedMatrix) {
    _cachedMatrix = generateProjectionMatrix(LSH_DEFAULTS.hashBits, LSH_DEFAULTS.dimensions, LSH_DEFAULTS.seed);
  }
  return _cachedMatrix;
}

/** UTC month used by the experimental scoped fingerprint projection. */
export function currentFingerprintEpochV2(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid fingerprint epoch time');
  return new Date(now).toISOString().slice(0, 7);
}

/**
 * Derive a distinct public hyperplane set for a community and month. This
 * prevents direct equality of hashes across scopes; it does not make a public
 * LSH fingerprint secret or safe against a relay that guesses the text.
 */
export function getScopedProjectionMatrixV2(groupId: string, epoch: string): Float32Array[] {
  if (!groupId || groupId.length > 128 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(epoch)
    || /[\u0000-\u001f\u007f]/.test(groupId + epoch)) {
    throw new Error('Invalid fingerprint scope');
  }
  const key = `${groupId.length}:${groupId}:${epoch}`;
  const cached = scopedMatrices.get(key);
  if (cached) return cached;
  // Four independently hashed 32-bit words seed xoshiro128**. This PRNG is
  // deterministic for interoperability, not a secrecy boundary.
  const seed = nacl.hash(new TextEncoder().encode(`resonance:projection:v2\n${key}`));
  const view = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);
  const state = [0, 4, 8, 12].map(offset => view.getUint32(offset, false));
  function random(): number {
    const result = Math.imul(rotl(Math.imul(state[1], 5), 7), 9) >>> 0;
    const shift = (state[1] << 9) >>> 0;
    state[2] ^= state[0]; state[3] ^= state[1];
    state[1] ^= state[2]; state[0] ^= state[3];
    state[2] ^= shift; state[3] = rotl(state[3], 11);
    return (result / 0x1_0000_0000) * 2 - 1;
  }
  const matrix: Float32Array[] = [];
  for (let bit = 0; bit < LSH_DEFAULTS.hashBits; bit++) {
    const row = new Float32Array(LSH_DEFAULTS.dimensions);
    let norm = 0;
    for (let dimension = 0; dimension < row.length; dimension++) {
      row[dimension] = random();
      norm += row[dimension] * row[dimension];
    }
    norm = Math.sqrt(norm);
    for (let dimension = 0; dimension < row.length; dimension++) row[dimension] /= norm;
    matrix.push(row);
  }
  if (scopedMatrices.size >= 4) scopedMatrices.delete(scopedMatrices.keys().next().value!);
  scopedMatrices.set(key, matrix);
  return matrix;
}

function rotl(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

const scopedMatrices = new Map<string, Float32Array[]>();
