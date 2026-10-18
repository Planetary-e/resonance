/** Durable honest-authority workflow. Key copies, rollback, or a separate journal can bypass this local boundary. */
import { createHash, hkdfSync } from 'node:crypto';
import { sign, verify } from '@resonance/core';
import { admissionKeyFingerprint } from './admission-wallet-profile.js';
import { parseAdmissionClaimAssignmentBody, signAdmissionClaimAssignment, verifyAdmissionClaimAssignment,
  type AdmissionClaimAssignmentBody, type SignedAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { admissionIssuanceAllocationDigest, assertAdmissionIssuanceAllocationCurrent, parseAdmissionIssuanceAllocationBody,
  signAdmissionIssuanceAllocation, verifyAdmissionIssuanceAllocation, type SignedAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';

export const MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES = 64;
export const MAX_ADMISSION_ALLOCATION_JOURNAL_BYTES = 8 * 1024 * 1024;
const DOMAIN = 'resonance:admission-allocation-authority-journal:v1';
export const MAX_ADMISSION_ALLOCATION_ASSIGNMENTS = 2048;
type State = { version: 1; authority: string; manifests: SignedAdmissionIssuanceAllocation[] }
  | { version: 2; authority: string; manifests: SignedAdmissionIssuanceAllocation[]; assignments: SignedAdmissionClaimAssignment[] };
export interface AdmissionClaimAssignmentRequest { community: 'public'; epoch: string; claimHandle: string; issuerKeyFingerprint: string }
function parseRequest(value: unknown): AdmissionClaimAssignmentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'claimHandle,community,epoch,issuerKeyFingerprint') throw new Error('Invalid claim assignment request');
  const request = structuredClone(value) as AdmissionClaimAssignmentRequest;
  // Reuse the strict wire parser without making this fabricated binding evidence.
  parseAdmissionClaimAssignmentBody({ ...request, version: 1, kind: 'admission-claim-assignment', authority: Buffer.alloc(32).toString('base64url'), allocationDigest: `sha256:${'0'.repeat(64)}` });
  return request;
}
const assignmentKey = (value: Pick<AdmissionClaimAssignmentBody, 'community' | 'epoch' | 'claimHandle'>) => JSON.stringify([value.community, value.epoch, value.claimHandle]);
function validAuthority(authority: string) {
  if (typeof authority !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(authority) || Buffer.from(authority, 'base64url').toString('base64url') !== authority) throw new Error('Invalid pinned allocation authority');
}
/** Authority-bound approval of a normalized plan; review is public and requires no signing secret or journal. */
export async function reviewAdmissionAllocationPlan(value: unknown, authority: string) {
  validAuthority(authority);
  const body = await parseAdmissionIssuanceAllocationBody(value);
  const approvalDigest = `sha256:${createHash('sha256').update('resonance:admission-allocation-approval:v1\n')
    .update(JSON.stringify([authority, body])).digest('hex')}`;
  return { body, approvalDigest };
}
export async function openAdmissionAllocationAuthority(options: {
  path: string; authority: string; secretKey: Uint8Array; mode: 'create-new' | 'open-existing'; now?: () => number;
}) {
  const authority = options.authority, path = options.path, mode = options.mode, now = options.now ?? Date.now;
  validAuthority(authority);
  if (mode !== 'create-new' && mode !== 'open-existing') throw new Error('Allocation journal requires explicit initialization or opening');
  const secret = Uint8Array.from(options.secretKey);
  let storage: ReturnType<typeof openEncryptedLocalState<State>> | undefined;
  let closed = false, busy = false;
  try {
    const challenge = Buffer.from(`${DOMAIN}\nkey-check`);
    if (!verify(challenge, sign(challenge, secret), Buffer.from(authority, 'base64url'))) throw new Error('Allocation authority private key does not match');
    const encryptionKey = Buffer.from(hkdfSync('sha256', secret, Buffer.from(authority, 'base64url'), Buffer.from(DOMAIN), 32));
    try {
      storage = openEncryptedLocalState<State>({ path, key: encryptionKey, domain: DOMAIN, mode,
        maxBytes: MAX_ADMISSION_ALLOCATION_JOURNAL_BYTES, initial: { version: 1, authority, manifests: [] },
        validate(value): value is State {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
          const state = value as State;
          return ((state.version === 1 && Object.keys(state).sort().join(',') === 'authority,manifests,version')
            || (state.version === 2 && Object.keys(state).sort().join(',') === 'assignments,authority,manifests,version'
              && Array.isArray(state.assignments) && state.assignments.length <= MAX_ADMISSION_ALLOCATION_ASSIGNMENTS))
            && state.authority === authority && Array.isArray(state.manifests) && state.manifests.length <= MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES;
        } });
    } finally { encryptionKey.fill(0); }
    const seen = new Set<string>();
    for (const value of storage.read().manifests) {
      const manifest = await verifyAdmissionIssuanceAllocation(value, authority), period = JSON.stringify([manifest.community, manifest.epoch]);
      if (seen.has(period)) throw new Error('Duplicate period in allocation authority journal');
      seen.add(period);
      if (JSON.stringify(value) !== JSON.stringify(manifest)) throw new Error('Noncanonical manifest in allocation authority journal');
    }
    const retained = storage.read();
    if (retained.version === 2) {
      const claims = new Set<string>(), counts = new Map<string, number>();
      for (const value of retained.assignments) {
        const manifest = retained.manifests.find(entry => entry.community === value.community && entry.epoch === value.epoch);
        if (!manifest) throw new Error('Assignment has no retained allocation');
        const assignment = await verifyAdmissionClaimAssignment(value, manifest, authority), id = assignmentKey(assignment);
        if (JSON.stringify(value) !== JSON.stringify(assignment)) throw new Error('Noncanonical assignment in authority journal');
        if (claims.has(id)) throw new Error('Duplicate claim assignment in authority journal');
        claims.add(id);
        const counter = JSON.stringify([assignment.allocationDigest, assignment.issuerKeyFingerprint]), count = (counts.get(counter) ?? 0) + 1;
        const issuer = manifest.allocations.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === assignment.issuerKeyFingerprint)!;
        if (count > issuer.maxPermits) throw new Error('Retained assignments exceed issuer capacity');
        counts.set(counter, count);
      }
    }
  } catch (error) { storage?.close(); secret.fill(0); throw error; }
  const store = storage;
  function ensureOpen() { if (closed) throw new Error('Allocation authority is closed'); store.read(); }
  async function reviewAssignment(value: unknown) {
    ensureOpen(); const request = parseRequest(value), state = store.read();
    const manifest = state.manifests.find(entry => entry.community === request.community && entry.epoch === request.epoch);
    if (!manifest || manifest.version !== 2) throw new Error('Claim assignment requires a retained authority-assigned v2 allocation');
    const body = parseAdmissionClaimAssignmentBody({ version: 1, kind: 'admission-claim-assignment', authority,
      allocationDigest: admissionIssuanceAllocationDigest(manifest), ...request });
    if (!manifest.allocations.some(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === request.issuerKeyFingerprint)) throw new Error('Claim assignment issuer is absent from allocation');
    const approvalDigest = `sha256:${createHash('sha256').update('resonance:admission-claim-assignment-approval:v1\n').update(JSON.stringify(body)).digest('hex')}`;
    return { body, approvalDigest };
  }
  return {
    reviewAssignment,
    currentAssignment(community: 'public', epoch: string, claimHandle: string) {
      ensureOpen(); const state = store.read();
      const assignment = state.version === 2 ? state.assignments.find(entry => assignmentKey(entry) === assignmentKey({ community, epoch, claimHandle })) : undefined;
      return assignment ? structuredClone(assignment) : undefined;
    },
    async assignClaim(value: unknown, approvedDigest: string): Promise<SignedAdmissionClaimAssignment> {
      ensureOpen(); if (busy) throw new Error('Allocation signing is already in progress');
      busy = true;
      try {
        const reviewed = await reviewAssignment(value); ensureOpen();
        if (approvedDigest !== reviewed.approvalDigest) throw new Error('Approval digest does not match this claim assignment; review it again');
        const state = store.read(), assignments = state.version === 2 ? state.assignments : [];
        const previous = assignments.find(entry => assignmentKey(entry) === assignmentKey(reviewed.body));
        if (previous) {
          if (previous.issuerKeyFingerprint !== reviewed.body.issuerKeyFingerprint) throw new Error('Claim already assigned to a different issuer');
          return structuredClone(previous);
        }
        if (assignments.length >= MAX_ADMISSION_ALLOCATION_ASSIGNMENTS) throw new Error('Claim assignment journal is full; reservations cannot be pruned or refunded');
        const manifest = state.manifests.find(entry => admissionIssuanceAllocationDigest(entry) === reviewed.body.allocationDigest)!;
        const issuer = manifest.allocations.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === reviewed.body.issuerKeyFingerprint)!;
        if (assignments.filter(entry => entry.allocationDigest === reviewed.body.allocationDigest && entry.issuerKeyFingerprint === reviewed.body.issuerKeyFingerprint).length >= issuer.maxPermits) throw new Error('Claim assignment issuer capacity is exhausted');
        assertAdmissionIssuanceAllocationCurrent(manifest, now());
        const assignment = await signAdmissionClaimAssignment(reviewed.body, manifest, authority, secret); ensureOpen();
        assertAdmissionIssuanceAllocationCurrent(manifest, now());
        store.write({ version: 2, authority, manifests: state.manifests, assignments: [...assignments, assignment] });
        return structuredClone(assignment);
      } finally { busy = false; }
    },
    async review(value: unknown) { ensureOpen(); return reviewAdmissionAllocationPlan(value, authority); },
    current(community: 'public', epoch: string) {
      ensureOpen(); const manifest = store.read().manifests.find(entry => entry.community === community && entry.epoch === epoch);
      return manifest ? structuredClone(manifest) : undefined;
    },
    async sign(value: unknown, approvedDigest: string): Promise<SignedAdmissionIssuanceAllocation> {
      ensureOpen(); if (busy) throw new Error('Allocation signing is already in progress');
      busy = true;
      try {
        const reviewed = await reviewAdmissionAllocationPlan(value, authority); ensureOpen();
        if (approvedDigest !== reviewed.approvalDigest) throw new Error('Approval digest does not match this allocation plan; review it again');
        const state = store.read(), previous = state.manifests.find(entry => entry.community === reviewed.body.community && entry.epoch === reviewed.body.epoch);
        if (previous) {
          const { authority: _, signature: __, ...body } = previous;
          if (JSON.stringify(body) !== JSON.stringify(reviewed.body)) throw new Error('Conflicting allocation already signed for this community epoch');
          return structuredClone(previous); // Exact durable retry remains exportable after the issuance window.
        }
        if (state.manifests.length >= MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES) throw new Error('Allocation authority journal is full; retained periods cannot be pruned or refunded');
        assertAdmissionIssuanceAllocationCurrent(reviewed.body, now());
        const manifest = await signAdmissionIssuanceAllocation(reviewed.body, authority, secret); ensureOpen();
        assertAdmissionIssuanceAllocationCurrent(manifest, now());
        store.write({ ...state, manifests: [...state.manifests, manifest] }); // Flush before returning or exporting the signed allocation.
        return structuredClone(manifest);
      } finally { busy = false; }
    },
    digest(manifest: SignedAdmissionIssuanceAllocation) { ensureOpen(); return admissionIssuanceAllocationDigest(manifest); },
    close() { if (!closed) { closed = true; secret.fill(0); store.close(); } },
  };
}
