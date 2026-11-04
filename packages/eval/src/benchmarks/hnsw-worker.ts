/** Fixed subprocess entry; its RSS history cannot include earlier evaluator workloads. */
import { HnswIndex } from '@resonance/relay';
import { generateRandomUnitVector, timeSync, percentile } from '../utils.js';
import { seededRandom } from '../witness-availability.js';
import type { HnswMeasurement } from './hnsw-measurement.js';

const vectorCount = Number(process.argv[2]), dimensions = 768, searchCount = 100, seed = 20261017;
if (!process.send || !Number.isSafeInteger(vectorCount) || vectorCount < 1 || vectorCount > 100000) throw new Error('Invalid isolated HNSW worker request');
const random = seededRandom(seed), baselineRssBytes = process.memoryUsage.rss(), cpuBefore = process.cpuUsage();
const index = new HnswIndex({ maxElements: vectorCount + 1000 }); index.initialize();
const initializedRssBytes = process.memoryUsage.rss(), insertStart = performance.now();
for (let i = 0; i < vectorCount; i++) {
  index.addVector(generateRandomUnitVector(dimensions, random), { did: `did:test:${i}`, itemType: i % 2 === 0 ? 'need' : 'offer', itemId: `item-${i}` });
}
const insertDurationMs = performance.now() - insertStart, insertedRssBytes = process.memoryUsage.rss();
const timings: number[] = [];
for (let i = 0; i < searchCount; i++) {
  const query = generateRandomUnitVector(dimensions, random);
  timings.push(timeSync(() => index.search(query, Math.min(vectorCount, 5), 0.0)).durationMs);
}
const finalRssBytes = process.memoryUsage.rss(), cpu = process.cpuUsage(cpuBefore);
// Node normalizes resourceUsage().maxRSS to KiB on its supported platforms.
// This high-water mark includes native HNSW allocation, runtime and imports.
const peakRssBytes = process.resourceUsage().maxRSS * 1024;
const result: HnswMeasurement = { version: 1, pid: process.pid, vectorCount, searchCount, dimensions, seed,
  nodeVersion: process.version, platform: process.platform, arch: process.arch, insertDurationMs,
  p50: percentile(timings, 50), p95: percentile(timings, 95), p99: percentile(timings, 99), mean: timings.reduce((a, b) => a + b, 0) / timings.length,
  cpuTimeMs: (cpu.user + cpu.system) / 1000, baselineRssBytes, initializedRssBytes, insertedRssBytes, finalRssBytes, peakRssBytes };
process.send(result, error => { if (error) process.exitCode = 1; process.disconnect?.(); });
