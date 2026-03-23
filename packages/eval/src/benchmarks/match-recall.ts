import { EmbeddingEngine, perturbVector, cosineSimilarity, type BenchmarkResult } from '@resonance/core';
import { HnswIndex } from '@resonance/relay';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateRandomUnitVector } from '../utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DatasetPair {
  id: string;
  category?: string;
  need: string;
  offer: string;
}

interface Dataset {
  positive_pairs: DatasetPair[];
  negative_pairs: DatasetPair[];
}

function loadDataset(): Dataset {
  const path = join(__dirname, '../../fixtures/dataset.json');
  return JSON.parse(readFileSync(path, 'utf-8'));
}

type PerturbMode = 'none' | 'index-only' | 'both';

/**
 * Core recall measurement.
 * @param perturbMode - 'none' (baseline), 'index-only' (single perturb), 'both' (double perturb)
 */
function measureRecall(
  needEmbeddings: Float32Array[],
  offerEmbeddings: Float32Array[],
  pairs: DatasetPair[],
  epsilon: number,
  threshold: number,
  distractorCount: number,
  perturbMode: PerturbMode,
): { recall: number; hits: number; total: number; matchesReturned: number } {
  const index = new HnswIndex({ maxElements: pairs.length + distractorCount + 100 });
  index.initialize();

  // Insert offers — perturbed if mode is 'index-only' or 'both'
  for (let i = 0; i < pairs.length; i++) {
    const vec = perturbMode === 'none'
      ? offerEmbeddings[i]
      : perturbVector(offerEmbeddings[i], epsilon).perturbed;
    index.addVector(vec, {
      did: `did:test:offer-${i}`,
      itemType: 'offer',
      itemId: pairs[i].id,
    });
  }

  // Distractors
  for (let i = 0; i < distractorCount; i++) {
    index.addVector(generateRandomUnitVector(768), {
      did: `did:test:distractor-${i}`,
      itemType: 'offer',
      itemId: `distractor-${i}`,
    });
  }

  // Search — perturb queries only in 'both' mode
  let hits = 0;
  let matchesReturned = 0;
  for (let i = 0; i < pairs.length; i++) {
    const queryVec = perturbMode === 'both'
      ? perturbVector(needEmbeddings[i], epsilon).perturbed
      : needEmbeddings[i]; // true embedding for 'none' and 'index-only'
    const results = index.search(queryVec, 10, threshold);
    matchesReturned += results.length;
    if (results.some(r => r.label === i)) hits++;
  }

  return { recall: hits / pairs.length, hits, total: pairs.length, matchesReturned };
}

/**
 * Benchmark: match recall under various conditions.
 *
 * Tests three perturbation modes:
 * - none: baseline (true embeddings)
 * - index-only: only published items perturbed (queries use true embeddings)
 * - both: both query and index perturbed (worst case)
 *
 * At multiple thresholds to find the sweet spot.
 */
export async function benchmarkMatchRecall(engine: EmbeddingEngine): Promise<BenchmarkResult[]> {
  const dataset = loadDataset();
  const pairs = dataset.positive_pairs;

  console.log(`  Embedding ${pairs.length} positive pairs...`);

  const needEmbeddings: Float32Array[] = [];
  const offerEmbeddings: Float32Array[] = [];

  for (const pair of pairs) {
    needEmbeddings.push(await engine.embed(pair.need, 'search_query'));
    offerEmbeddings.push(await engine.embed(pair.offer, 'search_document'));
  }

  // True similarity stats
  const trueSims = needEmbeddings.map((n, i) => cosineSimilarity(n, offerEmbeddings[i]));
  const avgTrueSim = trueSims.reduce((a, b) => a + b, 0) / trueSims.length;
  const minTrueSim = Math.min(...trueSims);
  const maxTrueSim = Math.max(...trueSims);
  console.log(`  True similarity: avg=${avgTrueSim.toFixed(3)}, min=${minTrueSim.toFixed(3)}, max=${maxTrueSim.toFixed(3)}`);

  const distractors = 1000;
  const results: BenchmarkResult[] = [];

  // --- True similarity stat as a result ---
  results.push({
    name: 'True need/offer similarity (avg)',
    target: 'info',
    actual: `${avgTrueSim.toFixed(3)} (min=${minTrueSim.toFixed(3)}, max=${maxTrueSim.toFixed(3)})`,
    value: avgTrueSim,
    passed: true,
    details: { avgTrueSim, minTrueSim, maxTrueSim },
  });

  // --- Test matrix: mode × epsilon × threshold ---
  const configs: Array<{
    mode: PerturbMode;
    epsilon: number;
    threshold: number;
    label: string;
    target?: number;
  }> = [
    // Baseline at different thresholds
    { mode: 'none', epsilon: Infinity, threshold: 0.72, label: 'Baseline @0.72' },
    { mode: 'none', epsilon: Infinity, threshold: 0.50, label: 'Baseline @0.50' },

    // INDEX-ONLY perturbation (recommended protocol: queries use true embeddings)
    { mode: 'index-only', epsilon: 5.0, threshold: 0.50, label: 'Index-only ε=5.0 @0.50', target: 0.90 },
    { mode: 'index-only', epsilon: 1.0, threshold: 0.50, label: 'Index-only ε=1.0 @0.50', target: 0.75 },
    { mode: 'index-only', epsilon: 1.0, threshold: 0.40, label: 'Index-only ε=1.0 @0.40' },

    // DOUBLE perturbation (worst case: both sides perturbed)
    { mode: 'both', epsilon: 5.0, threshold: 0.50, label: 'Double ε=5.0 @0.50' },
    { mode: 'both', epsilon: 1.0, threshold: 0.50, label: 'Double ε=1.0 @0.50' },
    { mode: 'both', epsilon: 1.0, threshold: 0.30, label: 'Double ε=1.0 @0.30' },
  ];

  console.log(`  Running recall matrix (${configs.length} configs, ${distractors} distractors)...`);

  for (const cfg of configs) {
    const r = measureRecall(needEmbeddings, offerEmbeddings, pairs, cfg.epsilon, cfg.threshold, distractors, cfg.mode);
    const hasTarget = cfg.target !== undefined;
    results.push({
      name: `Recall: ${cfg.label}`,
      target: hasTarget ? `>${(cfg.target! * 100).toFixed(0)}%` : 'info',
      actual: `${(r.recall * 100).toFixed(1)}% (${r.hits}/${r.total}), ${r.matchesReturned} matches`,
      value: r.recall,
      passed: hasTarget ? r.recall >= cfg.target! : true,
      details: {
        mode: cfg.mode,
        epsilon: cfg.epsilon === Infinity ? 'none' : cfg.epsilon,
        threshold: cfg.threshold,
        ...r,
        distractors,
      },
    });
  }

  return results;
}
