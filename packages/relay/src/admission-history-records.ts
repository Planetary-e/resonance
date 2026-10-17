/** Semantic admission records inside owner-authenticated encrypted history envelopes. */
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { admissionKeyFingerprint, admissionPolicyDigest, admissionPolicyKeys, assertAdmissionPolicyCurrent, assertAdmissionPolicySuccessor,
  isArchivedAdmissionKey, verifyAdmissionPolicy, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { HISTORY_CHECKPOINT_MAX_PAYLOAD, HISTORY_DELTA_MAX_PAYLOAD } from '@resonance/core/history-checkpoint';
import { parseAdmissionSpendState, type AdmissionSpendRecord } from './admission-spend-history.js';
import type { AdmissionSpendState } from './admission-legacy-recovery.js';
import { planAdmissionHistoryRetirement } from './admission-history-retirement.js';

export interface AdmissionHistoryImage {
  version: 1; kind: 'admission-spend-checkpoint'; policy: SignedAdmissionPolicy; state: AdmissionSpendState;
}
export interface AdmissionHistoryPolicyCheckpoint {
  version: 1; kind: 'admission-policy-checkpoint'; at: number; image: AdmissionHistoryImage;
}
/** A complete, unchanged application image. Publishing it alone authorizes no pruning. */
export interface AdmissionHistoryStateCheckpoint {
  version: 1; kind: 'admission-state-checkpoint'; at: number; image: AdmissionHistoryImage;
}
export type AdmissionHistoryRecord = AdmissionHistoryMutation | AdmissionHistoryPolicyCheckpoint | AdmissionHistoryStateCheckpoint;
export type AdmissionHistoryMutation =
  | { version: 1; kind: 'spend'; at: number; row: AdmissionSpendRecord & { issuerKey: string } }
  | { version: 1; kind: 'retire'; at: number; issuerKey: string }
  | { version: 1; kind: 'policy'; at: number; policy: SignedAdmissionPolicy }
  | { version: 1; kind: 'legacy-recovery'; at: number; attributions: Array<{ spend: string; issuerKey: string }> };

function bounded(value: unknown, maxBytes: number): unknown {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > maxBytes) throw new Error('Admission history record capacity exceeded');
  return JSON.parse(encoded);
}
export async function parseAdmissionHistoryImage(value: unknown, authority: string, limit = 10000): Promise<AdmissionHistoryImage> {
  const image = bounded(value, HISTORY_CHECKPOINT_MAX_PAYLOAD);
  if (!exactWitnessFields(image, ['version', 'kind', 'policy', 'state']) || image.version !== 1
    || image.kind !== 'admission-spend-checkpoint') throw new Error('Invalid admission history checkpoint');
  const policy = await verifyAdmissionPolicy(image.policy, authority);
  return { version: 1, kind: 'admission-spend-checkpoint', policy, state: parseAdmissionSpendState(image.state, policy, limit) };
}
export function encodeAdmissionHistoryRecord(value: AdmissionHistoryImage | AdmissionHistoryRecord): Buffer {
  const checkpoint = value.kind === 'admission-spend-checkpoint' || value.kind === 'admission-policy-checkpoint' || value.kind === 'admission-state-checkpoint';
  return Buffer.from(JSON.stringify(bounded(value, checkpoint ? HISTORY_CHECKPOINT_MAX_PAYLOAD : HISTORY_DELTA_MAX_PAYLOAD)));
}

/** Decode a full owner-authenticated state record. A caller replacing omitted
 * history must independently authenticate its checkpoint ancestry certificate;
 * this parser alone proves neither prior-state preservation nor freshness. */
