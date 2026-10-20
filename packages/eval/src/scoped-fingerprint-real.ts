/** Real-model quality and explicit cross-scope attacks. No model downloads,
 * relay traffic or private user text. Gates are fixed before measuring. */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { env } from '@huggingface/transformers';
import { EmbeddingEngine, EMBEDDING_CONFIG, getScopedProjectionMatrixV2, getSharedProjectionMatrix,
  hashEmbedding, hammingSimilarity, cosineSimilarity, normalize } from '@resonance/core';

const { values } = parseArgs({ options: { out: { type: 'string' }, enforce: { type: 'boolean', default: false } } });
const root = fileURLToPath(new URL('../../../', import.meta.url));
const datasetPath = fileURLToPath(new URL('../fixtures/dataset.json', import.meta.url));
type Pair = { id: string; need: string; offer: string };
const source = readFileSync(datasetPath), dataset = JSON.parse(source.toString('utf8')) as { positive_pairs: Pair[]; negative_pairs: Pair[] };
const positives = dataset.positive_pairs, negatives = dataset.negative_pairs;
if (!positives.length || !negatives.length || [...positives, ...negatives].some(pair => !pair.id || !pair.need || !pair.offer)
  || new Set([...positives, ...negatives].map(pair => pair.id)).size !== positives.length + negatives.length) throw new Error('Invalid labeled evaluation corpus');
// Do not tune these after seeing the result. Precision is for this balanced
// labeled fixture only; unannotated cross-pairs are not counted as negatives.
const threshold = 0.65, maximumRecallDrop = 0.05, maximumFalsePositiveIncrease = 0.05, maximumLinkAccuracy = 0.05;
env.allowRemoteModels = false;
if (!env.cacheDir) throw new Error('A populated local model cache is required');
async function sha256(path: string) {
  const digest = createHash('sha256'); for await (const bytes of createReadStream(path)) digest.update(bytes); return digest.digest('hex');
}
const modelFiles = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'];
const modelArtifacts = await Promise.all(modelFiles.map(async file => ({ file, sha256: await sha256(join(env.cacheDir!, EMBEDDING_CONFIG.modelId, file)) })));
const started = performance.now(), cpuStarted = process.cpuUsage(), engine = new EmbeddingEngine();
console.error('Initializing cached FP32 model; remote downloads are disabled.');
await engine.initialize(); const initializationMs = performance.now() - started, embeddingStarted = performance.now();
const needs = [...new Set([...positives, ...negatives].map(pair => pair.need))], offers = [...new Set([...positives, ...negatives].map(pair => pair.offer))];
const needVectors = new Map<string, Float32Array>(), offerVectors = new Map<string, Float32Array>();
let completed = 0;
for (const [texts, type, destination] of [[needs, 'need', needVectors], [offers, 'offer', offerVectors]] as const) {
  for (const text of texts) {
    const vector = await engine.embedForMatching(text, type);
    if (vector.length !== 768 || [...vector].some(value => !Number.isFinite(value))) throw new Error('Invalid real model embedding');
    destination.set(text, vector);
    if (++completed % 20 === 0) console.error(`Embedded ${completed}/${needs.length + offers.length} labeled texts.`);
  }
}
const embeddingMs = performance.now() - embeddingStarted;
const scopes = [
  { label: 'pilot-static-v1', matrix: getSharedProjectionMatrix() },
  ...['2026-09', '2026-10', '2026-11'].flatMap(epoch => ['public', 'community-comparison'].map(group => ({ label: `${group}/${epoch}`, matrix: getScopedProjectionMatrixV2(group, epoch) }))),
];
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const rounded = (value: number) => Number(value.toFixed(6));
const hashes = scopes.map(scope => ({ label: scope.label, matrix: scope.matrix,
  needs: new Map(needs.map(text => [text, hashEmbedding(needVectors.get(text)!, scope.matrix)])),
  offers: offers.map(text => hashEmbedding(offerVectors.get(text)!, scope.matrix)) }));
