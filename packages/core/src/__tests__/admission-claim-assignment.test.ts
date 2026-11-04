import { beforeAll, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { generateSigningKeyPair, verify } from '../crypto.js';
import { admissionKeyFingerprint } from '../admission-profile.js';
import { admissionIssuanceAllocationDigest, parseAdmissionIssuanceAllocationBody, signAdmissionIssuanceAllocation,
  verifyAdmissionIssuanceAllocation, type AdmissionIssuanceAllocationBody } from '../admission-issuance-allocation.js';
import { parseAdmissionClaimAssignmentBody, signAdmissionClaimAssignment, verifyAdmissionClaimAssignment,
  type AdmissionClaimAssignmentBody } from '../admission-claim-assignment.js';
const key = generateSigningKeyPair(), authority = Buffer.from(key.publicKey).toString('base64url');
let plan: AdmissionIssuanceAllocationBody;
beforeAll(() => {
  plan = { version: 2, claimPolicy: 'authority-assigned-v1', kind: 'admission-issuance-allocation', community: 'public', epoch: 'claim-epoch', notBefore: 100, issueUntil: 200,
    totalTokenBudget: 4, allocations: [0, 1].map(index => ({ batchSize: 1, maxPermits: 2, profile: { version: 1,
      scope: { issuer: `issuer-${index}`, community: 'public', epoch: 'claim-epoch' },
      issuerPublicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(), relayUrls: ['ws://127.0.0.1:44010/'] } })) };
});
async function fixture() {
  const manifest = await signAdmissionIssuanceAllocation(plan, authority, key.secretKey);
  const body: AdmissionClaimAssignmentBody = { version: 1, kind: 'admission-claim-assignment', authority,
    allocationDigest: admissionIssuanceAllocationDigest(manifest), community: 'public', epoch: plan.epoch,
    claimHandle: Buffer.alloc(32, 7).toString('base64url'), issuerKeyFingerprint: admissionKeyFingerprint(manifest.allocations[0].profile.issuerPublicKey) };
  return { manifest, body, assignment: await signAdmissionClaimAssignment(body, manifest, authority, key.secretKey) };
}
it('preserves the v1 signature payload and requires the signed v2 policy', async () => {
  const { claimPolicy: _, ...v1 } = plan as AdmissionIssuanceAllocationBody & { claimPolicy: string };
  const signed = await signAdmissionIssuanceAllocation({ ...v1, version: 1 }, authority, key.secretKey);
  const oldPayload = Buffer.from(`resonance:admission-issuance-allocation:v1\n${JSON.stringify([signed.version, signed.kind, signed.community,
    signed.epoch, signed.notBefore, signed.issueUntil, signed.totalTokenBudget, signed.allocations.map(entry => [entry.profile, entry.batchSize, entry.maxPermits])])}`);
  expect(verify(oldPayload, Buffer.from(signed.signature, 'base64url'), key.publicKey)).toBe(true);
  const { manifest } = await fixture(); expect(await verifyAdmissionIssuanceAllocation(manifest, authority)).toEqual(manifest);
  for (const claimPolicy of [undefined, 'unassigned', null]) {
    await expect(parseAdmissionIssuanceAllocationBody({ ...plan, claimPolicy })).rejects.toThrow();
    await expect(verifyAdmissionIssuanceAllocation({ ...manifest, claimPolicy }, authority)).rejects.toThrow();
  }
  await expect(parseAdmissionIssuanceAllocationBody({ ...signed, authority: undefined, signature: undefined })).rejects.toThrow();
  await expect(parseAdmissionIssuanceAllocationBody({ ...v1, version: 1, claimPolicy: 'authority-assigned-v1' })).rejects.toThrow();
});
it('authenticates actual assignment signatures, manifest authority, all scope pins, and issuer membership', async () => {
  const { manifest, body, assignment } = await fixture();
  expect(await verifyAdmissionClaimAssignment(assignment, manifest, authority)).toEqual(assignment);
  const other = generateSigningKeyPair(), otherAuthority = Buffer.from(other.publicKey).toString('base64url');
  await expect(verifyAdmissionClaimAssignment(assignment, manifest, otherAuthority)).rejects.toThrow();
  await expect(signAdmissionClaimAssignment(body, manifest, authority, other.secretKey)).rejects.toThrow('does not match');
  for (const change of [
    { signature: Buffer.alloc(64).toString('base64url') }, { authority: otherAuthority },
    { claimHandle: Buffer.alloc(32, 8).toString('base64url') }, { epoch: 'other-epoch' }, { community: 'private' },
    { allocationDigest: `sha256:${'0'.repeat(64)}` }, { issuerKeyFingerprint: `sha256:${'0'.repeat(64)}` },
    { issuerKeyFingerprint: admissionKeyFingerprint(manifest.allocations[1].profile.issuerPublicKey) },
  ]) await expect(verifyAdmissionClaimAssignment({ ...assignment, ...change }, manifest, authority)).rejects.toThrow();
  const tampered = structuredClone(manifest); tampered.issueUntil++;
  await expect(verifyAdmissionClaimAssignment(assignment, tampered, authority)).rejects.toThrow('signature');
  const { claimPolicy: _, ...v1 } = plan as AdmissionIssuanceAllocationBody & { claimPolicy: string };
  const old = await signAdmissionIssuanceAllocation({ ...v1, version: 1 }, authority, key.secretKey);
  await expect(signAdmissionClaimAssignment({ ...body, allocationDigest: admissionIssuanceAllocationDigest(old) }, old, authority, key.secretKey)).rejects.toThrow('v2');
});
it('enforces exact bounded canonical assignment fields', async () => {
  const { body, manifest, assignment } = await fixture();
  for (const change of [
    { claimHandle: `${body.claimHandle}=` }, { claimHandle: Buffer.alloc(31).toString('base64url') }, { claimHandle: 'x'.repeat(4097) },
    { issuerKeyFingerprint: body.issuerKeyFingerprint.toUpperCase() }, { epoch: '../invalid' }, { version: 2 }, { extra: true },
  ]) expect(() => parseAdmissionClaimAssignmentBody({ ...body, ...change })).toThrow();
  await expect(verifyAdmissionClaimAssignment({ ...assignment, signature: `${assignment.signature}=` }, manifest, authority)).rejects.toThrow();
  await expect(verifyAdmissionClaimAssignment({ ...assignment, extra: true }, manifest, authority)).rejects.toThrow();
});
it('snapshots assignment evidence, manifest profiles, and private keys before awaiting', async () => {
  const { body, manifest, assignment } = await fixture();
  const input = structuredClone(body), signingManifest = structuredClone(manifest), secret = Uint8Array.from(key.secretKey);
  const pending = signAdmissionClaimAssignment(input, signingManifest, authority, secret);
  input.claimHandle = Buffer.alloc(32, 99).toString('base64url'); signingManifest.allocations[0].profile.scope.epoch = 'mutated'; secret.fill(0);
  expect(await pending).toEqual(assignment);
  const evidence = structuredClone(assignment), pinned = structuredClone(manifest), verifying = verifyAdmissionClaimAssignment(evidence, pinned, authority);
  evidence.signature = 'mutated'; pinned.allocations[0].profile.issuerPublicKey = 'mutated';
  expect(await verifying).toEqual(assignment);
});
