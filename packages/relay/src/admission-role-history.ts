/** Witness/coordinator decisions retained inside encrypted owner history.
 * Parsing proves signatures and membership, not freshness or safe restoration. */
import { admissionKeyFingerprint, admissionPolicyKeys, assertAdmissionPolicyCurrent, isArchivedAdmissionKey,
  type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionSpendClaimId, exactWitnessFields, verifyAdmissionSpendCertificate, verifyAdmissionWitnessVote, witnessBytes,
  type AdmissionSpendCertificate, type AdmissionSpendClaim, type AdmissionWitnessVote } from '@resonance/core/admission-witness';
import { planAdmissionHistoryRetirement, validRetiredIssuerKeys } from './admission-history-retirement.js';

export interface AdmissionWitnessHistoryState {
  version: 2; witness: string; votes: AdmissionWitnessVote[]; retiredIssuerKeys: string[];
}
export interface AdmissionCoordinatorHistoryState {
  version: 2; coordinator: string; certificates: AdmissionSpendCertificate[]; retiredIssuerKeys: string[];
}
export interface AdmissionRoleHistories {
  witness: AdmissionWitnessHistoryState | null; coordinator: AdmissionCoordinatorHistoryState | null;
}
export type AdmissionRoleMutation =
  | { version: 1; kind: 'witness-vote'; at: number; vote: AdmissionWitnessVote }
  | { version: 1; kind: 'coordinator-certificate'; at: number; certificate: AdmissionSpendCertificate }
  | { version: 1; kind: 'role-retire'; at: number; role: 'witness' | 'coordinator'; issuerKey: string };
export const admissionRoleClaimIndex = (claim: AdmissionSpendClaim) => `${claim.issuerKey}:${claim.spend}`;
const entryFor = (policy: SignedAdmissionPolicy, issuerKey: string) =>
  admissionPolicyKeys(policy).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === issuerKey);
function capacity(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid admission role history capacity');
}

export function parseAdmissionRoleHistories(value: unknown, policy: SignedAdmissionPolicy, limit = 10000): AdmissionRoleHistories {
  capacity(limit);
  if (!exactWitnessFields(value, ['witness', 'coordinator'])) throw new Error('Invalid admission role histories');
  const byKey = new Map(admissionPolicyKeys(policy).map(entry => [admissionKeyFingerprint(entry.profile.issuerPublicKey), entry]));
  let witness: AdmissionWitnessHistoryState | null = null, coordinator: AdmissionCoordinatorHistoryState | null = null;
  if (value.witness !== null) {
    const raw = value.witness;
    if (!exactWitnessFields(raw, ['version', 'witness', 'votes', 'retiredIssuerKeys']) || raw.version !== 2 || !witnessBytes(raw.witness, 32)
      || ![...byKey.values()].some(entry => entry.witnesses?.members.some(member => member.publicKey === raw.witness))
      || !validRetiredIssuerKeys(raw.retiredIssuerKeys, policy, raw.witness, 'witness')
      || !Array.isArray(raw.votes) || raw.votes.length > limit) throw new Error('Invalid retained witness history');
    const seen = new Set<string>(), retired = new Set(raw.retiredIssuerKeys);
    for (const vote of raw.votes) {
      const set = byKey.get(vote?.issuerKey)?.witnesses;
      if (!set || retired.has(vote?.issuerKey) || vote.witness !== raw.witness || !verifyAdmissionWitnessVote(vote, vote, set)
        || seen.has(admissionRoleClaimIndex(vote))) throw new Error('Invalid or conflicting retained witness vote');
      seen.add(admissionRoleClaimIndex(vote));
    }
    witness = structuredClone(raw) as unknown as AdmissionWitnessHistoryState;
  }
  if (value.coordinator !== null) {
    const raw = value.coordinator;
    if (!exactWitnessFields(raw, ['version', 'coordinator', 'certificates', 'retiredIssuerKeys']) || raw.version !== 2 || !witnessBytes(raw.coordinator, 32)
      || ![...byKey.values()].some(entry => entry.witnesses?.coordinators.includes(raw.coordinator as string))
      || !validRetiredIssuerKeys(raw.retiredIssuerKeys, policy, raw.coordinator, 'coordinator')
      || !Array.isArray(raw.certificates) || raw.certificates.length > limit) throw new Error('Invalid retained coordinator history');
    const seen = new Set<string>(), retired = new Set(raw.retiredIssuerKeys);
    for (const certificate of raw.certificates) {
      const claim = certificate?.votes?.[0], set = byKey.get(claim?.issuerKey)?.witnesses;
      if (!set || !claim || !set.coordinators.includes(raw.coordinator) || retired.has(claim.issuerKey)
        || !verifyAdmissionSpendCertificate(certificate, claim, set) || seen.has(admissionRoleClaimIndex(claim))) {
        throw new Error('Invalid or conflicting retained admission certificate');
      }
      seen.add(admissionRoleClaimIndex(claim));
    }
    coordinator = structuredClone(raw) as unknown as AdmissionCoordinatorHistoryState;
  }
  return { witness, coordinator };
}

