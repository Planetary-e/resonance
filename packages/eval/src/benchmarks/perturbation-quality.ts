import { perturbVector, cosineSimilarity, l2Norm, type BenchmarkResult } from '@resonance/core';
import { generateRandomUnitVector } from '../utils.js';

interface EpsilonResult {
  epsilon: number;
  meanSimilarity: number;
  stdSimilarity: number;
  minSimilarity: number;
  maxSimilarity: number;
  allNormalized: boolean;
}

function evaluateEpsilon(epsilon: number, trials: number = 200): EpsilonResult {
  const similarities: number[] = [];
  let allNormalized = true;

  for (let i = 0; i < trials; i++) {
    const v = generateRandomUnitVector(768);
    const { perturbed } = perturbVector(v, epsilon);

    similarities.push(cosineSimilarity(v, perturbed));

    const norm = l2Norm(perturbed);
    if (Math.abs(norm - 1.0) > 0.01) {
      allNormalized = false;
    }
  }

  const mean = similarities.reduce((a, b) => a + b, 0) / similarities.length;
  const variance = similarities.reduce((a, b) => a + (b - mean) ** 2, 0) / similarities.length;

  return {
    epsilon,
    meanSimilarity: mean,
    stdSimilarity: Math.sqrt(variance),
    minSimilarity: Math.min(...similarities),
    maxSimilarity: Math.max(...similarities),
    allNormalized,
  };
}

/** Benchmark: perturbation quality at each epsilon level */
export async function benchmarkPerturbationQuality(): Promise<BenchmarkResult[]> {
  const epsilons = [
    { value: 5.0, label: 'low (ε=5.0)', maxSim: 1.0 },   // No strict upper bound
    { value: 1.0, label: 'medium (ε=1.0)', maxSim: 0.95 }, // PRD: < 0.95
    { value: 0.1, label: 'high (ε=0.1)', maxSim: 0.80 },   // PRD: < 0.80
  ];

  const results: BenchmarkResult[] = [];

  for (const { value, label, maxSim } of epsilons) {
    const r = evaluateEpsilon(value);
    const passed = r.meanSimilarity < maxSim && r.allNormalized;

    results.push({
      name: `Perturbation ${label}`,
      target: maxSim < 1.0 ? `sim < ${maxSim}` : 'normalized',
      actual: `sim=${r.meanSimilarity.toFixed(3)} ±${r.stdSimilarity.toFixed(3)}`,
      value: r.meanSimilarity,
      passed,
      details: {
        epsilon: value,
        meanSimilarity: r.meanSimilarity,
        stdSimilarity: r.stdSimilarity,
        minSimilarity: r.minSimilarity,
        maxSimilarity: r.maxSimilarity,
        allNormalized: r.allNormalized,
      },
    });
  }

  return results;
}
