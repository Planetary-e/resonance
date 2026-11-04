import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { createBlindAdmissionRequestV2, issueBlindAdmissionRequestV2, generateSigningKeyPair, createAdmissionRequestBindingV2 } from '@resonance/core';
import { signAdmissionPolicy, admissionKeyFingerprint, type AdmissionPolicyBody, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionPolicyHead, createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadVote, parseAdmissionPolicyObservers, type AdmissionPolicyHead } from '@resonance/core/admission-policy-freshness';
import { createAdmissionPolicyQuery } from '@resonance/core/admission-policy-query';
import { openManagedAdmissionWallet } from '../managed-admission-wallet.js';
import type { WalletPolicyObservation } from '../wallet-policy-freshness.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const close: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); close.splice(0).reverse().forEach(f => f()); });
let issuerPublicKey: string, tokens: string[];
const scope = { issuer: 'fresh-wallet', community: 'public', epoch: 'one' }, relayUrl = 'ws://127.0.0.1:33000/';
beforeAll(async () => {
  const keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
  const issuer = new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, scope.issuer, keys.privateKey, keys.publicKey);
  issuerPublicKey = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----`;
  tokens = [];
  for (let i = 0; i < 3; i++) { const batch = await createBlindAdmissionRequestV2(scope, keys.publicKey); tokens.push(await batch.finalize(await issueBlindAdmissionRequestV2(issuer, batch.request))); }
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wallet-fresh-')), encryptionKey = randomBytes(32), key = generateSigningKeyPair();
  close.push(() => { encryptionKey.fill(0); key.secretKey.fill(0); rmSync(directory, { recursive: true, force: true }); });
  let now = Date.now();
  const authority = Buffer.from(key.publicKey).toString('base64url'), keys = Array.from({ length: 5 }, generateSigningKeyPair);
  close.push(() => keys.forEach(k => k.secretKey.fill(0)));
  const body: AdmissionPolicyBody = { version: 1, kind: 'admission-policy', revision: 1, issuedAt: now - 1000, expiresAt: now + 300000,
    activeKey: admissionKeyFingerprint(issuerPublicKey), keys: [{ profile: { version: 1, scope, issuerPublicKey, relayUrls: [relayUrl] },
      notBefore: now - 1000, issueUntil: now + 100000, spendUntil: now + 200000, retryUntil: now + 250000 }] };
  const first = await signAdmissionPolicy(body, authority, key.secretKey);
  const context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority, genesis: admissionPolicyHead(first), quorum: 4,
    members: keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${33001 + i}/` })) });
  const options = { directory, encryptionKey, now: () => now };
  let wallet = await openManagedAdmissionWallet(options); close.push(() => wallet.close());
  await wallet.installPolicy(first, authority, context); await wallet.importTokens(tokens);
  const request = { relayUrl, action: 'search' as const, requestBinding: createAdmissionRequestBindingV2('search', { example: 'one' }) };
  const observation = (head = context.genesis): WalletPolicyObservation => {
    const query = createAdmissionPolicyQuery(context, now);
    return { query, reply: { version: 1, type: 'admission_policy_query_reply', certificate: { version: 1, kind: 'admission-policy-head-certificate',
      votes: keys.slice(0, 4).map(key => createAdmissionPolicyHeadVote(query.request, head, context, key, now)) } } };
  };
  return { directory, first, context, authority, request, observation, get wallet() { return wallet; },
    async restart() { wallet.close(); wallet = await openManagedAdmissionWallet(options); },
    async advance(previous = first, retained: AdmissionPolicyHead = context.genesis, changes: Partial<AdmissionPolicyBody> = {}) {
      const next = await signAdmissionPolicy({ ...body, revision: previous.revision + 1, ...changes }, authority, key.secretKey);
      return createAdmissionPolicyAdvance(previous, next, context, key, retained);
    }, setNow(value: number) { now = value; }, get now() { return now; } };
}

