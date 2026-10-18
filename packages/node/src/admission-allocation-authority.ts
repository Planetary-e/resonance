/** Durable honest-authority workflow. Key copies, rollback, or a separate journal can bypass this local boundary. */
import { admissionKeyFingerprint } from './admission-wallet-profile.js';
import { signAdmissionClaimAssignment, type SignedAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { admissionIssuanceAllocationDigest, assertAdmissionIssuanceAllocationCurrent,
  signAdmissionIssuanceAllocation, type SignedAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';
import { MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES, MAX_ADMISSION_ALLOCATION_JOURNAL_BYTES, MAX_ADMISSION_ALLOCATION_ASSIGNMENTS,
  ALLOCATION_AUTHORITY_DOMAIN as DOMAIN, assertAdmissionAllocationAuthority, deriveAdmissionAllocationAuthorityEncryptionKey,
  isAdmissionAllocationAuthorityState, parseAdmissionAllocationAuthorityState, admissionClaimAssignmentKey as assignmentKey,
  reviewAdmissionAllocationPlan, reviewAdmissionClaimAssignment, type AdmissionAllocationAuthorityState as State } from './admission-allocation-authority-state.js';
export { MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES, MAX_ADMISSION_ALLOCATION_JOURNAL_BYTES, MAX_ADMISSION_ALLOCATION_ASSIGNMENTS,
  reviewAdmissionAllocationPlan, type AdmissionClaimAssignmentRequest } from './admission-allocation-authority-state.js';

export async function openAdmissionAllocationAuthority(options: {
  path: string; authority: string; secretKey: Uint8Array; mode: 'create-new' | 'open-existing'; now?: () => number;
}) {
  const authority = options.authority, path = options.path, mode = options.mode, now = options.now ?? Date.now;
  assertAdmissionAllocationAuthority(authority);
  if (mode !== 'create-new' && mode !== 'open-existing') throw new Error('Allocation journal requires explicit initialization or opening');
  const secret = Uint8Array.from(options.secretKey);
  let storage: ReturnType<typeof openEncryptedLocalState<State>> | undefined;
  let closed = false, busy = false;
  try {
    const encryptionKey = deriveAdmissionAllocationAuthorityEncryptionKey(secret, authority);
    try {
      storage = openEncryptedLocalState<State>({ path, key: encryptionKey, domain: DOMAIN, mode,
        maxBytes: MAX_ADMISSION_ALLOCATION_JOURNAL_BYTES, initial: { version: 1, authority, manifests: [] },
        validate: (value): value is State => isAdmissionAllocationAuthorityState(value, authority) });
    } finally { encryptionKey.fill(0); }
    await parseAdmissionAllocationAuthorityState(storage.read(), authority);
  } catch (error) { storage?.close(); secret.fill(0); throw error; }
  const store = storage;
  function ensureOpen() { if (closed) throw new Error('Allocation authority is closed'); store.read(); }
  async function reviewAssignment(value: unknown) { ensureOpen(); return reviewAdmissionClaimAssignment(store.read(), value); }
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
