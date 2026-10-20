import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  createChannelMessageOperationV2, createConsentOfferV2, createDeterministicMatchId, createPairwiseChannelId,
  createMailboxRequest, createPublicationRecord, createRelationshipMailboxRequestV2,
  encryptChannelOperationV2, encryptRelationshipMessage,
  generatePublicationKeyMaterial, generateRelationshipKeyMaterial,
  verifyMailboxRequest, verifyRelationshipMailboxRequestV2,
  type MailboxRequest, type RelationshipMailboxRequestV2,
} from '@resonance/core';
import { createRelayServer } from '@resonance/relay';
import { openManagedAdmissionWallet } from '../managed-admission-wallet.js';
import { createRelayClient, type AdmissionCapabilityProviderV2, type RelayClient } from '../relay-client.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const unknownIds = (count: number) => Array.from({ length: count }, () => 'env_' + randomBytes(32).toString('base64url'));
let issuerPublicKeys: string[];
beforeAll(async () => {
  issuerPublicKeys = [];
  for (let i = 0; i < 2; i++) {
    const keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
    issuerPublicKeys.push(`-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----`);
  }
});
const variants = [ ['direct', 'publication'], ['direct', 'relationship'], ['private', 'publication'], ['private', 'relationship'] ] as const;

async function fixture(mode: 'direct' | 'private', kind: 'publication' | 'relationship') {
  const directory = mkdtempSync(join(tmpdir(), 'mailbox-ack-maintenance-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const destination = createRelayServer({ host: mode === 'private' ? '::1' : '127.0.0.1', port: 0,
    persistDir: join(directory, 'destination'), maxPublishesPerMin: 1000, maxSearchesPerMin: 1000,
    privateEntryMix: { windowMs: 10 }, privateReplyMix: { windowMs: 10 },
    relayDiscovery: { endpoints: [mode === 'private' ? 'ws://[::1]:0/' : 'ws://127.0.0.1:0/'],
      reachability: 'direct', supportedGroups: ['public'], storage: { capacityBytes: 4_000_000, availableBytes: 3_000_000 } } });
  cleanup.push(() => destination.stop({ graceful: false })); await destination.start();
  const endpoint = destination.getRelayDescriptor()!.endpoints[0]; let entryUrl: string | undefined;
  const destinationAddress = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
  if (mode === 'private') {
    const entry = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: join(directory, 'entry'),
      maxPeerRequestsPerMin: 1000, privateEntryMix: { windowMs: 10 }, privateReplyMix: { windowMs: 10 },
      relayDiscovery: { endpoints: ['ws://127.0.0.1:0/'], reachability: 'direct', supportedGroups: ['public'],
        storage: { capacityBytes: 4_000_000, availableBytes: 3_000_000 } } });
    cleanup.push(() => entry.stop({ graceful: false })); await entry.start();
    entry.observeRelayDescriptor(destination.getRelayDescriptor()!); entryUrl = entry.getRelayDescriptor()!.endpoints[0];
  }
  const client = (provider?: AdmissionCapabilityProviderV2, privateRoute = mode === 'private') => {
    const result = createRelayClient({ relayUrl: endpoint, admissionCapabilityProvider: provider,
      ...(privateRoute ? { privateEntryUrls: [entryUrl!], privateTraffic: { batchWindowMs: 10, jitterMs: 0, maxConcurrent: 1 } } : {}) });
    cleanup.push(() => result.disconnect()); return result;
  };
  const setup = client(undefined, false), recipientKeys = generatePublicationKeyMaterial(), senderKeys = generateRelationshipKeyMaterial(), relationshipKeys = generateRelationshipKeyMaterial();
  const base = { groupId: 'public', fingerprintEpoch: 'ack-maintenance', fingerprint: new Uint8Array(64).fill(0x39),
    createdAt: Date.now(), expiresAt: Date.now() + 300000 };
  const recipient = createPublicationRecord({ ...base, itemType: 'need' }, recipientKeys);
  if (kind === 'publication') await setup.submitPublicationOperation(recipient);
  let sequence = 0;
  const fetch = () => kind === 'publication' ? setup.fetchMailbox(recipient, recipientKeys) : setup.fetchRelationshipMailbox(relationshipKeys);
  const ack = (owner: RelayClient, ids: string[]) => kind === 'publication'
    ? owner.acknowledgeMailbox(recipient, recipientKeys, ids) : owner.acknowledgeRelationshipMailbox(relationshipKeys, ids);
  const request = (ids: string[], timestamp = Date.now()) => kind === 'publication'
    ? createMailboxRequest('ack', recipient, recipientKeys, ids, timestamp) : createRelationshipMailboxRequestV2('ack', relationshipKeys, ids, timestamp);
  async function seed(count: number) {
    const before = new Set((await fetch()).envelopes.map(envelope => envelope.envelopeId));
    for (let i = 0; i < count; i++) {
      if (kind === 'publication') {
        await setup.submitPublicationOperation(createPublicationRecord({ ...base, itemType: 'offer' }, generatePublicationKeyMaterial()));
      } else {
        const operation = createChannelMessageOperationV2(createPairwiseChannelId('match_' + 'a'.repeat(43), senderKeys.relationshipId, relationshipKeys.relationshipId),
          relationshipKeys.relationshipId, ++sequence, { kind: 'disclosure', text: 'retained message', level: 'general', createdAt: Date.now() }, randomBytes(32), senderKeys);
        const envelope = encryptChannelOperationV2(operation, { id: relationshipKeys.mailboxId,
          encryptionKey: Buffer.from(relationshipKeys.mailboxKeyPair.publicKey).toString('base64') });
        await setup.depositRelationshipMailboxEnvelope(relationshipKeys.relationshipId, senderKeys, envelope);
      }
    }
    const ids = (await fetch()).envelopes.map(envelope => envelope.envelopeId).filter(id => !before.has(id));
    expect(ids).toHaveLength(count); return ids;
  }
  const records = () => readFileSync(join(directory, 'destination', 'relay-operations.ndjson'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line)).filter(record => record.entry.kind === 'mailbox-ack')
    .map(record => record.entry.request as MailboxRequest | RelationshipMailboxRequestV2);
  async function deposit(owner: RelayClient) {
    if (kind === 'publication') {
      const otherKeys = generatePublicationKeyMaterial(), sender = createPublicationRecord({ ...base, itemType: 'offer' }, otherKeys);
      const offer = createConsentOfferV2(createDeterministicMatchId(sender.publicationId, recipient.publicationId), sender, recipient,
        otherKeys, generateRelationshipKeyMaterial(), Date.now(), Date.now() + 60000);
      return owner.depositMailboxEnvelope(offer.matchId, sender, recipient, otherKeys, encryptRelationshipMessage(offer, recipient));
    }
    const operation = createChannelMessageOperationV2(createPairwiseChannelId('match_' + 'a'.repeat(43), senderKeys.relationshipId, relationshipKeys.relationshipId),
      relationshipKeys.relationshipId, ++sequence, { kind: 'disclosure', text: 'provider must run', level: 'general', createdAt: Date.now() }, randomBytes(32), senderKeys);
    return owner.depositRelationshipMailboxEnvelope(relationshipKeys.relationshipId, senderKeys,
      encryptChannelOperationV2(operation, { id: relationshipKeys.mailboxId, encryptionKey: Buffer.from(relationshipKeys.mailboxKeyPair.publicKey).toString('base64') }));
  }
  function onReply(callback: () => boolean | void) {
    const send = WebSocket.prototype.send;
    return vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function(this: WebSocket, data: any, ...rest: any[]) {
      const socket = (this as WebSocket & { _socket?: { localAddress?: string; localPort?: number } })._socket;
      let frame: any; try { frame = JSON.parse(String(data)); } catch { /* Other transport payload. */ }
      if (socket?.localAddress === destinationAddress && socket.localPort === destination.getListeningPort() && frame?.type === (mode === 'private' ? 'private_response' : 'ack')) {
        if (callback() === false) { this.terminate(); return; }
      }
      return Reflect.apply(send, this, [data, ...rest]);
    });
  }
  return { client, seed, ack, fetch, request, records, deposit, onReply, endpoint, entryUrl,
    fetchWith: (owner: RelayClient) => kind === 'publication' ? owner.fetchMailbox(recipient, recipientKeys) : owner.fetchRelationshipMailbox(relationshipKeys) };
}

