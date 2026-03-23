import { EmbeddingEngine, perturbVector, cosineSimilarity, type BenchmarkResult } from '@resonance/core';
import { HnswIndex } from '@resonance/relay';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DatasetPair {
  id: string;
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
 * Benchmark: false positive rate at ε=1.0, index-only perturbation.
 *
 * Uses the recommended protocol (queries use true embeddings, only index is perturbed)
 * with the adjusted threshold of 0.50.
 *
 * A false positive = a match returned above the relay threshold where the
 * TRUE cosine similarity < confirmThreshold (would fail direct channel confirmation).
 */
export async function benchmarkFalsePositiveRate(engine: EmbeddingEngine): Promise<BenchmarkResult> {
  const dataset = loadDataset();
  const epsilon = 1.0;
  const relayThreshold = 0.50;
  const confirmThreshold = 0.55;

  const offers = dataset.positive_pairs;
  const allNeeds = [...dataset.positive_pairs, ...dataset.negative_pairs];

  console.log(`  Embedding ${offers.length} offers and ${allNeeds.length} needs for FPR...`);

  // Embed and store true offer embeddings
  const trueOfferEmbeddings: Float32Array[] = [];
  for (const pair of offers) {
    trueOfferEmbeddings.push(await engine.embed(pair.offer, 'search_document'));
  }

  // Build index with perturbed offers (index-only mode)
  const index = new HnswIndex({ maxElements: offers.length + 100 });
  index.initialize();
  for (let i = 0; i < offers.length; i++) {
    index.addVector(perturbVector(trueOfferEmbeddings[i], epsilon).perturbed, {
      did: `did:test:offer-${i}`,
      itemType: 'offer',
      itemId: offers[i].id,
    });
  }

  // Search with TRUE need embeddings (index-only perturbation mode)
  let totalMatches = 0;
  let falsePositives = 0;
  let truePositives = 0;

  for (const pair of allNeeds) {
    const trueNeedVec = await engine.embed(pair.need, 'search_query');
    // Query uses TRUE embedding (not perturbed)
    const results = index.search(trueNeedVec, 5, relayThreshold);

    for (const match of results) {
      totalMatches++;
      const trueSim = cosineSimilarity(trueNeedVec, trueOfferEmbeddings[match.label]);
      if (trueSim < confirmThreshold) {
        falsePositives++;
      } else {
        truePositives++;
      }
    }
  }

  const fpr = totalMatches > 0 ? falsePositives / totalMatches : 0;

  return {
    name: 'FPR (index-only ε=1.0 @0.50)',
    target: '<30%',
    actual: `${(fpr * 100).toFixed(1)}% (${falsePositives}/${totalMatches})`,
    value: fpr,
    passed: fpr < 0.30,
    details: {
      falsePositives,
      truePositives,
      totalMatches,
      fpr,
      epsilon,
      relayThreshold,
      confirmThreshold,
      mode: 'index-only',
    },
  };
}
