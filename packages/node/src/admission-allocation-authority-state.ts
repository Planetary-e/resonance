/** Authenticated historical authority state shared by local and protected workflows. */
import { createHash, hkdfSync } from 'node:crypto';
import { sign, verify } from '@resonance/core';
import { historyDigest, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { admissionKeyFingerprint } from './admission-wallet-profile.js';
import { parseAdmissionClaimAssignmentBody, verifyAdmissionClaimAssignment, type AdmissionClaimAssignmentBody, type SignedAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { admissionIssuanceAllocationDigest, parseAdmissionIssuanceAllocationBody, verifyAdmissionIssuanceAllocation, type SignedAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';

export const MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES = 64;
export const MAX_ADMISSION_ALLOCATION_JOURNAL_BYTES = 8 * 1024 * 1024;
export const MAX_ADMISSION_ALLOCATION_ASSIGNMENTS = 2048;
export const ALLOCATION_AUTHORITY_DOMAIN = 'resonance:admission-allocation-authority-journal:v1';
export type AdmissionAllocationAuthorityState = { version: 1; authority: string; manifests: SignedAdmissionIssuanceAllocation[] }
  | { version: 2; authority: string; manifests: SignedAdmissionIssuanceAllocation[]; assignments: SignedAdmissionClaimAssignment[] };
export interface AdmissionClaimAssignmentRequest { community: 'public'; epoch: string; claimHandle: string; issuerKeyFingerprint: string }
export function assertAdmissionAllocationAuthority(authority: string): void {
  if (typeof authority !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(authority) || Buffer.from(authority, 'base64url').toString('base64url') !== authority) throw new Error('Invalid pinned allocation authority');
}
export function parseAdmissionClaimAssignmentRequest(value: unknown): AdmissionClaimAssignmentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'claimHandle,community,epoch,issuerKeyFingerprint') throw new Error('Invalid claim assignment request');
  const request = structuredClone(value) as AdmissionClaimAssignmentRequest;
  // Structural validation only; the actual signed allocation binding is checked separately.
  parseAdmissionClaimAssignmentBody({ ...request, version: 1, kind: 'admission-claim-assignment', authority: Buffer.alloc(32).toString('base64url'), allocationDigest: `sha256:${'0'.repeat(64)}` });
  return request;
}
export const admissionClaimAssignmentKey = (value: Pick<AdmissionClaimAssignmentBody, 'community' | 'epoch' | 'claimHandle'>): string => JSON.stringify([value.community, value.epoch, value.claimHandle]);
export function deriveAdmissionAllocationAuthorityEncryptionKey(secretKey: Uint8Array, authority: string): Buffer {
  assertAdmissionAllocationAuthority(authority); const secret = Uint8Array.from(secretKey);
  try {
    const challenge = Buffer.from(`${ALLOCATION_AUTHORITY_DOMAIN}\nkey-check`);
    if (!verify(challenge, sign(challenge, secret), Buffer.from(authority, 'base64url'))) throw new Error('Allocation authority private key does not match');
    return Buffer.from(hkdfSync('sha256', secret, Buffer.from(authority, 'base64url'), Buffer.from(ALLOCATION_AUTHORITY_DOMAIN), 32));
  } finally { secret.fill(0); }
}
/** Public review preserves the original normalized plan and authority-bound approval digest. */
export async function reviewAdmissionAllocationPlan(value: unknown, authority: string) {
  assertAdmissionAllocationAuthority(authority);
  const body = await parseAdmissionIssuanceAllocationBody(value);
  const approvalDigest = `sha256:${createHash('sha256').update('resonance:admission-allocation-approval:v1\n').update(JSON.stringify([authority, body])).digest('hex')}`;
  return { body, approvalDigest };
}
export async function reviewAdmissionClaimAssignment(state: AdmissionAllocationAuthorityState, value: unknown) {
  const request = parseAdmissionClaimAssignmentRequest(value), authority = state.authority;
  const manifest = state.manifests.find(entry => entry.community === request.community && entry.epoch === request.epoch);
  if (!manifest || manifest.version !== 2) throw new Error('Claim assignment requires a retained authority-assigned v2 allocation');
  const body = parseAdmissionClaimAssignmentBody({ version: 1, kind: 'admission-claim-assignment', authority,
    allocationDigest: admissionIssuanceAllocationDigest(manifest), ...request });
  if (!manifest.allocations.some(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === request.issuerKeyFingerprint)) throw new Error('Claim assignment issuer is absent from allocation');
  const approvalDigest = `sha256:${createHash('sha256').update('resonance:admission-claim-assignment-approval:v1\n').update(JSON.stringify(body)).digest('hex')}`;
  return { body, approvalDigest };
}
/** Cheap exact shape for encrypted storage; authenticity still requires the asynchronous parser. */
export function isAdmissionAllocationAuthorityState(value: unknown, authority: string): value is AdmissionAllocationAuthorityState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as AdmissionAllocationAuthorityState;
  return ((state.version === 1 && Object.keys(state).sort().join(',') === 'authority,manifests,version')
    || (state.version === 2 && Object.keys(state).sort().join(',') === 'assignments,authority,manifests,version'
      && Array.isArray(state.assignments) && state.assignments.length <= MAX_ADMISSION_ALLOCATION_ASSIGNMENTS))
    && state.authority === authority && Array.isArray(state.manifests) && state.manifests.length <= MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES;
}
/** Signatures, period plans and claim reservations remain binding after historical expiry. */
export async function parseAdmissionAllocationAuthorityState(value: unknown, authority: string): Promise<AdmissionAllocationAuthorityState> {
  assertAdmissionAllocationAuthority(authority);
  if (!isAdmissionAllocationAuthorityState(value, authority) || Buffer.byteLength(JSON.stringify(value)) > MAX_ADMISSION_ALLOCATION_JOURNAL_BYTES) throw new Error('Invalid allocation authority journal state');
  const state = structuredClone(value), periods = new Set<string>();
  for (const value of state.manifests) {
    const manifest = await verifyAdmissionIssuanceAllocation(value, authority), period = JSON.stringify([manifest.community, manifest.epoch]);
    if (periods.has(period)) throw new Error('Duplicate period in allocation authority journal');
    periods.add(period);
    if (JSON.stringify(value) !== JSON.stringify(manifest)) throw new Error('Noncanonical manifest in allocation authority journal');
  }
  if (state.version === 2) {
    const claims = new Set<string>(), counts = new Map<string, number>();
    for (const value of state.assignments) {
      const manifest = state.manifests.find(entry => entry.community === value?.community && entry.epoch === value?.epoch);
      if (!manifest) throw new Error('Assignment has no retained allocation');
      const assignment = await verifyAdmissionClaimAssignment(value, manifest, authority), id = admissionClaimAssignmentKey(assignment);
      if (JSON.stringify(value) !== JSON.stringify(assignment)) throw new Error('Noncanonical assignment in authority journal');
      if (claims.has(id)) throw new Error('Duplicate claim assignment in authority journal'); claims.add(id);
      const counter = JSON.stringify([assignment.allocationDigest, assignment.issuerKeyFingerprint]), count = (counts.get(counter) ?? 0) + 1;
      const issuer = manifest.allocations.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === assignment.issuerKeyFingerprint)!;
      if (count > issuer.maxPermits) throw new Error('Retained assignments exceed issuer capacity'); counts.set(counter, count);
    }
    return { version: 2, authority, manifests: state.manifests, assignments: state.assignments };
  }
  return { version: 1, authority, manifests: state.manifests };
}
export function allocationAuthorityHistoryAnchor(authority: string): string {
  assertAdmissionAllocationAuthority(authority);
  return historyDigest('resonance:allocation-authority-history-genesis:v1\n' + JSON.stringify({ version: 2, authority, manifests: [], assignments: [] }));
}
/** Both snapshots must first pass the full historical parser. Retained entries are append-only. */
export async function assertProtectedAllocationAuthoritySuccessor(previous: AdmissionAllocationAuthorityState, next: AdmissionAllocationAuthorityState): Promise<void> {
  const before = previous, after = next;
  if (!isAdmissionAllocationAuthorityState(before, before.authority) || !isAdmissionAllocationAuthorityState(after, before.authority) || before.version !== 2 || after.version !== 2) throw new Error('Protected allocation authority requires v2 state without conversion');
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const manifests = after.manifests.length - before.manifests.length, assignments = after.assignments.length - before.assignments.length;
  if (!((manifests === 1 && assignments === 0) || (manifests === 0 && assignments === 1))) throw new Error('Protected authority checkpoint must append exactly one manifest or assignment');
  if (!before.manifests.every((entry, index) => JSON.stringify(entry) === JSON.stringify(after.manifests[index]))
    || !before.assignments.every((entry, index) => JSON.stringify(entry) === JSON.stringify(after.assignments[index]))) throw new Error('Protected authority retained plans and assignments are immutable and ordered');
}
export function assertProtectedAllocationAuthorityGenesis(state: AdmissionAllocationAuthorityState, context: HistoryCheckpointContext): void {
  if (context.role !== 'admission-allocation-authority' || state.version !== 2 || state.authority !== context.authority || state.manifests.length !== 0 || state.assignments.length !== 0
    || context.policyDigest !== allocationAuthorityHistoryAnchor(state.authority)) throw new Error('Protected allocation authority requires its independently pinned empty v2 genesis');
}
