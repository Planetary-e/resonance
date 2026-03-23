import { EmbeddingEngine } from '@resonance/core';
import type { BenchmarkResult } from '@resonance/core';
import { benchmarkEmbeddingInit } from './benchmarks/embedding-init.js';
import { benchmarkEmbeddingLatency } from './benchmarks/embedding-latency.js';
import { benchmarkPerturbationQuality } from './benchmarks/perturbation-quality.js';
import { benchmarkHnswPerformance } from './benchmarks/hnsw-performance.js';
import { benchmarkMatchRecall } from './benchmarks/match-recall.js';
import { benchmarkFalsePositiveRate } from './benchmarks/false-positive-rate.js';
import { benchmarkEndToEnd } from './benchmarks/end-to-end.js';
import { benchmarkComplementaryMatching } from './benchmarks/complementary.js';
import { benchmarkMultilingual } from './benchmarks/multilingual.js';
import { benchmarkComplementaryIndex } from './benchmarks/complementary-index.js';
import { printResults } from './reporters/console.js';
import { writeJsonReport } from './reporters/json.js';
import { writeMarkdownReport } from './reporters/markdown.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');

const quick = process.argv.includes('--quick');

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Planetary Resonance — Evaluation Suite     ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`\nMode: ${quick ? 'QUICK (10K vectors)' : 'FULL (100K vectors)'}\n`);

  const allResults: BenchmarkResult[] = [];

  // 1. Bootstrap time
  console.log('[1/9] Measuring bootstrap time...');
  const initResult = await benchmarkEmbeddingInit();
  allResults.push(initResult);
  console.log(`      ${initResult.actual}`);

  // Create a shared engine for subsequent benchmarks
  const engine = new EmbeddingEngine();
  await engine.initialize();

  // 2. Embedding latency
  console.log('[2/9] Measuring embedding latency...');
  const latencyResult = await benchmarkEmbeddingLatency(engine);
  allResults.push(latencyResult);
  console.log(`      ${latencyResult.actual}`);

  // 3. Perturbation quality
  console.log('[3/9] Evaluating perturbation quality...');
  const perturbResults = await benchmarkPerturbationQuality();
  allResults.push(...perturbResults);
  for (const r of perturbResults) console.log(`      ${r.name}: ${r.actual}`);

  // 4. HNSW performance
  console.log('[4/9] Benchmarking HNSW index...');
  const hnswResults = await benchmarkHnswPerformance(quick);
  allResults.push(...hnswResults);
  for (const r of hnswResults) console.log(`      ${r.name}: ${r.actual}`);

  // 5. Match recall
  console.log('[5/9] Measuring match recall...');
  const recallResults = await benchmarkMatchRecall(engine);
  allResults.push(...recallResults);
  for (const r of recallResults) console.log(`      ${r.name}: ${r.actual}`);

  // 6. Complementary matching (query rewriting)
  console.log('[6/9] Evaluating complementary matching...');
  const complementaryResults = await benchmarkComplementaryMatching(engine);
  allResults.push(...complementaryResults);
  for (const r of complementaryResults) console.log(`      ${r.name}: ${r.actual}`);

  // 7. Complementary index (MatchingIndex vs flat)
  console.log('[7/9] Evaluating complementary index...');
  const ciResults = await benchmarkComplementaryIndex(engine);
  allResults.push(...ciResults);
  for (const r of ciResults) console.log(`      ${r.name}: ${r.actual}`);

  // 8. Multilingual
  console.log('[8/9] Evaluating multilingual capability...');
  const mlResults = await benchmarkMultilingual(engine);
  allResults.push(...mlResults);
  for (const r of mlResults) console.log(`      ${r.name}: ${r.actual}`);

  // 9. False positive rate + end-to-end latency
  console.log('[9/9] Measuring FPR and end-to-end latency...');
  const fprResult = await benchmarkFalsePositiveRate(engine);
  allResults.push(fprResult);
  console.log(`      FPR: ${fprResult.actual}`);

  const e2eResult = await benchmarkEndToEnd(engine);
  allResults.push(e2eResult);
  console.log(`      E2E: ${e2eResult.actual}`);

  // Print results table
  printResults(allResults);

  // Write reports
  const jsonPath = writeJsonReport(allResults);
  const mdPath = writeMarkdownReport(allResults, PROJECT_ROOT);
  console.log(`JSON report: ${jsonPath}`);
  console.log(`Markdown report: ${mdPath}\n`);

  // Set exit code
  const testable = allResults.filter(r => r.target !== 'info');
  const allPassed = testable.every(r => r.passed);
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((err) => {
  console.error('Eval failed:', err);
  process.exitCode = 2;
});
