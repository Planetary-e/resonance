import { archivedAdmissionPolicyDigest, verifyArchivedAdmissionPolicy, assertArchivedAdmissionPolicyCurrent, parseAdmissionPolicyProofReference, parseAdmissionPolicyProofAppend, admissionPolicyHistoryEntry, type ArchivedAdmissionPolicy, type AdmissionPolicyProofReference, type AdmissionPolicyProofAppend, type AdmissionPolicyHistoryMembership } from '@resonance/core/admission-policy-archive';
import { parseAdmissionPolicyTrust, type AdmissionPolicyTrust } from '@resonance/core/admission-policy-trust';
import { sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHistoryProof, validateAdmissionPolicyHistoryImage, type PolicyProofHistory } from './admission-policy-history-proof.js';
/** Semantic admission records inside owner-authenticated encrypted history envelopes. */
import { exactWitnessFields, type AdmissionSpendCertificate } from '@resonance/core/admission-witness';
import { admissionKeyFingerprint, assertAdmissionPolicySuccessor, isArchivedAdmissionKey, verifyAdmissionPolicy, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { HISTORY_CHECKPOINT_MAX_PAYLOAD, HISTORY_DELTA_MAX_PAYLOAD } from '@resonance/core/history-checkpoint';
import { parseAdmissionSpendState, type AdmissionSpendRecord } from './admission-spend-history.js';
import type { AdmissionSpendState } from './admission-legacy-recovery.js';
import { planAdmissionHistoryRetirement } from './admission-history-retirement.js';
import { parseAdmissionRoleHistories, admissionRoleHistoriesIdentity, assertAdmissionRoleCapture, reduceAdmissionRoleHistory, type AdmissionRoleHistories, type AdmissionRoleMutation } from './admission-role-history.js';

export type AdmissionHistoryImage = {
  kind: 'admission-spend-checkpoint'; policy: ArchivedAdmissionPolicy; state: AdmissionSpendState;
  proofVersion?: 1; policyProof?: AdmissionPolicyProofReference; policyProofAppend?: AdmissionPolicyProofAppend; policyTrust?: AdmissionPolicyTrust;
} & ({ version: 1 } | { version: 2; roles: AdmissionRoleHistories });
export interface AdmissionHistoryPolicyCheckpoint {
  version: 1; kind: 'admission-policy-checkpoint'; at: number; image: AdmissionHistoryImage;
}
/** A complete, unchanged application image. Publishing it alone authorizes no pruning. */
export interface AdmissionHistoryStateCheckpoint {
  version: 1; kind: 'admission-state-checkpoint'; at: number; image: AdmissionHistoryImage;
}
/** Capturing a local role requires a separate same-file protection fence. */
export interface AdmissionHistoryRoleCheckpoint {
  version: 1; kind: 'admission-roles-checkpoint'; at: number; image: AdmissionHistoryImage & { version: 2 };
}
export type AdmissionHistoryRecord = AdmissionHistoryMutation | AdmissionHistoryPolicyCheckpoint | AdmissionHistoryStateCheckpoint | AdmissionHistoryRoleCheckpoint | AdmissionHistoryProofCheckpoint;
export interface AdmissionHistoryProofCheckpoint {
  version: 1; kind: 'admission-policy-proof-checkpoint'; at: number; image: AdmissionHistoryImage;
}
/** One authenticated decision and its matching spend, applied as one history mutation. */
export interface AdmissionAuthorizedSpendRecord {
  version: 1; kind: 'authorized-spend'; at: number;
  certificate: AdmissionSpendCertificate; row: AdmissionSpendRecord & { issuerKey: string };
}
export type AdmissionHistoryMutation =
  | { version: 1; kind: 'spend'; at: number; row: AdmissionSpendRecord & { issuerKey: string } }
  | AdmissionAuthorizedSpendRecord
  | { version: 1; kind: 'retire'; at: number; issuerKey: string }
  | { version: 1; kind: 'policy'; at: number; policy: SignedAdmissionPolicy }
  | { version: 1; kind: 'legacy-recovery'; at: number; attributions: Array<{ spend: string; issuerKey: string }> }
  | AdmissionRoleMutation;

function bounded(value: unknown, maxBytes: number): unknown {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > maxBytes) throw new Error('Admission history record capacity exceeded');
  return JSON.parse(encoded);
}
export async function parseAdmissionHistoryImage(value: unknown, authority: string, limit = 10000, proofHistory?: PolicyProofHistory): Promise<AdmissionHistoryImage> {
  const image = bounded(value, HISTORY_CHECKPOINT_MAX_PAYLOAD);
  const version = (image as AdmissionHistoryImage | null)?.version;
  if (!exactWitnessFields(image, ['version', 'kind', 'policy', 'state', ...(version === 2 ? ['roles'] : []), ...((image as AdmissionHistoryImage)?.proofVersion === 1 ? ['proofVersion','policyProof','policyTrust', ...((image as AdmissionHistoryImage).policyProofAppend ? ['policyProofAppend'] : [])] : [])]) || (version !== 1 && version !== 2)
    || image.kind !== 'admission-spend-checkpoint') throw new Error('Invalid admission history checkpoint');
  const openingProof = image.proofVersion === 1 && proofHistory ? createAdmissionPolicyHistoryProof({ ...proofHistory,
    reference: parseAdmissionPolicyProofReference(image.policyProof), candidate: image as unknown as AdmissionHistoryImage }) : undefined;
  const policy = openingProof ? await openingProof.budget.wait(() => verifyArchivedAdmissionPolicy(image.policy, authority)) : await verifyArchivedAdmissionPolicy(image.policy, authority);
  const proofVersion = image.proofVersion;
  if (policy.version === 3 && proofVersion !== 1) throw new Error('Protected v3 policy requires retained original proof');
  let membership: AdmissionPolicyHistoryMembership | undefined, proofFields = {};
  if (proofVersion === 1) {
    const policyProof = parseAdmissionPolicyProofReference(image.policyProof), policyTrust = parseAdmissionPolicyTrust(image.policyTrust, policy);
    const policyProofAppend = image.policyProofAppend ? parseAdmissionPolicyProofAppend(image.policyProofAppend) : undefined;
    if (JSON.stringify(policyProof.context) !== JSON.stringify(policyTrust.context) || policyProof.head.revision > policyTrust.installed.revision) throw new Error('Policy proof differs from independently installed observer pins');
    if (!proofHistory) throw new Error('Protected policy requires its retained funded history reader');
    const proofImage = { policyProof, ...(policyProofAppend ? { policyProofAppend } : {}) };
    if (sameAdmissionPolicyHead(policyProof.head, policyTrust.installed)) {
      const raw = image as unknown as AdmissionHistoryImage, roles = raw.version === 2 ? raw.roles : { witness: null, coordinator: null };
      const issuerKeys = [...new Set([...(Array.isArray(raw.state?.spends) ? raw.state.spends.map(row => row.issuerKey).filter((key): key is string => typeof key === 'string') : []),
        ...(raw.state?.retiredIssuerKeys ?? []), ...(roles.witness?.votes ?? []).map(vote => vote.issuerKey), ...(roles.witness?.retiredIssuerKeys ?? []),
        ...(roles.coordinator?.certificates ?? []).map(c => c.votes?.[0]?.issuerKey), ...(roles.coordinator?.retiredIssuerKeys ?? [])])];
      const participants = [...(roles.witness ? [{ role: 'witness' as const, publicKey: roles.witness.witness }] : []),
        ...(roles.coordinator ? [{ role: 'coordinator' as const, publicKey: roles.coordinator.coordinator }] : [])];
      membership = (await validateAdmissionPolicyHistoryImage({ ...proofHistory, image: proofImage, policy, issuerKeys, participants })).membership;
    } else {
      if (policy.version === 3) throw new Error('V3 proof must reach the exact installed head');
      await createAdmissionPolicyHistoryProof({ ...proofHistory, reference: policyProof, candidate: proofImage }).resolve();
    }
    proofFields = { proofVersion: 1 as const, policyProof, policyTrust, ...(policyProofAppend ? { policyProofAppend } : {}) };
  }
  const parsed = { kind: 'admission-spend-checkpoint' as const, policy, state: parseAdmissionSpendState(image.state, policy, limit, membership) };
  // Preserve the established v1 field order used by retained replay digests.
  const normalized: AdmissionHistoryImage = version === 1 ? { version: 1, ...parsed, ...proofFields } : { version: 2, ...parsed, roles: parseAdmissionRoleHistories(image.roles, policy, limit, membership), ...proofFields };
  openingProof?.budget.check(); return normalized;
}
export function encodeAdmissionHistoryRecord(value: AdmissionHistoryImage | AdmissionHistoryRecord): Buffer {
  const checkpoint = value.kind === 'admission-spend-checkpoint' || value.kind === 'admission-policy-checkpoint'
    || value.kind === 'admission-state-checkpoint' || value.kind === 'admission-roles-checkpoint' || value.kind === 'admission-policy-proof-checkpoint';
  return Buffer.from(JSON.stringify(bounded(value, checkpoint ? HISTORY_CHECKPOINT_MAX_PAYLOAD : HISTORY_DELTA_MAX_PAYLOAD)));
}