export async function parseAdmissionStateCheckpoint(value: unknown, authority: string, limit = 10000): Promise<AdmissionHistoryStateCheckpoint> {
  const raw = bounded(value, HISTORY_CHECKPOINT_MAX_PAYLOAD);
  if (!exactWitnessFields(raw, ['version', 'kind', 'at', 'image']) || raw.version !== 1 || raw.kind !== 'admission-state-checkpoint'
    || !Number.isSafeInteger(raw.at) || (raw.at as number) < 0) throw new Error('Invalid complete admission state checkpoint');
  const image = await parseAdmissionHistoryImage(raw.image, authority, limit), at = raw.at as number;
  assertAdmissionPolicyCurrent(image.policy, at);
  return { version: 1, kind: 'admission-state-checkpoint', at, image };
}

function spendStateIdentity(state: AdmissionSpendState): string {
  return JSON.stringify([state.version, state.authority,
    state.spends.map(row => JSON.stringify([row.spend, row.action, row.binding, row.issuerKey])).sort(),
    [...state.retiredIssuerKeys].sort()]);
}

/**
 * The image must come from parseAdmissionHistoryImage or a prior successful reduction.
 * The enclosing envelope authenticates the owner's historical operation; `at` is
 * owner-asserted event time, never independent freshness or a trusted wall clock.
 */
