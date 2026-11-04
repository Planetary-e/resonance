/** Offline MIRACL DEV preparation. No fetch, model loading, or inference. */
import { readFileSync, statSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesHash, contentHash, evaluateJudgedQuality, topicSplit, type CorpusRow, type Language, type Judgment, type JudgedQualityInput, type FrozenQualityConfig } from './fingerprint-judgments.js';

export const PREPARATION_SEED = 'miracl-dev-diagnostic-v1';
const MAX_SOURCE = 32 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024;
type Source = { path: string; url: string; revision: string; sha256: string; bytes: number; language: Language; kind: 'topics' | 'qrels' | 'passages' };
export type PreparationManifest = { version: 1; files: Source[]; frozenAt: string; testOpenedAtPlan: string; candidateThreshold: number };
type Passage = { docid: string; text: string; title: string };
type RecordRow = { query_id: string; query: string; positive_passages: Passage[]; negative_passages: Passage[] };
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const nonempty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= 20000;
const normalized = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function prepareCorpus(manifest: PreparationManifest, read: (source: Source) => string) {
  assert(manifest.version === 1 && Array.isArray(manifest.files) && manifest.files.length >= 4 && manifest.files.length <= 6, 'Expected four to six sources: topics/qrels/passages for en/es');
  assert(Number.isFinite(Date.parse(manifest.frozenAt)) && Date.parse(manifest.testOpenedAtPlan) > Date.parse(manifest.frozenAt), 'Opening plan must follow self-declared freeze');
  assert(Number.isFinite(manifest.candidateThreshold) && manifest.candidateThreshold >= 0 && manifest.candidateThreshold <= 1, 'Invalid threshold');
  const sources = new Map<string, string>(); let total = 0;
  for (const source of manifest.files) {
    assert(['en', 'es'].includes(source.language) && ['topics', 'qrels', 'passages'].includes(source.kind), 'Unknown source kind/language');
    assert(typeof source.url === 'string' && source.url.startsWith('https://') && /^[a-f0-9]{40}$/.test(source.revision) && /^[a-f0-9]{64}$/.test(source.sha256), 'Missing pinned source metadata');
    assert(Number.isInteger(source.bytes) && source.bytes > 0 && source.bytes <= MAX_SOURCE && (total += source.bytes) <= MAX_TOTAL, 'Source size bound exceeded');
    const k = `${source.language}/${source.kind}`; assert(!sources.has(k), 'Duplicate source');
    const data = read(source); assert(Buffer.byteLength(data) === source.bytes && bytesHash(data) === source.sha256, 'Source hash/size mismatch'); sources.set(k, data);
  }
  for (const language of ['en', 'es']) for (const kind of ['topics', 'qrels', 'passages']) assert(sources.has(`${language}/${kind}`), `Missing ${language}/${kind}; preparation blocked, no subset freeze`);
  const queries: CorpusRow[] = [], publications: CorpusRow[] = [], allJudgments: Judgment[] = [];
  const parents = new Map<string, string>();
  function root(x: string): string { if (!parents.has(x)) parents.set(x, x); let r = x; while (parents.get(r) !== r) r = parents.get(r)!; while (x !== r) { const p = parents.get(x)!; parents.set(x, r); x = p; } return r; }
  function union(a: string, b: string) { a = root(a); b = root(b); if (a !== b) parents.set(order(a, b) < 0 ? b : a, order(a, b) < 0 ? a : b); }
  const textNodes = new Map<string, string>();
  function row(id: string, language: Language, text: string): CorpusRow {
    assert(nonempty(id) && nonempty(text), 'Invalid corpus text/ID'); root(id); const t = normalized(text), old = textNodes.get(t); if (old) union(id, old); else textNodes.set(t, id);
    return { id, language, text, topicGroup: '', paraphraseGroup: id, split: 'development' };
  }
  const titles: Record<string, string> = {};
  for (const language of ['en', 'es'] as const) {
    const topics = new Map<string, string>(), labels = new Map<string, boolean>(), docs = new Map<string, Passage>(), seenQueries = new Set<string>(), seenLabels = new Set<string>();
    const lines = (kind: string) => { const s = sources.get(`${language}/${kind}`); assert(s, `Missing ${language}/${kind}`); return s.trimEnd().split('\n').map(l => l.replace(/\r$/, '')); };
    for (const line of lines('topics')) { const f = line.split('\t'); assert(f.length === 2 && nonempty(f[0]) && nonempty(f[1]) && !topics.has(f[0]), 'Invalid/duplicate topic'); topics.set(f[0], f[1]); }
    for (const line of lines('qrels')) { const f = line.split(/\s+/); assert(f.length === 4 && topics.has(f[0]) && /^(0|1)$/.test(f[3]) && /^.+#[0-9]+$/.test(f[2]), 'Unknown query/grade or malformed article passage ID'); const k = JSON.stringify([f[0], f[2]]); assert(!labels.has(k), 'Duplicate qrel'); labels.set(k, f[3] === '1'); }
    for (const line of lines('passages')) {
      const record = JSON.parse(line) as RecordRow;
      assert(nonempty(record.query_id) && topics.has(record.query_id) && topics.get(record.query_id) === record.query && !seenQueries.has(record.query_id), 'Missing/duplicate/conflicting passage query'); seenQueries.add(record.query_id);
      assert(Array.isArray(record.positive_passages) && Array.isArray(record.negative_passages), 'Invalid annotated passage arrays');
      for (const [passages, relevant] of [[record.positive_passages, true], [record.negative_passages, false]] as const) for (const p of passages) {
        assert(p && nonempty(p.docid) && nonempty(p.text) && typeof p.title === 'string' && p.title.length <= 20000, 'Invalid passage');
        const k = JSON.stringify([record.query_id, p.docid]); assert(labels.get(k) === relevant && !seenLabels.has(k), 'Unknown/conflicting/duplicate annotated judgment'); seenLabels.add(k);
        const old = docs.get(p.docid); assert(!old || (old.text === p.text && old.title === p.title), 'Conflicting passage text/title'); docs.set(p.docid, p);
      }
    }
    assert(seenQueries.size === topics.size && seenLabels.size === labels.size, 'Missing query or qrel passage text');
    for (const [id, text] of [...topics].sort((a, b) => order(a[0], b[0]))) queries.push(row(`${language}:q:${id}`, language, text));
    for (const [id, p] of [...docs].sort((a, b) => order(a[0], b[0]))) { const pid = `${language}:p:${id}`; publications.push(row(pid, language, p.text)); titles[pid] = p.title; union(pid, `${language}:article:${id.slice(0, id.lastIndexOf('#'))}`); }
    for (const [k, relevant] of [...labels].sort((a, b) => order(a[0], b[0]))) { const [q, p] = JSON.parse(k); const queryId = `${language}:q:${q}`, publicationId = `${language}:p:${p}`; union(queryId, publicationId); allJudgments.push({ queryId, publicationId, relevant }); }
  }
  for (const r of [...queries, ...publications]) { r.topicGroup = `component:${root(r.id)}`; r.split = topicSplit(PREPARATION_SEED, r.topicGroup); }
  const index = new Map([...queries, ...publications].map(r => [r.id, r]));
  const judgments = allJudgments.filter(j => index.get(j.queryId)!.split === 'test' && index.get(j.publicationId)!.split === 'test');
  const corpus = { queries, publications };
  const config: FrozenQualityConfig = { version: 1, seed: PREPARATION_SEED, frozenAt: manifest.frozenAt, testOpenedAt: manifest.testOpenedAtPlan, candidateThreshold: manifest.candidateThreshold, corpusSha256: contentHash(corpus), judgmentsSha256: contentHash(judgments) };
  const configBytes = JSON.stringify(config), configSha256 = bytesHash(configBytes);
  const input: JudgedQualityInput = { version: 1, corpus, judgments, provenance: { assessor: 'MIRACL native-speaker assessors (provider claim; not independently audited)', method: 'All supplied DEV qrels, exact annotated passage joins; diagnostic Wikipedia retrieval; model-training contamination unknown', independentOfEmbeddings: true, fixtureOnly: false, positiveInventoryComplete: false }, predictions: { generatedAt: manifest.testOpenedAtPlan, configSha256, pipeline: 'PREPARATION ONLY: empty planned prediction envelope; generatedAt is planned opening, not observed inference', rows: [] } };
  const inputBytes = JSON.stringify(input); assert(Buffer.byteLength(inputBytes) <= MAX_SOURCE, 'Prepared reader input exceeds32MiB');
  const validation = evaluateJudgedQuality(configBytes, inputBytes, configSha256);
  return { config, input, allJudgments, titles, receipt: { version: 1, status: 'prepared-only; no inference; K5 OPEN', seed: PREPARATION_SEED, sourceManifestSha256: contentHash(manifest), sources: manifest.files, officialSplit: 'DEV only; train and official test excluded', selection: 'Every provided DEV topic and qrel, both grades; no unjudged negatives', grouping: 'Transitive query-qrel-article components plus globally normalized exact text; paraphrase families beyond this require human review', attestations: 'Freeze/provenance self-declared; test opening and empty prediction timestamp are prospective plans', license: 'MIRACL topics/qrels Apache2.0 provider claim; corpus card also declares Apache2.0 and Wikipedia origin; underlying Wikipedia attribution separate, no legal conclusion. Keep raw data outside repo.', totals: { queries: queries.length, publications: publications.length, qrels: allJudgments.length, testJudgments: judgments.length, excludedDevelopmentJudgments: allJudgments.length - judgments.length, positive: allJudgments.filter(j => j.relevant).length, negative: allJudgments.filter(j => !j.relevant).length }, heldOut: validation.languages.map(l => ({ language: l.language, queries: l.testQueries, publications: l.testPublications })), gaps: validation.gaps, hashes: { config: configSha256, input: bytesHash(inputBytes), allJudgments: contentHash(allJudgments), titles: contentHash(titles) } } };
}
export function prepareFromFiles(manifestPath: string, out: string, expectedManifestSha256: string) {
  assert(statSync(manifestPath).isFile() && statSync(manifestPath).size <= 65536, 'Manifest exceeds bound');
  const manifestBytes = readFileSync(manifestPath, 'utf8');
  assert(/^[a-f0-9]{64}$/.test(expectedManifestSha256) && bytesHash(manifestBytes) === expectedManifestSha256, 'Pinned manifest digest mismatch');
  const manifest = JSON.parse(manifestBytes) as PreparationManifest;
  const prepared = prepareCorpus(manifest, s => { assert(statSync(s.path).isFile() && statSync(s.path).size === s.bytes, 'Source file/size mismatch'); return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(s.path)); });
  // Refuse replacement; clean this newly created directory on any write failure.
  mkdirSync(out); const staging = join(out, '.staging');
  try { mkdirSync(staging); for (const [name, value] of Object.entries(prepared)) writeFileSync(join(staging, `${name}.json`), JSON.stringify(value), { flag: 'wx' }); for (const name of Object.keys(prepared)) renameSync(join(staging, `${name}.json`), join(out, `${name}.json`)); rmSync(staging, { recursive: true }); } catch (e) { rmSync(out, { recursive: true }); throw e; }
  return prepared.receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifest, out, manifestSha256, ...extra] = process.argv.slice(2); if (!manifest || !out || !manifestSha256 || extra.length) throw new Error('Usage: fingerprint-corpus-prepare.ts MANIFEST.json NEW_OUTPUT_DIR MANIFEST_SHA256');
  console.log(JSON.stringify(prepareFromFiles(manifest, out, manifestSha256)));
}