/** Decode a full owner-authenticated state record. A caller replacing omitted
 * history must independently authenticate its checkpoint ancestry certificate;
 * this parser alone proves neither prior-state preservation nor freshness. */
export async function parseAdmissionStateCheckpoint(value: unknown, authority: string, limit = 10000, proofHistory?: PolicyProofHistory): Promise<AdmissionHistoryStateCheckpoint> {
  const raw = bounded(value, HISTORY_CHECKPOINT_MAX_PAYLOAD);
  if (!exactWitnessFields(raw, ['version', 'kind', 'at', 'image']) || raw.version !== 1 || raw.kind !== 'admission-state-checkpoint'
    || !Number.isSafeInteger(raw.at) || (raw.at as number) < 0) throw new Error('Invalid complete admission state checkpoint');
  const image = await parseAdmissionHistoryImage(raw.image, authority, limit, proofHistory), at = raw.at as number;
  assertArchivedAdmissionPolicyCurrent(image.policy, at);
  return { version: 1, kind: 'admission-state-checkpoint', at, image };
}

function spendStateIdentity(state: AdmissionSpendState): string {
  return JSON.stringify([state.version, state.authority,
    state.spends.map(row => JSON.stringify([row.spend, row.action, row.binding, row.issuerKey])).sort(),
    [...state.retiredIssuerKeys].sort()]);
}
const rolesOf = (image: AdmissionHistoryImage): AdmissionRoleHistories => image.version === 2 ? image.roles : { witness: null, coordinator: null };
function preserveRoles(previous: AdmissionHistoryImage, replacement: AdmissionHistoryImage) {
  if (previous.version !== replacement.version || admissionRoleHistoriesIdentity(rolesOf(previous)) !== admissionRoleHistoriesIdentity(rolesOf(replacement))) {
    throw new Error('Checkpoint must preserve every admission role, decision and permanent denial');
  }
}

