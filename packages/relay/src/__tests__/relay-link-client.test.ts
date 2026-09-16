import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import WebSocket from 'ws';
import {
  createPublicationOperationFrame,
  createPublicationRecord,
  createPublicationTombstone,
  createRelayContactHintV1,
  createRelayDescriptorV1,
  generateIdentity,
  generatePublicationKeyMaterial,
  serializePublicationOperationFrame,
  verifyRelayReplicaInventoryResponseV1,
  verifyRelayReplicaReceiptV1,
  type PublicationOperation,
} from '@resonance/core';
import { RelayLinkManager, connectRelayLinkV1 } from '../relay-link-client.js';
import { createRelayServer, type RelayServer } from '../server.js';

const HUB_PORT = 24_500 + Math.floor(Math.random() * 500);
const SPOKE_PORT = HUB_PORT + 600;
const HUB_DIR = `/tmp/resonance-link-hub-${Date.now()}`;
const SPOKE_DIR = `/tmp/resonance-link-spoke-${Date.now()}`;
const HUB_ENDPOINT = `ws://127.0.0.1:${HUB_PORT}/`;

let hub: RelayServer;
let spoke: RelayServer;

function createHub(): RelayServer {
  return createRelayServer({
    port: HUB_PORT,
    host: '127.0.0.1',
    persistDir: HUB_DIR,
    relayDiscovery: {
      endpoints: [HUB_ENDPOINT],
      reachability: 'direct',
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      descriptorLifetimeMs: 5_000,
    },
    relayLinkHeartbeatIntervalMs: 100,
    relayLinkHeartbeatTimeoutMs: 1_500,
  });
}

