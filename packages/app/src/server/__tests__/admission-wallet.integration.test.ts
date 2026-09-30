import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { EmbeddingEngine, generateSigningKeyPair, createBlindAdmissionRequestV2, issueBlindAdmissionRequestV2 } from '@resonance/core';
import { createRelayServer, createConfiguredAdmissionVerifier, type RelayServer } from '@resonance/relay';
import { signAdmissionPolicy, admissionKeyFingerprint, type SignedAdmissionPolicy, type AdmissionWalletProfileV1 } from '@resonance/core/admission-policy';
import { issueAdmissionBatch, openAdmissionIssuerLedger } from '@resonance/node';
import { createAppServer, type AppServer } from '../server.js';
import { getSession, lockSession } from '../session.js';

const directory = mkdtempSync(join(tmpdir(), 'desktop-admission-'));
const port = 50_100 + Math.floor(Math.random() * 400);
const entryUrl = `ws://127.0.0.1:${port}/`; const destinationUrl = `ws://[::1]:${port + 1}/`;
const scope = { issuer: 'desktop-test-community', community: 'public', epoch: '2026-09' };
const authorityKeys = generateSigningKeyPair(); const authority = Buffer.from(authorityKeys.publicKey).toString('base64url');
let policy: SignedAdmissionPolicy;
let app: AppServer; let base: string; let auth = ''; let profile: AdmissionWalletProfileV1;
let issuerKeys: CryptoKeyPair;
let verifier: Awaited<ReturnType<typeof createConfiguredAdmissionVerifier>>;
const relays: RelayServer[] = []; const tokens: string[] = [];
let publicationHold: string; let searchHold: string;
async function request(path: string, body?: unknown, authenticated = true, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json',
    ...(authenticated ? { authorization: `Bearer ${auth}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function restart() {
  await request('/api/lock', {});
  const unlocked = await request('/api/unlock', { password: 'desktop-wallet-test-password' });
  expect(unlocked.status).toBe(200); auth = unlocked.body.token;
}
beforeAll(async () => {
  vi.stubEnv('RESONANCE_DATA_DIR', join(directory, 'personal'));
  vi.stubEnv('RESONANCE_EXPERIMENTAL_PRIVATE_ROUTE_URLS', `${entryUrl},${destinationUrl}`);
  vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
  vi.spyOn(EmbeddingEngine.prototype, 'embedForMatching').mockResolvedValue(new Float32Array(768).fill(1 / Math.sqrt(768)));
  const keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
  issuerKeys = keys;
  const issuer = new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, scope.issuer, keys.privateKey, keys.publicKey);
  const der = Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64');
  profile = { version: 1, scope, issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${der}\n-----END PUBLIC KEY-----`, relayUrls: [destinationUrl] };
  for (let i = 0; i < 8; i++) {
    const blinded = await createBlindAdmissionRequestV2(scope, keys.publicKey);
    tokens.push(await blinded.finalize(await issueBlindAdmissionRequestV2(issuer, blinded.request)));
  }
  const now = Date.now();
  policy = await signAdmissionPolicy({ version: 1, kind: 'admission-policy', revision: 1, issuedAt: now - 1000, expiresAt: now + 86400000,
    activeKey: admissionKeyFingerprint(profile.issuerPublicKey), keys: [{ profile, notBefore: now - 1000, issueUntil: now + 3600000, spendUntil: now + 7200000, retryUntil: now + 10800000 }] }, authority, authorityKeys.secretKey);
  verifier = await createConfiguredAdmissionVerifier({ directory: join(directory, 'destination'), authority, policy, encryptionKey: randomBytes(32), initialize: true });
  for (const [index, host, endpoint] of [[0, '127.0.0.1', entryUrl], [1, '::1', destinationUrl]] as const) {
    const relay = createRelayServer({ port: port + index, host, persistDir: join(directory, index ? 'destination' : 'entry'),
      admissionVerifier: index ? verifier : undefined,
      relayDiscovery: { endpoints: [endpoint], reachability: 'direct', supportedGroups: ['public'],
        storage: { capacityBytes: 1_000_000, availableBytes: 900_000 }, maxKnownRelays: 8 } });
    relays.push(relay); await relay.start();
  }
  relays[0].observeRelayDescriptor(relays[1].getRelayDescriptor()!);
  app = createAppServer({ port: 0, relayUrl: destinationUrl }); base = `http://127.0.0.1:${await app.start()}`;
  expect((await request('/api/init', { password: 'desktop-wallet-test-password' })).status).toBe(200);
  await restart();
}, 15_000);
afterAll(async () => {
  lockSession(); if (app) await app.stop();
  for (const relay of relays.reverse()) await relay.stop();
  verifier?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});

