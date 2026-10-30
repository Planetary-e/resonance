/** Offline external judgments for the existing real fingerprint evaluation.
 * No model execution; supplied provenance/freeze timestamps are declarations. */
import { createHash } from 'node:crypto';

export type Language = 'es' | 'en';
export type CorpusRow = { id: string; language: Language; text: string; topicGroup: string; paraphraseGroup: string; split: 'development' | 'test' };
export type Judgment = { queryId: string; publicationId: string; relevant: boolean };
export type Prediction = { queryId: string; publicationId: string; score: number; notified: boolean | null };
export type FrozenQualityConfig = {
  version: 1; frozenAt: string; testOpenedAt: string; seed: string; candidateThreshold: number;
  corpusSha256: string; judgmentsSha256: string;
};
export type JudgedQualityInput = {
  version: 1; corpus: { queries: CorpusRow[]; publications: CorpusRow[] };
  judgments: Judgment[];
  provenance: { assessor: string; method: string; independentOfEmbeddings: boolean; fixtureOnly: boolean; positiveInventoryComplete: boolean };
  predictions: { generatedAt: string; configSha256: string; pipeline: string; rows: Prediction[] };
};
export const contentHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const bytesHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function topicSplit(seed: string, group: string): 'development' | 'test' {
  return parseInt(contentHash([seed, group]).slice(0, 8), 16) / 2 ** 32 < 0.2 ? 'test' : 'development';
}
function requireValue(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 20000;
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const key = (q: string, p: string) => JSON.stringify([q, p]);
type Counts = { numerator: number; denominator: number };
function estimate(counts: Counts[], seed: string) {
  const total = counts.reduce((a, b) => ({ numerator: a.numerator + b.numerator, denominator: a.denominator + b.denominator }), { numerator: 0, denominator: 0 });
  const value = total.denominator ? total.numerator / total.denominator : null;
  // Resample whole topic clusters, retaining correlated queries/notifications.
  let state = parseInt(contentHash(seed).slice(0, 8), 16) || 1;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; };
  const samples: number[] = [];
  if (counts.length >= 2) for (let i = 0; i < 200; i++) {
    let n = 0, d = 0;
    for (let j = 0; j < counts.length; j++) { const c = counts[Math.floor(next() * counts.length)]; n += c.numerator; d += c.denominator; }
    if (d) samples.push(n / d);
  }
  samples.sort((a, b) => a - b);
  return { ...total, value, topicClusters: counts.length, topicBootstrap95: samples.length >= 100 ? [samples[Math.floor(samples.length * .025)], samples[Math.floor(samples.length * .975)]] : null };
}

