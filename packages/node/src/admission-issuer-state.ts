/** Offline invitation admission. No member identifier is added to issuance or redemption. */
import { admissionPolicyKeys, isArchivedAdmissionKey, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { assertArchivedAdmissionPolicyCurrent, type ArchivedAdmissionPolicy } from '@resonance/core/admission-policy-archive';
import type { SignedAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';
import type { SignedAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { createHash, hkdfSync } from 'node:crypto';
import { admissionKeyFingerprint, type AdmissionWalletProfileV1 } from './admission-wallet-profile.js';
import type { AdmissionIssuanceResponse } from './blind-admission-issuance.js';
import { parseAdmissionPolicyTrust, type AdmissionPolicyTrust } from '@resonance/core/admission-policy-trust';

export interface AdmissionIssuancePermit {
  version: 1; kind: 'admission-issuance-permit'; scope: AdmissionWalletProfileV1['scope'];
  keyFingerprint: string; count: number; secret: string;
}
export interface AdmissionIssuerPolicy { batchSize: number; maxPermits: number }
export interface ClaimBinding { digest: string; binding: string; secret: string }
export interface Entry { assignment?: SignedAdmissionClaimAssignment; claim?: ClaimBinding; permitHash: string; batchId?: string; preparedResponse?: AdmissionIssuanceResponse; response?: AdmissionIssuanceResponse }
export interface Totals { allocatedPermits: number; boundPermits: number; completedPermits: number }
export interface AllocationBinding { authority: string; manifest: SignedAdmissionIssuanceAllocation; digest: string }
export interface BaseState<P = SignedAdmissionPolicy> { allocation?: AllocationBinding; claimMode?: 'operator-claim-required-v1' | 'authority-assigned-v1'; profile: AdmissionWalletProfileV1; policy: AdmissionIssuerPolicy; entries: Entry[]; communityPolicy?: P; freshness?: AdmissionPolicyTrust }
export type State<P = SignedAdmissionPolicy> = (BaseState<P> & { version: 1 | 3 | 4 | 6 | 8 }) | (BaseState<P> & {
  version: 2 | 5 | 7 | 9; communityPolicy: P; retirement: Totals & { retiredAt: number };
});
export const DOMAIN = 'resonance:admission-issuer-ledger:v1';
export const MAX_BYTES = 8 * 1024 * 1024;
export class IssuerPolicyObservationExpiredError extends Error {
  constructor() { super('Issuer policy observation expired; collect a new observation for the exact reserved batch'); this.name = 'IssuerPolicyObservationExpiredError'; }
}
export const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(',');
}
export function validatePolicy(policy: unknown): asserts policy is AdmissionIssuerPolicy {
  if (!exact(policy, ['batchSize', 'maxPermits']) || !Number.isInteger(policy.batchSize) || (policy.batchSize as number) < 1 || (policy.batchSize as number) > 32
    || !Number.isInteger(policy.maxPermits) || (policy.maxPermits as number) < 1 || (policy.maxPermits as number) > 256) {
    throw new Error('Issuer policy requires a fixed batch size of 1–32 and a maximum of 1–256 permits');
  }
}
export function permitHash(secret: string) { return createHash('sha256').update(`${DOMAIN}:permit\n${secret}`).digest('hex'); }
export function totals(state: State<ArchivedAdmissionPolicy>): Totals {
  if ((state.version === 2 || state.version === 5 || state.version === 7 || state.version === 9)) {
    const { allocatedPermits, boundPermits, completedPermits } = state.retirement;
    return { allocatedPermits, boundPermits, completedPermits };
  }
  return { allocatedPermits: state.entries.length, boundPermits: state.entries.filter(entry => entry.batchId).length,
    completedPermits: state.entries.filter(entry => entry.response).length };
}
export function validState(value: unknown, profile: AdmissionWalletProfileV1): value is State {
  const version = (value as State | null)?.version;
  if (!exact(value, ['version', 'profile', 'policy', 'entries',
    ...(version === 2 || version === 5 || version === 7 || version === 9 || (value as State)?.communityPolicy ? ['communityPolicy'] : []), ...(version === 2 || version === 5 || version === 7 || version === 9 ? ['retirement'] : []),
    ...(version === 4 || version === 5 || version === 6 || version === 7 || version === 8 || version === 9 ? ['claimMode'] : []),
    ...(version === 6 || version === 7 || version === 8 || version === 9 ? ['allocation'] : []),
    ...((value as State)?.freshness ? ['freshness'] : [])])
    || (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7 && version !== 8 && version !== 9)
    || JSON.stringify(value.profile) !== JSON.stringify(profile)) return false;
  if ((version === 4 || version === 5 || version === 6 || version === 7) && value.claimMode !== 'operator-claim-required-v1') return false;
  if ((version === 8 || version === 9) && value.claimMode !== 'authority-assigned-v1') return false;
  if ((version === 6 || version === 7 || version === 8 || version === 9) && (!exact(value.allocation, ['authority', 'manifest', 'digest'])
    || !canonicalClaim(value.allocation.authority) || typeof value.allocation.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.allocation.digest))) return false;
  try { validatePolicy(value.policy); } catch { return false; }
  if (value.freshness) { try { if (!value.communityPolicy) return false; parseAdmissionPolicyTrust(value.freshness, value.communityPolicy as SignedAdmissionPolicy); } catch { return false; } }
  if (!Array.isArray(value.entries) || value.entries.length > value.policy.maxPermits) return false;
  if (version === 2 || version === 5 || version === 7 || version === 9) {
    const r = value.retirement;
    return value.entries.length === 0 && !!value.communityPolicy
      && exact(r, ['retiredAt','allocatedPermits','boundPermits','completedPermits'])
      && [r.retiredAt, r.allocatedPermits, r.boundPermits, r.completedPermits].every(n => Number.isSafeInteger(n) && (n as number) >= 0)
      && (r.completedPermits as number) <= (r.boundPermits as number)
      && (r.boundPermits as number) <= (r.allocatedPermits as number) && (r.allocatedPermits as number) <= value.policy.maxPermits;
  }
  const permits = new Set<string>(); const batches = new Set<string>(); const claims = new Set<string>();
  for (const entry of value.entries) {
    if (!exact(entry, [...(entry?.response !== undefined ? ['permitHash', 'batchId', 'response']
      : (version === 3 || version === 4 || version === 6 || version === 8) && entry?.preparedResponse !== undefined ? ['permitHash', 'batchId', 'preparedResponse'] : entry?.batchId !== undefined ? ['permitHash', 'batchId'] : ['permitHash']), ...(version === 4 || version === 6 || version === 8 ? ['claim'] : []), ...(version === 8 ? ['assignment'] : [])])
      || !hex(entry.permitHash) || permits.has(entry.permitHash)) return false;
    if (version === 4 || version === 6 || version === 8) {
      const claim = entry.claim;
      if (!exact(claim, ['digest', 'binding', 'secret']) || !hex(claim.digest) || claims.has(claim.digest)
        || claim.binding !== claimScopeBinding(profile, value.policy, (value.allocation as AllocationBinding | undefined)?.digest) || !canonicalClaim(claim.secret) || permitHash(claim.secret) !== entry.permitHash) return false;
      claims.add(claim.digest);
    }
    permits.add(entry.permitHash);
    if (entry.batchId !== undefined) {
      if (!hex(entry.batchId) || batches.has(entry.batchId)) return false;
      batches.add(entry.batchId);
    }
    if (entry.response !== undefined || entry.preparedResponse !== undefined) {
      const response = entry.response ?? entry.preparedResponse;
      if (!exact(response, ['version', 'kind', 'batchId', 'responses']) || response.version !== 1 || response.kind !== 'admission-issuance-response'
        || response.batchId !== entry.batchId || !Array.isArray(response.responses) || response.responses.length !== value.policy.batchSize
        || response.responses.some(bytes => typeof bytes !== 'string' || bytes.length !== 342 || Buffer.from(bytes, 'base64url').length !== 256
          || Buffer.from(bytes, 'base64url').toString('base64url') !== bytes)) return false;
    }
  }
  return true;
}

export function canonicalClaim(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').length === 32
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}
export function claimDigest(binding: string, handle: string) {
  return createHash('sha256').update(JSON.stringify(['resonance:operator-claim:v1', binding, handle])).digest('hex');
}
export function claimScopeBinding(profile: AdmissionWalletProfileV1, policy: AdmissionIssuerPolicy, allocationDigest?: string) {
  return createHash('sha256').update(JSON.stringify(['resonance:operator-claim-scope:v1', profile.scope, admissionKeyFingerprint(profile.issuerPublicKey), policy.batchSize, ...(allocationDigest ? [allocationDigest] : [])])).digest('hex');
}

export async function deriveAdmissionIssuerEncryptionKey(privateKey: CryptoKey) {
  const privateBytes = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey));
  try { return Buffer.from(hkdfSync('sha256', privateBytes, Buffer.alloc(0), DOMAIN, 32)); }
  finally { privateBytes.fill(0); }
}

