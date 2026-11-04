/** Opt-in evaluation only. Snapshot signatures authenticate payloads, not collection provenance. */
import { decodeBase64, hammingSimilarity, verifyPublicationRecord, verifyMatchNoticeMessage,
  verifyMatchOperationAgainstPublicationsV2, type PublicationRecord, type Message, type MatchNoticePayload } from '@resonance/core';
import { bytesHash, contentHash, evaluateJudgedQuality, type JudgedQualityInput, type Prediction } from './fingerprint-judgments.js';

type Binding = { role: 'query' | 'publication'; corpusId: string; record: PublicationRecord };
export type ActualManifest = { version: 1; runId: string; configSha256: string; frozenAt: string;
  designatedEvaluationCorpus: true; codeSha256: string; modelSha256: string;
  scope: { groupId: string; algorithm: string; bits: number; epoch: string };
  window: { start: string; end: string }; bindings: Binding[] };
export type InboxSnapshot = { runId: string; manifestSha256: string; capturedAt: string;
  notices: Message<MatchNoticePayload>[]; excludedRows: number };
export type ActualCapture = { version: 1; runId: string; manifestSha256: string;
  baseline: InboxSnapshot; end: InboxSnapshot;
  searches: { queryId: string; eventKind: 'ephemeral-search'; observedAt: string; threshold: number; k: number;
    results: { did: string; itemType: string; similarity: number }[] }[] };
const ensure = (ok: unknown, message: string): void => { if (!ok) throw new Error(message); };
const time = (s: string) => Date.parse(s);
const digest = (s: string) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const exact = (v: unknown, keys: string[]) => { ensure(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(','), 'Invalid actual artifact schema keys'); };
const pairKey = (q: string, p: string) => JSON.stringify([q, p]);

/** Call only on an explicitly selected synthetic/evaluation store. Never opens an account. */
export function captureEvaluationInbox(store: { listMailboxMatches(): { notice: Message<MatchNoticePayload> }[] },
  manifest: ActualManifest, manifestSha256: string, capturedAt: string, optIn: boolean): InboxSnapshot {
  ensure(optIn === true && manifest.designatedEvaluationCorpus === true, 'Evaluation capture requires explicit opt-in');
  const ids = new Set(manifest.bindings.map(b => b.record.publicationId));
  const rows = store.listMailboxMatches();
  const notices = rows.filter(r => ids.has(r.notice.payload.recipientPublicationId) && ids.has(r.notice.payload.partnerPublicationId)).map(r => r.notice);
  return { runId: manifest.runId, manifestSha256, capturedAt, notices, excludedRows: rows.length - notices.length };
}