/**
 * The image must come from parseAdmissionHistoryImage or a prior successful reduction.
 * The enclosing envelope authenticates the owner's historical operation; `at` is
 * owner-asserted event time, never independent freshness or a trusted wall clock.
 */
export async function reduceAdmissionHistory(image: AdmissionHistoryImage, value: unknown, limit = 10000,
  envelopeKind: 'delta' | 'checkpoint' = 'delta', proofHistory?: PolicyProofHistory): Promise<{
  record: AdmissionHistoryRecord; image: AdmissionHistoryImage;
}> {
  const input = bounded(value, envelopeKind === 'checkpoint' ? HISTORY_CHECKPOINT_MAX_PAYLOAD : HISTORY_DELTA_MAX_PAYLOAD), current = structuredClone(image);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid admission history mutation');
  const raw = input as Record<string, unknown>;
  const fields = raw.kind === 'authorized-spend' ? ['certificate', 'row'] : raw.kind === 'spend' ? ['row'] : raw.kind === 'retire' ? ['issuerKey']
    : raw.kind === 'policy' ? ['policy'] : raw.kind === 'legacy-recovery' ? ['attributions']
      : ['admission-policy-checkpoint', 'admission-state-checkpoint', 'admission-roles-checkpoint', 'admission-policy-proof-checkpoint'].includes(raw.kind as string) ? ['image']
        : raw.kind === 'witness-vote' ? ['vote'] : raw.kind === 'coordinator-certificate' ? ['certificate']
          : raw.kind === 'role-retire' ? ['role', 'issuerKey'] : [];
  if (!fields.length || !exactWitnessFields(raw, ['version', 'kind', 'at', ...fields]) || raw.version !== 1
    || !Number.isSafeInteger(raw.at) || (raw.at as number) < 0
    || (envelopeKind === 'checkpoint') !== ['admission-policy-checkpoint', 'admission-state-checkpoint', 'admission-roles-checkpoint', 'admission-policy-proof-checkpoint'].includes(raw.kind as string)) throw new Error('Invalid admission history mutation');
  const at = raw.at as number, state = current.state, policy = current.policy;
  if (current.policyTrust && ['spend','authorized-spend','witness-vote','coordinator-certificate'].includes(raw.kind as string)
    && (current.policyTrust.conflict || !sameAdmissionPolicyHead(current.policyTrust.installed, current.policyTrust.observed))) throw new Error('Protected admission decision crossed a retained policy fence');
  let membership: AdmissionPolicyHistoryMembership | undefined;
  if (policy.version === 3) {
    if (!proofHistory) throw new Error('V3 history requires its authenticated retained proof reader');
    const roles = current.version === 2 ? current.roles : { witness: null, coordinator: null };
    const extraKey = (raw.row as { issuerKey?: string })?.issuerKey ?? (raw.vote as { issuerKey?: string })?.issuerKey
      ?? (raw.certificate as AdmissionSpendCertificate)?.votes?.[0]?.issuerKey ?? raw.issuerKey;
    const issuerKeys = [...new Set([...state.spends.map(row => row.issuerKey).filter((id): id is string => id !== null), ...state.retiredIssuerKeys,
      ...(roles.witness?.votes ?? []).map(v => v.issuerKey), ...(roles.coordinator?.certificates ?? []).map(c => c.votes[0].issuerKey),
      ...(roles.witness?.retiredIssuerKeys ?? []), ...(roles.coordinator?.retiredIssuerKeys ?? []), ...(typeof extraKey === 'string' ? [extraKey] : [])])];
    const participants = [...(roles.witness ? [{ role: 'witness' as const, publicKey: roles.witness.witness }] : []), ...(roles.coordinator ? [{ role: 'coordinator' as const, publicKey: roles.coordinator.coordinator }] : [])];
    membership = (await validateAdmissionPolicyHistoryImage({ ...proofHistory, image: current, policy, issuerKeys, participants })).membership;
  }
  if (raw.kind === 'authorized-spend') {
    const certificate = raw.certificate as AdmissionSpendCertificate, row = raw.row as AdmissionAuthorizedSpendRecord['row'];
    const claim = certificate?.votes?.[0];
    if (!claim || !row || claim.issuerKey !== row.issuerKey || claim.spend !== row.spend
      || claim.action !== row.action || claim.requestBinding !== row.binding) throw new Error('Authorized spend certificate does not match the spend');
    // Reuse both complete mutation rules on copies. Neither half can escape if
    // authentication, capacity, retirement or the other half's cutoff fails.
    const authorized = await reduceAdmissionHistory(current, { version: 1, kind: 'coordinator-certificate', at, certificate }, limit, 'delta', proofHistory);
    const spent = await reduceAdmissionHistory(authorized.image, { version: 1, kind: 'spend', at, row }, limit, 'delta', proofHistory);
    return { record: { version: 1, kind: 'authorized-spend', at, certificate: structuredClone(certificate), row: { ...row } }, image: spent.image };
  }
  let next = state, record: AdmissionHistoryRecord;
  if (raw.kind === 'admission-policy-proof-checkpoint') {
    const replacement = await parseAdmissionHistoryImage(raw.image, policy.authority, limit, proofHistory);
    if (!replacement.policyProof || !replacement.policyTrust || !replacement.policyProofAppend) throw new Error('Policy proof checkpoint lacks its bounded authenticated append');
    if (spendStateIdentity(replacement.state) !== spendStateIdentity(state)) throw new Error('Policy proof checkpoint must preserve every spend and denial');
    preserveRoles(current, replacement);
    if (current.policyProof && (JSON.stringify(current.policyProof.context) !== JSON.stringify(replacement.policyProof.context)
      || JSON.stringify(current.policyProof.limits) !== JSON.stringify(replacement.policyProof.limits)
      || (replacement.policyProof.head.revision !== current.policyProof.head.revision + 1 && !sameAdmissionPolicyHead(replacement.policyProof.head, current.policyProof.head)))) throw new Error('Protected proof must extend original pins by one bounded step');
    if (!current.policyProof && (replacement.policyProofAppend.kind !== 'genesis' || !sameAdmissionPolicyHead(replacement.policyProof.head, replacement.policyProof.genesis))) throw new Error('Protected proof starts at its original genesis');
    if (current.policyProof && sameAdmissionPolicyHead(current.policyProof.head, replacement.policyProof.head) && JSON.stringify(current.policyProofAppend) !== JSON.stringify(replacement.policyProofAppend)) throw new Error('Unchanged proof reference cannot replace its retained append');
    const changed = archivedAdmissionPolicyDigest(policy) !== archivedAdmissionPolicyDigest(replacement.policy);
    if (changed) {
      if (!current.policyProof || !current.policyTrust || !sameAdmissionPolicyHead(current.policyProof.head, current.policyTrust.installed)
        || replacement.policyProofAppend.kind !== 'advance' || !sameAdmissionPolicyHead(replacement.policyProofAppend.advance.commitment.previous, current.policyTrust.installed)
        || !sameAdmissionPolicyHead(replacement.policyProof.head, replacement.policyTrust.installed)
        || archivedAdmissionPolicyDigest(replacement.policyProofAppend.advance.policy) !== archivedAdmissionPolicyDigest(replacement.policy)) throw new Error('Protected policy installation requires its exact immediate original proof');
      assertArchivedAdmissionPolicyCurrent(replacement.policy, at);
      if (current.policyTrust.conflict || replacement.policyTrust.observed.revision < current.policyTrust.observed.revision
        || replacement.policyTrust.observed.revision === current.policyTrust.observed.revision && !sameAdmissionPolicyHead(replacement.policyTrust.observed, current.policyTrust.observed)) throw new Error('Protected policy freshness cannot roll back or discard conflict');
    } else if (current.policyTrust && JSON.stringify(current.policyTrust) !== JSON.stringify(replacement.policyTrust)) {
      const before = current.policyTrust, after = replacement.policyTrust;
      if (!current.policyProof || !sameAdmissionPolicyHead(current.policyProof.head, replacement.policyProof.head)
        || !sameAdmissionPolicyHead(before.installed, after.installed) || before.conflict
        || after.observed.revision < before.observed.revision || after.observed.revision === before.observed.revision && !sameAdmissionPolicyHead(after.observed, before.observed)
        || after.conflict && !sameAdmissionPolicyHead(before.observed, after.observed)) throw new Error('Proof backfill must preserve installed freshness; observations cannot roll back');
    }
    Object.assign(current, replacement); next = replacement.state;
    record = { version: 1, kind: 'admission-policy-proof-checkpoint', at, image: replacement };
  } else if (raw.kind === 'admission-state-checkpoint') {
    const replacement = (await parseAdmissionStateCheckpoint(raw, policy.authority, limit, proofHistory)).image;
    assertArchivedAdmissionPolicyCurrent(policy, at);
    if (archivedAdmissionPolicyDigest(replacement.policy) !== archivedAdmissionPolicyDigest(policy)
      || spendStateIdentity(replacement.state) !== spendStateIdentity(state)) {
      throw new Error('State checkpoint must preserve the policy, every spend and permanent denial');
    }
    preserveRoles(current, replacement);
    if (JSON.stringify([current.policyProof, current.policyProofAppend, current.policyTrust]) !== JSON.stringify([replacement.policyProof, replacement.policyProofAppend, replacement.policyTrust])) throw new Error('Business checkpoint must preserve original policy proof and freshness');
    // Preserve the retained ordering as well as semantics; a checkpoint is no mutation.
    record = { version: 1, kind: 'admission-state-checkpoint', at, image: structuredClone(current) };
  } else if (raw.kind === 'admission-policy-checkpoint') {
    const replacement = await parseAdmissionHistoryImage(raw.image, policy.authority, limit, proofHistory);
    assertArchivedAdmissionPolicyCurrent(replacement.policy, at); if (policy.version !== 3 && replacement.policy.version !== 3) assertAdmissionPolicySuccessor(policy, replacement.policy); else throw new Error('V3 policy changes require protected proof checkpoints');
    if (spendStateIdentity(replacement.state) !== spendStateIdentity(state)) throw new Error('Policy checkpoint must preserve every spend and permanent denial');
    preserveRoles(current, replacement);
    current.policy = replacement.policy; next = replacement.state;
    record = { version: 1, kind: 'admission-policy-checkpoint', at, image: replacement };
  } else if (raw.kind === 'admission-roles-checkpoint') {
    const replacement = await parseAdmissionHistoryImage(raw.image, policy.authority, limit, proofHistory);
    assertArchivedAdmissionPolicyCurrent(policy, at);
    if (replacement.version !== 2 || archivedAdmissionPolicyDigest(replacement.policy) !== archivedAdmissionPolicyDigest(policy)
      || spendStateIdentity(replacement.state) !== spendStateIdentity(state)) throw new Error('Role capture must preserve policy and spends');
    assertAdmissionRoleCapture(rolesOf(current), replacement.roles);
    // This records an explicitly fenced local capture; it is not authorization
    // to initialize a missing witness or invent a replacement membership.
    Object.assign(current, { version: 2, roles: replacement.roles });
    record = { version: 1, kind: 'admission-roles-checkpoint', at, image: replacement };
  } else if (['witness-vote', 'coordinator-certificate', 'role-retire'].includes(raw.kind as string)) {
    if (current.version !== 2 || (raw.kind === 'role-retire' && (!['witness', 'coordinator'].includes(raw.role as string)
      || typeof raw.issuerKey !== 'string'))) throw new Error('Admission role has not been captured or is invalid');
    record = structuredClone(raw) as unknown as AdmissionRoleMutation;
    current.roles = reduceAdmissionRoleHistory(current.roles, record, policy, limit, membership);
  } else if (raw.kind === 'policy') {
    if (policy.version === 3 || current.policyProof) throw new Error('Resolved protected policy changes require a proof checkpoint');
    const successor = await verifyAdmissionPolicy(raw.policy, policy.authority);
    assertArchivedAdmissionPolicyCurrent(successor, at); assertAdmissionPolicySuccessor(policy, successor);
    current.policy = successor;
    record = { version: 1, kind: 'policy', at, policy: successor };
  } else {
    assertArchivedAdmissionPolicyCurrent(policy, at);
    if (raw.kind === 'spend') {
      const row = raw.row as AdmissionSpendRecord & { issuerKey: string };
      if (!row || typeof row.issuerKey !== 'string') throw new Error('Admission history spend needs issuer attribution');
      // Reuse the complete persisted-state rules, including exact fields and legacy action/binding encoding.
      parseAdmissionSpendState({ ...state, spends: [row] }, policy, limit, membership);
      const entry = admissionPolicyHistoryEntry(policy, membership, row.issuerKey);
      const previous = state.spends.find(r => r.spend === row.spend);
      if (!entry || (policy.version === 3 ? !policy.keys.some(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === row.issuerKey) : isArchivedAdmissionKey(policy, row.issuerKey)) || state.retiredIssuerKeys.includes(row.issuerKey)
        || at < entry.notBefore || at >= (previous ? entry.retryUntil : entry.spendUntil)) throw new Error('Admission history issuer is unavailable at the recorded time');
      if (previous && (previous.action !== row.action || previous.binding !== row.binding
        || (previous.issuerKey !== null && previous.issuerKey !== row.issuerKey))) throw new Error('Conflicting admission history spend');
      next = { ...state, spends: previous ? state.spends.map(r => r.spend === row.spend ? { ...row } : r) : [...state.spends, { ...row }] };
      record = { version: 1, kind: 'spend', at, row: { ...row } };
    } else if (raw.kind === 'retire') {
      if (typeof raw.issuerKey !== 'string') throw new Error('Invalid history retirement key');
      planAdmissionHistoryRetirement({ role: 'local-spends', participant: 'protected-history', policy, issuerKey: raw.issuerKey,
        state, retiredIssuerKeys: state.retiredIssuerKeys, entries: state.spends.length,
        remove: state.spends.filter(row => row.issuerKey === raw.issuerKey).length, maximumEntries: limit, now: at, membership });
      next = { ...state, spends: state.spends.filter(row => row.issuerKey !== raw.issuerKey), retiredIssuerKeys: [...state.retiredIssuerKeys, raw.issuerKey].sort() };
      record = { version: 1, kind: 'retire', at, issuerKey: raw.issuerKey };
    } else {
      if (!Array.isArray(raw.attributions) || raw.attributions.length < 1 || raw.attributions.length > 32) throw new Error('Invalid historical legacy attribution batch');
      const selected = new Set<string>(), keys = new Set<string>();
      const attributions = raw.attributions.map((row: unknown) => {
        if (!exactWitnessFields(row, ['spend', 'issuerKey']) || typeof row.spend !== 'string' || typeof row.issuerKey !== 'string'
          || selected.has(row.spend) || !state.spends.some(r => r.spend === row.spend && r.issuerKey === null)) throw new Error('Legacy history attribution does not identify one unattributed row');
        const entry = admissionPolicyHistoryEntry(policy, membership, row.issuerKey);
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
  if (raw.kind === 'admission-policy-proof-checkpoint') return { record, image: current };
  current.state = parseAdmissionSpendState(next, current.policy, limit, membership);
  if (current.version === 2) current.roles = parseAdmissionRoleHistories(current.roles, current.policy, limit, membership);
  return { record, image: current };
}
