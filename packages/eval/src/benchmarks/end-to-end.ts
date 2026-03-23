import { EmbeddingEngine, perturbVector, type BenchmarkResult } from '@resonance/core';
import { HnswIndex } from '@resonance/relay';
import { timeAsync, percentile, formatMs, generateRandomUnitVector } from '../utils.js';

/**
 * Benchmark: end-to-end pipeline latency (embed → perturb → insert → search).
 * Target: <2s (this measures compute only, no network).
 */
export async function benchmarkEndToEnd(engine: EmbeddingEngine): Promise<BenchmarkResult> {
  const epsilon = 1.0;
  const iterations = 20;

  // Pre-populate index with 10K vectors for realistic search conditions
  const index = new HnswIndex({ maxElements: 12_000 });
  index.initialize();

  for (let i = 0; i < 10_000; i++) {
    index.addVector(generateRandomUnitVector(768), {
      did: `did:test:${i}`,
      itemType: i % 2 === 0 ? 'need' : 'offer',
      itemId: `item-${i}`,
    });
  }

  const texts = [
    'I need a freelance Python developer for backend work',
    'Looking for a shared apartment in central Barcelona',
    'Offering English tutoring for intermediate Spanish speakers',
    'Need a photographer for a corporate event next Friday',
    'Seeking a running partner for morning jogs by the beach',
  ];

  const timings: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const text = texts[i % texts.length];

    const { durationMs } = await timeAsync(async () => {
      // Full pipeline: embed → perturb → insert → search for matches
      const embedding = await engine.embed(text, 'search_document');
      const { perturbed } = perturbVector(embedding, epsilon);
      index.addVector(perturbed, {
        did: `did:test:e2e-${i}`,
        itemType: 'offer',
        itemId: `e2e-${i}`,
      });
      const matches = index.search(perturbed, 5, 0.72);
      return matches;
    });

    timings.push(durationMs);
  }

  const p50 = percentile(timings, 50);
  const p95 = percentile(timings, 95);
  const mean = timings.reduce((a, b) => a + b, 0) / timings.length;

  return {
    name: 'End-to-end latency (p95)',
    target: '<2s',
    actual: formatMs(p95),
    value: p95,
    passed: p95 < 2000,
    details: { p50, p95, mean, iterations },
  };
}
