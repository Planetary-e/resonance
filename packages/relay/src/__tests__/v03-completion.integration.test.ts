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
import { createRelayTestEndpoints, type RelayTestEndpoint } from './fixtures/relay-test-endpoint.js';

const RUN = `${Date.now()}-${process.pid}`;
let CONTROLLER = 0, GATEWAY = 0;
const VOLUNTEERS = [0, 0, 0, 0, 0];
let testEndpoints: RelayTestEndpoint[] = [];
const relayEndpoints = new Map<RelayServer, RelayTestEndpoint>();
const DIRECT_VOLUNTEER = 2;
// Seven relays share one event loop here. Keep maintenance and observation
// traffic below the work being tested, including on slower CI workers.
const LINK_TIMING = {
  handshakeTimeoutMs: 15_000, heartbeatIntervalMs: 1_000,
  heartbeatTimeoutMs: 15_000, reconnectBaseMs: 250, reconnectMaxMs: 1_000,
};
const directories = Array.from({ length: 7 }, (_, index) => `/tmp/resonance-v03-completion-${index}-${RUN}`);

function endpoint(port: number): string { return `ws://127.0.0.1:${port}/`; }

function volunteer(index: number): RelayServer {
  const port = VOLUNTEERS[index];
  const direct = index === DIRECT_VOLUNTEER;
  const relay = createRelayServer({
    maxSearchesPerMin: 1_000,
    port: 0, host: '127.0.0.1', persistDir: directories[index + 1],
    relayDiscovery: {
      endpoints: direct ? [endpoint(port)] : [],
      reachability: direct ? 'direct' : 'outbound-only',
      supportedGroups: ['public'],
      storage: { capacityBytes: 4_000_000, availableBytes: 3_000_000 },
    },
    relayLinks: {
      targets: [createRelayContactHintV1('configured', endpoint(CONTROLLER))],
      ...LINK_TIMING,
    },
    relayLinkHeartbeatIntervalMs: 1_000, relayLinkHeartbeatTimeoutMs: 15_000,
  });
  relayEndpoints.set(relay, testEndpoints[index + 1]); return relay;
}

function controller(volunteers: RelayServer[]): RelayServer {
  const relay = createRelayServer({
    maxSearchesPerMin: 1_000,
    port: 0, host: '127.0.0.1', persistDir: directories[0],
    desiredReplicaCount: 5, minimumHealthyReplicaCount: 3,
    replicaRepairIntervalMs: 1_000, replicaInventoryIntervalMs: 30_000,
    inboundReplicaTargetIds: volunteers.map(target => target.getRelayDescriptor()!.relayId),
    relayDiscovery: {
      endpoints: [endpoint(CONTROLLER)], reachability: 'direct',
      supportedGroups: ['public'],
      storage: { capacityBytes: 4_000_000, availableBytes: 3_000_000 },
    },
    relayLinkHeartbeatIntervalMs: 1_000, relayLinkHeartbeatTimeoutMs: 15_000,
  });
  relayEndpoints.set(relay, testEndpoints[0]); return relay;
}

function gateway(): RelayServer {
  const relay = createRelayServer({
    maxSearchesPerMin: 1_000,
    port: 0, host: '127.0.0.1', persistDir: directories[6],
    relayDiscovery: {
      endpoints: [], reachability: 'outbound-only', supportedGroups: ['public'],
      storage: { capacityBytes: 4_000_000, availableBytes: 3_000_000 },
    },
    relayLinks: {
      targets: [createRelayContactHintV1('configured', endpoint(VOLUNTEERS[DIRECT_VOLUNTEER]))],
      ...LINK_TIMING,
    },
    relayLinkHeartbeatIntervalMs: 1_000, relayLinkHeartbeatTimeoutMs: 15_000,
  });
  relayEndpoints.set(relay, testEndpoints[6]); return relay;
}

function request(port: number, raw: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint(port));
    const timer = setTimeout(() => { socket.terminate(); reject(new Error(`relay request to ${port} timed out`)); }, 15_000);
    socket.on('open', () => socket.send(raw));
    socket.on('message', data => {
      clearTimeout(timer);
      try { resolve(parseMessage(data.toString())); } catch (error) { reject(error); }
      socket.close();
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('close', (code, reason) => {
      clearTimeout(timer);
      reject(new Error(`relay request to ${port} closed before response (${code}: ${reason.toString()})`));
    });
  });
}

