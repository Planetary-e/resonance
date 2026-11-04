import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  createChannelMessageOperationV2, createPairwiseChannelId, createConsentOfferV2, createDeterministicMatchId,
  createMailboxRequest, createMailboxRequestFrame, createMailboxDepositRequest, createMailboxDepositFrame,
  createPublicationOperationFrame, createPublicationRecord,
  createRelationshipMailboxDepositFrameV2, createRelationshipMailboxDepositV2,
  createRelationshipMailboxRequestFrameV2, createRelationshipMailboxRequestV2,
  createPrivateRequestV1, createRelayContactHintV1, createRelayDescriptorV1,
  decodeUTF8, encodeUTF8, encryptChannelOperationV2, encryptRelationshipMessage,
  generateIdentity, generatePublicationKeyMaterial, generateRelationshipKeyMaterial,
  openPrivateResponseV1, parseMessage, parsePrivateResponseV1,
  serializeMailboxDepositFrame, serializeMailboxRequestFrame, serializePrivateRequestLayerV1, serializePublicationOperationFrame,
  serializeRelationshipMailboxDepositFrameV2, serializeRelationshipMailboxRequestFrameV2,
  type MailboxRequest, type RelationshipMailboxRequestV2,
} from '@resonance/core';
import { createRelayServer } from '../server.js';
import { RELAY_OPERATION_LOG_FILENAME, RelayOperationLog } from '../operation-log.js';
import { discoverRelayContactV1 } from '../relay-discovery-client.js';
import { connectRelayLinkV1 } from '../relay-link-client.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function send(endpoint: string, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint); let done = false;
    const finish = (error?: Error, value?: string) => {
      if (done) return; done = true; clearTimeout(timer); socket.terminate();
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('Mailbox budget request timed out')), 5000);
    socket.on('open', () => socket.send(raw)); socket.on('message', bytes => finish(undefined, bytes.toString()));
    socket.on('error', error => finish(error)); socket.on('close', () => finish(new Error('Mailbox budget socket closed')));
  });
}
const discovery = () => ({ endpoints: ['ws://127.0.0.1:0/'], reachability: 'direct' as const,
  supportedGroups: ['public'], storage: { capacityBytes: 4_000_000, availableBytes: 3_000_000 } });

