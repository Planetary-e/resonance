import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdmissionRequestBindingV2, generateSigningKeyPair, presentBlindAdmissionTokenV2 } from '@resonance/core';
import { openAdmissionPolicyStore, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionPolicyHead, createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadVote, parseAdmissionPolicyObservers, type AdmissionPolicyHead, type AdmissionPolicyHeadVote } from '@resonance/core/admission-policy-freshness';
import { admissionWitnessSetId, createAdmissionWitnessRequest } from '@resonance/core/admission-witness';
import { listenAdmissionPolicyObserver, type AdmissionPolicyObservationFrame } from '../admission-policy-observation-transport.js';
import { createConfiguredAdmissionVerifier } from '../configured-admission-verifier.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(withWitness = false) {
  const n = await witnessFixture(), directory = mkdtempSync(join(tmpdir(), 'configured-freshness-')), encryptionKey = randomBytes(32);
  cleanup.push(() => { encryptionKey.fill(0); rmSync(directory, { recursive: true, force: true });
    [n.authorityKey, ...n.witnesses, ...n.coordinators].forEach(key => key.secretKey.fill(0)); });
  const first = withWitness ? n.policy : await signAdmissionPolicy({ ...n.body, keys: n.body.keys.map(({ witnesses: _, ...entry }) => entry) }, n.authority, n.authorityKey.secretKey);
  const keys = Array.from({ length: 5 }, generateSigningKeyPair); cleanup.push(() => keys.forEach(key => key.secretKey.fill(0)));
  let context: ReturnType<typeof parseAdmissionPolicyObservers>, head: AdmissionPolicyHead, replay = false;
  const frames: AdmissionPolicyObservationFrame[] = [], online = Array(5).fill(true), retained: AdmissionPolicyHeadVote[] = [];
  const listeners: Array<Awaited<ReturnType<typeof listenAdmissionPolicyObserver>>> = [];
  // Real sockets and signatures; these controlled responders do not claim to
  // exercise protected histories (covered by the separate 25-store query suite).
  for (let i = 0; i < 5; i++) {
    const listener = await listenAdmissionPolicyObserver(async value => {
      if (!online[i]) throw new Error('Offline test observer');
      const frame = value as AdmissionPolicyObservationFrame; frames.push(structuredClone(frame));
      if (replay) return retained[i];
      return retained[i] = createAdmissionPolicyHeadVote(frame.request, head, context, keys[i]);
    }); listeners.push(listener); cleanup.push(listener.close);
  }
  context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority: n.authority,
    genesis: admissionPolicyHead(first), quorum: 4, members: keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: listeners[i].endpoint })) });
  head = context.genesis;
  const { authority: _authority, signature: _signature, ...body } = first;
  const second = await signAdmissionPolicy({ ...body, revision: 2 }, n.authority, n.authorityKey.secretKey);
  const advance = await createAdmissionPolicyAdvance(first, second, context, n.authorityKey);
  const options = { directory, authority: n.authority, policy: first, encryptionKey, initialize: true, policyObservers: context,
    policyObservationTimeoutMs: 1000, ...(withWitness ? { witnessKey: n.witnesses[0] } : {}) };
  let verifier = await createConfiguredAdmissionVerifier(options); cleanup.push(async () => { verifier.close(); await verifier.drainPolicyObservations(); });
  const binding = createAdmissionRequestBindingV2('search', { query: 'one' });
  const request = { action: 'search' as const, requestBinding: binding, now: Date.now() };
  const token = await n.token(), capability = presentBlindAdmissionTokenV2(token, n.scope, 'search', binding);
  const reopen = async (changes: Partial<Parameters<typeof createConfiguredAdmissionVerifier>[0]> = {}) => {
    verifier.close(); await verifier.drainPolicyObservations();
    verifier = await createConfiguredAdmissionVerifier({ ...options, initialize: false, ...changes }); return verifier;
  };
  return { ...n, first, second, advance, directory, encryptionKey, context, frames, online, request, capability, reopen,
    get verifier() { return verifier; }, observed(value: AdmissionPolicyHead) { head = value; }, replay(value: boolean) { replay = value; } };
}

