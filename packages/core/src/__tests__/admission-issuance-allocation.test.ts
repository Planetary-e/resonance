import { beforeAll, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { generateSigningKeyPair } from '../crypto.js';
import { admissionIssuanceAllocationDigest, assertAdmissionIssuanceAllocationCurrent, parseAdmissionIssuanceAllocationBody,
  selectAdmissionIssuerAllocation, signAdmissionIssuanceAllocation, verifyAdmissionIssuanceAllocation, type AdmissionIssuanceAllocationBody } from '../admission-issuance-allocation.js';
const key = generateSigningKeyPair(), authority = Buffer.from(key.publicKey).toString('base64url');
let template: AdmissionIssuanceAllocationBody;
beforeAll(() => {
  template = { version: 1, kind: 'admission-issuance-allocation', community: 'public', epoch: 'period-one', notBefore: 100, issueUntil: 200,
    totalTokenBudget: 8, allocations: [0, 1].map(index => ({ batchSize: 2, maxPermits: 2, profile: { version: 1,
      scope: { issuer: `issuer-${index}`, community: 'public', epoch: 'period-one' },
      issuerPublicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      relayUrls: ['ws://127.0.0.1:44010/'] } })) };
});
const body = () => structuredClone(template);
it('authenticates the authority, every budget field, and immutable profile pins with actual Ed25519 signatures', async () => {
  const signed = await signAdmissionIssuanceAllocation(body(), authority, key.secretKey);
  expect(await verifyAdmissionIssuanceAllocation(signed, authority)).toEqual(signed);
  const stranger = Buffer.from(generateSigningKeyPair().publicKey).toString('base64url');
  await expect(verifyAdmissionIssuanceAllocation(signed, stranger)).rejects.toThrow('pinned');
  await expect(signAdmissionIssuanceAllocation(body(), authority, generateSigningKeyPair().secretKey)).rejects.toThrow('does not match');
  for (const edit of [
    (v: typeof signed) => { v.totalTokenBudget++; },
    (v: typeof signed) => { v.issueUntil++; },
    (v: typeof signed) => { v.allocations[0].maxPermits--; },
    (v: typeof signed) => { v.allocations[0].profile.relayUrls = ['ws://127.0.0.1:44011/']; },
    (v: typeof signed) => { v.allocations[0].profile.scope.issuer = 'changed'; },
  ]) { const changed = structuredClone(signed); edit(changed); await expect(verifyAdmissionIssuanceAllocation(changed, authority)).rejects.toThrow('signature'); }
  await expect(verifyAdmissionIssuanceAllocation({ ...signed, refund: true }, authority)).rejects.toThrow();
  await expect(verifyAdmissionIssuanceAllocation({ ...signed, signature: `${signed.signature}=` }, authority)).rejects.toThrow();
  await expect(verifyAdmissionIssuanceAllocation({ ...signed, authority: `${authority}=` }, `${authority}=`)).rejects.toThrow();
});
it('canonicalizes allocation order, relay destinations and PEM encodings for exact signing and digest equality', async () => {
  const original = body(), equivalent = body(); equivalent.allocations.reverse();
  for (const entry of equivalent.allocations) {
    entry.profile.relayUrls = ['ws://127.0.0.1:44010', 'ws://127.0.0.1:44010/'];
    entry.profile.issuerPublicKey = entry.profile.issuerPublicKey.trim();
  }
  const a = await signAdmissionIssuanceAllocation(original, authority, key.secretKey), b = await signAdmissionIssuanceAllocation(equivalent, authority, key.secretKey);
  expect(a).toEqual(b); expect(admissionIssuanceAllocationDigest(a)).toBe(admissionIssuanceAllocationDigest(b));
  expect(admissionIssuanceAllocationDigest(a)).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(selectAdmissionIssuerAllocation(a, a.allocations[0].profile)).toEqual(a.allocations[0]);
  const changed = structuredClone(a.allocations[0].profile); changed.scope.issuer = 'changed';
  expect(() => selectAdmissionIssuerAllocation(a, changed)).toThrow('absent');
});
it('rejects duplicate issuer fingerprints, mismatched public community and epoch, and exact-schema violations', async () => {
  const edits = [
    (v: AdmissionIssuanceAllocationBody) => { v.allocations[1].profile.issuerPublicKey = v.allocations[0].profile.issuerPublicKey; },
    (v: AdmissionIssuanceAllocationBody) => { v.allocations[0].profile.scope.epoch = 'different'; },
    (v: AdmissionIssuanceAllocationBody) => { (v.allocations[0].profile.scope as { community: string }).community = 'private'; },
    (v: AdmissionIssuanceAllocationBody) => { v.epoch = '../invalid'; },
    (v: AdmissionIssuanceAllocationBody) => { Object.assign(v.allocations[0], { refund: true }); },
    (v: AdmissionIssuanceAllocationBody) => { Object.assign(v, { revision: 1 }); },
  ];
  for (const edit of edits) { const changed = body(); edit(changed); await expect(parseAdmissionIssuanceAllocationBody(changed)).rejects.toThrow(); }
});
it('bounds safe integer arithmetic, counts, bytes, and the aggregate budget before accepting a plan', async () => {
  for (const [field, values] of Object.entries({ notBefore: [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1], issueUntil: [100, 0], totalTokenBudget: [0, 7, 65537, Number.MAX_SAFE_INTEGER] })) {
    for (const value of values) await expect(parseAdmissionIssuanceAllocationBody({ ...body(), [field]: value })).rejects.toThrow();
  }
  for (const [field, values] of Object.entries({ batchSize: [0, 33, 1.5, Number.MAX_SAFE_INTEGER], maxPermits: [0, 257, Number.MAX_SAFE_INTEGER] })) {
    for (const value of values) { const changed = body(); Object.assign(changed.allocations[0], { [field]: value }); await expect(parseAdmissionIssuanceAllocationBody(changed)).rejects.toThrow(); }
  }
  for (const allocations of [[], Array(9).fill(body().allocations[0])]) await expect(parseAdmissionIssuanceAllocationBody({ ...body(), allocations })).rejects.toThrow();
  const huge = body(); huge.allocations[0].profile.issuerPublicKey = 'x'.repeat(65537);
  await expect(parseAdmissionIssuanceAllocationBody(huge)).rejects.toThrow();
  const max = body(); max.allocations[0].batchSize = 32; max.allocations[0].maxPermits = 256; max.totalTokenBudget = 8196;
  expect((await parseAdmissionIssuanceAllocationBody(max)).totalTokenBudget).toBe(8196);
});
it('snapshots inputs and signing secrets before asynchronous crypto and isolates returned profiles', async () => {
  const input = body(), secret = Uint8Array.from(key.secretKey), pending = signAdmissionIssuanceAllocation(input, authority, secret);
  input.allocations[1].profile.scope.epoch = 'mutated'; secret.fill(0);
  const signed = await pending, original = structuredClone(signed), verifying = verifyAdmissionIssuanceAllocation(signed, authority);
  signed.signature = 'changed'; signed.allocations[1].profile.relayUrls[0] = 'ws://127.0.0.1:44011/';
  expect(await verifying).toEqual(original);
});
it('keeps historical authentication separate from the half-open issuance window', async () => {
  const signed = await signAdmissionIssuanceAllocation(body(), authority, key.secretKey);
  expect(() => assertAdmissionIssuanceAllocationCurrent(signed, 100)).not.toThrow();
  expect(() => assertAdmissionIssuanceAllocationCurrent(signed, 199)).not.toThrow();
  for (const now of [99, 200, NaN, -1, Number.MAX_SAFE_INTEGER + 1]) expect(() => assertAdmissionIssuanceAllocationCurrent(signed, now)).toThrow('not current');
  expect(await verifyAdmissionIssuanceAllocation(signed, authority)).toEqual(signed);
});