async function fixture(kind: 'publication' | 'relationship') {
  const directory = mkdtempSync(join(tmpdir(), 'mailbox-ack-budget-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let admissionOffline = false;
  const open = (maxJournalStorageBytes = 1_000_000) => createRelayServer({ host: '127.0.0.1', port: 0, persistDir: directory,
    maxPublishesPerMin: 1000, maxSearchesPerMin: 1000, maxJournalStorageBytes, relayDiscovery: discovery(),
    privateReplyMix: { windowMs: 10 }, ...(admissionOffline ? { admissionVerifier: {
      isReady: () => false, verifyAndSpend() { throw new Error('ACK must not call admission'); },
    } } : {}) });
  let relay = open(); cleanup.push(() => relay.stop({ graceful: false })); await relay.start();
  const endpoint = () => `ws://127.0.0.1:${relay.getListeningPort()}/`;
  async function request(raw: string): Promise<any> {
    return parseMessage(await send(endpoint(), raw)).payload;
  }
  let makeRequest: (action: 'fetch' | 'ack', ids?: string[]) => MailboxRequest | RelationshipMailboxRequestV2;
  let serialize: (value: MailboxRequest | RelationshipMailboxRequestV2) => string;
  let deposit: string | undefined;
  let nextDeposit: () => string;
  if (kind === 'publication') {
    const keys = generatePublicationKeyMaterial(), other = generatePublicationKeyMaterial(), now = Date.now();
    const base = { groupId: 'public', fingerprintEpoch: 'ack-budget', fingerprint: new Uint8Array(64).fill(0x39),
      createdAt: now, expiresAt: now + 120000 };
    const record = createPublicationRecord({ ...base, itemType: 'need' }, keys);
    const sender = createPublicationRecord({ ...base, itemType: 'offer' }, other);
    for (const publication of [sender, record]) {
      expect(await request(serializePublicationOperationFrame(createPublicationOperationFrame(publication)))).toMatchObject({ status: 'ok' });
    }
    makeRequest = (action, ids = []) => createMailboxRequest(action, record, keys, ids);
    serialize = value => serializeMailboxRequestFrame(createMailboxRequestFrame(value as MailboxRequest));
    nextDeposit = () => {
      const match = createDeterministicMatchId(sender.publicationId, record.publicationId);
      const envelope = encryptRelationshipMessage(createConsentOfferV2(match, sender, record, other,
        generateRelationshipKeyMaterial(), Date.now(), Date.now() + 60000), record);
      return serializeMailboxDepositFrame(createMailboxDepositFrame(createMailboxDepositRequest(match, sender, record, other, envelope)));
    };
  } else {
    const sender = generateRelationshipKeyMaterial(), recipient = generateRelationshipKeyMaterial();
    const channel = createPairwiseChannelId('match_' + 'a'.repeat(43), sender.relationshipId, recipient.relationshipId);
    let sequence = 0;
    nextDeposit = () => {
      const operation = createChannelMessageOperationV2(channel, recipient.relationshipId, ++sequence,
        { kind: 'disclosure', text: 'retained message', level: 'general', createdAt: Date.now() }, randomBytes(32), sender);
      const envelope = encryptChannelOperationV2(operation, { id: recipient.mailboxId,
        encryptionKey: Buffer.from(recipient.mailboxKeyPair.publicKey).toString('base64') });
      return serializeRelationshipMailboxDepositFrameV2(createRelationshipMailboxDepositFrameV2(
        createRelationshipMailboxDepositV2(recipient.relationshipId, sender, envelope)));
    };
    deposit = nextDeposit();
    expect(await request(deposit)).toMatchObject({ status: 'ok' });
    makeRequest = (action, ids = []) => createRelationshipMailboxRequestV2(action, recipient, ids);
    serialize = value => serializeRelationshipMailboxRequestFrameV2(createRelationshipMailboxRequestFrameV2(value as RelationshipMailboxRequestV2));
  }
  const fetch = async () => (await request(serialize(makeRequest('fetch')))).envelopes.map((envelope: { envelopeId: string }) => envelope.envelopeId) as string[];
  const envelopes = await fetch(); expect(envelopes).toHaveLength(1);
  function snapshot() {
    const stats = relay.getStats();
    return { journal: readFileSync(join(directory, RELAY_OPERATION_LOG_FILENAME)),
      floor: stats.journal_commitment_floor_bytes, journalBytes: stats.journal_bytes,
      envelopes: stats.mailbox_envelopes, mailboxBytes: stats.mailbox_storage_reserved_bytes,
      mailboxFloor: stats.mailbox_commitment_floor_bytes };
  }
  return { request, makeRequest, serialize, fetch, snapshot, deposit, directory, endpoint, envelopeId: envelopes[0],
    async seed(count: number) { for (let i = 0; i < count; i++) expect(await request(nextDeposit())).toMatchObject({ status: 'ok' }); return fetch(); },
    async privateRequest(raw: string) {
      const entry = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: join(directory, `entry-${Date.now()}`),
        relayDiscovery: discovery(), privateEntryMix: { windowMs: 10 } });
      cleanup.push(() => entry.stop({ graceful: false })); await entry.start();
      const entryEndpoint = `ws://127.0.0.1:${entry.getListeningPort()}/`;
      const first = await discoverRelayContactV1(createRelayContactHintV1('configured', entryEndpoint));
      const last = await discoverRelayContactV1(createRelayContactHintV1('configured', endpoint()));
      entry.observeRelayDescriptor(last.responder);
      const exchange = await createPrivateRequestV1(decodeUTF8(raw), first.transportKey!, last.transportKey!);
      const response = parsePrivateResponseV1(await send(entryEndpoint, serializePrivateRequestLayerV1(exchange.request)));
      return parseMessage(encodeUTF8(await openPrivateResponseV1(response, exchange.responsePrivateKey,
        exchange.request.requestId, last.responder.relayId))).payload as any;
    },
    async restartWithoutAdmission() { admissionOffline = true; await relay.stop({ graceful: false }); relay = open(); await relay.start(); },
    async restoreHistoricalAck(request: MailboxRequest | RelationshipMailboxRequestV2) {
      await relay.stop({ graceful: false });
      const historical = new RelayOperationLog(directory); historical.load(); historical.append({ kind: 'mailbox-ack', request });
      relay = open(); await relay.start();
    },
    async restart(maximumBytes: number) { await relay.stop({ graceful: false }); relay = open(maximumBytes); await relay.start(); } };
}