it('authenticates setup and imports without network activity or spending on held requests', async () => {
  expect((await request('/api/admission-wallet', undefined, false)).status).toBe(401);
  expect((await request('/api/admission-wallet/configure', profile, false)).status).toBe(401);
  expect((await request('/api/admission-wallet/import', { tokens }, false)).status).toBe(401);
  const wire = vi.spyOn(WebSocket.prototype, 'send');
  try {
    expect((await request('/api/admission-wallet/configure', profile)).status).toBe(200);
    expect((await request('/api/status')).body.automaticMailboxes).toBe(false);
    expect((await request('/api/admission-wallet/import', { tokens: tokens.slice(0, 6) })).body.imported).toBe(6);
    expect((await request('/api/admission-wallet/import', { tokens: tokens.slice(0, 6) })).body.imported).toBe(0);
    const saved = await request('/api/items', { text: 'I offer patient gardening lessons.', type: 'offer', delivery: 'hold' });
    expect(saved.status).toBe(200);
    publicationHold = (await request('/api/items')).body[0].delivery.id;
    searchHold = (await request('/api/search', { text: 'I need gardening lessons.', type: 'need', delivery: 'hold' })).body.saved;
    await restart(); await request('/api/matches'); await request('/api/channels');
    expect(wire).not.toHaveBeenCalled();
    const status = (await request('/api/admission-wallet')).body;
    expect(status).toMatchObject({ configured: true, available: 6, reserved: 0 });
    expect(JSON.stringify(status)).not.toContain(tokens[0]);
    for (const name of ['admission-wallet.json', 'admission-profile.json']) {
      const raw = readFileSync(join(directory, 'personal', name), 'utf8');
      expect(raw).not.toContain(tokens[0]); expect(raw).not.toContain(scope.issuer);
    }
  } finally { wire.mockRestore(); }
});

it('retains a reserved token after the destination accepts a held publication but its reply is lost', async () => {
  const originalSend = WebSocket.prototype.send;
  const wire = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data, ...args) {
    const localPort = (this as unknown as { _socket?: { localPort: number } })._socket?.localPort;
    if (localPort === port && typeof data === 'string' && JSON.parse(data).type === 'private_response') return;
    return Reflect.apply(originalSend, this, [data, ...args]);
  });
  try {
    expect((await request(`/api/outbox/${publicationHold}/release`, {})).status).toBe(503);
    expect(relays[1].getStats().stored_publications).toBe(1);
    expect((await request('/api/items')).body[0].delivery.state).toBe('outcome-unknown');
    expect((await request('/api/admission-wallet')).body).toMatchObject({ available: 5, reserved: 1 });
    const entries = wire.mock.calls.filter(([data]) => typeof data === 'string' && JSON.parse(data).stage === 'entry');
    expect(entries).toHaveLength(1);
    for (const [raw] of entries) {
      expect(String(raw)).not.toContain(getSession()!.identity.did);
      tokens.forEach(token => expect(String(raw)).not.toContain(token));
    }
  } finally { wire.mockRestore(); }
  await restart();
  expect((await request(`/api/outbox/${publicationHold}/release`, {})).status).toBe(200);
  expect((await request('/api/admission-wallet')).body).toMatchObject({ available: 5, reserved: 1 });
  expect(relays[1].getStats().stored_publications).toBe(1);
}, 18_000);

it('uses admission for saved and immediate searches, mailbox checks, publication and withdrawal, then refuses exhaustion', async () => {
  const search = await request(`/api/private-requests/${searchHold}/release`, {});
  expect(search.status).toBe(200); expect(search.body.result.results).toHaveLength(1);
  const publication = getSession()!.store.listPublications()[0];
  const held = await request('/api/private-requests/hold-mailbox', { kind: 'publication-mailbox', id: publication.publicationId });
  expect((await request(`/api/private-requests/${held.body.saved}/release`, {})).status).toBe(200);
  expect((await request('/api/search', { text: 'Gardening lessons', type: 'need' })).status).toBe(200);
  const published = await request('/api/items', { text: 'I offer another gardening lesson.', type: 'offer' });
  expect(published.status).toBe(200);
  expect((await request(`/api/items/${published.body.id}`, undefined, true, 'DELETE')).status).toBe(200);
  expect((await request('/api/admission-wallet')).body).toMatchObject({ available: 0, reserved: 6 });
  expect((await request('/api/search', { text: 'No tokens remain', type: 'need' })).status).toBe(503);
  const unfunded = await request('/api/search', { text: 'Save without a token', type: 'need', delivery: 'hold' });
  expect(unfunded.status).toBe(200);
  expect((await request(`/api/private-requests/${unfunded.body.saved}/release`, {})).status).toBe(503);
  expect((await request('/api/private-requests')).body.requests.find((entry: { id: string }) => entry.id === unfunded.body.saved))
    .toMatchObject({ state: 'held', mayHaveBeenSent: false });
  expect((await request('/api/admission-wallet')).body).toMatchObject({ available: 0, reserved: 6 });
}, 20_000);