it('queries four current observers only for valid tokens and repeats the check for exact retries without exposing token contents', async () => {
  const n = await fixture();
  expect((await n.verifier.verifyAndSpend(n.capability, { ...n.request, requestBinding: createAdmissionRequestBindingV2('search', { query: 'other' }) })).status).toBe('rejected');
  expect(n.frames).toHaveLength(0);
  expect((await n.verifier.verifyAndSpend(n.capability, n.request)).status).toBe('accepted');
  const challenge = n.frames[0].request.challenge;
  expect(n.frames.every(frame => frame.advance === null && Object.keys(frame).sort().join(',') === 'advance,request')).toBe(true);
  expect(JSON.stringify(n.frames)).not.toContain(n.request.requestBinding);
  n.frames.length = 0; expect((await n.verifier.verifyAndSpend(n.capability, n.request)).status).toBe('replay');
  expect(n.frames[0].request.challenge).not.toBe(challenge);
  n.replay(true); await expect(n.verifier.verifyAndSpend(n.capability, n.request)).rejects.toThrow('four matching');
  n.replay(false); n.online[3] = n.online[4] = false;
  await expect(n.verifier.verifyAndSpend(n.capability, n.request)).rejects.toThrow('four matching');
  await n.reopen({ policyObservers: undefined });
  await expect(n.verifier.verifyAndSpend(n.capability, n.request)).rejects.toThrow('four matching');
  n.online[3] = n.online[4] = true; expect((await n.verifier.verifyAndSpend(n.capability, n.request)).status).toBe('replay');
});

it('retains a newer head before refusing a spend, survives restart without supplied pins and resumes only with its signed successor', async () => {
  const n = await fixture(); n.observed(n.advance.commitment.next);
  await expect(n.verifier.verifyAndSpend(n.capability, n.request)).rejects.toThrow('newer');
  await n.reopen({ policyObservers: undefined }); n.frames.length = 0;
  await expect(n.verifier.verifyAndSpend(n.capability, n.request)).rejects.toThrow('observed policy'); expect(n.frames).toHaveLength(0);
  await expect(n.reopen({ policy: n.second })).rejects.toThrow('signed immediate successor');
  await n.reopen({ policy: n.second, policyAdvance: n.advance, policyObservers: undefined });
  expect((await n.verifier.verifyAndSpend(n.capability, n.request)).status).toBe('accepted');
  n.observed({ ...n.advance.commitment.next, transition: 'f'.repeat(64) });
  await expect(n.verifier.verifyAndSpend(n.capability, n.request)).rejects.toThrow('conflict');
  n.verifier.close(); await n.verifier.drainPolicyObservations();
  const store = await openAdmissionPolicyStore({ path: join(n.directory, 'admission-community-policy.json'), encryptionKey: n.encryptionKey, mode: 'open-existing' });
  try { expect(store.freshness()!.conflict!.transition).toBe('f'.repeat(64)); } finally { store.close(); }
  await expect(n.reopen({ policy: n.second, policyAdvance: n.advance })).rejects.toThrow('fenced');
});

it('requires fresh policy evidence before a witness records a vote, including its exact retry', async () => {
  const n = await fixture(true), set = n.first.keys[0].witnesses!;
  const claim = { setId: admissionWitnessSetId(set), issuerKey: n.first.activeKey, spend: randomBytes(32).toString('base64url'), action: 'search' as const, requestBinding: n.request.requestBinding };
  const request = createAdmissionWitnessRequest(claim, n.coordinators[0]), path = join(n.directory, 'admission-witness-votes.json');
  const before = readFileSync(path);
  await expect(n.verifier.witness!.vote({ ...request, signature: 'A'.repeat(86) })).rejects.toThrow('Unauthenticated'); expect(n.frames).toHaveLength(0);
  n.observed(n.advance.commitment.next);
  await expect(n.verifier.witness!.vote(request)).rejects.toThrow('newer'); expect(readFileSync(path)).toEqual(before);
  await n.reopen({ policy: n.second, policyAdvance: n.advance });
  const vote = await n.verifier.witness!.vote(request); expect(vote.spend).toBe(claim.spend);
  n.online[3] = n.online[4] = false; const retained = readFileSync(path);
  await expect(n.verifier.witness!.vote(request)).rejects.toThrow('four matching'); expect(readFileSync(path)).toEqual(retained);
});
