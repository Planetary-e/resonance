import { EmbeddingEngine, type BenchmarkResult } from '@resonance/core';
import { timeAsync } from '../utils.js';

/** Benchmark: model initialization / bootstrap time. Target: <30s */
export async function benchmarkEmbeddingInit(): Promise<BenchmarkResult> {
  const engine = new EmbeddingEngine();
  let durationMs: number;
  try { ({ durationMs } = await timeAsync(() => engine.initialize())); }
  finally { await engine.dispose(); }
  const seconds = durationMs / 1000;

  return {
    name: 'Bootstrap time',
    target: '<30s',
    actual: `${seconds.toFixed(1)}s`,
    value: seconds,
    passed: seconds < 30,
    details: { durationMs },
  };
}
