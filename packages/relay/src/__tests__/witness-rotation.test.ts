import { beforeAll, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateSigningKeyPair, createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2 } from '@resonance/core';
import { assertAdmissionPolicySuccessor, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionWitnessSetId, createAdmissionWitnessVote, parseAdmissionWitnessSet, verifyAdmissionSpendCertificate } from '@resonance/core/admission-witness';
import { createConfiguredAdmissionVerifier } from '../configured-admission-verifier.js';
import type { AdmissionWitnessTransport } from '../admission-witness.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';

let old: Awaited<ReturnType<typeof witnessFixture>>, fresh: Awaited<ReturnType<typeof witnessFixture>>;
beforeAll(async () => {
  old = await witnessFixture(); fresh = await witnessFixture();
  // The fixture's token factory and unsigned body share this scope object.
  fresh.scope.epoch = 'witness-period-two';
});

it('demonstrates valid conflicting signatures after unsafe replacement, while installed-policy rules reject that replacement', async () => {
  const extra = [generateSigningKeyPair(), generateSigningKeyPair()];
  const signers = [...old.witnesses, ...extra]; // A..G, with A equivocating.
  const set = (indexes: number[]) => parseAdmissionWitnessSet({ ...old.body.keys[0].witnesses,
    members: indexes.map(i => ({ publicKey: Buffer.from(signers[i].publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${49000 + i}/` })) });
  const first = set([0, 1, 2, 3, 4]), second = set([0, 1, 2, 5, 6]);
  const a = { issuerKey: old.policy.activeKey, spend: randomBytes(32).toString('base64url'), setId: admissionWitnessSetId(first),
    action: 'search' as const, requestBinding: createAdmissionRequestBindingV2('search', { text: 'first' }) };
  const b = { ...a, setId: admissionWitnessSetId(second), requestBinding: createAdmissionRequestBindingV2('search', { text: 'conflict' }) };
  // Counterfactual raw signers model a system that permitted replacing membership.
  // Only A signs twice. This is not a bypass of Resonance's installed policy.
  const firstCert = { version: 1, votes: [0, 1, 3, 4].map(i => createAdmissionWitnessVote(a, signers[i])) };
  const secondCert = { version: 1, votes: [0, 2, 5, 6].map(i => createAdmissionWitnessVote(b, signers[i])) };
  expect(verifyAdmissionSpendCertificate(firstCert, a, first)).toBe(true);
  expect(verifyAdmissionSpendCertificate(secondCert, b, second)).toBe(true);
  expect(verifyAdmissionSpendCertificate(firstCert, a, second)).toBe(false);
  const body = { ...old.body, keys: [{ ...old.body.keys[0], witnesses: first }] };
  const initial = await signAdmissionPolicy(body, old.authority, old.authorityKey.secretKey);
  const replaced = await signAdmissionPolicy({ ...body, revision: 2, keys: [{ ...body.keys[0], witnesses: second }] }, old.authority, old.authorityKey.secretKey);
  expect(() => assertAdmissionPolicySuccessor(initial, replaced)).toThrow('retain prior keys');
});

it('restores new-key admission with a disjoint cohort while old votes, certificates and retirement survive restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'resonance-witness-rotation-')), encryptionKey = randomBytes(32);
  let time = Math.max(old.time, fresh.time) + 100;
  type Verifier = Awaited<ReturnType<typeof createConfiguredAdmissionVerifier>>;
  const peers = new Map<string, Verifier>(), instances = new Set<Verifier>();
  const oldKeys = old.witnesses.map(key => Buffer.from(key.publicKey).toString('base64url'));
  const newKeys = fresh.witnesses.map(key => Buffer.from(key.publicKey).toString('base64url'));
  let reachable = new Set(oldKeys);
  const contacts: Array<{ key: string; issuerKey: string }> = [];
  const transport: AdmissionWitnessTransport = async (member, request) => {
    contacts.push({ key: member.publicKey, issuerKey: request.issuerKey });
    if (!reachable.has(member.publicKey)) throw new Error('offline');
    return peers.get(member.publicKey)!.witness!.vote(request);
  };
  const shared = { encryptionKey, authority: old.authority, now: () => time };
  const close = (instance: Verifier) => { instance.close(); instances.delete(instance); };
  const open = async (options: Parameters<typeof createConfiguredAdmissionVerifier>[0]) => {
    const instance = await createConfiguredAdmissionVerifier(options); instances.add(instance); return instance;
  };
  const context = (text: string) => ({ action: 'search' as const, requestBinding: createAdmissionRequestBindingV2('search', { text }), now: time });
  try {
    for (let i = 0; i < 5; i++) peers.set(oldKeys[i], await open({ ...shared, directory: join(directory, `old-${i}`),
      policy: old.policy, witnessKey: old.witnesses[i], initialize: true }));
    const destination = { ...shared, directory: join(directory, 'destination'), coordinatorKey: old.coordinators[0], witnessTransport: transport };
    let coordinator = await open({ ...destination, policy: old.policy, initialize: true });
    const acceptedContext = context('accepted-old'), pendingContext = context('pending-old');
    const acceptedToken = await old.token(), pendingToken = await old.token();
    const present = (token: string, scope: typeof old.scope, ctx: ReturnType<typeof context>) => presentBlindAdmissionTokenV2(token, scope, ctx.action, ctx.requestBinding);
    const accepted = present(acceptedToken, old.scope, acceptedContext), pending = present(pendingToken, old.scope, pendingContext);
    await expect(coordinator.verifyAndSpend(accepted, acceptedContext)).resolves.toEqual({ status: 'accepted' });
    reachable = new Set(oldKeys.slice(0, 3));
    await expect(coordinator.verifyAndSpend(pending, pendingContext)).rejects.toThrow('Four admission witnesses');
    close(coordinator);
    const oldRetiredEntry = { ...old.body.keys[0], issueUntil: time + 1000, spendUntil: time + 2000 };
    const newEntry = { ...fresh.body.keys[0], witnesses: { ...fresh.body.keys[0].witnesses!,
      coordinators: old.body.keys[0].witnesses!.coordinators } };
    const policy = await signAdmissionPolicy({ ...old.body, revision: 2, issuedAt: time, activeKey: fresh.policy.activeKey,
      keys: [oldRetiredEntry, newEntry] }, old.authority, old.authorityKey.secretKey);
    expect(() => assertAdmissionPolicySuccessor(old.policy, policy)).not.toThrow();
    for (let i = 0; i < 5; i++) {
      close(peers.get(oldKeys[i])!);
      peers.set(oldKeys[i], await open({ ...shared, directory: join(directory, `old-${i}`), policy, witnessKey: old.witnesses[i] }));
      peers.set(newKeys[i], await open({ ...shared, directory: join(directory, `new-${i}`), policy, witnessKey: fresh.witnesses[i], initialize: true }));
    }
    coordinator = await open({ ...destination, policy });
    reachable = new Set([...oldKeys.slice(0, 3), ...newKeys]);
    contacts.length = 0;
    await expect(coordinator.verifyAndSpend(pending, pendingContext)).rejects.toThrow('Four admission witnesses');
    expect(contacts.length).toBe(5);
    expect(contacts.every(contact => oldKeys.includes(contact.key) && contact.issuerKey === old.policy.activeKey)).toBe(true);
    const freshContext = context('fresh-key'), freshToken = await fresh.token();
    contacts.length = 0;
    await expect(coordinator.verifyAndSpend(present(freshToken, fresh.scope, freshContext), freshContext)).resolves.toEqual({ status: 'accepted' });
    expect(contacts.length).toBeGreaterThanOrEqual(4);
    expect(contacts.every(contact => newKeys.includes(contact.key) && contact.issuerKey === policy.activeKey)).toBe(true);
    const relabeled = present(pendingToken, fresh.scope, freshContext);
    expect(await verifyBlindAdmissionTokenV2(relabeled, fresh.scope, freshContext.action, freshContext.requestBinding, fresh.keys.publicKey)).toBeNull();
    // Presentation metadata cannot choose a new key: the combined verifier still
    // recognizes the old token and consults only its original, conflicting votes.
    contacts.length = 0;
    await expect(coordinator.verifyAndSpend(relabeled, freshContext)).rejects.toThrow('Four admission witnesses');
    expect(contacts.length).toBe(5);
    expect(contacts.every(contact => oldKeys.includes(contact.key))).toBe(true);
    const conflict = context('changed-old');
    expect(await coordinator.verifyAndSpend(present(acceptedToken, old.scope, conflict), conflict)).toEqual({ status: 'rejected', reason: 'double_spend' });
    // A returning fourth OLD witness recovers its original operation before cutoff.
    reachable.add(oldKeys[3]);
    await expect(coordinator.verifyAndSpend(pending, pendingContext)).resolves.toEqual({ status: 'accepted' });
    close(coordinator);
    const retained = readFileSync(join(directory, 'destination', 'admission-witness-certificates.json'));
    time = oldRetiredEntry.spendUntil;
    reachable.clear(); contacts.length = 0;
    coordinator = await open({ ...destination, policy });
    expect(await coordinator.verifyAndSpend(accepted, { ...acceptedContext, now: time })).toEqual({ status: 'replay' });
    expect(await coordinator.verifyAndSpend(pending, { ...pendingContext, now: time })).toEqual({ status: 'replay' });
    expect(contacts).toHaveLength(0);
    expect(readFileSync(join(directory, 'destination', 'admission-witness-certificates.json'))).toEqual(retained);
    const unused = present(await old.token(), old.scope, acceptedContext);
    expect(await coordinator.verifyAndSpend(unused, { ...acceptedContext, now: time })).toEqual({ status: 'rejected', reason: 'key_retired' });
    close(coordinator);
    await expect(open({ ...destination, policy: old.policy })).rejects.toThrow('rollback');
    coordinator = await open({ ...destination, policy });
    time = policy.keys[0].retryUntil;
    expect(await coordinator.verifyAndSpend(accepted, { ...acceptedContext, now: time })).toEqual({ status: 'rejected', reason: 'invalid_token' });
    expect(contacts).toHaveLength(0);
  } finally {
    for (const instance of instances) instance.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
