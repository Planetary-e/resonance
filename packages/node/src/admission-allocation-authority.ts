/** Durable honest-authority workflow. Key copies, rollback, or a separate journal can bypass this local boundary. */
import { createHash, hkdfSync } from 'node:crypto';
import { sign, verify } from '@resonance/core';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { admissionIssuanceAllocationDigest, assertAdmissionIssuanceAllocationCurrent, parseAdmissionIssuanceAllocationBody,
  signAdmissionIssuanceAllocation, verifyAdmissionIssuanceAllocation, type SignedAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';

export const MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES = 64;
export const MAX_ADMISSION_ALLOCATION_JOURNAL_BYTES = 8 * 1024 * 1024;
const DOMAIN = 'resonance:admission-allocation-authority-journal:v1';
type State = { version: 1; authority: string; manifests: SignedAdmissionIssuanceAllocation[] };
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
          return Object.keys(state).sort().join(',') === 'authority,manifests,version' && state.version === 1 && state.authority === authority
            && Array.isArray(state.manifests) && state.manifests.length <= MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES;
        } });
    } finally { encryptionKey.fill(0); }
    const seen = new Set<string>();
    for (const value of storage.read().manifests) {
      const manifest = await verifyAdmissionIssuanceAllocation(value, authority), period = JSON.stringify([manifest.community, manifest.epoch]);
      if (seen.has(period)) throw new Error('Duplicate period in allocation authority journal');
      seen.add(period);
      if (JSON.stringify(value) !== JSON.stringify(manifest)) throw new Error('Noncanonical manifest in allocation authority journal');
    }
  } catch (error) { storage?.close(); secret.fill(0); throw error; }
  const store = storage;
  function ensureOpen() { if (closed) throw new Error('Allocation authority is closed'); store.read(); }
  return {
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