const quality = hashes.map(scope => {
  const score = (pair: Pair) => hammingSimilarity(scope.needs.get(pair.need)!, scope.offers[offers.indexOf(pair.offer)]);
  const truePositives = positives.filter(pair => score(pair) >= threshold).length, falsePositives = negatives.filter(pair => score(pair) >= threshold).length;
  const retrieval = positives.map(pair => {
    const goal = offers.indexOf(pair.offer), query = scope.needs.get(pair.need)!, scores = scope.offers.map(hash => hammingSimilarity(query, hash));
    // Deterministic corpus order breaks exact score ties; report that convention.
    const rank = 1 + scores.filter((value, index) => value > scores[goal] || value === scores[goal] && index < goal).length;
    return { id: pair.id, similarity: scores[goal], rank, found: scores[goal] >= threshold && rank <= 5 };
  });
  return { scope: scope.label, truePositives, positiveCount: positives.length, falsePositives, negativeCount: negatives.length,
    recall: rounded(truePositives / positives.length), falsePositiveRate: rounded(falsePositives / negatives.length),
    balancedFixturePrecision: rounded(truePositives / Math.max(1, truePositives + falsePositives)),
    recallAt5: rounded(retrieval.filter(row => row.found).length / positives.length), retrieval };
});
// This adversary sees only public matrices and observed binary fingerprints.
// A signed sum of hyperplanes estimates a direction; no original text/vector is
// passed to reconstruction. Two colluding observers compare these estimates.
function reconstruct(hash: Uint8Array, matrix: Float32Array[]) {
  const vector = new Float32Array(768);
  for (let bit = 0; bit < matrix.length; bit++) {
    const sign = hash[bit >>> 3] & (1 << (bit & 7)) ? 1 : -1;
    for (let dimension = 0; dimension < vector.length; dimension++) vector[dimension] += sign * matrix[bit][dimension];
  }
  return normalize(vector);
}
function linking(sourceIndex: number, targetIndex: number) {
  const first = hashes[sourceIndex], second = hashes[targetIndex];
  // Reverse the target corpus: an index/position shortcut cannot yield matches.
  const candidates = second.offers.map((hash, id) => ({ id, hash, vector: reconstruct(hash, second.matrix) })).reverse();
  const attacks = first.offers.map((hash, id) => {
    const vector = reconstruct(hash, first.matrix);
    const ranked = candidates.map(candidate => ({ id: candidate.id, score: cosineSimilarity(vector, candidate.vector) }))
      .sort((a, b) => b.score - a.score || a.id - b.id);
    const correctScore = ranked.find(candidate => candidate.id === id)!.score;
    // Conservatively charge all equal-score candidates before the correct one;
    // corpus indices must never give an adversary credit for an ambiguous tie.
    const worstRank = 1 + ranked.filter(candidate => candidate.id !== id && candidate.score >= correctScore).length;
    const uniqueDictionaryMatch = (scope: typeof first) =>
      scope.offers.filter(candidate => hammingSimilarity(candidate, scope.offers[id]) === 1).length === 1;
    return { id, reconstructedTop1: worstRank === 1, reconstructedTop5: worstRank <= 5,
      // The known-corpus attack identifies the same text uniquely in BOTH
      // scopes. These candidate hashes were recomputed from the known texts.
      dictionaryUnique: uniqueDictionaryMatch(first) && uniqueDictionaryMatch(second),
      directSimilarity: hammingSimilarity(hash, second.offers[id]) };
  });
  return { from: first.label, to: second.label, candidates: offers.length, chanceTop1: rounded(1 / offers.length),
    rawEqualityCount: attacks.filter(row => row.directSimilarity === 1).length, meanDirectSimilarity: rounded(mean(attacks.map(row => row.directSimilarity))),
    reconstructedTop1: rounded(attacks.filter(row => row.reconstructedTop1).length / offers.length),
    reconstructedTop5: rounded(attacks.filter(row => row.reconstructedTop5).length / offers.length),
    dictionaryUniqueIdentification: rounded(attacks.filter(row => row.dictionaryUnique).length / offers.length) };
}
const attacks = [linking(1, 3), linking(1, 2), linking(3, 5)];
const baseline = quality[0], gates = {
  qualityRelativeToPilot: quality.slice(1).every(row => row.recall >= baseline.recall - maximumRecallDrop
    && row.recallAt5 >= baseline.recallAt5 - maximumRecallDrop && row.falsePositiveRate <= baseline.falsePositiveRate + maximumFalsePositiveIncrease),
  crossScopeLinking: attacks.every(row => row.reconstructedTop1 <= maximumLinkAccuracy && row.dictionaryUniqueIdentification <= maximumLinkAccuracy),
};
const cpu = process.cpuUsage(cpuStarted);
const report = { measuredAt: new Date().toISOString(), model: EMBEDDING_CONFIG.modelId, dtype: 'fp32', modelArtifacts,
  datasetSha256: createHash('sha256').update(source).digest('hex'), positivePairs: positives.length, negativePairs: negatives.length,
  uniqueNeedTexts: needs.length, uniqueOfferTexts: offers.length, threshold,
  targets: { maximumRecallDrop, maximumFalsePositiveIncrease, maximumLinkAccuracy }, gates, quality, attacks,
  resources: { initializationMs: rounded(initializationMs), embeddingMs: rounded(embeddingMs), totalMs: rounded(performance.now() - started),
    cpuSeconds: rounded((cpu.user + cpu.system) / 1e6), peakRssBytes: process.resourceUsage().maxRSS * 1024,
    node: process.version, platform: process.platform, architecture: process.arch },
  limitations: ['Fixed small English labeled fixture, not a representative deployment or multilingual quality study.',
    'Relative quality preservation is not absolute matching adequacy: the current threshold admits many labeled negative candidates, before any later confirmation.',
    'Balanced-fixture precision is not estimated real-network precision; unannotated cross-pairs are not labeled negatives.',
    'Dictionary linking requires unique identification in both scopes and assumes the exact text is in the candidate corpus; it does not estimate arbitrary-world guessing probability.',
    'Reconstruction attack uses only fingerprints/public matrices and the same candidate population at both scopes; churn is not modeled.',
    'CPU time and process RSS do not measure device energy, full-app memory or Internet traffic.',
    'Scopes are public deterministic transforms, not encryption or differential privacy. No live protocol behavior is changed.'] };
