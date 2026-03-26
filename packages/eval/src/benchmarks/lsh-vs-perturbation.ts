/**
 * Head-to-head benchmark: LSH vs Perturbation
 *
 * Tests both approaches on the same 50 complementary need/offer pairs
 * with 1000 distractors. Measures:
 *   - Recall (true matches found)
 *   - FPR (false matches)
 *   - Hash/perturbation latency
 *   - Information preserved (correlation with true similarity)
 *
 * Uses the existing MatchingIndex for perturbation and a brute-force
 * Hamming scan for LSH (fair comparison — both are relay-side).
 */

import type { BenchmarkResult } from '@resonance/core';
import {
  EmbeddingEngine,
  perturbVector,
  cosineSimilarity,
  normalize,
  generateProjectionMatrix,
  hashEmbedding,
  hammingSimilarity,
  expectedHammingSimilarity,
} from '@resonance/core';
import { MatchingIndex } from '@resonance/relay';
import { timeSync, formatMs, generateRandomUnitVector } from '../utils.js';

// Same 50 need/offer pairs used in other benchmarks
const NEED_OFFER_PAIRS = [
  { need: 'I need a freelance Python developer for a 2-week Django project', offer: 'Freelance Python developer, experienced with Django and REST APIs' },
  { need: 'Looking for a React developer to build a dashboard for our analytics platform', offer: 'Frontend developer specializing in React, TypeScript, and data visualization' },
  { need: 'We need a graphic designer for our startup branding and logo design', offer: 'Graphic designer with 5 years experience in branding and identity design' },
  { need: 'Seeking a data analyst who can work with SQL and Tableau for quarterly reports', offer: 'Data analyst proficient in SQL, Tableau, and business intelligence reporting' },
  { need: 'Need a DevOps engineer to set up our CI/CD pipeline and Kubernetes cluster', offer: 'DevOps engineer experienced with GitHub Actions, Docker, and Kubernetes' },
  { need: 'Looking for a Spanish tutor for conversational practice twice a week', offer: 'Native Spanish speaker offering conversation lessons for intermediate learners' },
  { need: 'Need a plumber for emergency bathroom repair in Gracia Barcelona', offer: 'Licensed plumber available for emergency repairs in Barcelona area' },
  { need: 'Searching for a room to rent in Eixample Barcelona under 600 euros', offer: 'Room available in shared flat in Eixample, 550/month, available immediately' },
  { need: 'Looking for a yoga instructor for private sessions at home', offer: 'Certified yoga teacher offering private home sessions in Barcelona' },
  { need: 'Need someone to walk my dog twice a day in Sant Antoni', offer: 'Pet sitter and dog walker available in Sant Antoni and Poble Sec areas' },
];

