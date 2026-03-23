import { HnswIndex } from '@resonance/relay';
import type { BenchmarkResult } from '@resonance/core';
import { generateRandomUnitVector, timeSync, percentile, formatMs } from '../utils.js';

/** Benchmark: HNSW insert + search latency. Target: search p95 <5ms at 100K vectors */
export async function benchmarkHnswPerformance(quick: boolean): Promise<BenchmarkResult[]> {
  const vectorCount = quick ? 10_000 : 100_000;
  const searchCount = 100;

  const index = new HnswIndex({ maxElements: vectorCount + 1000 });
  index.initialize();

  // Measure insert time
  const memBefore = process.memoryUsage().heapUsed;
  const insertStart = performance.now();

  for (let i = 0; i < vectorCount; i++) {
    index.addVector(generateRandomUnitVector(768), {
      did: `did:test:${i}`,
      itemType: i % 2 === 0 ? 'need' : 'offer',
      itemId: `item-${i}`,
    });
  }

  const insertDuration = performance.now() - insertStart;
  const memAfter = process.memoryUsage().heapUsed;
  const memUsedMB = (memAfter - memBefore) / (1024 * 1024);

  // Measure search latency
  const searchTimings: number[] = [];
  for (let i = 0; i < searchCount; i++) {
    const query = generateRandomUnitVector(768);
    const { durationMs } = timeSync(() => index.search(query, 5, 0.0));
    searchTimings.push(durationMs);
  }

  const p50 = percentile(searchTimings, 50);
  const p95 = percentile(searchTimings, 95);
  const p99 = percentile(searchTimings, 99);
  const mean = searchTimings.reduce((a, b) => a + b, 0) / searchTimings.length;

  return [
    {
      name: `HNSW search (p95, ${(vectorCount / 1000)}K)`,
      target: '<5ms',
      actual: formatMs(p95),
      value: p95,
      passed: p95 < 5,
      details: { vectorCount, p50, p95, p99, mean, insertDurationMs: insertDuration, memUsedMB },
    },
    {
      name: `HNSW insert (${(vectorCount / 1000)}K total)`,
      target: 'info',
      actual: formatMs(insertDuration),
      value: insertDuration,
      passed: true, // informational
      details: { vectorCount, totalMs: insertDuration, perVectorMs: insertDuration / vectorCount },
    },
    {
      name: `HNSW memory (${(vectorCount / 1000)}K)`,
      target: '<4GB',
      actual: `${memUsedMB.toFixed(0)}MB`,
      value: memUsedMB,
      passed: memUsedMB < 4096,
      details: { memUsedMB },
    },
  ];
}
