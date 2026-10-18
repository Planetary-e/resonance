import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { generateSigningKeyPair } from '@resonance/core';
import { admissionKeyFingerprint, signAdmissionPolicy, type AdmissionWalletProfileV1 } from '@resonance/core/admission-policy';
import { admissionPolicyHead, createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadVote, parseAdmissionPolicyObservers, type AdmissionPolicyHead } from '@resonance/core/admission-policy-freshness';
import { ADMISSION_POLICY_QUERY_REPLY_TYPE } from '@resonance/core/admission-policy-query';
import { openAdmissionIssuerLedger, approveAdmissionIssuerBatch } from '../admission-issuer-ledger.js';
import { createAdmissionIssuanceBatch } from '../blind-admission-issuance.js';

let keys: CryptoKeyPair, profile: AdmissionWalletProfileV1;
beforeAll(async () => {
  keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
  profile = { version: 1, scope: { issuer: 'fresh-issuer', community: 'public', epoch: 'one' }, relayUrls: ['ws://127.0.0.1:33000/'],
    issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----` };
});
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'issuer-freshness-')), authorityKey = generateSigningKeyPair(), observers = Array.from({ length: 5 }, generateSigningKeyPair);
  cleanup.push(() => { authorityKey.secretKey.fill(0); observers.forEach(k => k.secretKey.fill(0)); rmSync(directory, { recursive: true, force: true }); });
  const authority = Buffer.from(authorityKey.publicKey).toString('base64url'); let now = Date.now();
  const body = { version: 1 as const, kind: 'admission-policy' as const, revision: 1, issuedAt: now - 1000, expiresAt: now + 600000,
    activeKey: admissionKeyFingerprint(profile.issuerPublicKey), keys: [{ profile, notBefore: now - 1000, issueUntil: now + 100000, spendUntil: now + 200000, retryUntil: now + 300000 }] };
  const first = await signAdmissionPolicy(body, authority, authorityKey.secretKey), second = await signAdmissionPolicy({ ...body, revision: 2 }, authority, authorityKey.secretKey);
  const context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority, genesis: admissionPolicyHead(first), quorum: 4,
    members: observers.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${33001 + i}/` })) });
  const advance = await createAdmissionPolicyAdvance(first, second, context, authorityKey), path = join(directory, 'ledger.json');
  const options = { path, expectedProfile: profile, privateKey: keys.privateKey, now: () => now };
  let ledger = await openAdmissionIssuerLedger({ ...options, create: { batchSize: 1, maxPermits: 3 } }); cleanup.push(() => ledger.close());
  await ledger.installPolicy(first, authority, { observers: context });
  const proof = (head: AdmissionPolicyHead = context.genesis) => {
    const { query } = ledger.preparePolicyObservation();
    return { version: 1 as const, type: ADMISSION_POLICY_QUERY_REPLY_TYPE, certificate: { version: 1 as const, kind: 'admission-policy-head-certificate' as const,
      votes: observers.slice(0, 4).map(key => createAdmissionPolicyHeadVote(query.request, head, context, key, now)) } };
  };
  return { authority, authorityKey, body, first, second, context, advance, path, proof, get ledger() { return ledger; },
    clock(value: number) { now = value; }, async reopen() { ledger.close(); ledger = await openAdmissionIssuerLedger(options); } };
}

it('requires a newly prepared issuer challenge for every grant, approval and cached response, including across restart', async () => {
  const n = await fixture(); expect(() => n.ledger.grant()).toThrow('new issuer policy observation');
  const proof = n.proof(); expect(() => n.ledger.preparePolicyObservation()).toThrow('already pending');
  const permit = n.ledger.grant(proof); expect(() => n.ledger.grant(proof)).toThrow('new issuer policy observation');
  const before = readFileSync(n.path); n.proof(); expect(() => n.ledger.grant(proof)).toThrow(); expect(readFileSync(n.path)).toEqual(before);
  const batch = await createAdmissionIssuanceBatch(profile, 1);
  await expect(n.ledger.approve(permit, batch.request)).rejects.toThrow('new issuer policy observation');
  const response = await n.ledger.approve(permit, batch.request, n.proof()); expect(await batch.finalize(response)).toHaveLength(1);
  const pending = n.proof(); await n.reopen();
  await expect(n.ledger.approve(permit, batch.request, pending)).rejects.toThrow('new issuer policy observation');
  const signing = vi.spyOn(publicVerif.Issuer.prototype, 'issue');
  expect(await n.ledger.approve(permit, batch.request, n.proof())).toEqual(response); expect(signing).not.toHaveBeenCalled();
  expect(n.ledger.status()).toMatchObject({ allocatedPermits: 1, boundPermits: 1, completedPermits: 1, policyFreshness: { installedRevision: 1, observedRevision: 1 } });
});