const percent = (value: number) => `${(100 * value).toFixed(1)}%`;
const markdown = `# Scoped fingerprint real-text evaluation\n\nMeasured ${report.measuredAt} using the cached ${report.model} FP32 model with remote downloads disabled.\n\n` +
  `${positives.length} labeled positive pairs, ${negatives.length} labeled negative pairs, ${needs.length} unique needs and ${offers.length} unique offers. Matching uses the application's actual need rewriting and embedding path. Threshold: ${threshold}.\n\n` +
  '| Projection | Recall | Negative-pair false positives | Balanced-fixture precision | Recall at 5 |\n| --- | ---: | ---: | ---: | ---: |\n' +
  quality.map(row => `| ${row.scope} | ${percent(row.recall)} | ${percent(row.falsePositiveRate)} | ${percent(row.balancedFixturePrecision)} | ${percent(row.recallAt5)} |`).join('\n') +
  '\n\nRetrieval ranks labeled target offers among the distinct corpus offers; corpus order breaks equal-score ties.\n\n' +
  '| Scope pair | Direct equal hashes | Mean direct similarity | Reconstruction top 1 | Reconstruction top 5 | Known-text unique identification |\n| --- | ---: | ---: | ---: | ---: | ---: |\n' +
  attacks.map(row => `| ${row.from} → ${row.to} | ${row.rawEqualityCount}/${row.candidates} | ${row.meanDirectSimilarity} | ${percent(row.reconstructedTop1)} | ${percent(row.reconstructedTop5)} | ${percent(row.dictionaryUniqueIdentification)} |`).join('\n') +
  `\n\nChance top-1 matching is ${percent(1 / offers.length)}. Reconstruction receives only public projection matrices and fingerprints, with target order reversed and ties scored conservatively. The dictionary attack knows the candidate texts, recomputes their public fingerprints, and requires unique identification in both scopes.\n\n` +
  `## Predetermined gates\n\nQuality must lose at most five percentage points of recall/recall-at-five, and add at most five points of negative-pair false positives, relative to the pilot. Result: **${gates.qualityRelativeToPilot ? 'pass' : 'fail'}**. This relative gate does not establish adequate absolute quality: ${baseline.falsePositives}/${baseline.negativeCount} labeled negatives pass the pilot's fingerprint threshold. Both linking attacks must stay at or below 5% top-1 identification. Result: **${gates.crossScopeLinking ? 'pass' : 'fail'}**. These are engineering screening criteria, not a formal privacy guarantee.\n\n` +
  `## Resource measurements\n\nModel initialization: ${(initializationMs / 1000).toFixed(2)} s. Embedding: ${(embeddingMs / 1000).toFixed(2)} s. CPU: ${report.resources.cpuSeconds} s. Process lifetime peak RSS: ${(report.resources.peakRssBytes / 1024 ** 2).toFixed(1)} MiB. ${process.platform}/${process.arch}, Node ${process.version}.\n\n` +
  '## Limits\n\n' + report.limitations.map(text => `- ${text}`).join('\n') + '\n\nThe companion JSON records model-file and dataset hashes, exact per-pair ranks and all measured counts.\n';
if (values.out) {
  const output = resolve(root, values.out); mkdirSync(dirname(output), { recursive: true });
  if (!output.endsWith('.json')) throw new Error('Output must end in .json');
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(output.slice(0, -5) + '.md', markdown, { flag: 'wx' });
  console.log(JSON.stringify({ output, gates, quality: quality.map(({ retrieval: _, ...row }) => row), attacks, resources: report.resources }, null, 2));
} else console.log(JSON.stringify(report, null, 2));
if (values.enforce && (!gates.qualityRelativeToPilot || !gates.crossScopeLinking)) process.exitCode = 1;