it('requires fresh observations for both new reservations and exact retries across restart', async () => {
  const n = await fixture();
  expect(() => n.wallet.capabilityFor(n.request)).toThrow('fresh private policy observation');
  const proof = n.observation(), first = n.wallet.capabilityFor({ ...n.request, policyObservation: proof });
  expect(n.wallet.status()).toMatchObject({ available: 2, reserved: 1, freshness: { required: true } });
  n.setNow(proof.query.request.expiresAt);
  expect(() => n.wallet.capabilityFor({ ...n.request, policyObservation: proof })).toThrow('expired');
  await n.restart(); expect(() => n.wallet.capabilityFor(n.request)).toThrow('fresh private');
  expect(n.wallet.capabilityFor({ ...n.request, policyObservation: n.observation() })).toEqual(first);
  expect(n.wallet.status().reserved).toBe(1);
  expect(readFileSync(join(n.directory, 'admission-profile.json'), 'utf8')).not.toContain(n.authority);
});

it('retains a newer observed floor before refusing a reservation and requires the exact signed transition', async () => {
  const n = await fixture(), advance = await n.advance();
  expect(() => n.wallet.capabilityFor({ ...n.request, policyObservation: n.observation(advance.commitment.next) })).toThrow('newer community policy');
  expect(n.wallet.status()).toMatchObject({ available: 3, reserved: 0, freshness: { installedRevision: 1, observedRevision: 2 } });
  await n.restart();
  expect(() => n.wallet.capabilityFor({ ...n.request, policyObservation: n.observation() })).toThrow('older than');
  await expect(n.wallet.installPolicy(advance.policy, n.authority)).rejects.toThrow('signed immediate successor');
  await n.wallet.installPolicy(advance, n.authority);
  await n.wallet.installPolicy(advance, n.authority); // Lost local API response: exact reimport is safe.
  n.wallet.capabilityFor({ ...n.request, policyObservation: n.observation(advance.commitment.next) });
  expect(n.wallet.status().reserved).toBe(1);
  await expect(n.wallet.installPolicy(n.first, n.authority)).rejects.toThrow();
  await n.restart(); expect(n.wallet.provider().policyObservers!()).toEqual(n.context);
});

it('cannot replace observer pins or erase them with a plain policy reimport', async () => {
  const n = await fixture();
  await n.wallet.installPolicy(n.first, n.authority);
  expect(n.wallet.status().freshness?.required).toBe(true);
  const changed = structuredClone(n.context); changed.members[0].endpoint = 'ws://127.0.0.1:39999/';
  await expect(n.wallet.installPolicy(n.first, n.authority, changed)).rejects.toThrow('already pinned');
  const other = structuredClone(n.context); other.genesis.digest = 'a'.repeat(64); other.genesis.transition = other.genesis.digest;
  await expect(n.wallet.installPolicy(n.first, n.authority, other)).rejects.toThrow();
  const pins = n.wallet.provider().policyObservers!()!; pins.members[0].endpoint = 'ws://127.0.0.1:39998/';
  expect(n.wallet.provider().policyObservers!()).toEqual(n.context);
});

it('replays an expired intermediate only toward an already observed later head and never authorizes its keys', async () => {
  const n = await fixture(), intermediate = await n.advance(n.first, n.context.genesis, { expiresAt: n.now + 1000 });
  const current = await n.advance(intermediate.policy, intermediate.commitment.next);
  n.setNow(n.now + 2000);
  await expect(n.wallet.installPolicy(intermediate, n.authority)).rejects.toThrow('not current');
  expect(() => n.wallet.capabilityFor({ ...n.request, policyObservation: n.observation(current.commitment.next) })).toThrow('newer community policy');
  await n.wallet.installPolicy(intermediate, n.authority); await n.restart();
  await expect(n.wallet.requestTokens(1)).rejects.toThrow('not current');
  expect(() => n.wallet.capabilityFor({ ...n.request, policyObservation: n.observation(intermediate.commitment.next) })).toThrow('older than');
  expect(n.wallet.status().reserved).toBe(0);
  await n.wallet.installPolicy(current, n.authority);
  n.wallet.capabilityFor({ ...n.request, policyObservation: n.observation(current.commitment.next) });
  expect(n.wallet.status().reserved).toBe(1);
});