it.each(variants)('%s %s ACKs snapshot and batch100IDs without invoking admission or policy providers', async (mode, kind) => {
  const n = await fixture(mode, kind), calls = { provider: 0, observers: 0, current: 0 };
  const provider: AdmissionCapabilityProviderV2 = Object.assign(() => { calls.provider++; throw new Error('provider forbidden'); }, {
    policyObservers: () => { calls.observers++; throw new Error('provider forbidden'); },
    assertCurrent: () => { calls.current++; throw new Error('provider forbidden'); },
  });
  const owner = n.client(provider), single = unknownIds(100); single[0] = (await n.seed(1))[0];
  const zeroLast = await n.ack(owner, single); expect(zeroLast).toMatchObject({ status: 'ok', message: 'acknowledged:0' });
  expect(n.records()).toHaveLength(1); expect((await n.fetch()).envelopes).toEqual([]);
  const present = await n.seed(7), ids = unknownIds(100); present.forEach((id, index) => { ids[index * 16] = id; });
  const original = [...ids], pending = n.ack(owner, ids); ids[99] = 'not an envelope';
  const last = await pending, requests = n.records().slice(1);
  expect(requests.map(request => request.envelopeIds.length)).toEqual([16, 16, 16, 16, 16, 16, 4]);
  expect(requests.flatMap(request => request.envelopeIds)).toEqual(original);
  expect(requests.every(request => kind === 'publication' ? verifyMailboxRequest(request) : verifyRelationshipMailboxRequestV2(request))).toBe(true);
  expect(last).toMatchObject({ status: 'ok', ref: requests.at(-1)!.requestId, message: 'acknowledged:1' });
  expect(calls).toEqual({ provider: 0, observers: 0, current: 0 });
  expect((await n.fetch()).envelopes).toEqual([]);
  // All protocol strings have fixed bounds; maximize every journal number too.
  const worst = { version: 1, sequence: Number.MAX_SAFE_INTEGER, committedAt: Number.MAX_SAFE_INTEGER,
    entry: { kind: 'mailbox-ack', request: n.request(original.slice(0, 16), Number.MAX_SAFE_INTEGER) }, recordId: 'jrn_' + 'z'.repeat(43) };
  expect(Buffer.byteLength(JSON.stringify(worst) + '\n')).toBeLessThanOrEqual(2048);
  await expect(n.fetchWith(owner)).rejects.toThrow('provider forbidden');
  await expect(n.deposit(owner)).rejects.toThrow('provider forbidden');
  expect(calls.provider + calls.observers).toBeGreaterThanOrEqual(2);
}, 15000);

