import { rmSync } from 'node:fs';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import {
  createMailboxRequest, createMailboxRequestFrame,
  createPublicationOperationFrame, createPublicationRecord, createPublicationTombstone,
  createRelayContactHintV1, createSearchRequestFrameV2, createSearchRequestV2,
  decryptMatchNotice, generatePublicationKeyMaterial, parseMessage,
  serializeMailboxRequestFrame, serializePublicationOperationFrame,
  serializeSearchRequestFrameV2, verifyRelayReplicaReceiptV1,
  verifyMessage, verifySearchResponsePayloadV2,
  type EncryptedMailboxEnvelope, type Message, type PublicationKeyMaterial,
  type PublicationRecord,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '../server.js';

const BASE = 38_000 + Math.floor(Math.random() * 1_000);
const RUN = `${Date.now()}-${BASE}`;
const CONTROLLER = BASE;
const VOLUNTEERS = [1, 2, 3, 4, 5].map(offset => BASE + offset);
const GATEWAY = BASE + 6;
const DIRECT_VOLUNTEER = 2;
const directories = [CONTROLLER, ...VOLUNTEERS, GATEWAY]
  .map(port => `/tmp/resonance-v03-completion-${port}-${RUN}`);

function endpoint(port: number): string { return `ws://127.0.0.1:${port}/`; }

function volunteer(index: number): RelayServer {
  const port = VOLUNTEERS[index];
  const direct = index === DIRECT_VOLUNTEER;
  return createRelayServer({
    port, host: '127.0.0.1', persistDir: directories[index + 1],
    relayDiscovery: {
      endpoints: direct ? [endpoint(port)] : [],
      reachability: direct ? 'direct' : 'outbound-only',
      supportedGroups: ['public'],
      storage: { capacityBytes: 4_000_000, availableBytes: 3_000_000 },
    },
    relayLinks: {
      targets: [createRelayContactHintV1('configured', endpoint(CONTROLLER))],
      handshakeTimeoutMs: 2_000, heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 1_500, reconnectBaseMs: 50, reconnectMaxMs: 200,
    },
    relayLinkHeartbeatIntervalMs: 100, relayLinkHeartbeatTimeoutMs: 1_500,
  });
}

function controller(volunteers: RelayServer[]): RelayServer {
  return createRelayServer({
    port: CONTROLLER, host: '127.0.0.1', persistDir: directories[0],
    desiredReplicaCount: 5, minimumHealthyReplicaCount: 3,
    replicaRepairIntervalMs: 100, replicaInventoryIntervalMs: 300,
    inboundReplicaTargetIds: volunteers.map(target => target.getRelayDescriptor()!.relayId),
    relayDiscovery: {
      endpoints: [endpoint(CONTROLLER)], reachability: 'direct',
      supportedGroups: ['public'],
      storage: { capacityBytes: 4_000_000, availableBytes: 3_000_000 },
    },
    relayLinkHeartbeatIntervalMs: 100, relayLinkHeartbeatTimeoutMs: 1_500,
  });
}

function gateway(): RelayServer {
  return createRelayServer({
    port: GATEWAY, host: '127.0.0.1', persistDir: directories[6],
    relayDiscovery: {
      endpoints: [], reachability: 'outbound-only', supportedGroups: ['public'],
      storage: { capacityBytes: 4_000_000, availableBytes: 3_000_000 },
    },
    relayLinks: {
      targets: [createRelayContactHintV1('configured', endpoint(VOLUNTEERS[DIRECT_VOLUNTEER]))],
      handshakeTimeoutMs: 2_000, heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 1_500, reconnectBaseMs: 50, reconnectMaxMs: 200,
    },
    relayLinkHeartbeatIntervalMs: 100, relayLinkHeartbeatTimeoutMs: 1_500,
  });
}

function request(port: number, raw: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint(port));
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('relay request timed out')); }, 5_000);
    socket.on('open', () => socket.send(raw));
    socket.on('message', data => {
      clearTimeout(timer);
      try { resolve(parseMessage(data.toString())); } catch (error) { reject(error); }
      socket.close();
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('v0.3 completion condition not met');
}

function publication(itemType: 'need' | 'offer') {
  const keys = generatePublicationKeyMaterial();
  const now = Date.now();
  return {
    keys,
    record: createPublicationRecord({
      groupId: 'public', fingerprintEpoch: 'v03-completion',
      fingerprint: new Uint8Array(64).fill(0x6d), itemType,
      createdAt: now, expiresAt: now + 120_000,
    }, keys),
  };
}

async function publish(record: PublicationRecord): Promise<void> {
  expect((await request(CONTROLLER, serializePublicationOperationFrame(
    createPublicationOperationFrame(record),
  ))).payload).toMatchObject({ status: 'ok' });
}

async function fetch(port: number, record: PublicationRecord, keys: PublicationKeyMaterial) {
  const response = await request(port, serializeMailboxRequestFrame(createMailboxRequestFrame(
    createMailboxRequest('fetch', record, keys, [], Date.now()),
  ))) as Message<{ envelopes: EncryptedMailboxEnvelope[] }>;
  return response.payload.envelopes;
}

describe('v0.3 volunteer-only completion path', () => {
  it('keeps search and encrypted notice delivery after the controller and two volunteers disappear', async () => {
    const volunteers = VOLUNTEERS.map((_, index) => volunteer(index));
    let source = controller(volunteers);
    const entry = gateway();
    const running = new Set<RelayServer>();
    const start = async (relay: RelayServer): Promise<void> => {
      await relay.start();
      running.add(relay);
    };
    const stop = async (relay: RelayServer): Promise<void> => {
      running.delete(relay);
      await relay.stop({ graceful: false });
    };
    try {
      await start(source);
      await Promise.all(volunteers.map(start));
      await start(entry);
      await waitFor(() => source.getRelayLinkStatus().inboundRelayIds.length === 5
        && entry.getRelayLinkStatus().connectedRelayIds.length === 1);

      const offer = publication('offer');
      const need = publication('need');
      await publish(offer.record);
      await publish(need.record);
      await waitFor(() => source.getReplicaPlacementStatus(offer.record.publicationId)?.confirmedReplicaCount === 5
        && source.getReplicaPlacementStatus(need.record.publicationId)?.confirmedReplicaCount === 5);
      const receipts = source.getReplicaReceipts(offer.record.publicationId);
      expect(new Set(receipts.map(receipt => receipt.responderRelayId)).size).toBe(5);
      expect(receipts.every(receipt => verifyRelayReplicaReceiptV1(receipt)
        && (receipt.status === 'stored' || receipt.status === 'already-stored')
        && receipt.operationSignature === offer.record.signature)).toBe(true);
      await waitFor(async () => (await fetch(VOLUNTEERS[DIRECT_VOLUNTEER], offer.record, offer.keys)).length === 1);
      expect(entry.getStats().stored_publications).toBe(0);

      await stop(source);
      await stop(volunteers[0]);
      await stop(volunteers[1]);
      expect(volunteers.slice(2).every(target => target.getStats().active_publications === 2))
        .toBe(true);
      expect(volunteers[DIRECT_VOLUNTEER].getStats().active_publications).toBe(2);
      const search = createSearchRequestV2({
        groupId: 'public', fingerprintEpoch: 'v03-completion',
        fingerprint: new Uint8Array(64).fill(0x6d), itemType: 'need',
        k: 5, threshold: 0.9,
      });
      const response = await request(GATEWAY, serializeSearchRequestFrameV2(
        createSearchRequestFrameV2(search),
      )) as Message<{ results: Array<{ publicationId: string }> }>;
      expect(verifyMessage(response)).toBe(true);
      expect(verifySearchResponsePayloadV2(response.payload)).toBe(true);
      expect(response.payload.results.map(result => result.publicationId))
        .toContain(offer.record.publicationId);
      expect(entry.getStats().stored_publications).toBe(0);
      const notices = await fetch(VOLUNTEERS[DIRECT_VOLUNTEER], offer.record, offer.keys);
      expect(notices).toHaveLength(1);
      expect(decryptMatchNotice(notices[0], offer.keys).payload).toMatchObject({
        recipientPublicationId: offer.record.publicationId,
        partnerPublicationId: need.record.publicationId,
      });

      source = controller(volunteers);
      volunteers[0] = volunteer(0);
      volunteers[1] = volunteer(1);
      await start(source);
      await Promise.all([start(volunteers[0]), start(volunteers[1])]);
      await waitFor(() => source.getReplicaPlacementStatus(offer.record.publicationId)?.confirmedReplicaCount === 5
        && source.getRelayLinkStatus().inboundRelayIds.length === 5);
      await waitFor(async () => (await Promise.all(VOLUNTEERS.map(port => fetch(port, offer.record, offer.keys))))
        .every(envelopes => envelopes.length === 1 && envelopes[0].envelopeId === notices[0].envelopeId));

      const ack = await request(VOLUNTEERS[DIRECT_VOLUNTEER], serializeMailboxRequestFrame(
        createMailboxRequestFrame(createMailboxRequest('ack', offer.record, offer.keys,
          [notices[0].envelopeId], Date.now())),
      ));
      expect(ack.payload).toMatchObject({ status: 'ok', message: 'acknowledged:1' });
      await waitFor(async () => (await Promise.all([CONTROLLER, ...VOLUNTEERS]
        .map(port => fetch(port, offer.record, offer.keys))))
        .every(envelopes => envelopes.length === 0));

      const tombstone = createPublicationTombstone(
        offer.record, 'withdrawn', offer.keys.signingKeyPair, Date.now(),
      );
      expect((await request(CONTROLLER, serializePublicationOperationFrame(
        createPublicationOperationFrame(tombstone),
      ))).payload).toMatchObject({ status: 'ok' });
      await waitFor(() => volunteers.every(target => target.getStats().active_publications === 1));
      expect(await fetch(VOLUNTEERS[DIRECT_VOLUNTEER], offer.record, offer.keys)).toEqual([]);
    } finally {
      await Promise.all([...running].map(relay => relay.stop({ graceful: false })));
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