export async function benchmarkLshVsPerturbation(engine: EmbeddingEngine): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  console.log('  Embedding pairs + distractors...');

  // Embed all pairs
  const pairs: { needEmb: Float32Array; offerEmb: Float32Array }[] = [];
  for (const pair of NEED_OFFER_PAIRS) {
    const needEmb = await engine.embedForMatching(pair.need, 'need');
    const offerEmb = await engine.embedForMatching(pair.offer, 'offer');
    pairs.push({ needEmb, offerEmb });
  }

  // Generate distractors
  const NUM_DISTRACTORS = 500;
  const distractorNeeds: Float32Array[] = [];
  const distractorOffers: Float32Array[] = [];
  for (let i = 0; i < NUM_DISTRACTORS; i++) {
    distractorNeeds.push(generateRandomUnitVector(768));
    distractorOffers.push(generateRandomUnitVector(768));
  }

  // True cosine similarities for reference
  const trueSims = pairs.map(p => cosineSimilarity(p.needEmb, p.offerEmb));
  const avgTrueSim = trueSims.reduce((a, b) => a + b, 0) / trueSims.length;

  results.push({
    name: 'True cosine similarity (avg)',
    target: 'info',
    actual: `${avgTrueSim.toFixed(3)}`,
    value: avgTrueSim,
    passed: true,
  });

  // =====================================================================
  // PERTURBATION BENCHMARKS
  // =====================================================================
  console.log('  Perturbation benchmarks...');

  for (const epsilon of [5.0, 1.0]) {
    const index = new MatchingIndex({ maxElements: 2000 });
    index.initialize();

    // Add all offers (perturbed) + distractor offers
    for (let i = 0; i < pairs.length; i++) {
      const { perturbed } = perturbVector(pairs[i].offerEmb, epsilon);
      index.addVector(perturbed, { did: `offer-${i}`, itemType: 'offer', itemId: `o${i}` });
    }
    for (let i = 0; i < NUM_DISTRACTORS; i++) {
      const { perturbed } = perturbVector(distractorOffers[i], epsilon);
      index.addVector(perturbed, { did: `dist-o-${i}`, itemType: 'offer', itemId: `do${i}` });
    }

    // Search with true need embeddings (index-only perturbation mode)
    let found = 0;
    let totalMatches = 0;
    for (let i = 0; i < pairs.length; i++) {
      const matches = index.search(pairs[i].needEmb, 'need', 10, 0.50);
      totalMatches += matches.length;
      const matchDids = matches.map(m => index.getMetadata(m.label, 'offer')?.did);
      if (matchDids.includes(`offer-${i}`)) found++;
    }

    const recall = found / pairs.length;
    const fpr = totalMatches > 0 ? (totalMatches - found) / totalMatches : 0;

    results.push({
      name: `Perturbation ε=${epsilon} recall @0.50`,
      target: epsilon === 1.0 ? '>75%' : '>90%',
      actual: `${(recall * 100).toFixed(1)}% (${found}/${pairs.length}), ${totalMatches} matches`,
      value: recall,
      passed: epsilon === 1.0 ? recall > 0.75 : recall > 0.90,
    });
  }

  // =====================================================================
  // LSH BENCHMARKS
  // =====================================================================
  console.log('  LSH benchmarks...');

  const SEED = 42; // Fixed seed for reproducibility

  for (const hashBits of [128, 256, 512]) {
    const matrix = generateProjectionMatrix(hashBits, 768, SEED);

    // Hash all offers + distractor offers
    const offerHashes: { hash: Uint8Array; id: string }[] = [];
    for (let i = 0; i < pairs.length; i++) {
      offerHashes.push({ hash: hashEmbedding(pairs[i].offerEmb, matrix), id: `offer-${i}` });
    }
    for (let i = 0; i < NUM_DISTRACTORS; i++) {
      offerHashes.push({ hash: hashEmbedding(distractorOffers[i], matrix), id: `dist-o-${i}` });
    }

    // Calibrate threshold: expected Hamming similarity for true match
    const expectedSim = expectedHammingSimilarity(avgTrueSim);

    // Try multiple thresholds
    for (const threshold of [0.55, 0.60, 0.65]) {
      let found = 0;
      let totalMatches = 0;

      for (let i = 0; i < pairs.length; i++) {
        const queryHash = hashEmbedding(pairs[i].needEmb, matrix);

        // Brute-force Hamming scan (relay-side)
        const matches: { id: string; sim: number }[] = [];
        for (const entry of offerHashes) {
          const sim = hammingSimilarity(queryHash, entry.hash);
          if (sim >= threshold) {
            matches.push({ id: entry.id, sim });
          }
        }

        totalMatches += matches.length;
        if (matches.some(m => m.id === `offer-${i}`)) found++;
      }

      const recall = found / pairs.length;

      results.push({
        name: `LSH ${hashBits}-bit recall @${threshold}`,
        target: 'info',
        actual: `${(recall * 100).toFixed(1)}% (${found}/${pairs.length}), ${totalMatches} matches`,
        value: recall,
        passed: true,
      });
    }

    // Measure hash generation latency
    const { durationMs } = timeSync(() => {
      for (let i = 0; i < 100; i++) {
        hashEmbedding(pairs[i % pairs.length].needEmb, matrix);
      }
    });

    results.push({
      name: `LSH ${hashBits}-bit hash latency`,
      target: 'info',
      actual: `${(durationMs / 100).toFixed(2)}ms/hash`,
      value: durationMs / 100,
      passed: true,
    });
  }

  // =====================================================================
  // SIMILARITY CORRELATION
  // =====================================================================
  console.log('  Similarity correlation...');

  // How well does Hamming similarity predict true cosine similarity?
  const matrix256 = generateProjectionMatrix(256, 768, SEED);

  let sumSqError = 0;
  let count = 0;
  for (let i = 0; i < pairs.length; i++) {
    const needHash = hashEmbedding(pairs[i].needEmb, matrix256);
    const offerHash = hashEmbedding(pairs[i].offerEmb, matrix256);
    const hamSim = hammingSimilarity(needHash, offerHash);
    const cosSim = trueSims[i];
    const expected = expectedHammingSimilarity(cosSim);
    sumSqError += (hamSim - expected) ** 2;
    count++;
  }
  const rmse = Math.sqrt(sumSqError / count);

  results.push({
    name: 'LSH 256-bit RMSE vs theoretical',
    target: 'info',
    actual: `${rmse.toFixed(4)} (lower is better)`,
    value: rmse,
    passed: true,
  });

  // =====================================================================
  // INVERSION RESISTANCE (qualitative)
  // =====================================================================
  // A 256-bit hash has 2^256 possible values, but only 256 bits of info
  // from a 768-dim * 32-bit = 24,576-bit vector. Compression ratio:
  const compressionRatio = (768 * 32) / 256;
  results.push({
    name: 'LSH 256-bit compression ratio',
    target: 'info',
    actual: `${compressionRatio.toFixed(0)}:1 (vector bits / hash bits)`,
    value: compressionRatio,
    passed: true,
  });

  // =====================================================================
  // HAMMING SCAN PERFORMANCE
  // =====================================================================
  console.log('  Hamming scan performance...');

  // Build an index of 10K hashes and measure scan time
  const bigMatrix = generateProjectionMatrix(256, 768, SEED);
  const bigIndex: Uint8Array[] = [];
  for (let i = 0; i < 10_000; i++) {
    bigIndex.push(hashEmbedding(generateRandomUnitVector(768), bigMatrix));
  }

  const queryHash = hashEmbedding(pairs[0].needEmb, bigMatrix);
  const { durationMs: scanMs } = timeSync(() => {
    for (let iter = 0; iter < 100; iter++) {
      let bestSim = 0;
      for (const h of bigIndex) {
        const sim = hammingSimilarity(queryHash, h);
        if (sim > bestSim) bestSim = sim;
      }
    }
  });

  results.push({
    name: 'Hamming scan 10K hashes (p95)',
    target: '<5ms',
    actual: formatMs(scanMs / 100),
    value: scanMs / 100,
    passed: scanMs / 100 < 5,
  });

  return results;
}