it.each(variants)('%s %s validates the entire input before any wire work', async (mode, kind) => {
  const n = await fixture(mode, kind), owner = n.client(); let sent = 0;
  const spy = vi.spyOn(WebSocket.prototype, 'send'); spy.mockImplementation(() => { sent++; });
  for (const ids of [[], [...unknownIds(99), 'invalid'], unknownIds(101)]) await expect(n.ack(owner, ids)).rejects.toThrow('Invalid mailbox acknowledgement');
  const duplicates = unknownIds(17); duplicates[16] = duplicates[0];
  await expect(n.ack(owner, duplicates)).rejects.toThrow('Invalid mailbox acknowledgement');
  expect(sent).toBe(0);
});

for (const fault of ['disconnect', 'reply-loss'] as const) it.each(variants)(`%s %s fails on middle-batch ${fault} and preserves retryable prior progress`, async (mode, kind) => {
  const n = await fixture(mode, kind), owner = n.client(), present = await n.seed(3), ids = unknownIds(48);
  present.forEach((id, index) => { ids[index * 16] = id; }); let replies = 0;
  const spy = n.onReply(() => { if (++replies === 2) { if (fault === 'disconnect') owner.disconnect(); return false; } });
  await expect(n.ack(owner, ids)).rejects.toThrow(); spy.mockRestore();
  expect(replies).toBe(2); expect(n.records()).toHaveLength(2);
  expect((await n.fetch()).envelopes.map(envelope => envelope.envelopeId)).toEqual([present[2]]);
  expect((await n.ack(owner, ids)).status).toBe('ok'); expect((await n.fetch()).envelopes).toEqual([]);
}, 15000);