it('never downgrades to direct token delivery when private routing is removed, while pinned held routes remain usable', async () => {
  expect((await request('/api/admission-wallet/import', { tokens: tokens.slice(6) })).body.imported).toBe(2);
  const held = await request('/api/search', { text: 'A pinned private search', type: 'need', delivery: 'hold' });
  vi.stubEnv('RESONANCE_EXPERIMENTAL_PRIVATE_ROUTE_URLS', undefined); await restart();
  expect((await request('/api/search', { text: 'Must not spend directly', type: 'need' })).status).toBe(503);
  expect((await request('/api/admission-wallet')).body.available).toBe(2);
  expect((await request(`/api/private-requests/${held.body.saved}/release`, {})).status).toBe(200);
  expect((await request('/api/admission-wallet')).body).toMatchObject({ available: 1, reserved: 7 });
}, 10_000);

it('prepares blinded requests without relay traffic and redeems newly issued tokens through the desktop private route', async () => {
  vi.stubEnv('RESONANCE_EXPERIMENTAL_PRIVATE_ROUTE_URLS', `${entryUrl},${destinationUrl}`); await restart();
  for (const path of ['request', 'complete', 'cancel']) {
    expect((await request(`/api/admission-wallet/${path}`, { count: 2 }, false)).status).toBe(401);
  }
  const wire = vi.spyOn(WebSocket.prototype, 'send');
  try {
    expect((await request('/api/admission-wallet/request', { count: 33 })).status).toBe(409);
    const prepared = await request('/api/admission-wallet/request', { count: 2 }); expect(prepared.status).toBe(200);
    const blinded = prepared.body.request;
    expect(JSON.stringify(blinded)).not.toContain(getSession()!.identity.did);
    const issuer = await openAdmissionIssuerLedger({ path: join(directory, 'issuer-ledger.json'), expectedProfile: profile,
      privateKey: issuerKeys.privateKey, create: { batchSize: 2, maxPermits: 1 } });
    let response;
    try {
      await issuer.installPolicy(policy, authority);
      const permit = issuer.grant(); response = await issuer.approve(permit, blinded);
      expect(JSON.stringify(response)).not.toContain(permit.secret);
      expect(issuer.status()).toMatchObject({ remainingPermits: 0, boundTokens: 2 });
    } finally { issuer.close(); }
    expect((await request('/api/admission-wallet/complete', { ...response, batchId: 'wrong' })).status).toBe(409);
    expect((await request('/api/admission-wallet/complete', response)).body.imported).toBe(2);
    expect((await request('/api/admission-wallet/complete', response)).status).toBe(409);
    expect((await request('/api/admission-wallet')).body).toMatchObject({ available: 3, reserved: 7 });
    expect((await request('/api/status')).body.automaticMailboxes).toBe(false);
    expect(wire).not.toHaveBeenCalled();
  } finally { wire.mockRestore(); }
  expect((await request('/api/search', { text: 'A search using a replenished wallet', type: 'need' })).status).toBe(200);
  expect((await request('/api/admission-wallet')).body).toMatchObject({ available: 2, reserved: 8 });
  const abandoned = (await request('/api/admission-wallet/request', { count: 1 })).body.request;
  const lateResponse = await issueAdmissionBatch({ request: abandoned, expectedProfile: profile, privateKey: issuerKeys.privateKey });
  await restart();
  expect((await request('/api/admission-wallet')).body.pendingIssuance).toBeUndefined();
  expect((await request('/api/admission-wallet/complete', lateResponse)).status).toBe(409);
  expect((await request('/api/admission-wallet')).body.available).toBe(2);
  await request('/api/admission-wallet/request', { count: 1 });
  expect((await request('/api/admission-wallet/cancel', {})).status).toBe(200);
  expect((await request('/api/admission-wallet')).body.pendingIssuance).toBeUndefined();
}, 12_000);

it('authenticates signed setup, retains policy through unlock, and refuses manual changes, rollback and retired fresh operations', async () => {
  expect((await request('/api/admission-wallet/policy', { policy, authority }, false)).status).toBe(401);
  expect((await request('/api/admission-wallet/policy', { policy: { ...policy, revision: 9 }, authority })).status).toBe(409);
  expect((await request('/api/admission-wallet/policy', { policy, authority })).status).toBe(200);
  await restart();
  expect((await request('/api/admission-wallet')).body.policy.revision).toBe(1);
  expect((await request('/api/admission-wallet/configure', profile)).status).toBe(409);
  expect((await request('/api/search', { text: 'Signed community policy search', type: 'need' })).status).toBe(200);
  const { signature: _, authority: __, ...body } = policy;
  const now = Date.now();
  const retired = await signAdmissionPolicy({ ...body, revision: 2, keys: [{ ...body.keys[0], issueUntil: now - 500, spendUntil: now - 100 }] }, authority, authorityKeys.secretKey);
  expect((await request('/api/admission-wallet/policy', { policy: retired, authority })).status).toBe(200);
  expect((await request('/api/search', { text: 'Retired tokens must not be used', type: 'need' })).status).toBe(503);
  expect((await request('/api/admission-wallet/policy', { policy, authority })).status).toBe(409);
  expect((await request('/api/admission-wallet')).body.policy.revision).toBe(2);
}, 12000);
