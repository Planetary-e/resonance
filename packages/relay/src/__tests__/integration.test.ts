import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  MessageTypes,
  createAdmissionRequestBindingV2,
  createMailboxRequest,
  createMailboxRequestFrame,
  createMessage,
  createRelayDescriptorV1,
  createRelayPeerRequestFrameV1,
  createRelayPeerRequestV1,
  createSearchRequestFrameV2,
  createSearchRequestV2,
  createPublicationOperationFrame,
  createPublicationRecord,
  createPublicationTombstone,
  generateIdentity,
  generatePublicationKeyMaterial,
  parseMessage,
  parseRelayPeerResponseFrameV1,
  serializeMessage,
  serializeMailboxRequestFrame,
  serializePublicationOperationFrame,
  serializeRelayPeerRequestFrameV1,
  serializeSearchRequestFrameV2,
  verifyMessage,
  verifyMatchOperationV2,
  verifyRelayDescriptorV1,
  verifyRelayPeerResponseV1,
  type AckPayload,
  type AdmissionCapabilityV2,
  type Message,
  type PublicationOperation,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '../server.js';
import type { AdmissionCapabilityVerifierV2 } from '../admission.js';
import { RELAY_OPERATION_LOG_FILENAME } from '../operation-log.js';

const PORT = 19090 + Math.floor(Math.random() * 1000);
const PERSIST_DIR = `/tmp/resonance-integration-test-${Date.now()}`;
let server: RelayServer;

function record(itemType: 'need' | 'offer', fill: number, groupId = 'public') {
  const keys = generatePublicationKeyMaterial();
  const now = Date.now();
  return createPublicationRecord({
    groupId,
    fingerprintEpoch: 'pilot-static-v1',
    fingerprint: new Uint8Array(64).fill(fill),
    itemType,
    createdAt: now,
    expiresAt: now + 86_400_000,
  }, keys);
}

function recordWithKeys(
  itemType: 'need' | 'offer',
  fill: number,
  groupId: string,
  lifetimeMs = 86_400_000,
) {
  const keys = generatePublicationKeyMaterial();
  const now = Date.now();
  return {
    keys,
    record: createPublicationRecord({
      groupId,
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(fill),
      itemType,
      createdAt: now,
      expiresAt: now + lifetimeMs,
    }, keys),
  };
}

function createServer(): RelayServer {
  return createRelayServer({
    port: PORT,
    host: '127.0.0.1',
    maxAuthAttemptsPerMin: 100,
    persistDir: PERSIST_DIR,
    persistIntervalMs: 999_999,
    relayDiscovery: {
      endpoints: [`ws://127.0.0.1:${PORT}`],
      reachability: 'direct',
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 900_000 },
      maxKnownRelays: 8,
    },
  });
}

function submit(operation: PublicationOperation): Promise<Message<AckPayload>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const timeout = setTimeout(() => reject(new Error('submission timeout')), 5_000);
    ws.on('open', () => {
      ws.send(serializePublicationOperationFrame(createPublicationOperationFrame(operation)));
    });
    ws.on('message', (data: Buffer) => {
      clearTimeout(timeout);
      const message = parseMessage(data.toString('utf8')) as Message<AckPayload>;
      ws.close();
      resolve(message);
    });
    ws.on('error', reject);
  });
}

function sendFrame(raw: string): Promise<Message> {
  return sendFrameToPort(PORT, raw);
}

function sendFrameToPort(port: number, raw: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const timeout = setTimeout(() => reject(new Error('frame response timeout')), 5_000);
    ws.on('open', () => ws.send(raw));
    ws.on('message', (data: Buffer) => {
      clearTimeout(timeout);
      const message = parseMessage(data.toString('utf8'));
      ws.close();
      resolve(message);
    });
    ws.on('error', reject);
  });
}

function sendRawFrame(raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const timeout = setTimeout(() => reject(new Error('raw frame response timeout')), 5_000);
    ws.on('open', () => ws.send(raw));
    ws.on('message', (data: Buffer) => {
      clearTimeout(timeout);
      ws.close();
      resolve(data.toString('utf8'));
    });
    ws.on('error', reject);
  });
}

