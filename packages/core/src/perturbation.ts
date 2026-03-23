/**
 * Differential privacy perturbation engine.
 * Adds calibrated Laplace noise to embedding vectors.
 */

import { l2Norm, normalize } from './vectors.js';
import type { PrivacyLevel, PerturbationResult } from './types.js';
import { EPSILON_MAP } from './types.js';

/**
 * Sample from Laplace(0, scale) using inverse CDF.
 * Uses crypto.getRandomValues for high-quality randomness.
 */
export function sampleLaplace(scale: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // Uniform in (0, 1), avoiding exact 0 and 0.5 to prevent log(0)
  const u = (buf[0] + 1) / (0xFFFFFFFF + 2);
  const centered = u - 0.5;
  return -scale * Math.sign(centered) * Math.log(1 - 2 * Math.abs(centered));
}

/**
 * Default embedding dimensions (Nomic-embed-text).
 * Used for scale calibration.
 */
const DEFAULT_DIMENSIONS = 768;

/**
 * Calibrate Laplace scale parameter for a given epsilon and dimensionality.
 *
 * Strict ε-DP in high dimensions requires enormous noise (L1 sensitivity
 * of unit vectors grows as √d), which destroys utility. Instead, we use
 * a practical calibration: scale = C / (ε · √d), where C is tuned so that
 * at ε=1.0 the expected cosine similarity between original and perturbed
 * vectors is ~0.88. This provides meaningful privacy while preserving
 * enough signal for matching.
 *
 * Expected cosine similarity ≈ 1 / √(1 + 2·C²/ε²)
 *   ε=5.0 → ~0.99  (minimal noise)
 *   ε=1.0 → ~0.88  (moderate noise, < 0.95 per PRD)
 *   ε=0.1 → ~0.18  (heavy noise, < 0.80 per PRD)
 */
export function calibrateScale(epsilon: number, dimensions: number = DEFAULT_DIMENSIONS): number {
  const C = 0.38;
  return C / (epsilon * Math.sqrt(dimensions));
}

/**
 * Perturb a unit-norm embedding vector with Laplace noise.
 * Returns a new unit-norm vector with calibrated noise applied.
 */
export function perturbVector(
  vector: Float32Array,
  epsilon: number
): PerturbationResult {
  if (epsilon <= 0) {
    throw new Error('Epsilon must be positive');
  }

  const scale = calibrateScale(epsilon);
  const noisy = new Float32Array(vector.length);

  for (let i = 0; i < vector.length; i++) {
    noisy[i] = vector[i] + sampleLaplace(scale);
  }

  // Re-normalize to unit sphere
  const perturbed = normalize(noisy);

  return { perturbed, epsilon };
}

/** Map privacy level preset to numeric epsilon */
export function privacyLevelToEpsilon(level: PrivacyLevel): number {
  return EPSILON_MAP[level];
}

/**
 * Convenience: perturb a vector using a privacy level preset.
 */
export function perturbWithLevel(
  vector: Float32Array,
  level: PrivacyLevel
): PerturbationResult {
  return perturbVector(vector, privacyLevelToEpsilon(level));
}
