import { describe, it, expect } from 'vitest';
import { sampleLaplace, calibrateScale, perturbVector, privacyLevelToEpsilon } from '../perturbation.js';
import { l2Norm, normalize, cosineSimilarity } from '../vectors.js';

function randomUnitVector(dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random() - 0.5;
  return normalize(v);
}

describe('sampleLaplace', () => {
  it('produces samples centered around 0', () => {
    const samples = Array.from({ length: 10000 }, () => sampleLaplace(1.0));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(Math.abs(mean)).toBeLessThan(0.1);
  });

  it('variance scales with scale parameter', () => {
    const samplesSmall = Array.from({ length: 5000 }, () => sampleLaplace(0.5));
    const samplesLarge = Array.from({ length: 5000 }, () => sampleLaplace(2.0));
    const varSmall = samplesSmall.reduce((a, b) => a + b * b, 0) / samplesSmall.length;
    const varLarge = samplesLarge.reduce((a, b) => a + b * b, 0) / samplesLarge.length;
    expect(varLarge).toBeGreaterThan(varSmall * 2);
  });
});

describe('calibrateScale', () => {
  it('scales inversely with epsilon', () => {
    const s1 = calibrateScale(1.0);
    const s5 = calibrateScale(5.0);
    const s01 = calibrateScale(0.1);
    // Higher epsilon → smaller scale (less noise)
    expect(s5).toBeLessThan(s1);
    expect(s1).toBeLessThan(s01);
    // Linear scaling: scale(0.1) = 10 * scale(1.0)
    expect(s01 / s1).toBeCloseTo(10, 1);
  });
});

describe('perturbVector', () => {
  it('produces unit-norm output', () => {
    const v = randomUnitVector(768);
    const { perturbed } = perturbVector(v, 1.0);
    expect(l2Norm(perturbed)).toBeCloseTo(1.0, 2);
  });

  it('at ε=1.0, mean cosine similarity < 0.95', () => {
    const trials = 100;
    let totalSim = 0;
    for (let t = 0; t < trials; t++) {
      const v = randomUnitVector(768);
      const { perturbed } = perturbVector(v, 1.0);
      totalSim += cosineSimilarity(v, perturbed);
    }
    const meanSim = totalSim / trials;
    expect(meanSim).toBeLessThan(0.95);
  });

  it('at ε=0.1, mean cosine similarity < 0.80', () => {
    const trials = 100;
    let totalSim = 0;
    for (let t = 0; t < trials; t++) {
      const v = randomUnitVector(768);
      const { perturbed } = perturbVector(v, 0.1);
      totalSim += cosineSimilarity(v, perturbed);
    }
    const meanSim = totalSim / trials;
    expect(meanSim).toBeLessThan(0.80);
  });

  it('at ε=5.0, similarity is higher than at ε=1.0', () => {
    const trials = 100;
    let simHigh = 0, simLow = 0;
    for (let t = 0; t < trials; t++) {
      const v = randomUnitVector(768);
      simHigh += cosineSimilarity(v, perturbVector(v, 5.0).perturbed);
      simLow += cosineSimilarity(v, perturbVector(v, 1.0).perturbed);
    }
    expect(simHigh / trials).toBeGreaterThan(simLow / trials);
  });

  it('different calls produce different results', () => {
    const v = randomUnitVector(768);
    const a = perturbVector(v, 1.0).perturbed;
    const b = perturbVector(v, 1.0).perturbed;
    // Extremely unlikely to be identical
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeLessThan(0.999);
  });

  it('throws on non-positive epsilon', () => {
    const v = randomUnitVector(768);
    expect(() => perturbVector(v, 0)).toThrow('positive');
    expect(() => perturbVector(v, -1)).toThrow('positive');
  });
});

describe('privacyLevelToEpsilon', () => {
  it('maps levels correctly', () => {
    expect(privacyLevelToEpsilon('low')).toBe(5.0);
    expect(privacyLevelToEpsilon('medium')).toBe(1.0);
    expect(privacyLevelToEpsilon('high')).toBe(0.1);
  });
});
