import { beforeAll, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { generateSigningKeyPair } from '@resonance/core';
import { historyDigest, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { admissionIssuanceAllocationDigest, signAdmissionIssuanceAllocation, type AdmissionIssuanceAllocationBody, type SignedAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';
import { signAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { admissionKeyFingerprint } from '../admission-wallet-profile.js';
import { ALLOCATION_AUTHORITY_DOMAIN, MAX_ADMISSION_ALLOCATION_ASSIGNMENTS, MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES,
  allocationAuthorityHistoryAnchor, assertProtectedAllocationAuthorityGenesis, assertProtectedAllocationAuthoritySuccessor,
  deriveAdmissionAllocationAuthorityEncryptionKey, parseAdmissionAllocationAuthorityState, reviewAdmissionAllocationPlan, reviewAdmissionClaimAssignment,
  type AdmissionAllocationAuthorityState } from '../admission-allocation-authority-state.js';

const key = generateSigningKeyPair(), authority = Buffer.from(key.publicKey).toString('base64url');
let template: AdmissionIssuanceAllocationBody;
beforeAll(() => {
  template = { version: 2, claimPolicy: 'authority-assigned-v1', kind: 'admission-issuance-allocation', community: 'public', epoch: 'expired-one', notBefore: 100, issueUntil: 200,
    totalTokenBudget: 4, allocations: [0, 1].map(index => ({ batchSize: 1, maxPermits: 2, profile: { version: 1,
      scope: { issuer: `state-issuer-${index}`, community: 'public', epoch: 'expired-one' },
      issuerPublicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(), relayUrls: ['ws://127.0.0.1:44010/'] } })) };
});
const empty = (): AdmissionAllocationAuthorityState => ({ version: 2, authority, manifests: [], assignments: [] });
function body(epoch = 'expired-one') { const value = structuredClone(template); value.epoch = epoch; value.allocations.forEach(entry => { entry.profile.scope.epoch = epoch; }); return value; }
const handle = (n: number) => { const bytes = Buffer.alloc(32); bytes.writeUInt32BE(n); return bytes.toString('base64url'); };
async function allocation(epoch = 'expired-one') { return signAdmissionIssuanceAllocation(body(epoch), authority, key.secretKey); }
function request(manifest: SignedAdmissionIssuanceAllocation, n: number, issuer = 0) { return { community: 'public' as const, epoch: manifest.epoch, claimHandle: handle(n), issuerKeyFingerprint: admissionKeyFingerprint(manifest.allocations[issuer].profile.issuerPublicKey) }; }
async function assignment(manifest: SignedAdmissionIssuanceAllocation, n = 1, issuer = 0) {
  return signAdmissionClaimAssignment({ version: 1, kind: 'admission-claim-assignment', authority, allocationDigest: admissionIssuanceAllocationDigest(manifest), ...request(manifest, n, issuer) }, manifest, authority, key.secretKey);
}
async function state() { const manifest = await allocation(), claim = await assignment(manifest); return { version: 2 as const, authority, manifests: [manifest], assignments: [claim] }; }

it('preserves historical v1/v2 signature authentication after expiry and snapshots inputs before awaiting', async () => {
  const original = await state(), mutable = structuredClone(original), parsing = parseAdmissionAllocationAuthorityState(mutable, authority);
  mutable.assignments[0].claimHandle = handle(999); mutable.manifests.length = 0;
  expect(await parsing).toEqual(original);
  expect(await parseAdmissionAllocationAuthorityState({ version: 1, authority, manifests: original.manifests }, authority)).toEqual({ version: 1, authority, manifests: original.manifests });
  expect(await parseAdmissionAllocationAuthorityState(original, authority)).toEqual(original); // issueUntil=200 is historical, never a parsing deadline.
});

it('authenticates signed plans and assignments, immutable periods, unique claims, issuer capacity and canonical entries', async () => {
  const original = await state(), manifest = original.manifests[0];
  const conflictingBody = body(); conflictingBody.totalTokenBudget = 5;
  const conflictingManifest = await signAdmissionIssuanceAllocation(conflictingBody, authority, key.secretKey);
  const foreignBinding = await assignment(conflictingManifest);
  const another = await assignment(manifest, 1, 1), second = await assignment(manifest, 2), overQuota = await assignment(manifest, 3);
  for (const change of [
    (value: typeof original) => { value.manifests[0].signature = Buffer.alloc(64).toString('base64url'); },
    (value: typeof original) => { value.manifests.push(conflictingManifest); },
    (value: typeof original) => { const profile = value.manifests[0].allocations[0].profile; value.manifests[0].allocations[0].profile = { scope: profile.scope, version: 1, issuerPublicKey: profile.issuerPublicKey, relayUrls: profile.relayUrls }; },
    (value: typeof original) => { value.assignments[0] = foreignBinding; },
    (value: typeof original) => { value.assignments[0].signature = Buffer.alloc(64).toString('base64url'); },
    (value: typeof original) => { value.assignments[0].allocationDigest = `sha256:${'0'.repeat(64)}`; },
    (value: typeof original) => { value.assignments.push(another); },
    (value: typeof original) => { value.assignments.push(second, overQuota); },
    (value: typeof original) => { value.manifests = []; },
    (value: typeof original) => { value.assignments[0].claimHandle += '='; },
    (value: typeof original) => { const { signature, ...rest } = value.assignments[0]; value.assignments[0] = { signature, ...rest }; },
  ]) { const value = structuredClone(original); change(value); await expect(parseAdmissionAllocationAuthorityState(value, authority)).rejects.toThrow(); }
  await expect(parseAdmissionAllocationAuthorityState(original, Buffer.alloc(32).toString('base64url'))).rejects.toThrow();
  await expect(parseAdmissionAllocationAuthorityState({ ...original, extra: true }, authority)).rejects.toThrow();
});

it('accepts exactly one append and identity, while rejecting signed rewrites, deletion, reordering, reassignment and combined mutations', async () => {
  const base = empty(), first = await state(), manifest = first.manifests[0];
  const installed = { ...first, assignments: [] }; await assertProtectedAllocationAuthoritySuccessor(base, installed);
  await assertProtectedAllocationAuthoritySuccessor(installed, first); await assertProtectedAllocationAuthoritySuccessor(first, structuredClone(first));
  const nextManifest = await allocation('period-two'), second = { ...first, manifests: [...first.manifests, nextManifest] };
  await assertProtectedAllocationAuthoritySuccessor(first, second);
  const nextAssignment = await assignment(nextManifest, 2), combined = { ...second, assignments: [...second.assignments, nextAssignment] };
  await assertProtectedAllocationAuthoritySuccessor(second, combined);
  for (const changed of [base, { ...first, assignments: [] }, { ...first, assignments: [await assignment(manifest, 1, 1)] },
    { ...combined, manifests: [...combined.manifests].reverse() }, { ...combined, assignments: [...combined.assignments].reverse() }]) {
    await expect(assertProtectedAllocationAuthoritySuccessor(first, changed)).rejects.toThrow();
  }
  await expect(assertProtectedAllocationAuthoritySuccessor(first, combined)).rejects.toThrow('exactly one');
  await expect(assertProtectedAllocationAuthoritySuccessor({ version: 1, authority, manifests: [] }, base)).rejects.toThrow('without conversion');
});

it('binds the empty protected genesis to its exact static anchor and preserves the old approval/key bytes', async () => {
  const state = empty(), expected = historyDigest('resonance:allocation-authority-history-genesis:v1\n' + JSON.stringify({ version: 2, authority, manifests: [], assignments: [] }));
  expect(allocationAuthorityHistoryAnchor(authority)).toBe(expected);
  const context = { version: 1, role: 'admission-allocation-authority', historyId: handle(10), owner: handle(11), authority, policyDigest: expected, members: [], quorum: 4 } as HistoryCheckpointContext;
  assertProtectedAllocationAuthorityGenesis(state, context);
  expect(() => assertProtectedAllocationAuthorityGenesis(state, { ...context, role: 'admission-issuer' })).toThrow('genesis');
  expect(() => assertProtectedAllocationAuthorityGenesis(state, { ...context, policyDigest: historyDigest('wrong') })).toThrow('genesis');
  expect(() => assertProtectedAllocationAuthorityGenesis({ version: 1, authority, manifests: [] }, context)).toThrow('genesis');
  const input = body(), reviewed = await reviewAdmissionAllocationPlan(input, authority);
  expect(reviewed.approvalDigest).toBe(`sha256:${createHash('sha256').update('resonance:admission-allocation-approval:v1\n').update(JSON.stringify([authority, reviewed.body])).digest('hex')}`);
  const derived = deriveAdmissionAllocationAuthorityEncryptionKey(key.secretKey, authority), old = Buffer.from(hkdfSync('sha256', key.secretKey, Buffer.from(authority, 'base64url'), Buffer.from(ALLOCATION_AUTHORITY_DOMAIN), 32));
  expect(derived).toEqual(old); derived.fill(0); old.fill(0);
  expect(() => deriveAdmissionAllocationAuthorityEncryptionKey(generateSigningKeyPair().secretKey, authority)).toThrow('does not match');
  const retained = await stateWithManifest(), reviewedAssignment = await reviewAdmissionClaimAssignment(retained, request(retained.manifests[0], 1));
  expect(reviewedAssignment.body.allocationDigest).toBe(admissionIssuanceAllocationDigest(retained.manifests[0]));
  await expect(reviewAdmissionClaimAssignment(retained, { ...request(retained.manifests[0], 1), extra: true })).rejects.toThrow('Invalid');
});
async function stateWithManifest() { return { version: 2 as const, authority, manifests: [await allocation()], assignments: [] }; }

it('enforces the manifest and assignment caps before authenticating excess untrusted entries', async () => {
  const manifest = await allocation();
  await expect(parseAdmissionAllocationAuthorityState({ version: 2, authority, manifests: Array(MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES + 1).fill(manifest), assignments: [] }, authority)).rejects.toThrow();
  await expect(parseAdmissionAllocationAuthorityState({ version: 2, authority, manifests: [manifest], assignments: Array(MAX_ADMISSION_ALLOCATION_ASSIGNMENTS + 1).fill(await assignment(manifest)) }, authority)).rejects.toThrow();
  const manifests = await Promise.all(Array.from({ length: MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES }, (_, index) => allocation(`bounded-${index}`)));
  expect((await parseAdmissionAllocationAuthorityState({ version: 2, authority, manifests, assignments: [] }, authority)).manifests).toHaveLength(MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES);
});