function submitToSpoke(operation: PublicationOperation): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${SPOKE_PORT}/`);
    const timeout = setTimeout(() => reject(new Error('publication submission timed out')), 3_000);
    ws.on('open', () => {
      ws.send(serializePublicationOperationFrame(createPublicationOperationFrame(operation)));
    });
    ws.on('message', () => {
      clearTimeout(timeout);
      ws.close();
      resolve();
    });
    ws.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

beforeAll(async () => {
  hub = createHub();
  spoke = createRelayServer({
    port: SPOKE_PORT,
    host: '127.0.0.1',
    persistDir: SPOKE_DIR,
    relayDiscovery: {
      endpoints: [],
      reachability: 'outbound-only',
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      descriptorLifetimeMs: 5_000,
    },
    relayLinks: {
      targets: [createRelayContactHintV1('configured', HUB_ENDPOINT)],
      maxConnections: 2,
      handshakeTimeoutMs: 1_000,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 1_500,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
    },
    relayLinkHeartbeatIntervalMs: 100,
    relayLinkHeartbeatTimeoutMs: 1_500,
  });
  await hub.start();
  await spoke.start();
});

afterAll(async () => {
  await spoke.stop();
  await hub.stop();
  rmSync(HUB_DIR, { recursive: true, force: true });
  rmSync(SPOKE_DIR, { recursive: true, force: true });
});

describe('authenticated outbound relay links', () => {
  it('rejects a reachable relay that does not match an invitation pin', async () => {
    const initiator = generateIdentity();
    const wrongRelay = generateIdentity();
    const now = Date.now();
    const descriptor = createRelayDescriptorV1({
      sequence: 1,
      endpoints: [],
      reachability: 'outbound-only',
      capabilities: {
        storesPublications: true,
        storesMailboxes: true,
        answersQueries: true,
        forwardsQueries: false,
        replicaExchange: false,
      },
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      issuedAt: now,
      expiresAt: now + 30_000,
    }, initiator);
    const hint = createRelayContactHintV1('invitation', HUB_ENDPOINT, wrongRelay.did);

    await expect(connectRelayLinkV1(hint, descriptor, initiator, {
      handshakeTimeoutMs: 1_000,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 250,
    })).rejects.toThrow('does not match the pinned relay identity');
    await waitFor(() => !hub.getRelayLinkStatus().inboundRelayIds.includes(initiator.did));
  });

  it('returns a signed rejection for a replica outside its advertised groups', async () => {
    const storedBefore = hub.getStats().stored_publications;
    const identity = generateIdentity();
    const now = Date.now();
    const descriptor = createRelayDescriptorV1({
      sequence: 1,
      endpoints: [],
      reachability: 'outbound-only',
      capabilities: {
        storesPublications: true,
        storesMailboxes: true,
        answersQueries: true,
        forwardsQueries: false,
        replicaExchange: true,
      },
      supportedGroups: ['private'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      issuedAt: now,
      expiresAt: now + 30_000,
    }, identity);
    const connection = await connectRelayLinkV1(
      createRelayContactHintV1('configured', HUB_ENDPOINT),
      descriptor,
      identity,
      {
        handshakeTimeoutMs: 1_000,
        heartbeatIntervalMs: 100,
        heartbeatTimeoutMs: 1_500,
        replicaRequestTimeoutMs: 1_000,
      },
    );
    const operation = createPublicationRecord({
      groupId: 'private',
      fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0x3c),
      itemType: 'need',
      createdAt: now,
      expiresAt: now + 60_000,
    }, generatePublicationKeyMaterial());

    const receipt = await connection.placeReplica(operation);
    expect(verifyRelayReplicaReceiptV1(receipt)).toBe(true);
    expect(receipt.status).toBe('rejected');
    expect(receipt.reason).toBe('unsupported-group');
    expect(hub.getStats().stored_publications).toBe(storedBefore);
    connection.close();
    await connection.closed;
    await waitFor(() => !hub.getRelayLinkStatus().inboundRelayIds.includes(identity.did));
  });

  it('keeps an outbound-only relay reachable through a direct relay', async () => {
    await waitFor(() => spoke.getRelayLinkStatus().connectedRelayIds.length === 1);

    const spokeId = spoke.getRelayDescriptor()!.relayId;
    const hubId = hub.getRelayDescriptor()!.relayId;
    expect(spoke.getRelayLinkStatus().connectedRelayIds).toEqual([hubId]);
    expect(hub.getRelayLinkStatus().inboundRelayIds).toEqual([spokeId]);
    expect(spoke.getStats().connected_relays).toBe(1);
    expect(hub.getStats().connected_relays).toBe(1);
    expect(hub.getKnownRelayDescriptors().find(value => value.relayId === spokeId)?.reachability)
      .toBe('outbound-only');

    await new Promise(resolve => setTimeout(resolve, 300));
    await waitFor(() => spoke.getRelayLinkStatus().connectedRelayIds.includes(hubId)
      && hub.getRelayLinkStatus().inboundRelayIds.includes(spokeId));
    expect(spoke.getRelayLinkStatus().connectedRelayIds).toEqual([hubId]);
    expect(hub.getRelayLinkStatus().inboundRelayIds).toEqual([spokeId]);
  });

  it('places publications and tombstones durably and collects signed receipts', async () => {
    await waitFor(() => spoke.getRelayLinkStatus().connectedRelayIds.length === 1);
    const keys = generatePublicationKeyMaterial();
    const now = Date.now();
    const publication = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0x5a),
      itemType: 'offer',
      createdAt: now,
      expiresAt: now + 60_000,
    }, keys);

    await submitToSpoke(publication);
    await waitFor(() => hub.getStats().active_publications === 1
      && spoke.getReplicaReceipts(publication.publicationId).length === 1);
    const publicationReceipt = spoke.getReplicaReceipts(publication.publicationId)[0];
    expect(publicationReceipt.status).toBe('stored');
    expect(publicationReceipt.operationSignature).toBe(publication.signature);
    expect(publicationReceipt.responderRelayId).toBe(hub.getRelayDescriptor()!.relayId);
    expect(spoke.getStats().durability_receipts).toBe(1);

    await submitToSpoke(publication);
    await waitFor(() => spoke.getReplicaReceipts(publication.publicationId)[0]?.status
      === 'already-stored');

    const tombstone = createPublicationTombstone(
      publication,
      'withdrawn',
      keys.signingKeyPair,
      Date.now(),
    );
    await submitToSpoke(tombstone);
    await waitFor(() => hub.getStats().retained_tombstones === 1
      && spoke.getReplicaReceipts(publication.publicationId)[0]?.operationSequence
        === tombstone.sequence);

    const tombstoneReceipt = spoke.getReplicaReceipts(publication.publicationId)[0];
    expect(tombstoneReceipt.status).toBe('stored');
    expect(tombstoneReceipt.operationKind).toBe('publication-tombstone');
    expect(tombstoneReceipt.operationSignature).toBe(tombstone.signature);
    expect(hub.getStats().active_publications).toBe(0);
  });

  it('reconnects after the directly reachable relay restarts and replays its durable replicas', async () => {
    const hubId = hub.getRelayDescriptor()!.relayId;
    const spokeId = spoke.getRelayDescriptor()!.relayId;
    await hub.stop();
    await waitFor(() => spoke.getRelayLinkStatus().connectedRelayIds.length === 0);

    hub = createHub();
    await hub.start();
    await waitFor(() => spoke.getRelayLinkStatus().connectedRelayIds.includes(hubId));

    expect(hub.getRelayDescriptor()!.relayId).toBe(hubId);
    expect(hub.getRelayLinkStatus().inboundRelayIds).toEqual([spokeId]);
    expect(hub.getStats().retained_tombstones).toBe(1);
  });

  it('checks an exact replica with its prior target-signed receipt', async () => {
    const identity = generateIdentity();
    const now = Date.now();
    const descriptor = createRelayDescriptorV1({
      sequence: 1,
      endpoints: [],
      reachability: 'outbound-only',
      capabilities: {
        storesPublications: true,
        storesMailboxes: true,
        answersQueries: true,
        forwardsQueries: false,
        replicaExchange: true,
      },
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      issuedAt: now,
      expiresAt: now + 30_000,
    }, identity);
    const connection = await connectRelayLinkV1(
      createRelayContactHintV1('configured', HUB_ENDPOINT),
      descriptor,
      identity,
      {
        handshakeTimeoutMs: 1_000,
        heartbeatIntervalMs: 100,
        heartbeatTimeoutMs: 1_500,
        replicaRequestTimeoutMs: 1_000,
      },
    );
    const keys = generatePublicationKeyMaterial();
    const operation = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0x69),
      itemType: 'offer',
      createdAt: now,
      expiresAt: now + 60_000,
    }, keys);

    const receipt = await connection.placeReplica(operation);
    expect(receipt.status).toBe('stored');
    const present = await connection.checkReplica(receipt);
    expect(verifyRelayReplicaInventoryResponseV1(present)).toBe(true);
    expect(present.status).toBe('present');

    const tombstone = createPublicationTombstone(
      operation,
      'withdrawn',
      keys.signingKeyPair,
      Date.now(),
    );
    expect((await connection.placeReplica(tombstone)).status).toBe('stored');
    const missing = await connection.checkReplica(receipt);
    expect(missing.status).toBe('missing');

    const stale = await connection.placeReplica(operation);
    expect(stale.status).toBe('rejected');
    expect(['stale', 'terminal']).toContain(stale.reason);
    connection.close();
    await connection.closed;
    await waitFor(() => !hub.getRelayLinkStatus().inboundRelayIds.includes(identity.did));
  });

  it('checks multiple receipt-holders on one target without dropping any request', async () => {
    const identity = generateIdentity();
    const now = Date.now();
    const descriptor = createRelayDescriptorV1({
      sequence: 1,
      endpoints: [],
      reachability: 'outbound-only',
      capabilities: {
        storesPublications: true,
        storesMailboxes: true,
        answersQueries: true,
        forwardsQueries: false,
        replicaExchange: true,
      },
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      issuedAt: now,
      expiresAt: now + 30_000,
    }, identity);
    const manager = new RelayLinkManager(identity, () => descriptor, {
      targets: [createRelayContactHintV1('configured', HUB_ENDPOINT)],
      maxConnections: 1,
      handshakeTimeoutMs: 1_000,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 1_500,
      replicaRequestTimeoutMs: 1_000,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
    });
    manager.start();
    await waitFor(() => manager.status().connectedRelayIds.length === 1);
    const targetId = manager.status().connectedRelayIds[0];
    const operations = [0x70, 0x71].map(byte => createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(byte),
      itemType: 'offer',
      createdAt: now,
      expiresAt: now + 60_000,
    }, generatePublicationKeyMaterial()));
    const receipts = (await Promise.all(operations.map(operation => (
      manager.replicateTo(operation, [targetId])
    )))).flat();
    expect(receipts).toHaveLength(2);

    const responses = await manager.checkReplicaReceipts(receipts);
    expect(responses).toHaveLength(2);
    expect(responses.map(response => response.status)).toEqual(['present', 'present']);
    manager.stop();
    await waitFor(() => !hub.getRelayLinkStatus().inboundRelayIds.includes(identity.did));
  });

  it('renews the link before continuing with expired descriptors', async () => {
    const spokeId = spoke.getRelayDescriptor()!.relayId;
    const initialSequence = hub.getKnownRelayDescriptors()
      .find(value => value.relayId === spokeId)!.sequence;

    await waitFor(() => {
      const observed = hub.getKnownRelayDescriptors().find(value => value.relayId === spokeId);
      return observed !== undefined
        && observed.sequence > initialSequence
        && spoke.getRelayLinkStatus().connectedRelayIds.length === 1
        && hub.getRelayLinkStatus().inboundRelayIds.includes(spokeId);
    }, 12_000);

    expect(spoke.getRelayLinkStatus().connectedRelayIds).toHaveLength(1);
    expect(hub.getRelayLinkStatus().inboundRelayIds).toEqual([spokeId]);
  });

  it('re-authenticates an active link on its descriptor refresh interval', async () => {
    const identity = generateIdentity();
    const now = Date.now();
    const descriptor = createRelayDescriptorV1({
      sequence: 1,
      endpoints: [],
      reachability: 'outbound-only',
      capabilities: {
        storesPublications: true,
        storesMailboxes: true,
        answersQueries: true,
        forwardsQueries: false,
        replicaExchange: true,
      },
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      issuedAt: now,
      expiresAt: now + 30_000,
    }, identity);
    const connection = await connectRelayLinkV1(
      createRelayContactHintV1('configured', HUB_ENDPOINT),
      descriptor,
      identity,
      {
        handshakeTimeoutMs: 1_000,
        heartbeatIntervalMs: 100,
        heartbeatTimeoutMs: 1_500,
        descriptorRefreshIntervalMs: 100,
      },
    );

    await expect(connection.closed).resolves.toEqual({
      code: 1000,
      reason: 'relay_descriptor_refresh',
    });
    await waitFor(() => !hub.getRelayLinkStatus().inboundRelayIds.includes(identity.did));
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for relay link state');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