beforeAll(async () => {
  server = createServer();
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

describe('Relay protocol v2 integration', () => {
  it('persists a self-authenticating publication before ACK without AUTH or a root DID', async () => {
    const publication = record('offer', 0xa5);
    const ack = await submit(publication);

    expect(verifyMessage(ack)).toBe(true);
    expect(ack.type).toBe(MessageTypes.ACK);
    expect(ack.payload).toEqual({
      ref: publication.publicationId,
      status: 'ok',
      message: 'accepted',
    });
    expect(server.getStats().stored_publications).toBe(1);
    expect(server.getStats().connected_nodes).toBe(0);
  });

  it('indexes complementary v2 records under independent publication identities', async () => {
    const offer = record('offer', 0x3c);
    const need = record('need', 0x3c);

    expect((await submit(offer)).payload.status).toBe('ok');
    expect((await submit(need)).payload.status).toBe('ok');
    expect(offer.publicationId).not.toBe(need.publicationId);
    expect(server.getStats().stored_publications).toBe(3);
    expect(server.getStats().indexed_embeddings).toBe(3);
    expect(server.getStats().matches_today).toBeGreaterThan(0);
    expect(server.getStats().mailbox_envelopes).toBe(2);
    const records = readFileSync(join(PERSIST_DIR, RELAY_OPERATION_LOG_FILENAME), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    const matchRecords = records.filter(record => record.entry.kind === 'match');
    expect(matchRecords).toHaveLength(1);
    expect(verifyMatchOperationV2(matchRecords[0].entry.operation)).toBe(true);
    expect(matchRecords[0].entry.envelopes).toHaveLength(2);
    expect(server.getStats().stored_matches).toBe(1);
  });

  it('does not compare fingerprints across groups', async () => {
    const matchesBefore = server.getStats().matches_today;
    await submit(record('offer', 0xf0, 'community:a'));
    await submit(record('need', 0xf0, 'community:b'));

    expect(server.getStats().matches_today).toBe(matchesBefore);
  });

  it('rejects replay of a one-use search identity', async () => {
    const now = Date.now();
    const request = createSearchRequestV2({
      groupId: `search-replay-${now}`,
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0x77),
      itemType: 'need',
      k: 5,
      threshold: 0.7,
      createdAt: now,
      expiresAt: now + 30_000,
    });
    const raw = serializeSearchRequestFrameV2(createSearchRequestFrameV2(request));

    const first = await sendFrame(raw);
    expect(first.type).toBe('search_response_v2');
    const replay = await sendFrame(raw) as Message<AckPayload>;
    expect(replay.payload).toEqual({
      ref: request.searchId,
      status: 'error',
      message: 'replayed_search',
    });
  });

  it('enforces one-use admission while allowing an exact operation retry', async () => {
    const admissionPort = PORT + 1100;
    const admissionDir = `${PERSIST_DIR}-admission`;
    const spent = new Map<string, string>();
    const verifier: AdmissionCapabilityVerifierV2 = {
      verifyAndSpend(capability, context) {
        if (capability.requestProof !== context.requestBinding) {
          return { status: 'rejected', reason: 'request_proof_mismatch' };
        }
        const spendKey = `${capability.issuer}\n${capability.token}`;
        const use = `${context.action}\n${context.requestBinding}`;
        const previous = spent.get(spendKey);
        if (previous === undefined) {
          spent.set(spendKey, use);
          return { status: 'accepted' };
        }
        return previous === use ? { status: 'replay' } : { status: 'rejected', reason: 'double_spend' };
      },
    };
    const admissionServer = createRelayServer({
      port: admissionPort,
      host: '127.0.0.1',
      persistDir: admissionDir,
      admissionVerifier: verifier,
    });
    await admissionServer.start();
    try {
      const first = record('offer', 0x31, `admission-${Date.now()}`);
      const missing = await sendFrameToPort(
        admissionPort,
        serializePublicationOperationFrame(createPublicationOperationFrame(first)),
      ) as Message<AckPayload>;
      expect(missing.payload.message).toBe('admission_required');

      const capability: AdmissionCapabilityV2 = {
        version: 2,
        kind: 'admission-capability',
        scheme: 'test-blind-token-v1',
        issuer: 'community:test',
        token: 'A'.repeat(43),
        requestProof: createAdmissionRequestBindingV2('publication-write', first),
      };
      const admitted = serializePublicationOperationFrame(createPublicationOperationFrame(first, capability));
      expect((await sendFrameToPort(admissionPort, admitted) as Message<AckPayload>).payload.message).toBe('accepted');
      expect((await sendFrameToPort(admissionPort, admitted) as Message<AckPayload>).payload.message).toBe('duplicate');

      const second = record('offer', 0x32, first.groupId);
      const reusedCapability = {
        ...capability,
        requestProof: createAdmissionRequestBindingV2('publication-write', second),
      };
      const reused = await sendFrameToPort(
        admissionPort,
        serializePublicationOperationFrame(createPublicationOperationFrame(second, reusedCapability)),
      ) as Message<AckPayload>;
      expect(reused.payload.message).toBe('admission_rejected');
      expect(admissionServer.getStats().stored_publications).toBe(1);
    } finally {
      await admissionServer.stop();
      rmSync(admissionDir, { recursive: true, force: true });
    }
  });

  it('rejects legacy root-DID authentication and discovery routes', async () => {
    const identity = generateIdentity();
    const auth = await sendFrame(serializeMessage(createMessage(MessageTypes.AUTH, {}, identity))) as Message<AckPayload>;
    expect(auth.payload).toEqual({
      ref: 'auth',
      status: 'error',
      message: 'legacy_auth_disabled',
    });

    const publish = await sendFrame(serializeMessage(createMessage(MessageTypes.PUBLISH, {
      itemId: 'legacy-item', hash: 'AA==', itemType: 'need', ttl: 60,
    }, identity))) as Message<AckPayload>;
    expect(publish.payload).toEqual({
      ref: MessageTypes.PUBLISH,
      status: 'error',
      message: 'unknown_message_type',
    });

    const search = await sendFrame(serializeMessage(createMessage(MessageTypes.SEARCH, {
      hash: 'AA==', k: 5, threshold: 0.7,
    }, identity))) as Message<AckPayload>;
    expect(search.payload).toEqual({
      ref: MessageTypes.SEARCH,
      status: 'error',
      message: 'unknown_message_type',
    });
  });

  it('/health and /stats report v2 state', async () => {
    const health = await fetch(`http://localhost:${PORT}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const response = await fetch(`http://localhost:${PORT}/stats`);
    const stats = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(stats).toHaveProperty('stored_publications');
    expect(stats).toHaveProperty('active_publications');
    expect(stats).toHaveProperty('retained_tombstones');
    expect(stats).toHaveProperty('indexed_embeddings');
    expect(stats).toHaveProperty('connected_nodes');
    expect(stats).toHaveProperty('mailbox_envelopes');
    expect(stats).toHaveProperty('stored_matches');
    expect(stats).toHaveProperty('journal_entries');
    expect(stats).toHaveProperty('known_relays');
    expect(stats).toHaveProperty('connected_relays');
    expect(stats).toHaveProperty('durability_receipts');
  });

  it('publishes its signed descriptor and answers bounded signed peer exchange', async () => {
    const descriptorResponse = await fetch(`http://localhost:${PORT}/relay-descriptor`);
    const ownDescriptor = await descriptorResponse.json();
    expect(descriptorResponse.status).toBe(200);
    expect(verifyRelayDescriptorV1(ownDescriptor)).toBe(true);

    const peerIdentity = generateIdentity();
    const now = Date.now();
    const peerDescriptor = createRelayDescriptorV1({
      sequence: 1,
      endpoints: ['wss://community-relay.example.net'],
      reachability: 'direct',
      capabilities: {
        storesPublications: true,
        storesMailboxes: true,
        answersQueries: true,
        forwardsQueries: false,
        replicaExchange: false,
      },
      supportedGroups: ['public'],
      storage: { capacityBytes: 2_000_000, availableBytes: 1_500_000 },
      issuedAt: now,
      expiresAt: now + 60_000,
    }, peerIdentity);
    expect(server.observeRelayDescriptor(peerDescriptor, now)).toBe('accepted');

    const request = createRelayPeerRequestV1({
      supportedGroups: ['public'],
      maxPeers: 2,
      createdAt: now,
      expiresAt: now + 30_000,
    });
    const rawResponse = await sendRawFrame(serializeRelayPeerRequestFrameV1(
      createRelayPeerRequestFrameV1(request),
    ));
    const frame = parseRelayPeerResponseFrameV1(rawResponse);

    expect(verifyRelayPeerResponseV1(frame.response, request)).toBe(true);
    expect(frame.response.descriptors).toHaveLength(2);
    expect(frame.response.descriptors.map(value => value.relayId)).toContain(peerIdentity.did);
    expect(frame.response.descriptors.map(value => value.relayId)).toContain((ownDescriptor as { relayId: string }).relayId);
    expect(server.getStats().known_relays).toBe(1);
  });

  it('removes each publication at its signed expiry before further matching', async () => {
    const groupId = `expiry-${Date.now()}`;
    const activeBefore = server.getStats().active_publications;
    const expiring = recordWithKeys('offer', 0x44, groupId, 300);
    expect((await submit(expiring.record)).payload.status).toBe('ok');
    expect(server.getStats().active_publications).toBe(activeBefore + 1);

    await new Promise(resolve => setTimeout(resolve, 400));
    expect(server.getStats().active_publications).toBe(activeBefore);
    expect(server.getStats().indexed_embeddings).toBe(activeBefore);

    const matchesBefore = server.getStats().matches_today;
    expect((await submit(record('need', 0x44, groupId))).payload.status).toBe('ok');
    expect(server.getStats().matches_today).toBe(matchesBefore);
  });

  it('replays publications, matches, deposits, and acknowledgements across restart', async () => {
    const groupId = `restart-${Date.now()}`;
    const offer = recordWithKeys('offer', 0x66, groupId);
    const need = recordWithKeys('need', 0x66, groupId);
    await submit(offer.record);
    await submit(need.record);

    const fetched = await sendFrame(serializeMailboxRequestFrame(createMailboxRequestFrame(
      createMailboxRequest('fetch', offer.record, offer.keys, [], Date.now()),
    ))) as Message<{ envelopes: Array<{ envelopeId: string }> }>;
    expect(fetched.payload.envelopes).toHaveLength(1);
    const envelopeId = fetched.payload.envelopes[0].envelopeId;
    const acknowledged = await sendFrame(serializeMailboxRequestFrame(createMailboxRequestFrame(
      createMailboxRequest('ack', offer.record, offer.keys, [envelopeId], Date.now()),
    ))) as Message<AckPayload>;
    expect(acknowledged.payload.message).toBe('acknowledged:1');

    const statsBeforeRestart = server.getStats();
    await server.stop();
    server = createServer();
    await server.start();

    expect(server.getStats().stored_publications).toBe(statsBeforeRestart.stored_publications);
    expect(server.getStats().stored_matches).toBe(statsBeforeRestart.stored_matches);
    expect(server.getStats().mailbox_envelopes).toBe(statsBeforeRestart.mailbox_envelopes);
    const afterRestart = await sendFrame(serializeMailboxRequestFrame(createMailboxRequestFrame(
      createMailboxRequest('fetch', offer.record, offer.keys, [], Date.now()),
    ))) as Message<{ envelopes: unknown[] }>;
    expect(afterRestart.payload.envelopes).toEqual([]);

    const surviving = await sendFrame(serializeMailboxRequestFrame(createMailboxRequestFrame(
      createMailboxRequest('fetch', need.record, need.keys, [], Date.now()),
    ))) as Message<{ envelopes: Array<{ envelopeId: string }> }>;
    expect(surviving.payload.envelopes).toHaveLength(1);
    const repeatedFetch = await sendFrame(serializeMailboxRequestFrame(createMailboxRequestFrame(
      createMailboxRequest('fetch', need.record, need.keys, [], Date.now()),
    ))) as Message<{ envelopes: Array<{ envelopeId: string }> }>;
    expect(repeatedFetch.payload.envelopes.map(envelope => envelope.envelopeId))
      .toEqual(surviving.payload.envelopes.map(envelope => envelope.envelopeId));

    const survivingEnvelopeId = surviving.payload.envelopes[0].envelopeId;
    const survivingAck = await sendFrame(serializeMailboxRequestFrame(createMailboxRequestFrame(
      createMailboxRequest('ack', need.record, need.keys, [survivingEnvelopeId], Date.now()),
    ))) as Message<AckPayload>;
    expect(survivingAck.payload.message).toBe('acknowledged:1');
    const emptyAfterAck = await sendFrame(serializeMailboxRequestFrame(createMailboxRequestFrame(
      createMailboxRequest('fetch', need.record, need.keys, [], Date.now()),
    ))) as Message<{ envelopes: unknown[] }>;
    expect(emptyAfterAck.payload.envelopes).toEqual([]);
  });

  it('retains owner-signed tombstones across restart and prevents resurrection', async () => {
    const retainedBefore = server.getStats().retained_tombstones;
    const publication = recordWithKeys('offer', 0x27, `tombstone-${Date.now()}`);
    expect((await submit(publication.record)).payload.status).toBe('ok');
    const tombstone = createPublicationTombstone(
      publication.record,
      'withdrawn',
      publication.keys.signingKeyPair,
      Date.now(),
    );
    expect((await submit(tombstone)).payload.status).toBe('ok');
    expect(server.getStats().retained_tombstones).toBe(retainedBefore + 1);

    await server.stop();
    server = createServer();
    await server.start();

    const now = Date.now();
    const attemptedResurrection = createPublicationRecord({
      groupId: publication.record.groupId,
      fingerprintEpoch: publication.record.fingerprint.epoch,
      fingerprint: new Uint8Array(64).fill(0x27),
      itemType: publication.record.itemType,
      sequence: tombstone.sequence + 1,
      createdAt: now,
      expiresAt: now + 86_400_000,
    }, publication.keys);
    const rejected = await submit(attemptedResurrection);
    expect(rejected.payload).toEqual({
      ref: publication.record.publicationId,
      status: 'error',
      message: 'terminal',
    });
    expect(server.getStats().retained_tombstones).toBe(retainedBefore + 1);
  });
});