for (const kind of ['publication', 'relationship'] as const) it.each(['direct', 'private'] as const)(
  `fresh ${kind} ACKs with all IDs present are bounded through %s transport`, async transport => {
    const n = await fixture(kind), ids = await n.seed(99);
    expect(ids).toHaveLength(100);
    const invoke = transport === 'direct' ? n.request : n.privateRequest;
    const before = n.snapshot();
    for (const count of [100, 17]) {
      const request = n.makeRequest('ack', ids.slice(0, count)), raw = n.serialize(request);
      if (count === 17) expect(Buffer.byteLength(raw)).toBeLessThan(2048);
      else expect(Buffer.byteLength(JSON.stringify({ version: 1, sequence: Number.MAX_SAFE_INTEGER,
        committedAt: Number.MAX_SAFE_INTEGER, entry: { kind: 'mailbox-ack', request }, recordId: 'jrn_' + 'z'.repeat(43) }) + '\n')).toBeGreaterThan(2048);
      expect(await invoke(raw)).toMatchObject({ status: 'error', message: 'acknowledgement_batch_too_large' });
      expect(n.snapshot()).toEqual(before); expect(await n.fetch()).toEqual(ids);
    }
    const small = n.makeRequest('ack', ids.slice(0, 16));
    expect(await invoke(n.serialize(small))).toMatchObject({ status: 'ok', message: 'acknowledged:16' });
    expect(await n.fetch()).toEqual(ids.slice(16));
    expect(JSON.parse(n.snapshot().journal.toString().trim().split('\n').at(-1)!).entry).toEqual({ kind: 'mailbox-ack', request: small });
    // Restore a complete legacy proof offline: parsing/replay still permit100
    // IDs, while the fresh parsed-client paths refuse to create such rows.
    const historical = n.makeRequest('ack', ids);
    await n.restoreHistoricalAck(historical); expect(await n.fetch()).toEqual([]);
    const reopened = n.snapshot();
    expect(reopened.journal.toString()).toContain(historical.signature);
    expect(await n.request(n.serialize(historical))).toMatchObject({ status: 'ok', message: 'acknowledged:0' });
    expect(n.snapshot()).toEqual(reopened);
  }, 15000);