async function waitFor(
  check: () => boolean | Promise<boolean>, timeoutMs = 40_000,
  diagnostics?: () => unknown,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`v0.3 completion condition not met: ${JSON.stringify(diagnostics?.() ?? {})}`);
}

function publication(itemType: 'need' | 'offer') {
  const keys = generatePublicationKeyMaterial();
  const now = Date.now();
  return {
    keys,
    record: createPublicationRecord({
      groupId: 'public', fingerprintEpoch: 'v03-completion',
      fingerprint: new Uint8Array(64).fill(0x6d), itemType,
      createdAt: now, expiresAt: now + 240_000,
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
    let volunteers: RelayServer[], source: RelayServer, entry: RelayServer;
    const running = new Set<RelayServer>();
    const start = async (relay: RelayServer): Promise<void> => {
      await relay.start();
      running.add(relay); relayEndpoints.get(relay)!.forwardTo(relay.getListeningPort()!);
    };
    const stop = async (relay: RelayServer): Promise<void> => {
      await relay.stop({ graceful: false }); relayEndpoints.get(relay)!.disconnect();
      running.delete(relay);
    };
    try {
      testEndpoints = await createRelayTestEndpoints(7);
      CONTROLLER = testEndpoints[0].port; GATEWAY = testEndpoints[6].port;
      VOLUNTEERS.forEach((_, index) => { VOLUNTEERS[index] = testEndpoints[index + 1].port; });
      volunteers = VOLUNTEERS.map((_, index) => volunteer(index)); source = controller(volunteers); entry = gateway();
      await start(source);
      await Promise.all(volunteers.map(start));
      await start(entry);
      await waitFor(() => source.getRelayLinkStatus().inboundRelayIds.length === 5
        && volunteers.every(target => target.getRelayLinkStatus().connectedRelayIds.length === 1)
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
        && source.getRelayLinkStatus().inboundRelayIds.length === 5
        && volunteers.every(target => target.getRelayLinkStatus().connectedRelayIds.length === 1));
      await waitFor(async () => (await Promise.all(VOLUNTEERS.map(port => fetch(port, offer.record, offer.keys))))
        .every(envelopes => envelopes.length === 1 && envelopes[0].envelopeId === notices[0].envelopeId));

      const ack = await request(VOLUNTEERS[DIRECT_VOLUNTEER], serializeMailboxRequestFrame(
        createMailboxRequestFrame(createMailboxRequest('ack', offer.record, offer.keys,
          [notices[0].envelopeId], Date.now())),
      ));
      expect(ack.payload).toMatchObject({ status: 'ok', message: 'acknowledged:1' });
      let remainingEnvelopes: number[] = [];
      await waitFor(async () => {
        remainingEnvelopes = (await Promise.all([CONTROLLER, ...VOLUNTEERS]
          .map(port => fetch(port, offer.record, offer.keys)))).map(envelopes => envelopes.length);
        return remainingEnvelopes.every(count => count === 0);
      }, 40_000, () => ({
        phase: 'acknowledgement propagation', remainingEnvelopes,
        controller: source.getRelayLinkStatus(),
        volunteers: volunteers.map(target => target.getRelayLinkStatus()),
      }));

      const tombstone = createPublicationTombstone(
        offer.record, 'withdrawn', offer.keys.signingKeyPair, Date.now(),
      );
      expect((await request(CONTROLLER, serializePublicationOperationFrame(
        createPublicationOperationFrame(tombstone),
      ))).payload).toMatchObject({ status: 'ok' });
      await waitFor(() => volunteers.every(target => target.getStats().active_publications === 1));
      expect(await fetch(VOLUNTEERS[DIRECT_VOLUNTEER], offer.record, offer.keys)).toEqual([]);
    } finally {
      const stopped = await Promise.allSettled([...running].map(relay => relay.stop({ graceful: false })));
      const closed = await Promise.allSettled(testEndpoints.map(endpoint => endpoint.close())); relayEndpoints.clear();
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
      const failures = [...stopped, ...closed].filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Completion fixture cleanup failed');
    }
  }, 180_000);
});