export function evaluateJudgedQuality(configBytes: string, inputBytes: string, expectedConfigSha256: string) {
  requireValue(Buffer.byteLength(configBytes) <= 65536 && Buffer.byteLength(inputBytes) <= 32 * 1024 * 1024, 'Input exceeds bounded JSON size');
  requireValue(/^[a-f0-9]{64}$/.test(expectedConfigSha256) && bytesHash(configBytes) === expectedConfigSha256, 'Frozen configuration digest mismatch');
  const config = JSON.parse(configBytes) as FrozenQualityConfig, input = JSON.parse(inputBytes) as JudgedQualityInput;
  requireValue(config?.version === 1 && input?.version === 1, 'Unsupported schema version');
  requireValue(date(config.frozenAt) && date(config.testOpenedAt) && Date.parse(config.frozenAt) < Date.parse(config.testOpenedAt), 'Freeze must precede test opening');
  requireValue(text(config.seed) && Number.isFinite(config.candidateThreshold) && config.candidateThreshold >= 0 && config.candidateThreshold <= 1, 'Invalid frozen seed/threshold');
  requireValue(input.corpus && Array.isArray(input.corpus.queries) && Array.isArray(input.corpus.publications) && Array.isArray(input.judgments) && Array.isArray(input.predictions?.rows), 'Invalid input arrays');
  requireValue(input.corpus.queries.length > 0 && input.corpus.queries.length <= 10000 && input.corpus.publications.length > 0 && input.corpus.publications.length <= 100000 && input.judgments.length <= 1000000 && input.predictions.rows.length <= 1000000, 'Invalid corpus bounds');
  requireValue(contentHash(input.corpus) === config.corpusSha256 && contentHash(input.judgments) === config.judgmentsSha256, 'Frozen corpus/judgment digest mismatch');
  requireValue(input.predictions.configSha256 === expectedConfigSha256 && date(input.predictions.generatedAt) && Date.parse(input.predictions.generatedAt) >= Date.parse(config.testOpenedAt) && text(input.predictions.pipeline), 'Predictions must bind frozen configuration and follow test opening');
  const provenance = input.provenance;
  requireValue(provenance && text(provenance.assessor) && text(provenance.method) && typeof provenance.independentOfEmbeddings === 'boolean' && typeof provenance.fixtureOnly === 'boolean' && typeof provenance.positiveInventoryComplete === 'boolean', 'Missing label provenance');
  const paraphrases = new Map<string, string>(), texts = new Map<string, string>();
  function rows(values: CorpusRow[]) {
    const index = new Map<string, CorpusRow>();
    for (const row of values) {
      requireValue(row && text(row.id) && text(row.text) && text(row.topicGroup) && text(row.paraphraseGroup) && (row.language === 'es' || row.language === 'en'), 'Invalid corpus row/language');
      requireValue(!index.has(row.id), 'Duplicate corpus ID');
      requireValue(row.split === topicSplit(config.seed, row.topicGroup), 'Topic split differs from frozen seed');
      for (const [map, group] of [[paraphrases, row.paraphraseGroup], [texts, row.text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()]] as const) {
        requireValue(!map.has(group) || map.get(group) === row.split, 'Paraphrase/text split leakage'); map.set(group, row.split);
      }
      index.set(row.id, row);
    }
    return index;
  }
  const queries = rows(input.corpus.queries), publications = rows(input.corpus.publications);
  function pair(row: { queryId: string; publicationId: string }) {
    requireValue(row && text(row.queryId) && text(row.publicationId), 'Invalid pair IDs');
    const q = queries.get(row.queryId), p = publications.get(row.publicationId);
    requireValue(q && p && q.language === p.language && q.split === 'test' && p.split === 'test', 'Pair must reference same-language held-out rows');
    return key(row.queryId, row.publicationId);
  }
  const labels = new Map<string, boolean>(), judgmentsByQuery = new Map<string, Judgment[]>();
  for (const row of input.judgments) {
    const k = pair(row); requireValue(typeof row.relevant === 'boolean' && !labels.has(k), 'Invalid/duplicate judgment'); labels.set(k, row.relevant);
    const list = judgmentsByQuery.get(row.queryId) ?? []; list.push(row); judgmentsByQuery.set(row.queryId, list);
  }
  const predictions = new Map<string, Prediction>(), byQuery = new Map<string, Prediction[]>();
  for (const row of input.predictions.rows) {
    const k = pair(row); requireValue(!predictions.has(k) && Number.isFinite(row.score) && row.score >= 0 && row.score <= 1 && (typeof row.notified === 'boolean' || row.notified === null), 'Invalid/duplicate prediction');
    requireValue(!row.notified || row.score >= config.candidateThreshold, 'Notification below frozen candidate threshold');
    predictions.set(k, row); const list = byQuery.get(row.queryId) ?? []; list.push(row); byQuery.set(row.queryId, list);
  }
  const languages = (['es', 'en'] as const).map(language => {
    const qs = [...queries.values()].filter(q => q.language === language && q.split === 'test');
    const ps = [...publications.values()].filter(p => p.language === language && p.split === 'test');
    const groups = [...new Set(qs.map(q => q.topicGroup))];
    const perQuery = qs.map(q => {
      const scored = byQuery.get(q.id) ?? [];
      const ranked = [...scored].sort((a, b) => b.score - a.score || (a.publicationId < b.publicationId ? -1 : a.publicationId > b.publicationId ? 1 : 0)).slice(0, 5);
      const known = (judgmentsByQuery.get(q.id) ?? []), positive = known.filter(j => j.relevant), negative = known.filter(j => !j.relevant);
      const notices = scored.filter(p => p.notified), candidates = scored.filter(p => p.score >= config.candidateThreshold);
      const tp = (values: Prediction[]) => values.filter(p => labels.get(key(q.id, p.publicationId)) === true).length;
      const fp = (values: Prediction[]) => values.filter(p => labels.get(key(q.id, p.publicationId)) === false).length;
      const judged = (values: Prediction[]) => values.filter(p => labels.has(key(q.id, p.publicationId))).length;
      return { group: q.topicGroup, positives: positive.length, candidateHits: tp(candidates), hits: positive.filter(j => ranked.some(p => p.publicationId === j.publicationId)).length,
        negatives: negative.length, negativeScores: negative.filter(j => predictions.has(key(q.id, j.publicationId))).length,
        negativeDecisions: negative.filter(j => { const p = predictions.get(key(q.id, j.publicationId)); return p && p.notified !== null; }).length,
        notices: notices.length, noticeJudged: judged(notices), noticeTp: tp(notices), noticeFp: fp(notices),
        candidates: candidates.length, candidateJudged: judged(candidates), candidateTp: tp(candidates), candidateFp: fp(candidates), scored: scored.length };
    });
    type QueryCounts = typeof perQuery[number];
    const sum = (field: keyof Omit<QueryCounts, 'group'>) => perQuery.reduce((n, q) => n + q[field], 0);
    const metric = (n: keyof Omit<QueryCounts, 'group'>, d?: keyof Omit<QueryCounts, 'group'>) => estimate(groups.map(group => {
      const rows = perQuery.filter(q => q.group === group);
      return { numerator: rows.reduce((v, q) => v + q[n], 0), denominator: d ? rows.reduce((v, q) => v + q[d], 0) : rows.length };
    }), config.seed + language + n);
    const pairPopulation = qs.length * ps.length;
    return { language, testQueries: qs.length, testPublications: ps.length, queriesWithPredictions: perQuery.filter(q => q.scored).length,
      queriesWithKnownPositives: perQuery.filter(q => q.positives).length,
      recallAt5KnownPositives: { ...metric('hits', 'positives'), aggregation: 'micro: retrieved known-positive pairs / known-positive pairs' },
      macroQueryRecallAt5KnownPositives: { ...estimate(groups.map(group => {
        const rows = perQuery.filter(q => q.group === group && q.positives > 0);
        return { numerator: rows.reduce((n, q) => n + q.hits / q.positives, 0), denominator: rows.length };
      }), config.seed + language + 'macroRecall'), aggregation: 'macro: mean query recall among queries with known positives' },
      queriesExcludedFromMacroRecall: perQuery.filter(q => q.positives === 0).length,
      notifiedPrecisionJudgedOnly: metric('noticeTp', 'noticeJudged'),
      notifiedPrecisionConservative: metric('noticeTp', 'notices'), notifiedFalsePositiveRateKnownNegatives: metric('noticeFp', 'negativeDecisions'),
      falseNotificationsPerQueryKnown: metric('noticeFp'), candidatePrecisionJudgedOnly: metric('candidateTp', 'candidateJudged'), candidateRecallKnownPositives: metric('candidateHits', 'positives'),
      candidateFalsePositiveRateKnownNegatives: metric('candidateFp', 'negativeScores'),
      notificationCount: sum('notices'), unjudgedNotifications: sum('notices') - sum('noticeJudged'),
      candidateCount: sum('candidates'), unjudgedCandidates: sum('candidates') - sum('candidateJudged'),
      knownNegativePairs: sum('negatives'), knownNegativePairsWithDecisions: sum('negativeDecisions'),
      pairPopulation, judgedPairs: sum('positives') + sum('negatives'), scoredPairs: sum('scored'),
      allPairsJudged: pairPopulation > 0 && sum('positives') + sum('negatives') === pairPopulation,
    };
  });
  return { version: 1, configSha256: expectedConfigSha256, inputSha256: bytesHash(inputBytes), config, provenance,
    provenanceStatus: 'self-declared; independent data/freeze audit required', languages,
    k5Qualified: false,
    gaps: ['Independent relevance provenance and pre-test freeze need external review; hashes/timestamps alone cannot prove either.',
      ...(!provenance.independentOfEmbeddings ? ['Provenance explicitly declares labels are not independent of embeddings.'] : []),
      ...(!provenance.positiveInventoryComplete ? ['Provenance explicitly declares incomplete positive inventories; recall is conditional on known positives.'] : []),
      ...(provenance.fixtureOnly ? ['Input is a test fixture, never K5 evidence.'] : []),
      ...(languages.reduce((n, l) => n + l.testQueries, 0) < 1000 || languages.reduce((n, l) => n + l.testPublications, 0) < 10000 ? ['Held-out corpus below 1,000 queries / 10,000 publications.'] : []),
      ...languages.filter(l => !l.testQueries || !l.testPublications || l.queriesWithKnownPositives !== l.testQueries || l.queriesWithPredictions !== l.testQueries || l.unjudgedNotifications || l.knownNegativePairsWithDecisions !== l.knownNegativePairs || !l.allPairsJudged).map(l => `${l.language}: incomplete relevance/decision coverage; recall and FPR are conditional on judged pairs.`),
      'Rotation degradation, reconstruction, known-text identification and epoch migration are separate missing qualification evidence; retain historical failed privacy screen.'],
    uncertainty: 'Deterministic 200-replicate percentile topic-cluster bootstrap; null for fewer than two topics or insufficient nonempty replicates. Descriptive intervals do not repair selection bias.',
    semantics: 'Micro pair recall and macro query recall are separate; no K5 threshold aggregation is asserted. Recall@5 ranks supplied scored publications by descending score then publication ID, without candidate threshold; omitted publications are unretrieved. Notifications are explicit observed pipeline notices; null decisions are unknown. Unjudged pairs never count as negatives. FPR uses judged negative pairs with explicit decisions; missing decisions are unknown. False notices/query is a lower bound when notices are unjudged. No metric pass certifies K5.' };
}
