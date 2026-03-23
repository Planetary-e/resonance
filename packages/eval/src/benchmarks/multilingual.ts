import { EmbeddingEngine, rewriteForMatching, cosineSimilarity, type BenchmarkResult } from '@resonance/core';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CrossLangPair {
  id: string;
  need: string;
  need_lang: string;
  offer: string;
  offer_lang: string;
  category: string;
}

interface SameLangPair {
  id: string;
  need: string;
  offer: string;
  lang: string;
  category: string;
}

interface MultilingualDataset {
  cross_language_pairs: CrossLangPair[];
  same_language_pairs: SameLangPair[];
}

function loadDataset(): MultilingualDataset {
  const path = join(__dirname, '../../fixtures/multilingual.json');
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Benchmark: multilingual embedding quality.
 *
 * Tests:
 * 1. Cross-language similarity (e.g., Spanish need vs English offer)
 * 2. Same-language non-English similarity (e.g., Spanish need vs Spanish offer)
 * 3. Compares against English baseline from the main dataset
 */
export async function benchmarkMultilingual(engine: EmbeddingEngine): Promise<BenchmarkResult[]> {
  const dataset = loadDataset();
  const results: BenchmarkResult[] = [];

  // --- Cross-language pairs ---
  console.log(`  Cross-language: ${dataset.cross_language_pairs.length} pairs...`);
  const crossSims: number[] = [];
  const crossRewrittenSims: number[] = [];

  for (const pair of dataset.cross_language_pairs) {
    const needVec = await engine.embed(pair.need, 'search_query');
    const offerVec = await engine.embed(pair.offer, 'search_document');
    crossSims.push(cosineSimilarity(needVec, offerVec));

    const rewritten = rewriteForMatching(pair.need, 'need');
    const rewrittenVec = await engine.embed(rewritten, 'search_query');
    crossRewrittenSims.push(cosineSimilarity(rewrittenVec, offerVec));
  }

  const avgCross = crossSims.reduce((a, b) => a + b, 0) / crossSims.length;
  const avgCrossRewritten = crossRewrittenSims.reduce((a, b) => a + b, 0) / crossRewrittenSims.length;

  results.push({
    name: 'Cross-language similarity (raw)',
    target: 'info',
    actual: `avg=${avgCross.toFixed(3)}, min=${Math.min(...crossSims).toFixed(3)}, max=${Math.max(...crossSims).toFixed(3)}`,
    value: avgCross,
    passed: true,
    details: {
      avg: avgCross,
      min: Math.min(...crossSims),
      max: Math.max(...crossSims),
      pairs: dataset.cross_language_pairs.map((p, i) => ({
        id: p.id,
        langs: `${p.need_lang}→${p.offer_lang}`,
        similarity: crossSims[i],
      })),
    },
  });

  results.push({
    name: 'Cross-language similarity (rewritten)',
    target: 'info',
    actual: `avg=${avgCrossRewritten.toFixed(3)}, min=${Math.min(...crossRewrittenSims).toFixed(3)}, max=${Math.max(...crossRewrittenSims).toFixed(3)}`,
    value: avgCrossRewritten,
    passed: true,
    details: { avg: avgCrossRewritten, min: Math.min(...crossRewrittenSims), max: Math.max(...crossRewrittenSims) },
  });

  // --- Same-language non-English pairs ---
  console.log(`  Same-language: ${dataset.same_language_pairs.length} pairs...`);
  const sameSims: number[] = [];

  for (const pair of dataset.same_language_pairs) {
    const needVec = await engine.embed(pair.need, 'search_query');
    const offerVec = await engine.embed(pair.offer, 'search_document');
    sameSims.push(cosineSimilarity(needVec, offerVec));
  }

  const avgSame = sameSims.reduce((a, b) => a + b, 0) / sameSims.length;

  results.push({
    name: 'Same-language non-EN similarity',
    target: 'info',
    actual: `avg=${avgSame.toFixed(3)}, min=${Math.min(...sameSims).toFixed(3)}, max=${Math.max(...sameSims).toFixed(3)}`,
    value: avgSame,
    passed: true,
    details: {
      avg: avgSame,
      min: Math.min(...sameSims),
      max: Math.max(...sameSims),
      pairs: dataset.same_language_pairs.map((p, i) => ({
        id: p.id,
        lang: p.lang,
        similarity: sameSims[i],
      })),
    },
  });

  // --- Viability assessment ---
  // Compare against English baseline (avg 0.634 from main eval)
  // If cross-language is significantly lower, the model needs replacing
  const crossVsEnglishRatio = avgCross / 0.634;
  const needsMultilingualModel = avgCross < 0.40;

  results.push({
    name: 'Multilingual viability',
    target: '>0.40 avg',
    actual: needsMultilingualModel
      ? `NEEDS MULTILINGUAL MODEL (avg=${avgCross.toFixed(3)}, ${(crossVsEnglishRatio * 100).toFixed(0)}% of EN baseline)`
      : `OK (avg=${avgCross.toFixed(3)}, ${(crossVsEnglishRatio * 100).toFixed(0)}% of EN baseline)`,
    value: avgCross,
    passed: !needsMultilingualModel,
    details: { avgCross, englishBaseline: 0.634, ratio: crossVsEnglishRatio, needsMultilingualModel },
  });

  return results;
}