it('retains a same-revision conflicting quorum and fences spending and updates after restart', async () => {
  const n = await fixture(), advance = await n.advance(); await n.wallet.installPolicy(advance, n.authority);
  const fork = await n.advance(n.first, n.context.genesis, { expiresAt: n.first.expiresAt + 1 });
  expect(() => n.wallet.capabilityFor({ ...n.request, policyObservation: n.observation(fork.commitment.next) })).toThrow('conflict');
  await n.restart(); expect(n.wallet.status().freshness?.conflicted).toBe(true);
  expect(() => n.wallet.capabilityFor({ ...n.request, policyObservation: n.observation(advance.commitment.next) })).toThrow('fenced');
  await expect(n.wallet.installPolicy(advance.policy, n.authority)).rejects.toThrow('fenced');
  expect(n.wallet.status().reserved).toBe(0);
});

it('rejects a repeated observer, a different challenge and a different transition before reservation', async () => {
  const n = await fixture(), proof = n.observation();
  const repeated = structuredClone(proof); repeated.reply.certificate.votes[3] = repeated.reply.certificate.votes[0];
  expect(() => n.wallet.capabilityFor({ ...n.request, policyObservation: repeated })).toThrow('repeat');
  expect(() => n.wallet.capabilityFor({ ...n.request, policyObservation: { ...proof, query: n.observation().query } })).toThrow('this request');
  const altered = structuredClone(proof); altered.reply.certificate.votes[0].head.transition = 'b'.repeat(64);
  expect(() => n.wallet.capabilityFor({ ...n.request, policyObservation: altered })).toThrow();
  expect(n.wallet.status().reserved).toBe(0);
});

it('does not reserve when retaining a newer floor fails and refuses further work in that process', async () => {
  const n = await fixture(), advance = await n.advance();
  vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('disk unavailable'); });
  expect(() => n.wallet.capabilityFor({ ...n.request, policyObservation: n.observation(advance.commitment.next) })).toThrow('disk unavailable');
  expect(() => n.wallet.capabilityFor({ ...n.request, policyObservation: n.observation() })).toThrow('write failed');
  await n.restart(); expect(n.wallet.status()).toMatchObject({ reserved: 0, available: 3 });
});

it('rechecks a policy update and closed wallet through the provider without allocating another token', async () => {
  const n = await fixture(), provider = n.wallet.provider(), context = { ...n.request, policyObservation: n.observation() };
  provider(context); provider.assertCurrent!(context);
  await n.wallet.installPolicy(await n.advance(), n.authority);
  expect(() => provider.assertCurrent!(context)).toThrow('older than');
  expect(n.wallet.status().reserved).toBe(1);
  n.wallet.close(); expect(() => provider.assertCurrent!(context)).toThrow('closed');
});

it('permits prepaid maintenance for active pins after policy expiry and token exhaustion without changing wallet state', async () => {
  const n = await fixture(), provider = n.wallet.provider();
  for (let i = 0; i < 3; i++) n.wallet.capabilityFor({ ...n.request,
    requestBinding: createAdmissionRequestBindingV2('search', { request: i }), policyObservation: n.observation() });
  expect(n.wallet.status()).toMatchObject({ available: 0, reserved: 3 });
  n.setNow(n.first.expiresAt + 1);
  const paths = ['admission-profile.json', 'admission-wallet.json'].map(file => join(n.directory, file));
  const before = paths.map(path => readFileSync(path));
  expect(() => provider.assertMaintenanceDestination!(relayUrl.slice(0, -1))).not.toThrow();
  expect(() => provider.assertMaintenanceDestination!('ws://127.0.0.1:33099/')).toThrow('pinned');
  expect(paths.map(path => readFileSync(path))).toEqual(before);
  expect(() => provider({ ...n.request, policyObservation: n.observation() })).toThrow('not current');
  n.wallet.close(); expect(() => provider.assertMaintenanceDestination!(relayUrl)).toThrow('closed');
});
