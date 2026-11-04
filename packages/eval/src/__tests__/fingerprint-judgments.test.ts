import { describe, it, expect } from 'vitest';
import { bytesHash, contentHash, evaluateJudgedQuality, topicSplit, type CorpusRow, type FrozenQualityConfig, type JudgedQualityInput } from '../fingerprint-judgments.js';

function fixture() {
  const seed = 'k5-fixture-v1';
  const groups = Array.from({ length: 100 }, (_, i) => `topic-${i}`);
  const test = groups.filter(g => topicSplit(seed, g) === 'test').slice(0, 2);
  const development = groups.find(g => topicSplit(seed, g) === 'development')!;
  const row = (id: string, language: 'es' | 'en', topicGroup: string): CorpusRow => ({ id, language, text: `${language} synthetic fixture ${id}`, topicGroup, paraphraseGroup: id, split: topicSplit(seed, topicGroup) });
  const input: JudgedQualityInput = {
    version: 1,
    corpus: { queries: [row('es-q', 'es', test[0]), row('en-q', 'en', test[1]), row('dev-q', 'en', development)],
      publications: ['es', 'en'].flatMap(l => ['p1', 'p2', 'p3'].map(id => row(`${l}-${id}`, l as 'es' | 'en', test[l === 'es' ? 0 : 1]))) },
    judgments: ['es', 'en'].flatMap(l => [{ queryId: `${l}-q`, publicationId: `${l}-p1`, relevant: true }, { queryId: `${l}-q`, publicationId: `${l}-p2`, relevant: false }]),
    provenance: { assessor: 'hand-computed unit-test author', method: 'synthetic test only; no independent relevance evidence', independentOfEmbeddings: false, fixtureOnly: true, positiveInventoryComplete: false },
    predictions: { generatedAt: '2026-10-22T12:00:02Z', configSha256: '', pipeline: 'test final-decision export',
      rows: ['es', 'en'].flatMap(l => [
        { queryId: `${l}-q`, publicationId: `${l}-p1`, score: .9, notified: true },
        { queryId: `${l}-q`, publicationId: `${l}-p2`, score: .8, notified: l === 'es' },
        { queryId: `${l}-q`, publicationId: `${l}-p3`, score: .76, notified: l === 'es' },
      ]) },
  };
  const config: FrozenQualityConfig = { version: 1, frozenAt: '2026-10-22T12:00:00Z', testOpenedAt: '2026-10-22T12:00:01Z', seed, candidateThreshold: .75,
    corpusSha256: '', judgmentsSha256: '' };
  function freeze() {
    config.corpusSha256 = contentHash(input.corpus); config.judgmentsSha256 = contentHash(input.judgments);
    const bytes = JSON.stringify(config); input.predictions.configSha256 = bytesHash(bytes);
    return { config: bytes, input: JSON.stringify(input), sha: bytesHash(bytes) };
  }
  return { input, config, freeze, test, development };
}
function evaluate(f: ReturnType<typeof fixture>) { const frozen = f.freeze(); return evaluateJudgedQuality(frozen.config, frozen.input, frozen.sha); }