export function assertAdmissionIssuerPolicy(state: State<ArchivedAdmissionPolicy>, profile: AdmissionWalletProfileV1, now: number, recover = false): void {
  const policy = state.communityPolicy;
  if (!policy) { if (state.allocation) throw new Error('Issuer allocation requires an installed signed community policy'); return; }
  if (state.allocation && policy.authority !== state.allocation.authority) throw new Error('Community policy authority does not match the pinned issuer allocation');
  assertArchivedAdmissionPolicyCurrent(policy, now);
  const id = admissionKeyFingerprint(profile.issuerPublicKey);
  const entry = (policy.version === 3 ? policy.keys : admissionPolicyKeys(policy)).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === id);
  if (!entry || (policy.version !== 3 && isArchivedAdmissionKey(policy, id)) || now < entry.notBefore || now >= (recover ? entry.spendUntil : entry.issueUntil)
    || (!recover && policy.activeKey !== id)) throw new Error('Issuer is retired or inactive under the signed community policy');
}

export function validateAdmissionIssuerPermit(value: unknown, state: State<ArchivedAdmissionPolicy>, profile: AdmissionWalletProfileV1): asserts value is AdmissionIssuancePermit {
  if (!exact(value, ['version', 'kind', 'scope', 'keyFingerprint', 'count', 'secret']) || value.version !== 1 || value.kind !== 'admission-issuance-permit'
    || !exact(value.scope, ['issuer', 'community', 'epoch'])
    || value.scope.issuer !== profile.scope.issuer || value.scope.community !== profile.scope.community || value.scope.epoch !== profile.scope.epoch
    || value.keyFingerprint !== admissionKeyFingerprint(profile.issuerPublicKey) || value.count !== state.policy.batchSize
    || typeof value.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.secret)
    || Buffer.from(value.secret, 'base64url').toString('base64url') !== value.secret) throw new Error('Invalid permit for this issuer policy');
}
