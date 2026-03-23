import { EmbeddingEngine, rewriteForMatching, perturbVector, cosineSimilarity, type BenchmarkResult } from '@resonance/core';
import { HnswIndex, MatchingIndex } from '@resonance/relay';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateRandomUnitVector } from '../utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DatasetPair { id: string; need: string; offer: string; }
interface Dataset { positive_pairs: DatasetPair[]; negative_pairs: DatasetPair[]; }

function loadDataset(): Dataset {
  const path = join(__dirname, '../../fixtures/dataset.json');
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Benchmark: MatchingIndex (complementary pairing) vs HnswIndex (flat).
 *
 * With MatchingIndex, needs only match offers. This eliminates same-type noise
 * and focuses the search on genuinely complementary items.
 */
export async function benchmarkComplementaryIndex(engine: EmbeddingEngine): Promise<BenchmarkResult[]> {
  const dataset = loadDataset();
  const pairs = dataset.positive_pairs;
  const results: BenchmarkResult[] = [];

  const epsilon = 1.0;
  const threshold = 0.50;
  const confirmThreshold = 0.55;
  const distractorNeeds = 500;
  const distractorOffers = 500;

  console.log(`  Embedding ${pairs.length} pairs...`);

  // Embed everything
  const needVecs: Float32Array[] = [];
  const offerVecs: Float32Array[] = [];
  for (const pair of pairs) {
    needVecs.push(await engine.embed(rewriteForMatching(pair.need, 'need'), 'search_query'));
    offerVecs.push(await engine.embed(pair.offer, 'search_document'));
  }

  // --- MatchingIndex (complementary) ---
  console.log(`  MatchingIndex: ${distractorNeeds} distractor needs + ${distractorOffers} distractor offers...`);
  const mIdx = new MatchingIndex({ maxElements: pairs.length + distractorOffers + 100 });
  mIdx.initialize();

  // Index real offers (perturbed)
  for (let i = 0; i < pairs.length; i++) {
    mIdx.addVector(perturbVector(offerVecs[i], epsilon).perturbed, {
      did: `did:test:offer-${i}`, itemType: 'offer', itemId: pairs[i].id,
    });
  }

  // Distractor offers (random)
  for (let i = 0; i < distractorOffers; i++) {
    mIdx.addVector(generateRandomUnitVector(768), {
      did: `did:test:d-offer-${i}`, itemType: 'offer', itemId: `d-offer-${i}`,
    });
  }

  // Distractor needs (these should NEVER appear in results since we search offers)
  for (let i = 0; i < distractorNeeds; i++) {
    mIdx.addVector(generateRandomUnitVector(768), {
      did: `did:test:d-need-${i}`, itemType: 'need', itemId: `d-need-${i}`,
    });
  }

  // Search: needs against offers (complementary)
  let mHits = 0;
  let mTotalMatches = 0;
  let mFP = 0;
  for (let i = 0; i < pairs.length; i++) {
    const r = mIdx.search(needVecs[i], 'need', 10, threshold);
    mTotalMatches += r.length;
    if (r.some(m => m.label === i)) mHits++;
    for (const match of r) {
      const trueSim = cosineSimilarity(needVecs[i], offerVecs[match.label] ?? new Float32Array(768));
      if (match.label < pairs.length && trueSim < confirmThreshold) mFP++;
      if (match.label >= pairs.length) mFP++; // distractor = false positive
    }
  }

  const mRecall = mHits / pairs.length;
  const mFPR = mTotalMatches > 0 ? mFP / mTotalMatches : 0;

  results.push({
    name: 'MatchingIndex recall (ε=1.0 @0.50)',
    target: '>75%',
    actual: `${(mRecall * 100).toFixed(1)}% (${mHits}/${pairs.length}), ${mTotalMatches} matches`,
    value: mRecall,
    passed: mRecall >= 0.75,
    details: { recall: mRecall, hits: mHits, total: pairs.length, matchesReturned: mTotalMatches, distractorNeeds, distractorOffers },
  });

  results.push({
    name: 'MatchingIndex FPR (ε=1.0 @0.50)',
    target: '<20%',
    actual: `${(mFPR * 100).toFixed(1)}% (${mFP}/${mTotalMatches})`,
    value: mFPR,
    passed: mFPR < 0.20,
    details: { fpr: mFPR, fp: mFP, totalMatches: mTotalMatches, confirmThreshold },
  });

  // --- Flat HnswIndex (old approach, for comparison) ---
  console.log(`  Flat HnswIndex (comparison)...`);
  const fIdx = new HnswIndex({ maxElements: pairs.length * 2 + distractorNeeds + distractorOffers + 100 });
  fIdx.initialize();

  // Index both needs and offers (the old way)
  for (let i = 0; i < pairs.length; i++) {
    fIdx.addVector(perturbVector(offerVecs[i], epsilon).perturbed, {
      did: `did:test:offer-${i}`, itemType: 'offer', itemId: pairs[i].id,
    });
  }
  // Also index all needs (the old approach treats them the same)
  for (let i = 0; i < pairs.length; i++) {
    fIdx.addVector(perturbVector(needVecs[i], epsilon).perturbed, {
      did: `did:test:need-${i}`, itemType: 'need', itemId: `need-${i}`,
    });
  }
  // Distractors
  for (let i = 0; i < distractorNeeds + distractorOffers; i++) {
    fIdx.addVector(generateRandomUnitVector(768), {
      did: `did:test:d-${i}`, itemType: i % 2 === 0 ? 'need' : 'offer', itemId: `d-${i}`,
    });
  }

  let fHits = 0;
  let fTotalMatches = 0;
  let fSameType = 0;
  for (let i = 0; i < pairs.length; i++) {
    const r = fIdx.search(needVecs[i], 10, threshold);
    fTotalMatches += r.length;
    if (r.some(m => m.label === i)) fHits++;
    // Count how many results are same-type (need matched need = wasted slot)
    for (const match of r) {
      const meta = fIdx.getMetadata(match.label);
      if (meta?.itemType === 'need') fSameType++;
    }
  }

  const fRecall = fHits / pairs.length;
  const sameTypePct = fTotalMatches > 0 ? fSameType / fTotalMatches : 0;

  results.push({
    name: 'Flat index recall (ε=1.0 @0.50)',
    target: 'info',
    actual: `${(fRecall * 100).toFixed(1)}% (${fHits}/${pairs.length}), ${fTotalMatches} matches`,
    value: fRecall,
    passed: true,
    details: { recall: fRecall, hits: fHits, total: pairs.length, matchesReturned: fTotalMatches },
  });

  results.push({
    name: 'Flat index same-type noise',
    target: 'info',
    actual: `${(sameTypePct * 100).toFixed(1)}% of matches are same-type (${fSameType}/${fTotalMatches})`,
    value: sameTypePct,
    passed: true,
    details: { sameType: fSameType, totalMatches: fTotalMatches, sameTypePct },
  });

  return results;
}