describe('held-out fingerprint judgment ingestion', () => {
  it('hand-computed ES/EN metrics keep unknown notices out of negative labels', () => {
    const result = evaluate(fixture()), [es, en] = result.languages;
    expect(es.recallAt5KnownPositives).toMatchObject({ numerator: 1, denominator: 1, value: 1, topicBootstrap95: null });
    expect(es.notifiedPrecisionJudgedOnly).toMatchObject({ numerator: 1, denominator: 2, value: .5 });
    expect(es.notifiedPrecisionConservative).toMatchObject({ numerator: 1, denominator: 3, value: 1 / 3 });
    expect(es.notifiedFalsePositiveRateKnownNegatives).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(es.falseNotificationsPerQueryKnown.value).toBe(1);
    expect(es).toMatchObject({ unjudgedNotifications: 1, unjudgedCandidates: 1, pairPopulation: 3, judgedPairs: 2, allPairsJudged: false });
    expect(es.candidatePrecisionJudgedOnly.value).toBe(.5);
    expect(en.notifiedPrecisionJudgedOnly.value).toBe(1);
    expect(en.notifiedFalsePositiveRateKnownNegatives.value).toBe(0);
    expect(result.k5Qualified).toBe(false);
    expect(result.provenanceStatus).toContain('self-declared');
  });
  it('unjudged-only notifications have null judged precision, never perfect precision', () => {
    const f = fixture(); f.input.predictions.rows = [{ queryId: 'es-q', publicationId: 'es-p3', score: .9, notified: true }];
    const es = evaluate(f).languages[0];
    expect(es.notifiedPrecisionJudgedOnly.value).toBeNull();
    expect(es.notifiedPrecisionConservative.value).toBe(0);
    expect(es.notifiedFalsePositiveRateKnownNegatives.value).toBeNull();
    expect(es.knownNegativePairsWithDecisions).toBe(0);
  });
  it('counts every known relevant publication in Recall@5 denominator', () => {
    const f = fixture(); f.input.judgments.push({ queryId: 'es-q', publicationId: 'es-p3', relevant: true });
    f.input.predictions.rows = f.input.predictions.rows.filter(p => p.publicationId !== 'es-p3');
    expect(evaluate(f).languages[0].recallAt5KnownPositives).toMatchObject({ numerator: 1, denominator: 2, value: .5 });
  });
  it.each(['query', 'publication', 'judgment', 'prediction'])('refuses duplicate %s IDs/pairs', kind => {
    const f = fixture();
    if (kind === 'query') f.input.corpus.queries.push(f.input.corpus.queries[0]);
    if (kind === 'publication') f.input.corpus.publications.push(f.input.corpus.publications[0]);
    if (kind === 'judgment') f.input.judgments.push(f.input.judgments[0]);
    if (kind === 'prediction') f.input.predictions.rows.push(f.input.predictions.rows[0]);
    expect(() => evaluate(f)).toThrow(/Duplicate|duplicate/);
  });
  it.each(['language', 'development', 'topic', 'paraphrase', 'text'])('refuses %s mismatch/leakage', kind => {
    const f = fixture();
    if (kind === 'language') f.input.predictions.rows[0].publicationId = 'en-p1';
    if (kind === 'development') f.input.predictions.rows[0].queryId = 'dev-q';
    if (kind === 'topic') f.input.corpus.queries[0].split = 'development';
    if (kind === 'paraphrase') f.input.corpus.queries[2].paraphraseGroup = f.input.corpus.queries[0].paraphraseGroup;
    if (kind === 'text') f.input.corpus.queries[2].text = f.input.corpus.queries[0].text.toUpperCase();
    expect(() => evaluate(f)).toThrow(/same-language|split|leakage/);
  });
  it('refuses modified threshold/config, corpus, judgments and prediction binding', () => {
    const f = fixture(), frozen = f.freeze();
    expect(() => evaluateJudgedQuality(frozen.config.replace('.75', '.76'), frozen.input, frozen.sha)).toThrow('digest');
    f.input.corpus.queries[0].text += ' altered';
    expect(() => evaluateJudgedQuality(frozen.config, JSON.stringify(f.input), frozen.sha)).toThrow('digest');
    const g = fixture(), original = g.freeze(); g.input.judgments[0].relevant = false;
    expect(() => evaluateJudgedQuality(original.config, JSON.stringify(g.input), original.sha)).toThrow('digest');
    const h = fixture(), old = h.freeze(); h.input.predictions.configSha256 = '0'.repeat(64);
    expect(() => evaluateJudgedQuality(old.config, JSON.stringify(h.input), old.sha)).toThrow('bind');
  });
  it('refuses post-hoc freeze and predictions predating opening', () => {
    const f = fixture(); f.config.frozenAt = f.config.testOpenedAt;
    expect(() => evaluate(f)).toThrow('Freeze');
    const g = fixture(); g.input.predictions.generatedAt = g.config.frozenAt;
    expect(() => evaluate(g)).toThrow('follow test');
  });
  it('refuses invalid language, score and final notification below candidate threshold', () => {
    const f = fixture(); (f.input.corpus.queries[0] as { language: string }).language = 'fr';
    expect(() => evaluate(f)).toThrow('language');
    const g = fixture(); g.input.predictions.rows[0].score = NaN;
    expect(() => evaluate(g)).toThrow('prediction');
    const h = fixture(); h.input.predictions.rows[0].score = .1;
    expect(() => evaluate(h)).toThrow('below frozen');
  });
  it('distinguishes micro pair recall from macro query recall with unequal positive counts', () => {
    const f = fixture();
    f.input.corpus.queries.push({ ...f.input.corpus.queries[0], id: 'es-q2', text: 'second query', paraphraseGroup: 'q2' });
    f.input.corpus.queries.push({ ...f.input.corpus.queries[0], id: 'es-q3', text: 'unlabeled query', paraphraseGroup: 'q3' });
    f.input.judgments.push({ queryId: 'es-q2', publicationId: 'es-p1', relevant: true }, { queryId: 'es-q2', publicationId: 'es-p2', relevant: true });
    f.input.predictions.rows.push({ queryId: 'es-q2', publicationId: 'es-p1', score: .9, notified: true });
    const result = evaluate(f), es = result.languages[0];
    expect(es.recallAt5KnownPositives).toMatchObject({ numerator: 2, denominator: 3, value: 2 / 3 });
    expect(es.macroQueryRecallAt5KnownPositives).toMatchObject({ numerator: 1.5, denominator: 2, value: .75 });
    expect(es.queriesExcludedFromMacroRecall).toBe(1);
    expect(result.gaps).toContain('Provenance explicitly declares labels are not independent of embeddings.');
    expect(result.gaps).toContain('Provenance explicitly declares incomplete positive inventories; recall is conditional on known positives.');
  });
  it('ranks only five with stable lexical ties and keeps candidate recall separate', () => {
    const f = fixture();
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      f.input.corpus.publications.push({ ...f.input.corpus.publications[0], id, text: `ranking distractor ${id}`, paraphraseGroup: id });
      f.input.predictions.rows.push({ queryId: 'es-q', publicationId: id, score: .9, notified: false });
    }
    const es = evaluate(f).languages[0];
    // a,b,c,d,e precede es-p1 on the .9 tie: relevant publication ranks sixth.
    expect(es.recallAt5KnownPositives.value).toBe(0);
    expect(es.candidateRecallKnownPositives.value).toBe(1);
    const g = fixture(); g.input.predictions.rows[0].score = .1; g.input.predictions.rows[0].notified = false;
    expect(evaluate(g).languages[0].recallAt5KnownPositives.value).toBe(1);
    expect(evaluate(g).languages[0].candidateRecallKnownPositives.value).toBe(0);
  });
  it('reports reproducible topic-cluster intervals with multiple topics', () => {
    const f = fixture(); const q = { ...f.input.corpus.queries[0], id: 'es-q2', text: 'second fixture query', paraphraseGroup: 'second', topicGroup: f.test[1] };
    f.input.corpus.queries.push(q); f.input.judgments.push({ queryId: q.id, publicationId: 'es-p1', relevant: true });
    const first = evaluate(f), second = evaluate(f);
    expect(first.languages[0].recallAt5KnownPositives).toMatchObject({ value: .5, topicClusters: 2, topicBootstrap95: [0, 1] });
    expect(first).toEqual(second);
  });
});
