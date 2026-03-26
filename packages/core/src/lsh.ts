/**
 * Locality-Sensitive Hashing (LSH) for privacy-preserving similarity search.
 *
 * Converts 768-dim embedding vectors into compact binary hashes using
 * random hyperplane projections. Similar vectors produce similar hashes
 * (measured by Hamming distance).
 *
 * The relay sees only binary hashes — never the original vectors.
 * The random projection irreversibly discards information, making
 * inversion significantly harder than inverting a perturbed vector.
 */

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