it('persists newer and conflicting observations before refusal and never reserves or signs under the old policy', async () => {
  const n = await fixture(), permit = n.ledger.grant(n.proof()), batch = await createAdmissionIssuanceBatch(profile, 1);
  const signing = vi.spyOn(publicVerif.Issuer.prototype, 'issue');
  await expect(n.ledger.approve(permit, batch.request, n.proof(n.advance.commitment.next))).rejects.toThrow('newer');
  expect(signing).not.toHaveBeenCalled(); await n.reopen();
  expect(n.ledger.status()).toMatchObject({ boundPermits: 0, policyFreshness: { installedRevision: 1, observedRevision: 2 } });
  expect(() => n.ledger.grant(n.proof())).toThrow('older');
  await expect(n.ledger.installPolicy(n.second, n.authority)).rejects.toThrow('signed immediate successor');
  await n.ledger.installPolicy(n.second, n.authority, { advance: n.advance });
  expect(await batch.finalize(await n.ledger.approve(permit, batch.request, n.proof(n.advance.commitment.next)))).toHaveLength(1);
  expect(() => n.ledger.grant(n.proof({ ...n.advance.commitment.next, transition: 'f'.repeat(64) }))).toThrow('conflict');
  await n.reopen(); expect(n.ledger.status().policyFreshness?.conflict).toBe(true);
  expect(() => n.ledger.preparePolicyObservation()).toThrow('conflicting');
  await expect(n.ledger.installPolicy(n.second, n.authority, { advance: n.advance })).rejects.toThrow('fenced');
});

it('retains a batch reservation if its observation expires during signing and requires a new proof to recover it', async () => {
  const n = await fixture(), permit = n.ledger.grant(n.proof()), batch = await createAdmissionIssuanceBatch(profile, 1), proof = n.proof();
  const pending = n.ledger.approve(permit, batch.request, proof); n.clock(proof.certificate.votes[0].request.expiresAt);
  await expect(pending).rejects.toThrow('observation expired');
  expect(n.ledger.status()).toMatchObject({ allocatedPermits: 1, boundPermits: 1, completedPermits: 0, preparedPermits: 1 }); await n.reopen();
  const other = await createAdmissionIssuanceBatch(profile, 1);
  await expect(n.ledger.approve(permit, other.request)).rejects.toThrow('already bound');
  const signing = vi.spyOn(publicVerif.Issuer.prototype, 'issue');
  expect(await batch.finalize(await n.ledger.approve(permit, batch.request, n.proof()))).toHaveLength(1);
  expect(signing).not.toHaveBeenCalled(); expect(n.ledger.status()).toMatchObject({ preparedPermits: 0, completedPermits: 1 });
  n.ledger.preparePolicyObservation(); n.ledger.cancelPolicyObservation(); expect(() => n.ledger.grant()).toThrow('new issuer policy observation');
});

it('does not promote prepared signatures after issuance closes even while approved-response recovery would be allowed', async () => {
  const n = await fixture(), permit = n.ledger.grant(n.proof()), batch = await createAdmissionIssuanceBatch(profile, 1), proof = n.proof();
  const pending = n.ledger.approve(permit, batch.request, proof); n.clock(proof.certificate.votes[0].request.expiresAt);
  await expect(pending).rejects.toThrow('observation expired'); await n.reopen();
  n.clock(n.body.keys[0].issueUntil);
  const signing = vi.spyOn(publicVerif.Issuer.prototype, 'issue');
  await expect(n.ledger.approve(permit, batch.request, n.proof())).rejects.toThrow('retired or inactive');
  expect(signing).not.toHaveBeenCalled(); expect(n.ledger.status()).toMatchObject({ preparedPermits: 1, completedPermits: 0, boundPermits: 1 });
});

it.each([false, true])('refreshes slow batch approval once, without resigning or bypassing a newer quorum head (%s)', async newer => {
  const n = await fixture(), permit = n.ledger.grant(n.proof()), batch = await createAdmissionIssuanceBatch(profile, 1);
  const original = publicVerif.Issuer.prototype.issue;
  const signing = vi.spyOn(publicVerif.Issuer.prototype, 'issue').mockImplementation(async function (this: InstanceType<typeof publicVerif.Issuer>, ...args) {
    const response = await Reflect.apply(original, this, args); n.clock(n.body.issuedAt + 5000); return response;
  });
  let observations = 0;
  const observe = async () => n.proof(++observations === 2 && newer ? n.advance.commitment.next : n.context.genesis);
  const result = approveAdmissionIssuerBatch(n.ledger, permit, batch.request, observe);
  if (newer) {
    await expect(result).rejects.toThrow('newer');
    expect(n.ledger.status()).toMatchObject({ preparedPermits: 1, completedPermits: 0 });
  } else {
    expect(await batch.finalize(await result)).toHaveLength(1);
    expect(n.ledger.status()).toMatchObject({ preparedPermits: 0, completedPermits: 1 });
  }
  expect(observations).toBe(2); expect(signing).toHaveBeenCalledTimes(1);
});
