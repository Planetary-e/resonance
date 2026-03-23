import { EmbeddingEngine, rewriteForMatching, cosineSimilarity, perturbVector, type BenchmarkResult } from '@resonance/core';
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

/**
 * Benchmark: complementary matching with query rewriting.
 *
 * Compares:
 * 1. Raw similarity (need embedded as-is vs offer)
 * 2. Rewritten similarity (need rewritten to offer-like framing vs offer)
 * 3. Recall with rewriting at various thresholds and epsilon levels
 */
export async function benchmarkComplementaryMatching(engine: EmbeddingEngine): Promise<BenchmarkResult[]> {
  const dataset = loadDataset();
  const pairs = dataset.positive_pairs;
  const results: BenchmarkResult[] = [];

  console.log(`  Embedding ${pairs.length} pairs (raw + rewritten)...`);

  // Embed all offers (these stay the same)
  const offerEmbeddings: Float32Array[] = [];
  for (const pair of pairs) {
    offerEmbeddings.push(await engine.embed(pair.offer, 'search_document'));
  }

  // Embed needs — raw
  const rawNeedEmbeddings: Float32Array[] = [];
  for (const pair of pairs) {
    rawNeedEmbeddings.push(await engine.embed(pair.need, 'search_query'));
  }

  // Embed needs — rewritten for matching
  const rewrittenNeedEmbeddings: Float32Array[] = [];
  const rewrittenTexts: string[] = [];
  for (const pair of pairs) {
    const rewritten = rewriteForMatching(pair.need, 'need');
    rewrittenTexts.push(rewritten);
    rewrittenNeedEmbeddings.push(await engine.embed(rewritten, 'search_query'));
  }

  // Compare raw vs rewritten similarity
  const rawSims = rawNeedEmbeddings.map((n, i) => cosineSimilarity(n, offerEmbeddings[i]));
  const rewrittenSims = rewrittenNeedEmbeddings.map((n, i) => cosineSimilarity(n, offerEmbeddings[i]));

  const avgRaw = rawSims.reduce((a, b) => a + b, 0) / rawSims.length;
  const avgRewritten = rewrittenSims.reduce((a, b) => a + b, 0) / rewrittenSims.length;
  const improvement = avgRewritten - avgRaw;

  results.push({
    name: 'Similarity: raw needs vs offers',
    target: 'info',
    actual: `avg=${avgRaw.toFixed(3)}, min=${Math.min(...rawSims).toFixed(3)}, max=${Math.max(...rawSims).toFixed(3)}`,
    value: avgRaw,
    passed: true,
    details: { avgRaw, minRaw: Math.min(...rawSims), maxRaw: Math.max(...rawSims) },
  });

  results.push({
    name: 'Similarity: rewritten needs vs offers',
    target: 'info',
    actual: `avg=${avgRewritten.toFixed(3)}, min=${Math.min(...rewrittenSims).toFixed(3)}, max=${Math.max(...rewrittenSims).toFixed(3)}`,
    value: avgRewritten,
    passed: true,
    details: { avgRewritten, minRewritten: Math.min(...rewrittenSims), maxRewritten: Math.max(...rewrittenSims) },
  });

  results.push({
    name: 'Rewriting improvement',
    target: '>0',
    actual: `+${(improvement * 100).toFixed(1)}pp (${avgRaw.toFixed(3)} → ${avgRewritten.toFixed(3)})`,
    value: improvement,
    passed: improvement > 0,
    details: { improvement, avgRaw, avgRewritten },
  });

  // Log some examples of rewriting
  console.log('  Sample rewrites:');
  for (let i = 0; i < Math.min(5, pairs.length); i++) {
    const rawSim = rawSims[i].toFixed(3);
    const rewSim = rewrittenSims[i].toFixed(3);
    console.log(`    "${pairs[i].need.slice(0, 50)}..." → "${rewrittenTexts[i].slice(0, 50)}..." (${rawSim} → ${rewSim})`);
  }

  // Recall with rewriting: index-only perturbation, threshold 0.50
  const distractors = 1000;
  const configs = [
    { epsilon: 5.0, threshold: 0.50, label: 'ε=5.0 @0.50', target: 0.90 },
    { epsilon: 1.0, threshold: 0.50, label: 'ε=1.0 @0.50', target: 0.75 },
  ];

  console.log(`  Recall with rewriting (${distractors} distractors, index-only)...`);

  for (const cfg of configs) {
    const index = new HnswIndex({ maxElements: pairs.length + distractors + 100 });
    index.initialize();

    // Index offers (perturbed)
    for (let i = 0; i < pairs.length; i++) {
      index.addVector(perturbVector(offerEmbeddings[i], cfg.epsilon).perturbed, {
        did: `did:test:offer-${i}`,
        itemType: 'offer',
        itemId: pairs[i].id,
      });
    }

    // Distractors
    for (let i = 0; i < distractors; i++) {
      index.addVector(generateRandomUnitVector(768), {
        did: `did:test:d-${i}`,
        itemType: 'offer',
        itemId: `d-${i}`,
      });
    }

    // Search with REWRITTEN needs (true embeddings, index-only mode)
    let hits = 0;
    let matchesReturned = 0;
    for (let i = 0; i < pairs.length; i++) {
      const r = index.search(rewrittenNeedEmbeddings[i], 10, cfg.threshold);
      matchesReturned += r.length;
      if (r.some(m => m.label === i)) hits++;
    }

    const recall = hits / pairs.length;
    results.push({
      name: `Recall (rewritten) ${cfg.label}`,
      target: `>${(cfg.target * 100).toFixed(0)}%`,
      actual: `${(recall * 100).toFixed(1)}% (${hits}/${pairs.length}), ${matchesReturned} matches`,
      value: recall,
      passed: recall >= cfg.target,
      details: { epsilon: cfg.epsilon, threshold: cfg.threshold, hits, total: pairs.length, recall, matchesReturned, distractors, mode: 'rewritten+index-only' },
    });
  }

  // FPR with rewriting
  const fprEpsilon = 1.0;
  const fprThreshold = 0.50;
  const confirmThreshold = 0.55;

  const fprIndex = new HnswIndex({ maxElements: pairs.length + 100 });
  fprIndex.initialize();
  for (let i = 0; i < pairs.length; i++) {
    fprIndex.addVector(perturbVector(offerEmbeddings[i], fprEpsilon).perturbed, {
      did: `did:test:offer-${i}`,
      itemType: 'offer',
      itemId: pairs[i].id,
    });
  }

  let totalMatches = 0;
  let falsePositives = 0;

  // Test positive needs (rewritten)
  for (let i = 0; i < pairs.length; i++) {
    const r = fprIndex.search(rewrittenNeedEmbeddings[i], 5, fprThreshold);
    for (const match of r) {
      totalMatches++;
      // True similarity: rewritten need vs true offer
      const trueSim = cosineSimilarity(rewrittenNeedEmbeddings[i], offerEmbeddings[match.label]);
      if (trueSim < confirmThreshold) falsePositives++;
    }
  }

  // Test negative needs (rewritten)
  for (const neg of dataset.negative_pairs) {
    const rewritten = rewriteForMatching(neg.need, 'need');
    const vec = await engine.embed(rewritten, 'search_query');
    const r = fprIndex.search(vec, 5, fprThreshold);
    for (const match of r) {
      totalMatches++;
      const trueSim = cosineSimilarity(vec, offerEmbeddings[match.label]);
      if (trueSim < confirmThreshold) falsePositives++;
    }
  }

  const fpr = totalMatches > 0 ? falsePositives / totalMatches : 0;
  results.push({
    name: 'FPR (rewritten, ε=1.0 @0.50)',
    target: '<30%',
    actual: `${(fpr * 100).toFixed(1)}% (${falsePositives}/${totalMatches})`,
    value: fpr,
    passed: fpr < 0.30,
    details: { falsePositives, totalMatches, fpr, confirmThreshold },
  });

  return results;
}
