import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicVerif } from '@cloudflare/privacypass-ts';
import WebSocket from 'ws';
import { createBlindAdmissionRequestV2, issueBlindAdmissionRequestV2, generateSigningKeyPair, createPublicationRecord, generatePublicationKeyMaterial } from '@resonance/core';
import { createLocalBlindAdmissionVerifierV2, createRelayServer } from '@resonance/relay';
import { admissionKeyFingerprint, signAdmissionPolicy, type AdmissionPolicyBody } from '@resonance/core/admission-policy';
import { admissionPolicyHead, createAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadVote, parseAdmissionPolicyObservers, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { parseAdmissionPolicyQuery, type AdmissionPolicyQuery, type AdmissionPolicyQueryReply } from '@resonance/core/admission-policy-query';
import { openManagedAdmissionWallet } from '../managed-admission-wallet.js';
import { createRelayClient } from '../relay-client.js';
import { openPublicationOutbox } from '../publication-outbox.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of cleanup.splice(0).reverse()) await f(); });
const scope = { issuer: 'private-wallet-policy', community: 'public', epoch: 'one' };
let keys: CryptoKeyPair, issuerPublicKey: string, tokens: string[];
beforeAll(async () => {
  keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
  issuerPublicKey = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----`;
  const issuer = new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, scope.issuer, keys.privateKey, keys.publicKey); tokens = [];
  for (let i = 0; i < 6; i++) { const request = await createBlindAdmissionRequestV2(scope, keys.publicKey); tokens.push(await request.finalize(await issueBlindAdmissionRequestV2(issuer, request.request))); }
});
async function fixture(entryDescriptorLifetimeMs = 60 * 60_000) {
  const directory = mkdtempSync(join(tmpdir(), 'private-wallet-policy-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const authorityKey = generateSigningKeyPair(), observers = Array.from({ length: 5 }, generateSigningKeyPair);
  cleanup.push(() => { authorityKey.secretKey.fill(0); observers.forEach(k => k.secretKey.fill(0)); });
  const authority = Buffer.from(authorityKey.publicKey).toString('base64url');
  const verifier = createLocalBlindAdmissionVerifierV2({ directory: join(directory, 'spent'), issuerPublicKey: keys.publicKey, scope }); cleanup.push(() => verifier.close());
  const verify = vi.spyOn(verifier, 'verifyAndSpend');
  let context: AdmissionPolicyObservers, observed: ReturnType<typeof admissionPolicyHead>;
  let gate: ((signal: AbortSignal) => Promise<void>) | undefined;
  let reply: AdmissionPolicyQueryReply | undefined, replay = false;
  const queries: AdmissionPolicyQuery[] = [];
  const discovery = { reachability: 'direct' as const, supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 } };
  const entry = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: join(directory, 'entry'),
    relayDiscovery: { ...discovery, descriptorLifetimeMs: entryDescriptorLifetimeMs, endpoints: ['ws://127.0.0.1:0/'] } });
  const destination = createRelayServer({ host: '::1', port: 0, persistDir: join(directory, 'destination'), admissionVerifier: verifier,
    relayDiscovery: { ...discovery, endpoints: ['ws://[::1]:0/'] },
    // Controlled signed observer fixture. Protected-history quorum behavior has
    // a separate real 25-store integration test in the app server project.
    policyQuery: async (value, signal) => {
      const query = parseAdmissionPolicyQuery(value, context, Date.now()); queries.push(query); await gate?.(signal);
      if (replay) return reply!;
      reply = { version: 1, type: 'admission_policy_query_reply', certificate: { version: 1, kind: 'admission-policy-head-certificate',
        votes: observers.slice(0, 4).map(key => createAdmissionPolicyHeadVote(query.request, observed, context, key)) } }; return reply;
    } });
  await entry.start(); cleanup.push(() => entry.stop({ graceful: false }));
  await destination.start(); cleanup.push(() => destination.stop({ graceful: false }));
  expect(entry.observeRelayDescriptor(destination.getRelayDescriptor()!)).toBe('accepted');
  const route = { relayUrl: `ws://[::1]:${destination.getListeningPort()}/`, fallbackUrls: [], privateEntryUrls: [`ws://127.0.0.1:${entry.getListeningPort()}/`] };
  const now = Date.now(), body: AdmissionPolicyBody = { version: 1, kind: 'admission-policy', revision: 1, issuedAt: now - 1000, expiresAt: now + 300000,
    activeKey: admissionKeyFingerprint(issuerPublicKey), keys: [{ profile: { version: 1, scope, issuerPublicKey, relayUrls: [route.relayUrl] },
      notBefore: now - 1000, issueUntil: now + 100000, spendUntil: now + 200000, retryUntil: now + 250000 }] };
  const policy = await signAdmissionPolicy(body, authority, authorityKey.secretKey);
  context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority, genesis: admissionPolicyHead(policy), quorum: 4,
    members: observers.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${33000 + i}/` })) });
  observed = context.genesis;
  const walletOptions = { directory: join(directory, 'wallet'), encryptionKey: randomBytes(32) };
  let wallet = await openManagedAdmissionWallet(walletOptions); cleanup.push(() => { wallet.close(); walletOptions.encryptionKey.fill(0); });
  await wallet.installPolicy(policy, authority, context); await wallet.importTokens(tokens);
  function client() { const c = createRelayClient({ ...route, privateTraffic: { batchWindowMs: 10, jitterMs: 0 }, admissionCapabilityProvider: wallet.provider() }); cleanup.push(() => c.disconnect()); return c; }
  const record = (lifetime = 100000) => createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: new Uint8Array(64).fill(0xd6), itemType: 'offer', createdAt: Date.now(), expiresAt: Date.now() + lifetime }, generatePublicationKeyMaterial());
  return { directory, route, queries, verify, destination, context, authority, client, record, get wallet() { return wallet; },
    setGate(value?: typeof gate) { gate = value; }, setReplay() { replay = true; },
    async restart() { wallet.close(); wallet = await openManagedAdmissionWallet(walletOptions); },
    async advance() { const next = await signAdmissionPolicy({ ...body, revision: 2 }, authority, authorityKey.secretKey);
      const advance = await createAdmissionPolicyAdvance(policy, next, context, authorityKey); observed = advance.commitment.next; return advance; },
  };
}

it('holds without policy traffic, then queries privately before a real blind-token publication and rejects certificate replay', async () => {
  const n = await fixture(), outbox = openPublicationOutbox({ path: join(n.directory, 'outbox.json'), encryptionKey: randomBytes(32), admissionCapabilityProvider: n.wallet.provider() });
  cleanup.push(() => outbox.close());
  const held = outbox.hold(n.record(), n.route);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(n.queries).toHaveLength(0); expect(n.wallet.status().reserved).toBe(0);
  expect((await outbox.release(held.id)).status).toBe('ok');
  expect(n.queries).toHaveLength(1); expect(n.verify).toHaveBeenCalledTimes(1); expect(n.wallet.status().reserved).toBe(1);
  const second = outbox.hold(n.record(), n.route); n.setReplay();
  await expect(outbox.release(second.id)).rejects.toMatchObject({ outcome: 'not-sent' });
  expect(outbox.read(second.id).delivery).toMatchObject({ state: 'held', mayHaveBeenSent: false });
  expect(n.queries[0].request.challenge).not.toBe(n.queries[1].request.challenge);
  expect(n.wallet.status().reserved).toBe(1); expect(n.verify).toHaveBeenCalledTimes(1);
}, 30000);

it('learns a newer policy without spending, preserves it after restart and resumes only after the signed successor', async () => {
  const n = await fixture(), advance = await n.advance(), client = n.client(), record = n.record();
  await expect(client.submitPublicationOperation(record)).rejects.toMatchObject({ outcome: 'not-sent' });
  expect(n.wallet.status()).toMatchObject({ reserved: 0, freshness: { observedRevision: 2, installedRevision: 1 } });
  expect(n.verify).not.toHaveBeenCalled(); client.disconnect(); await n.restart();
  await n.wallet.installPolicy(advance, n.authority);
  expect((await n.client().submitPublicationOperation(record)).status).toBe('ok');
  expect(n.wallet.status().reserved).toBe(1); expect(n.verify).toHaveBeenCalledTimes(1);
}, 30000);

it('cancels an in-flight metadata query without reserving a token or reporting an unknown publication outcome', async () => {
  const n = await fixture(), client = n.client(); let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  n.setGate(signal => new Promise((_, reject) => { entered(); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }));
  const publication = client.submitPublicationOperation(n.record());
  const rejected = expect(publication).rejects.toMatchObject({ outcome: 'not-sent', code: 'PRIVATE_OPERATION_CANCELLED' });
  await started; client.disconnect(); await rejected;
  expect(n.wallet.status().reserved).toBe(0); expect(n.verify).not.toHaveBeenCalled();
}, 15000);

it('checks the installed pins on direct calls and cannot bypass private freshness through the direct client', async () => {
  const n = await fixture(), client = createRelayClient({ relayUrl: n.route.relayUrl, admissionCapabilityProvider: n.wallet.provider() }); cleanup.push(() => client.disconnect());
  await expect(client.submitPublicationOperation(n.record())).rejects.toThrow('fresh private policy observation');
  expect(n.queries).toHaveLength(0); expect(n.wallet.status().reserved).toBe(0); expect(n.verify).not.toHaveBeenCalled();
});

it('discovers one route per admitted operation while retaining separate policy queries and credentials', async () => {
  const n = await fixture(), client = n.client(), discoveries: unknown[] = [];
  const send = WebSocket.prototype.send;
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data, ...args: any[]) {
    if (typeof data === 'string') {
      try { const frame = JSON.parse(data); if (frame.type === 'private_discovery_request') discoveries.push(frame); } catch { /* Capture only JSON frames. */ }
    }
    return Reflect.apply(send, this, [data, ...args]);
  } as typeof send);
  expect((await client.submitPublicationOperation(n.record())).status).toBe('ok');
  expect(discoveries).toHaveLength(1); expect(n.queries).toHaveLength(1); expect(n.wallet.status().reserved).toBe(1);
  expect((await client.submitPublicationOperation(n.record())).status).toBe('ok');
  expect(discoveries).toHaveLength(2); expect(n.queries).toHaveLength(2); expect(n.wallet.status().reserved).toBe(2);
  expect(n.queries[0].request.challenge).not.toBe(n.queries[1].request.challenge);
});

it('refuses an operation route that expires during its policy query before reserving a credential', async () => {
  const n = await fixture(1000);
  n.setGate(signal => new Promise<void>((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(done, 1100);
    const cancel = () => { clearTimeout(timer); reject(new Error('cancelled')); };
    signal.addEventListener('abort', cancel, { once: true });
  }));
  await expect(n.client().submitPublicationOperation(n.record())).rejects.toThrow('independent');
  expect(n.queries).toHaveLength(1); expect(n.verify).not.toHaveBeenCalled(); expect(n.wallet.status().reserved).toBe(0);
});

it('does not reserve a token when the publication expires while its policy query is in flight', async () => {
  const n = await fixture();
  await expect(n.client().submitPublicationOperation(n.record(500))).rejects.toMatchObject({ outcome: 'not-sent' });
  expect(n.queries).toHaveLength(1); expect(n.wallet.status().reserved).toBe(0); expect(n.verify).not.toHaveBeenCalled();
});

it('keeps the original ten-second deadline while a policy responder stays silent', async () => {
  const n = await fixture();
  n.setGate(signal => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }));
  const start = performance.now();
  await expect(n.client().submitPublicationOperation(n.record())).rejects.toMatchObject({ outcome: 'not-sent', code: 'PRIVATE_OPERATION_TIMEOUT' });
  expect(performance.now() - start).toBeLessThan(13000); expect(n.queries).toHaveLength(1);
  expect(n.wallet.status().reserved).toBe(0); expect(n.verify).not.toHaveBeenCalled();
}, 20000);