export async function reduceAdmissionHistory(image: AdmissionHistoryImage, value: unknown, limit = 10000,
  envelopeKind: 'delta' | 'checkpoint' = 'delta'): Promise<{
  record: AdmissionHistoryRecord; image: AdmissionHistoryImage;
}> {
  const input = bounded(value, envelopeKind === 'checkpoint' ? HISTORY_CHECKPOINT_MAX_PAYLOAD : HISTORY_DELTA_MAX_PAYLOAD), current = structuredClone(image);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid admission history mutation');
  const raw = input as Record<string, unknown>;
  const fields = raw.kind === 'spend' ? ['row'] : raw.kind === 'retire' ? ['issuerKey']
    : raw.kind === 'policy' ? ['policy'] : raw.kind === 'legacy-recovery' ? ['attributions']
      : raw.kind === 'admission-policy-checkpoint' || raw.kind === 'admission-state-checkpoint' ? ['image'] : [];
  if (!fields.length || !exactWitnessFields(raw, ['version', 'kind', 'at', ...fields]) || raw.version !== 1
    || !Number.isSafeInteger(raw.at) || (raw.at as number) < 0
    || (envelopeKind === 'checkpoint') !== (raw.kind === 'admission-policy-checkpoint' || raw.kind === 'admission-state-checkpoint')) throw new Error('Invalid admission history mutation');
  const at = raw.at as number, state = current.state, policy = current.policy;
  let next = state, record: AdmissionHistoryRecord;
  if (raw.kind === 'admission-state-checkpoint') {
    const replacement = (await parseAdmissionStateCheckpoint(raw, policy.authority, limit)).image;
    assertAdmissionPolicyCurrent(policy, at);
    if (admissionPolicyDigest(replacement.policy) !== admissionPolicyDigest(policy)
      || spendStateIdentity(replacement.state) !== spendStateIdentity(state)) {
      throw new Error('State checkpoint must preserve the policy, every spend and permanent denial');
    }
    // Preserve the retained ordering as well as semantics; a checkpoint is no mutation.
    record = { version: 1, kind: 'admission-state-checkpoint', at, image: structuredClone(current) };
  } else if (raw.kind === 'admission-policy-checkpoint') {
    const replacement = await parseAdmissionHistoryImage(raw.image, policy.authority, limit);
    assertAdmissionPolicyCurrent(replacement.policy, at); assertAdmissionPolicySuccessor(policy, replacement.policy);
    if (spendStateIdentity(replacement.state) !== spendStateIdentity(state)) throw new Error('Policy checkpoint must preserve every spend and permanent denial');
    current.policy = replacement.policy; next = replacement.state;
    record = { version: 1, kind: 'admission-policy-checkpoint', at, image: replacement };
  } else if (raw.kind === 'policy') {
    const successor = await verifyAdmissionPolicy(raw.policy, policy.authority);
    assertAdmissionPolicyCurrent(successor, at); assertAdmissionPolicySuccessor(policy, successor);
    current.policy = successor;
    record = { version: 1, kind: 'policy', at, policy: successor };
  } else {
    assertAdmissionPolicyCurrent(policy, at);
    if (raw.kind === 'spend') {
      const row = raw.row as AdmissionSpendRecord & { issuerKey: string };
      if (!row || typeof row.issuerKey !== 'string') throw new Error('Admission history spend needs issuer attribution');
      // Reuse the complete persisted-state rules, including exact fields and legacy action/binding encoding.
      parseAdmissionSpendState({ ...state, spends: [row] }, policy, limit);
      const entry = admissionPolicyKeys(policy).find(e => admissionKeyFingerprint(e.profile.issuerPublicKey) === row.issuerKey);
      const previous = state.spends.find(r => r.spend === row.spend);
      if (!entry || isArchivedAdmissionKey(policy, row.issuerKey) || state.retiredIssuerKeys.includes(row.issuerKey)
        || at < entry.notBefore || at >= (previous ? entry.retryUntil : entry.spendUntil)) throw new Error('Admission history issuer is unavailable at the recorded time');
      if (previous && (previous.action !== row.action || previous.binding !== row.binding
        || (previous.issuerKey !== null && previous.issuerKey !== row.issuerKey))) throw new Error('Conflicting admission history spend');
      next = { ...state, spends: previous ? state.spends.map(r => r.spend === row.spend ? { ...row } : r) : [...state.spends, { ...row }] };
      record = { version: 1, kind: 'spend', at, row: { ...row } };
    } else if (raw.kind === 'retire') {
      if (typeof raw.issuerKey !== 'string') throw new Error('Invalid history retirement key');
      planAdmissionHistoryRetirement({ role: 'local-spends', participant: 'protected-history', policy, issuerKey: raw.issuerKey,
        state, retiredIssuerKeys: state.retiredIssuerKeys, entries: state.spends.length,
        remove: state.spends.filter(row => row.issuerKey === raw.issuerKey).length, maximumEntries: limit, now: at });
      next = { ...state, spends: state.spends.filter(row => row.issuerKey !== raw.issuerKey), retiredIssuerKeys: [...state.retiredIssuerKeys, raw.issuerKey].sort() };
      record = { version: 1, kind: 'retire', at, issuerKey: raw.issuerKey };
    } else {
      if (!Array.isArray(raw.attributions) || raw.attributions.length < 1 || raw.attributions.length > 32) throw new Error('Invalid historical legacy attribution batch');
      const selected = new Set<string>(), keys = new Set<string>();
      const attributions = raw.attributions.map((row: unknown) => {
        if (!exactWitnessFields(row, ['spend', 'issuerKey']) || typeof row.spend !== 'string' || typeof row.issuerKey !== 'string'
          || selected.has(row.spend) || !state.spends.some(r => r.spend === row.spend && r.issuerKey === null)) throw new Error('Legacy history attribution does not identify one unattributed row');
        const entry = admissionPolicyKeys(policy).find(e => admissionKeyFingerprint(e.profile.issuerPublicKey) === row.issuerKey);
        if (!entry || policy.activeKey === row.issuerKey || at < entry.retryUntil) throw new Error('Historical legacy recovery precedes final key cutoff');
        selected.add(row.spend); keys.add(row.issuerKey); return { spend: row.spend, issuerKey: row.issuerKey };
      }).sort((a, b) => a.spend < b.spend ? -1 : a.spend > b.spend ? 1 : 0);
      next = { ...state, spends: state.spends.filter(r => !selected.has(r.spend) && (r.issuerKey === null || !keys.has(r.issuerKey))),
        retiredIssuerKeys: [...new Set([...state.retiredIssuerKeys, ...keys])].sort() };
      // This records the authenticated owner's already verified local proofs, not bearer tokens.
      // Live callers must run checkAdmissionLegacyRecovery before creating this record.
      record = { version: 1, kind: 'legacy-recovery', at, attributions };
    }
  }
  current.state = parseAdmissionSpendState(next, current.policy, limit);
  return { record, image: current };
}