it('repairs a partial relationship replica with one present envelope using the intact bounded owner proof', async () => {
  const n = await fixture('relationship'), ids = await n.seed(15), directory = join(n.directory, 'replica');
  mkdirSync(directory); writeFileSync(join(directory, RELAY_OPERATION_LOG_FILENAME), n.snapshot().journal);
  const open = () => createRelayServer({ host: '127.0.0.1', port: 0, persistDir: directory,
    maxSearchesPerMin: 1000, relayDiscovery: discovery() });
  let replica = open(); cleanup.push(() => replica.stop({ graceful: false })); await replica.start();
  const endpoint = () => `ws://127.0.0.1:${replica.getListeningPort()}/`;
  const request = async (raw: string): Promise<any> => parseMessage(await send(endpoint(), raw)).payload;
  const fetch = async () => (await request(n.serialize(n.makeRequest('fetch')))).envelopes.map((value: { envelopeId: string }) => value.envelopeId);
  expect(await request(n.serialize(n.makeRequest('ack', ids.slice(1))))).toMatchObject({ status: 'ok', message: 'acknowledged:15' });
  expect(await fetch()).toEqual([ids[0]]);
  const proof = n.makeRequest('ack', ids) as RelationshipMailboxRequestV2;
  expect(await n.request(n.serialize(proof))).toMatchObject({ status: 'ok', message: 'acknowledged:16' });

  // An authenticated repair volunteer forwards the source's exact signed owner
  // proof. Drive one real sync RPC directly, avoiding scheduler interval sleeps.
  const identity = generateIdentity(), now = Date.now();
  const descriptor = createRelayDescriptorV1({ sequence: 1, endpoints: [], reachability: 'outbound-only',
    capabilities: { storesPublications: false, storesMailboxes: true, answersQueries: false,
      forwardsQueries: false, replicaExchange: true }, supportedGroups: ['public'],
    storage: { capacityBytes: 4_000_000, availableBytes: 3_000_000 }, issuedAt: now, expiresAt: now + 60_000 }, identity);
  cleanup.push(() => { identity.secretKey.fill(0); });
  const connection = await connectRelayLinkV1(createRelayContactHintV1('configured', endpoint(), replica.getRelayDescriptor()!.relayId),
    descriptor, identity, { handshakeTimeoutMs: 2000, replicaRequestTimeoutMs: 1000 });
  cleanup.push(() => connection.close());
  // Historical repair parsing remains100, but the actual-byte guard must still
  // reject a huge valid signature when only one envelope can fund its record.
  const legacy = n.makeRequest('ack', [...ids, ...Array.from({ length: 84 }, () => 'env_' + randomBytes(32).toString('base64url'))]) as RelationshipMailboxRequestV2;
  const before = readFileSync(join(directory, RELAY_OPERATION_LOG_FILENAME));
  expect(await connection.syncRelationshipMailbox(proof.mailboxId, 0, [{ kind: 'ack', request: legacy }])).toMatchObject({ status: 'rejected' });
  expect(readFileSync(join(directory, RELAY_OPERATION_LOG_FILENAME))).toEqual(before); expect(await fetch()).toEqual([ids[0]]);
  expect(await connection.syncRelationshipMailbox(proof.mailboxId, 0, [{ kind: 'ack', request: proof }])).toMatchObject({ status: 'ok' });
  expect(await fetch()).toEqual([]);
  const retained = readFileSync(join(directory, RELAY_OPERATION_LOG_FILENAME), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(retained.at(-1).entry).toEqual({ kind: 'mailbox-ack', request: proof });
  expect(Buffer.byteLength(JSON.stringify(retained.at(-1)) + '\n')).toBeLessThanOrEqual(2048);
  connection.close(); await replica.stop({ graceful: false }); replica = open(); await replica.start();
  expect(await fetch()).toEqual([]);
});

for (const kind of ['publication', 'relationship'] as const) it.each(['ample', 'prepaid-floor'] as const)(
  `bounds ${kind} acknowledgement records with %s journal space while preserving signed retries and restart`, async quota => {
    const n = await fixture(kind);
    if (quota === 'prepaid-floor') await n.restart(n.snapshot().floor);
    const unknown = Array.from({ length: 99 }, () => 'env_' + randomBytes(32).toString('base64url'));
    const before = n.snapshot();
    expect(await n.request(n.serialize(n.makeRequest('ack', unknown)))).toMatchObject({ status: 'ok', message: 'acknowledged:0' });
    expect(n.snapshot()).toEqual(before);

    const inflated = n.makeRequest('ack', [n.envelopeId, ...unknown]);
    expect(Buffer.byteLength(n.serialize(inflated))).toBeGreaterThan(2048);
    const refused = await n.request(n.serialize(inflated));
    expect(n.snapshot().floor, 'one present envelope must not fund a journal row larger than its prepaid reserve').toBeLessThanOrEqual(before.floor);
    expect(refused).toMatchObject({ status: 'error', message: 'acknowledgement_batch_too_large' });
    expect(n.snapshot()).toEqual(before); expect(await n.fetch()).toEqual([n.envelopeId]);

    const small = n.makeRequest('ack', [n.envelopeId, unknown[0]]), raw = n.serialize(small);
    expect(await n.request(raw)).toMatchObject({ status: 'ok', message: 'acknowledged:1' });
    const accepted = n.snapshot(); expect(accepted.floor).toBeLessThanOrEqual(before.floor);
    const records = accepted.journal.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(records.at(-1).entry).toEqual({ kind: 'mailbox-ack', request: small });
    expect(await n.request(raw)).toMatchObject({ status: 'ok', message: 'acknowledged:0' }); expect(n.snapshot()).toEqual(accepted);
    await n.restart(accepted.floor); expect(await n.fetch()).toEqual([]);
    const reopened = n.snapshot();
    expect(await n.request(n.serialize(inflated))).toMatchObject({ status: 'ok', message: 'acknowledged:0' });
    if (n.deposit) expect(await n.request(n.deposit)).toMatchObject({ status: 'ok', message: 'duplicate' });
    expect(n.snapshot()).toEqual(reopened);
  });

for (const kind of ['publication', 'relationship'] as const) it(`retires accepted ${kind} mail during admission outage, preserving ownership and durable retries`, async () => {
  const n = await fixture(kind);
  await n.restartWithoutAdmission();
  const before = n.snapshot();
  expect(await n.request(n.serialize(n.makeRequest('fetch')))).toMatchObject({ status: 'error', message: 'admission_unavailable' });
  if (n.deposit) expect(await n.request(n.deposit)).toMatchObject({ status: 'error', message: 'admission_unavailable' });
  // Altering the mailbox or owner signature cannot authorize deletion.
  const ack = n.makeRequest('ack', [n.envelopeId]);
  const otherKeys = generatePublicationKeyMaterial(), now = Date.now();
  const otherRecord = createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'ack-budget',
    fingerprint: new Uint8Array(64).fill(0x39), itemType: 'need', createdAt: now, expiresAt: now + 120000 }, otherKeys);
  const foreign = kind === 'publication' ? createMailboxRequest('ack', otherRecord, otherKeys, [n.envelopeId])
    : createRelationshipMailboxRequestV2('ack', generateRelationshipKeyMaterial(), [n.envelopeId]);
  expect(await n.request(n.serialize(foreign))).toMatchObject(kind === 'publication'
    ? { status: 'error', message: 'unknown_mailbox' } : { status: 'ok', message: 'acknowledged:0' });
  expect(n.snapshot()).toEqual(before);
  for (const field of ['mailboxId', 'signature'] as const) {
    const frame = JSON.parse(n.serialize(ack));
    frame.request[field] = field === 'mailboxId' ? 'mbx_' + randomBytes(32).toString('base64url') : 'A'.repeat(88);
    await expect(n.request(JSON.stringify(frame))).rejects.toThrow('Mailbox budget socket closed');
    expect(n.snapshot()).toEqual(before);
  }
  expect(await n.request(n.serialize(ack))).toMatchObject({ status: 'ok', message: 'acknowledged:1' });
  const accepted = n.snapshot();
  expect(accepted.floor).toBeLessThanOrEqual(before.floor); expect(accepted.envelopes).toBe(before.envelopes - 1);
  expect(JSON.parse(accepted.journal.toString('utf8').trim().split('\n').at(-1)!).entry).toEqual({ kind: 'mailbox-ack', request: ack });
  await n.restartWithoutAdmission();
  const reopened = n.snapshot();
  expect(await n.request(n.serialize(ack))).toMatchObject({ status: 'ok', message: 'acknowledged:0' });
  expect(n.snapshot()).toEqual(reopened);
});
