import { EmbeddingEngine, type BenchmarkResult } from '@resonance/core';
import { timeAsync, percentile, formatMs } from '../utils.js';

const SAMPLE_TEXTS = [
  'I need a freelance web developer for a React project',
  'Looking for a room in Barcelona near the beach',
  'Experienced plumber available for emergency repairs',
  'Want to learn Spanish with a native speaker',
  'Organizing a weekend hiking trip to Montserrat',
  'Need a photographer for a birthday party',
  'Offering guitar lessons for beginners, acoustic and electric',
  'Searching for a co-working space with fast internet',
  'Available as a personal trainer for home workouts',
  'Looking to join a book club focused on philosophy',
];

/** Benchmark: per-inference embedding latency. Target: p95 <100ms */
export async function benchmarkEmbeddingLatency(engine: EmbeddingEngine): Promise<BenchmarkResult> {
  // Warm-up: 5 inferences
  for (let i = 0; i < 5; i++) {
    await engine.embed(SAMPLE_TEXTS[i % SAMPLE_TEXTS.length]);
  }

  // Measure: 50 inferences
  const timings: number[] = [];
  for (let i = 0; i < 50; i++) {
    const text = SAMPLE_TEXTS[i % SAMPLE_TEXTS.length];
    const { durationMs } = await timeAsync(() => engine.embed(text));
    timings.push(durationMs);
  }

  const p50 = percentile(timings, 50);
  const p95 = percentile(timings, 95);
  const p99 = percentile(timings, 99);
  const mean = timings.reduce((a, b) => a + b, 0) / timings.length;

  return {
    name: 'Embedding latency (p95)',
    target: '<100ms',
    actual: formatMs(p95),
    value: p95,
    passed: p95 < 100,
    details: { p50, p95, p99, mean, min: Math.min(...timings), max: Math.max(...timings) },
  };
}