export function exportActualPredictions(configBytes: string, baseBytes: string, manifestBytes: string,
  captureBytes: string, configSha256: string, manifestSha256: string) {
  ensure(Buffer.byteLength(manifestBytes) <= 8 * 1024 * 1024 && Buffer.byteLength(captureBytes) <= 32 * 1024 * 1024, 'Actual artifacts exceed bounds');
  ensure(digest(manifestSha256) && bytesHash(manifestBytes) === manifestSha256, 'Frozen manifest digest mismatch');
  const manifest = JSON.parse(manifestBytes) as ActualManifest, capture = JSON.parse(captureBytes) as ActualCapture;
  exact(manifest, ['version','runId','configSha256','frozenAt','designatedEvaluationCorpus','codeSha256','modelSha256','scope','window','bindings']);
  exact(capture, ['version','runId','manifestSha256','baseline','end','searches']);
  exact(manifest.scope, ['groupId','algorithm','bits','epoch']); exact(manifest.window, ['start','end']);
  const input = JSON.parse(baseBytes) as JudgedQualityInput;
  // Validate the original corpus/config/provenance using the same runner before joining.
  evaluateJudgedQuality(configBytes, baseBytes, configSha256);
  const config = JSON.parse(configBytes);
  ensure(manifest.version === 1 && capture.version === 1 && manifest.designatedEvaluationCorpus === true && typeof manifest.runId === 'string' && manifest.runId.length > 0 && manifest.runId.length <= 200, 'Invalid evaluation manifest');
  ensure(manifest.configSha256 === configSha256 && digest(manifest.codeSha256) && digest(manifest.modelSha256), 'Invalid config/code/model binding');
  const start = time(manifest.window.start), end = time(manifest.window.end);
  ensure(Number.isFinite(start) && Number.isFinite(end) && start < end && end - start <= 86400000 && time(manifest.frozenAt) < start && time(manifest.frozenAt) <= time(config.testOpenedAt) && start >= time(config.testOpenedAt), 'Invalid frozen observation window (maximum 24h)');
  ensure(capture.runId === manifest.runId && capture.manifestSha256 === manifestSha256 && Array.isArray(manifest.bindings) && manifest.bindings.length > 0 && manifest.bindings.length <= 10000 && Array.isArray(capture.searches) && capture.searches.length <= 10000, 'Capture/run mismatch or bounds');
  const bindings = new Map<string, Binding>(), corpusBindings = new Set<string>();
  const scope = manifest.scope;
  for (const binding of manifest.bindings) {
    exact(binding, ['role','corpusId','record']);
    const r = binding.record;
    ensure(verifyPublicationRecord(r), 'Invalid signed mapped publication');
    ensure(binding.role === 'query' || binding.role === 'publication', 'Invalid mapping role');
    const row = (binding.role === 'query' ? input.corpus.queries : input.corpus.publications).find(v => v.id === binding.corpusId);
    ensure(row?.split === 'test', 'Mapping must name frozen held-out corpus ID');
    ensure(!bindings.has(r.publicationId) && !corpusBindings.has(pairKey(binding.role, binding.corpusId)), 'Ambiguous duplicate/revised mapping');
    ensure(r.groupId === scope.groupId && r.fingerprint.algorithm === scope.algorithm && r.fingerprint.bits === scope.bits && r.fingerprint.epoch === scope.epoch && r.createdAt <= start && r.expiresAt >= end, 'Mapped publication scope/lifetime mismatch');
    bindings.set(r.publicationId, binding); corpusBindings.add(pairKey(binding.role, binding.corpusId));
  }
  const scores = new Map<string, Prediction>(), searched = new Set<string>();
  for (const search of capture.searches) {
    exact(search, ['queryId','eventKind','observedAt','threshold','k','results']);
    const q = manifest.bindings.find(b => b.role === 'query' && b.corpusId === search.queryId);
    ensure(q && !searched.has(search.queryId) && search.eventKind === 'ephemeral-search' && time(search.observedAt) >= start && time(search.observedAt) <= end && search.threshold === config.candidateThreshold && Number.isInteger(search.k) && search.k >= 5 && search.k <= 100000 && Array.isArray(search.results) && search.results.length <= search.k, 'Invalid/duplicate search capture');
    searched.add(search.queryId);
    for (const result of search.results) {
      exact(result, ['did','itemType','similarity']);
      const p = bindings.get(result.did);
      ensure(p?.role === 'publication' && q!.record.itemType !== p.record.itemType && result.itemType === p.record.itemType, 'Unmapped/noncomplementary search result');
      const k = pairKey(q!.corpusId, p!.corpusId);
      const actual = hammingSimilarity(decodeBase64(q!.record.fingerprint.value), decodeBase64(p!.record.fingerprint.value));
      ensure(!scores.has(k) && Number.isFinite(result.similarity) && result.similarity >= search.threshold && Math.abs(actual - result.similarity) <= 1e-12, 'Duplicate/inconsistent observed search score');
      scores.set(k, { queryId: q!.corpusId, publicationId: p!.corpusId, score: result.similarity, notified: null });
    }
  }
  function snapshot(s: InboxSnapshot, expectedTime: number) {
    exact(s, ['runId','manifestSha256','capturedAt','notices','excludedRows']);
    ensure(s && s.runId === manifest.runId && s.manifestSha256 === manifestSha256 && time(s.capturedAt) === expectedTime && Number.isInteger(s.excludedRows) && s.excludedRows >= 0 && Array.isArray(s.notices) && s.notices.length <= 100000, 'Invalid snapshot window/run/bounds');
    const result = new Map<string, string>();
    for (const notice of s.notices) {
      ensure(verifyMatchNoticeMessage(notice), 'Invalid signed snapshot notice');
      const n = notice.payload, q = bindings.get(n.recipientPublicationId), p = bindings.get(n.partnerPublicationId);
      ensure(q?.role === 'query' && p?.role === 'publication', 'Unmapped/reversed snapshot notice');
      ensure(verifyMatchOperationAgainstPublicationsV2(n.matchOperation, q!.record, p!.record, 0), 'Stale/foreign notice revision or scope');
      const k = pairKey(q!.corpusId, p!.corpusId);
      ensure(!result.has(n.matchId), 'Duplicate snapshot notice ID'); result.set(n.matchId, k);
      if (expectedTime === end) {
        const score = scores.get(k);
        ensure(score && Math.abs(score.score - n.similarity) <= 1e-12, 'Notice missing/inconsistent scored capture');
      }
    }
    return result;
  }
  const baseline = snapshot(capture.baseline, start), ending = snapshot(capture.end, end);
  for (const [id, k] of baseline) ensure(ending.get(id) === k, 'Snapshot lost/changed a baseline row');
  for (const [id, k] of ending) if (!baseline.has(id)) scores.get(k)!.notified = true;
  input.predictions = { generatedAt: manifest.window.end, configSha256, pipeline: 'actual-v2-inbox-snapshot-delta + MatchingEngine.search; capture provenance self-declared', rows: [...scores.values()].sort((a,b) => pairKey(a.queryId,a.publicationId).localeCompare(pairKey(b.queryId,b.publicationId))) };
  const report = evaluateJudgedQuality(configBytes, JSON.stringify(input), configSha256);
  return { version: 1, input, report, manifestSha256, captureSha256: bytesHash(captureBytes), outputSha256: contentHash(input), complete: false, k5Qualified: false,
    gaps: ['Capture origin/window completeness and code/model hashes are declarations, not authenticated collection evidence.', 'Snapshot delta counts newly stored v2 inbox rows before vector confirmation; no complete explicit-false decision stream exists. Missing, failed, pending, cancelled and omitted pairs remain unknown.', 'Search ranking is limited to captured threshold/k; omitted below-threshold publications may affect Recall@5.', 'Single frozen revision/scope only; epoch migration and live deletion/reinsertion are not qualified.'] };
}
