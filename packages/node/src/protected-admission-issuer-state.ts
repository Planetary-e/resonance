import { parseAdmissionPolicyTrust } from '@resonance/core/admission-policy-trust';
import { createAdmissionPolicyHistoryProof, type PolicyProofOperation, type PolicyProofCache } from '../../relay/src/admission-policy-history-proof.js';
import { inspectResolvedAdmissionPolicyKey, retainedResolvedAdmissionPolicyKey } from '@resonance/core/admission-policy-archive';
import type { HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
/** Authenticated full issuer images, shared by live storage and historical replay. */
import { archivedAdmissionPolicyDigest, verifyArchivedAdmissionPolicy, parseAdmissionPolicyProofReference, parseAdmissionPolicyProofAppend, assertArchivedAdmissionPolicyCurrent, type ArchivedAdmissionPolicy, type AdmissionPolicyProofReference, type AdmissionPolicyProofAppend } from '@resonance/core/admission-policy-archive';
import { createHash } from 'node:crypto';
import type { HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { admissionPolicyKeys, assertAdmissionPolicySuccessor } from '@resonance/core/admission-policy';
import { verifyAdmissionIssuanceAllocation, admissionIssuanceAllocationDigest, selectAdmissionIssuerAllocation } from '@resonance/core/admission-issuance-allocation';
import { verifyAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { admissionPolicyObserversId } from '@resonance/core/admission-policy-freshness';
import { sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { admissionKeyFingerprint, type AdmissionWalletProfileV1 } from './admission-wallet-profile.js';
import { validState, claimDigest, totals, MAX_BYTES, type State as LegacyState } from './admission-issuer-state.js';
export type ProtectedIssuerState = LegacyState<ArchivedAdmissionPolicy> & { proofVersion?: 1; policyProof?: AdmissionPolicyProofReference; policyProofAppend?: AdmissionPolicyProofAppend };
type State = ProtectedIssuerState;

export async function parseProtectedIssuerImage(value: unknown, pins: { profile: AdmissionWalletProfileV1; authority: string }): Promise<State> {
  const profile = structuredClone(pins.profile), authority = pins.authority;
  value = structuredClone(value);
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > MAX_BYTES) throw new Error('Protected issuer snapshot exceeds its bound');
  const raw = value as State, state = raw;
  const { proofVersion, policyProof, policyProofAppend, ...business } = raw ?? {};
  const archived = raw?.communityPolicy?.version === 3;
  const structural = business;
  if ((proofVersion !== undefined && proofVersion !== 1) || (proofVersion === 1 ? !policyProof : policyProof !== undefined || policyProofAppend !== undefined)
    || archived && proofVersion !== 1 || !validState(structural, profile) || (state.version !== 8 && state.version !== 9) || !state.allocation || !state.communityPolicy || !state.freshness) {
    throw new Error('Protected issuer requires an authority-assigned allocation, signed community policy and independently pinned policy observers');
  }
  if (policyProof) { parseAdmissionPolicyProofReference(policyProof); if (policyProofAppend) parseAdmissionPolicyProofAppend(policyProofAppend); }
  const allocation = state.allocation;
  if (allocation.authority !== authority) throw new Error('Issuer allocation authority does not match its independent pin');
  const verified = await verifyAdmissionIssuanceAllocation(allocation.manifest, authority);
  if (verified.version !== 2) throw new Error('Protected issuer requires a v2 authority-assigned allocation');
  const selected = selectAdmissionIssuerAllocation(verified, profile);
  if (admissionIssuanceAllocationDigest(verified) !== allocation.digest || selected.batchSize !== state.policy.batchSize || selected.maxPermits !== state.policy.maxPermits) {
    throw new Error('Retained issuer allocation does not match its derived quota');
  }
  if (state.version === 8) for (const entry of state.entries) {
    const assignment = await verifyAdmissionClaimAssignment(entry.assignment, verified, authority);
    if (assignment.issuerKeyFingerprint !== admissionKeyFingerprint(profile.issuerPublicKey)
      || claimDigest(entry.claim!.binding, assignment.claimHandle) !== entry.claim!.digest) throw new Error('Retained issuer assignment does not match its claim binding');
  }
  const policy = await verifyArchivedAdmissionPolicy(state.communityPolicy, authority);
  parseAdmissionPolicyTrust(state.freshness, policy);
  if (policy.version !== 3 && !admissionPolicyKeys(policy).some(entry => JSON.stringify(entry.profile) === JSON.stringify(profile))) throw new Error('Issuer is absent from its signed community policy');
  if (state.version === 9) {
    const id = admissionKeyFingerprint(profile.issuerPublicKey), entry = (policy.version === 3 ? policy.keys : admissionPolicyKeys(policy)).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === id)!;
    if (policy.activeKey === id || entry && state.retirement.retiredAt < entry.retryUntil) throw new Error('Invalid permanent issuer retirement');
    assertArchivedAdmissionPolicyCurrent(policy, state.retirement.retiredAt);
  }
  return structuredClone(raw);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Both images must first pass parseProtectedIssuerImage. Identity is useful for
 * baseline checks; every changed image must be one operation the live API can emit. */
export async function assertProtectedIssuerImageSuccessor(previous: State, next: State): Promise<void> {
  if (same(previous, next)) return;
  if (previous.version !== 8 || (next.version !== 8 && next.version !== 9)) throw new Error('Protected issuer retirement is terminal');
  for (const field of ['profile', 'allocation', 'policy', 'claimMode'] as const) {
    if (!same(previous[field], next[field])) throw new Error('Protected issuer immutable allocation or quota changed');
  }
  if (!previous.communityPolicy || !next.communityPolicy || !previous.freshness || !next.freshness) throw new Error('Protected issuer pins are missing');
  const policyChanged = !same(previous.communityPolicy, next.communityPolicy), freshnessChanged = !same(previous.freshness, next.freshness);
  const entriesChanged = !same(previous.entries, next.entries);
  if (next.version === 9) {
    if (policyChanged || freshnessChanged || !same(totals(previous), totals(next)) || !same(previous.policyProof, next.policyProof) || !same(previous.policyProofAppend, next.policyProofAppend) || previous.proofVersion !== next.proofVersion) throw new Error('Issuer retirement must preserve policy, freshness and exact lifetime totals');
    return; // Parser authenticated the inactive key and historical retry cutoff.
  }
  if (entriesChanged && (policyChanged || freshnessChanged)) throw new Error('Issuer checkpoint combines unrelated decision and policy mutations');
  const proofChanged = !same(previous.policyProof, next.policyProof) || !same(previous.policyProofAppend, next.policyProofAppend);
  if (previous.proofVersion === 1 && next.proofVersion !== 1) throw new Error('Issuer cannot discard retained original proof');
  if (proofChanged && (entriesChanged || freshnessChanged && !policyChanged)) throw new Error('Issuer proof backfill must preserve business state and freshness');
  if (next.policyProof && previous.policyProof) {
    if (!same(previous.policyProof.context, next.policyProof.context) || !same(previous.policyProof.limits, next.policyProof.limits)
      || next.policyProof.head.revision < previous.policyProof.head.revision) throw new Error('Issuer proof ancestry or resource pins changed');
  }
  if (policyChanged && previous.communityPolicy.version !== 3 && next.communityPolicy.version !== 3) assertAdmissionPolicySuccessor(previous.communityPolicy, next.communityPolicy);
  if (policyChanged && next.communityPolicy.version === 3 && (!next.policyProof || next.policyProofAppend?.kind !== 'advance'
    || !sameAdmissionPolicyHead(next.policyProof.head, next.freshness.installed)
    || archivedAdmissionPolicyDigest(next.policyProofAppend.advance.policy) !== archivedAdmissionPolicyDigest(next.communityPolicy))) throw new Error('Issuer v3 installation requires its exact retained signed advance');
  const before = previous.freshness, after = next.freshness;
  if (admissionPolicyObserversId(before.context) !== admissionPolicyObserversId(after.context)) throw new Error('Issuer policy observers changed');
  for (const field of ['installed', 'observed'] as const) {
    if (after[field].revision < before[field].revision || after[field].revision === before[field].revision && !sameAdmissionPolicyHead(after[field], before[field])) {
      throw new Error('Issuer policy freshness floor moved backwards or equivocated');
    }
  }
  if (before.conflict && !same(before, after)) throw new Error('Issuer policy conflict evidence is permanent');
  if (after.conflict && !before.conflict && (!sameAdmissionPolicyHead(before.observed, after.observed) || !sameAdmissionPolicyHead(before.installed, after.installed))) {
    throw new Error('Issuer conflict checkpoint must preserve both retained policy floors');
  }
  if (!policyChanged && !sameAdmissionPolicyHead(before.installed, after.installed)) throw new Error('Issuer installed head changed without its signed policy');
  if (policyChanged && (!(next.communityPolicy.revision === after.installed.revision && archivedAdmissionPolicyDigest(next.communityPolicy) === after.installed.digest) || after.installed.revision !== before.installed.revision + 1)) {
    throw new Error('Issuer installed policy must be an immediate successor');
  }
  if (policyChanged) {
    const expectedTransition = createHash('sha256').update(`resonance:admission-policy-advance:v1:chain\n${JSON.stringify([
      admissionPolicyObserversId(before.context), before.installed.revision, before.installed.digest, before.installed.transition,
      after.installed.revision, after.installed.digest,
    ])}`).digest('hex');
    if (after.installed.transition !== expectedTransition) throw new Error('Issuer installed policy lost its predecessor transition');
  }
  if (!entriesChanged) return;
  if (before.conflict || !sameAdmissionPolicyHead(before.installed, before.observed)) throw new Error('Issuer decision continued across a retained policy fence');
  const old = previous.entries, rows = next.entries;
  if (rows.length === old.length + 1) {
    if (!old.every((entry, i) => same(entry, rows[i])) || rows.at(-1)!.batchId !== undefined) throw new Error('Issuer grant must append one unbound immutable permit');
    return;
  }
  if (rows.length !== old.length) throw new Error('Issuer history deleted or reset an allocated permit');
  const changed = old.map((entry, i) => same(entry, rows[i]) ? -1 : i).filter(i => i >= 0);
  if (changed.length !== 1) throw new Error('Issuer checkpoint changes multiple permit decisions');
  const a = old[changed[0]], b = rows[changed[0]];
  if (!same([a.permitHash, a.claim, a.assignment], [b.permitHash, b.claim, b.assignment])) throw new Error('Issuer permit identity or claim assignment changed');
  if (a.batchId === undefined) {
    if (!b.batchId || b.preparedResponse || b.response) throw new Error('Issuer must reserve its exact batch before signing');
  } else {
    if (a.batchId !== b.batchId) throw new Error('Issuer permit batch binding changed');
    if (a.response) throw new Error('Issuer completed response is immutable');
    if (a.preparedResponse) {
      if (!b.response || b.preparedResponse || !same(a.preparedResponse, b.response)) throw new Error('Issuer completion must preserve its exact prepared response');
    } else if (!b.preparedResponse || b.response) throw new Error('Issuer must retain a prepared response before completion');
  }
}

/** The original baseline is independently pinned and starts with no consumed quota. */
export function assertProtectedIssuerGenesis(image: State, context: HistoryCheckpointContext): void {
  if (context.role !== 'admission-issuer' || image.version !== 8 || image.entries.length || !image.communityPolicy || !image.freshness
    || context.authority !== image.allocation?.authority || context.policyDigest !== `sha256:${archivedAdmissionPolicyDigest(image.communityPolicy)}`
    || !(image.communityPolicy.revision === image.freshness.context.genesis.revision && archivedAdmissionPolicyDigest(image.communityPolicy) === image.freshness.context.genesis.digest)
    || !sameAdmissionPolicyHead(image.freshness.installed, image.freshness.context.genesis)
    || !sameAdmissionPolicyHead(image.freshness.observed, image.freshness.context.genesis) || image.freshness.conflict) {
    throw new Error('Issuer genesis differs from its initial policy and empty quota pins');
  }
}

export async function validateProtectedIssuerPolicyProof(image: State, options: {
  context: HistoryCheckpointContext; encryptionKey: Uint8Array; source: () => Iterable<HistoryCheckpointEnvelope>; signal?: AbortSignal; deadline?: number; operation?: PolicyProofOperation; cache?: PolicyProofCache;
}) {
  if (!image.policyProof) { if (image.communityPolicy?.version === 3) throw new Error('Issuer v3 requires retained original proof'); return; }
  if (!image.freshness || admissionPolicyObserversId(image.policyProof.context) !== admissionPolicyObserversId(image.freshness.context)) throw new Error('Issuer proof differs from independent observer pins');
  const issuerKey = admissionKeyFingerprint(image.profile.issuerPublicKey);
  const proof = createAdmissionPolicyHistoryProof({ ...options, reference: image.policyProof, candidate: image });
  const exact = sameAdmissionPolicyHead(image.policyProof.head, image.freshness.installed);
  if (!exact && image.communityPolicy?.version === 3) throw new Error('Issuer v3 proof does not reach its installed head');
  const resolved = exact ? await proof.matches(image.communityPolicy!, [issuerKey]) : await proof.resolve([issuerKey]);
  if (image.policyProof.head.revision > image.freshness.installed.revision) throw new Error('Issuer backfill exceeds installed policy');
  if (exact) {
    const entry = inspectResolvedAdmissionPolicyKey(resolved, retainedResolvedAdmissionPolicyKey(resolved, issuerKey));
    if (JSON.stringify(entry.profile) !== JSON.stringify(image.profile)) throw new Error('Issuer original membership differs from pinned profile');
    if (image.version === 9 && (image.communityPolicy!.activeKey === issuerKey || image.retirement.retiredAt < entry.retryUntil)) throw new Error('Invalid permanent issuer retirement');
  }
}
