import type { BenchmarkResult } from '@resonance/core';
import { formatMs } from '../utils.js';
import { measureHnswProcess } from './hnsw-measurement.js';

/** Dedicated-process insert/search latency and absolute process peak RSS. */
export async function benchmarkHnswPerformance(quick: boolean): Promise<BenchmarkResult[]> {
  const measured = await measureHnswProcess(quick ? 10000 : 100000);
  const { vectorCount, insertDurationMs, p50, p95, p99, mean } = measured;
  const peakRssMiB = measured.peakRssBytes / 1048576;
  return [
    { name: `HNSW search (p95, ${vectorCount / 1000}K)`, target: '<5ms', actual: formatMs(p95), value: p95, passed: p95 < 5,
      details: { vectorCount, p50, p95, p99, mean, insertDurationMs } },
    { name: `HNSW insert (${vectorCount / 1000}K total)`, target: 'info', actual: formatMs(insertDurationMs), value: insertDurationMs, passed: true,
      details: { vectorCount, totalMs: insertDurationMs, perVectorMs: insertDurationMs / vectorCount } },
    { name: `HNSW process peak RSS (${vectorCount / 1000}K)`, target: '<4096 MiB', actual: `${peakRssMiB.toFixed(1)} MiB`, value: peakRssMiB,
      passed: peakRssMiB < 4096, details: { ...measured, peakRssMiB, measurement: 'isolated-process-resourceUsage.maxRSS',
        scope: 'Whole child process through search completion, including runtime/imports/native allocations; not index-only or full-app memory.' } },
  ];
}