it.each(variants)('%s %s charges later batches against the original monotonic deadline', async (mode, kind) => {
  const n = await fixture(mode, kind), owner = n.client(), present = await n.seed(3), ids = unknownIds(48);
  present.forEach((id, index) => { ids[index * 16] = id; });
  const now = performance.now.bind(performance); let elapsed = 0, replies = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + elapsed);
  const spy = n.onReply(() => { replies++; elapsed += 6000; });
  try { await expect(n.ack(owner, ids)).rejects.toThrow(/deadline|timeout|expired/i); }
  finally { spy.mockRestore(); clock.mockRestore(); }
  expect(replies).toBe(2); expect(n.records()).toHaveLength(2);
  expect((await n.fetch()).envelopes.map(envelope => envelope.envelopeId)).toEqual([present[2]]);
}, 15000);

for (const revoke of ['profile-change', 'close'] as const) it.each(variants)(`%s %s rechecks local destination consent at actual send after ${revoke}`, async (mode, kind) => {
  const n = await fixture(mode, kind), directory = mkdtempSync(join(tmpdir(), 'ack-local-consent-')), encryptionKey = randomBytes(32);
  cleanup.push(() => { encryptionKey.fill(0); rmSync(directory, { recursive: true, force: true }); });
  const wallet = await openManagedAdmissionWallet({ directory, encryptionKey }); cleanup.push(() => wallet.close());
  const profile = { version: 1 as const, scope: { issuer: 'ack-local-consent', community: 'public', epoch: 'one' },
    issuerPublicKey: issuerPublicKeys[0], relayUrls: [n.endpoint] };
  const provider = wallet.provider(), maintenance = vi.spyOn(provider, 'assertMaintenanceDestination');
  // An unconfigured wallet permits maintenance, then a pinned wallet with no tokens still permits it.
  expect(() => provider.assertMaintenanceDestination!(n.endpoint)).not.toThrow();
  await wallet.configure(profile);
  const owner = n.client(provider), ids = await n.seed(1);
  await expect(n.ack(owner, unknownIds(1))).resolves.toMatchObject({ status: 'ok' });
  expect(wallet.status()).toMatchObject({ available: 0, reserved: 0 }); maintenance.mockClear();
  const emit = WebSocket.prototype.emit; let release!: () => void, held = false;
  const opened = new Promise<void>(resolve => {
    vi.spyOn(WebSocket.prototype, 'emit').mockImplementation(function(this: WebSocket, event: string | symbol, ...args: any[]) {
      // Private discovery opens happen before preparation. Hold only the encrypted ACK's socket.
      if (!held && event === 'open' && this.url === (mode === 'private' ? n.entryUrl : n.endpoint)
        && (mode === 'direct' || maintenance.mock.calls.length >= 3)) {
        held = true; release = () => { Reflect.apply(emit, this, [event, ...args]); }; resolve(); return true;
      }
      return Reflect.apply(emit, this, [event, ...args]);
    });
  });
  const failed = expect(n.ack(owner, ids)).rejects.toThrow(revoke === 'close' ? /closed/ : /pinned/);
  await opened;
  if (revoke === 'close') wallet.close();
  else await wallet.configure({ ...profile, issuerPublicKey: issuerPublicKeys[1], relayUrls: ['ws://127.0.0.1:45998/'] });
  release(); await failed;
  expect(n.records()).toHaveLength(0);
  expect((await n.fetch()).envelopes.map(envelope => envelope.envelopeId)).toEqual(ids);
  // A subsequent ACK fails at preparation, before discovery, dialing or a signed request is sent.
  const sent = vi.spyOn(WebSocket.prototype, 'send');
  await expect(n.ack(owner, ids)).rejects.toThrow(revoke === 'close' ? /closed/ : /pinned/);
  expect(sent).not.toHaveBeenCalled();
}, 15000);