/** Preserve exact signed decisions while ignoring harmless collection ordering. */
export function admissionRoleHistoriesIdentity(value: AdmissionRoleHistories): string {
  const decision = (v: AdmissionWitnessVote) => JSON.stringify([admissionSpendClaimId(v), v.version, v.kind, v.witness, v.signature]);
  return JSON.stringify([
    value.witness && [value.witness.witness, value.witness.votes.map(decision).sort(), [...value.witness.retiredIssuerKeys].sort()],
    value.coordinator && [value.coordinator.coordinator,
      value.coordinator.certificates.map(c => JSON.stringify(c.votes.map(decision).sort())).sort(), [...value.coordinator.retiredIssuerKeys].sort()],
  ]);
}

/** Existing roles cannot be replaced or cleared by a capture checkpoint. The
 * caller must separately fence and capture any previously local role. */
export function assertAdmissionRoleCapture(before: AdmissionRoleHistories, after: AdmissionRoleHistories) {
  for (const role of ['witness', 'coordinator'] as const) if (before[role] !== null) {
    if (admissionRoleHistoriesIdentity({ witness: null, coordinator: null, [role]: before[role] })
      !== admissionRoleHistoriesIdentity({ witness: null, coordinator: null, [role]: after[role] })) {
      throw new Error('Role capture must preserve every existing decision and permanent denial');
    }
  }
}

/** A newer image may add decisions or replace expired-key rows with a permanent
 * fence. It must not forget a captured participant, decision or prior fence. */
export function assertAdmissionRoleRetention(before: AdmissionRoleHistories, after: AdmissionRoleHistories) {
  for (const role of ['witness', 'coordinator'] as const) {
    const old = before[role], next = after[role]; if (!old) continue;
    if (!next || ('witness' in old ? old.witness !== (next as AdmissionWitnessHistoryState).witness
      : old.coordinator !== (next as AdmissionCoordinatorHistoryState).coordinator)
      || old.retiredIssuerKeys.some(key => !next.retiredIssuerKeys.includes(key))) throw new Error('Retained admission role or denial is missing');
    const decisions = 'votes' in old ? old.votes : old.certificates.map(c => c.votes[0]);
    const retained = new Map(('votes' in next ? next.votes : next.certificates.map(c => c.votes[0])).map(c => [admissionRoleClaimIndex(c), admissionSpendClaimId(c)]));
    if (decisions.some(c => !next.retiredIssuerKeys.includes(c.issuerKey) && retained.get(admissionRoleClaimIndex(c)) !== admissionSpendClaimId(c))) {
      throw new Error('Retained admission role decision is missing or conflicting');
    }
  }
}

export function reduceAdmissionRoleHistory(roles: AdmissionRoleHistories, record: AdmissionRoleMutation,
  policy: SignedAdmissionPolicy, limit = 10000): AdmissionRoleHistories {
  capacity(limit); assertAdmissionPolicyCurrent(policy, record.at);
  const next = structuredClone(roles);
  if (record.kind === 'role-retire') {
    const state = next[record.role]; if (!state) throw new Error('Admission role has not been captured');
    const participant = record.role === 'witness' ? next.witness!.witness : next.coordinator!.coordinator;
    const claims = record.role === 'witness' ? next.witness!.votes : next.coordinator!.certificates.map(cert => cert.votes[0]);
    planAdmissionHistoryRetirement({ role: record.role, participant, policy, issuerKey: record.issuerKey, state,
      retiredIssuerKeys: state.retiredIssuerKeys, entries: claims.length, remove: claims.filter(c => c.issuerKey === record.issuerKey).length,
      maximumEntries: limit, now: record.at });
    state.retiredIssuerKeys = [...state.retiredIssuerKeys, record.issuerKey].sort();
    if (record.role === 'witness') next.witness!.votes = next.witness!.votes.filter(v => v.issuerKey !== record.issuerKey);
    else next.coordinator!.certificates = next.coordinator!.certificates.filter(c => c.votes[0].issuerKey !== record.issuerKey);
  } else {
    const witness = record.kind === 'witness-vote', state = witness ? next.witness : next.coordinator;
    if (!state) throw new Error('Admission role has not been captured');
    const claim = witness ? record.vote : record.certificate?.votes?.[0];
    const entry = entryFor(policy, claim?.issuerKey), set = entry?.witnesses;
    if (!set || !claim || (witness ? record.vote.witness !== next.witness!.witness || !verifyAdmissionWitnessVote(record.vote, record.vote, set)
      : !set.coordinators.includes(next.coordinator!.coordinator) || !verifyAdmissionSpendCertificate(record.certificate, claim, set))) {
      throw new Error('Invalid admission role decision');
    }
    const previous = witness ? next.witness!.votes.find(v => admissionRoleClaimIndex(v) === admissionRoleClaimIndex(claim))
      : next.coordinator!.certificates.find(c => admissionRoleClaimIndex(c.votes[0]) === admissionRoleClaimIndex(claim))?.votes[0];
    if (state.retiredIssuerKeys.includes(claim.issuerKey) || isArchivedAdmissionKey(policy, claim.issuerKey)
      || record.at < entry!.notBefore || record.at >= (witness && !previous ? entry!.spendUntil : entry!.retryUntil)) {
      throw new Error('Admission role issuer is unavailable at the recorded time');
    }
    if (previous && admissionSpendClaimId(previous) !== admissionSpendClaimId(claim)) throw new Error('Conflicting retained admission decision');
    if (!previous) {
      if (witness) next.witness!.votes.push(structuredClone(record.vote));
      else next.coordinator!.certificates.push(structuredClone(record.certificate));
    }
  }
  return parseAdmissionRoleHistories(next, policy, limit);
}
