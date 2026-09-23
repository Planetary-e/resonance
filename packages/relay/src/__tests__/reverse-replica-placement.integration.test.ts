import { rmSync } from 'node:fs';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMailboxRequest, createMailboxRequestFrame,
  createPublicationOperationFrame, createPublicationRecord, createPublicationTombstone,
  createRelayContactHintV1, generatePublicationKeyMaterial,
  parseMessage, serializeMailboxRequestFrame, serializePublicationOperationFrame,
  type Message, type PublicationKeyMaterial, type PublicationRecord,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '../server.js';

const BASE = 36_000 + Math.floor(Math.random() * 1_000);
const RUN = `${Date.now()}-${BASE}`;
const CONTROLLER_DIR = `/tmp/resonance-reverse-controller-${RUN}`;
const VOLUNTEER_DIRS = Array.from({ length: 6 }, (_, index) => (
  `/tmp/resonance-reverse-volunteer-${index}-${RUN}`
));
let controller: RelayServer;
const volunteers: RelayServer[] = [];

function createVolunteer(index: number): RelayServer {
  return createRelayServer({
    port: BASE + index + 1,
    host: '127.0.0.1',
    persistDir: VOLUNTEER_DIRS[index],
    relayDiscovery: {
      endpoints: [], reachability: 'outbound-only', supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      descriptorLifetimeMs: 60_000,
    },
    relayLinks: {
      targets: [createRelayContactHintV1('configured', `ws://127.0.0.1:${BASE}/`)],
      handshakeTimeoutMs: 2_000, heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 1_500, reconnectBaseMs: 50, reconnectMaxMs: 200,
    },
    relayLinkHeartbeatIntervalMs: 100,
    relayLinkHeartbeatTimeoutMs: 1_500,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for reverse-link placement');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function request(port: number, raw: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('request timed out')); }, 5_000);
    socket.on('open', () => socket.send(raw));
    socket.on('message', data => {
      clearTimeout(timer);
      socket.close();
      resolve(parseMessage(data.toString()));
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function fetch(
  port: number, record: PublicationRecord, keys: PublicationKeyMaterial,
): Promise<string[]> {
  const response = await request(port, serializeMailboxRequestFrame(createMailboxRequestFrame(
    createMailboxRequest('fetch', record, keys, [], Date.now()),
  ))) as Message<{ envelopes: Array<{ envelopeId: string }> }>;
  return response.payload.envelopes.map(envelope => envelope.envelopeId);
}

beforeAll(async () => {
  for (let index = 0; index < 6; index++) volunteers.push(createVolunteer(index));
  controller = createRelayServer({
    port: BASE, host: '127.0.0.1', persistDir: CONTROLLER_DIR,
    desiredReplicaCount: 5, minimumHealthyReplicaCount: 3,
    inboundReplicaTargetIds: volunteers.slice(0, 5)
      .map(volunteer => volunteer.getRelayDescriptor()!.relayId),
    replicaRepairIntervalMs: 100, replicaInventoryIntervalMs: 300,
    relayLinkHeartbeatIntervalMs: 100, relayLinkHeartbeatTimeoutMs: 1_500,
    relayDiscovery: {
      endpoints: [`ws://127.0.0.1:${BASE}/`], reachability: 'direct',
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      descriptorLifetimeMs: 60_000,
    },
  });
  await controller.start();
  for (const volunteer of volunteers) await volunteer.start();
});

afterAll(async () => {
  await Promise.all(volunteers.map(volunteer => volunteer.stop({ graceful: false })));
  await controller.stop({ graceful: false });
  rmSync(CONTROLLER_DIR, { recursive: true, force: true });
  for (const dir of VOLUNTEER_DIRS) rmSync(dir, { recursive: true, force: true });
});

describe('reverse-link placement onto NAT-style volunteers', () => {
  it('reaches five signed receipts and repairs a lost volunteer over its outbound link', async () => {
    await waitFor(() => controller.getRelayLinkStatus().inboundRelayIds.length === 6);
    expect(controller.getRelayLinkStatus().connectedRelayIds).toHaveLength(0);
    const now = Date.now();
    const keys = generatePublicationKeyMaterial();
    const record = createPublicationRecord({
      groupId: 'public', fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0x35), itemType: 'offer',
      createdAt: now, expiresAt: now + 60_000,
    }, keys);
    expect((await request(BASE, serializePublicationOperationFrame(
      createPublicationOperationFrame(record),
    ))).payload).toMatchObject({ status: 'ok' });
    await waitFor(() => controller.getReplicaPlacementStatus(record.publicationId)?.targetConfirmed === true);
    expect(controller.getReplicaPlacementStatus(record.publicationId)).toMatchObject({
      confirmedReplicaCount: 5, minimumConfirmed: true,
    });
    expect(volunteers.slice(0, 5).every(volunteer => volunteer.getStats().active_publications === 1)).toBe(true);
    expect(volunteers[5].getStats().active_publications).toBe(0);
    expect(controller.getReplicaPlacementStatus(record.publicationId)?.intent.targetRelayIds)
      .not.toContain(volunteers[5].getRelayDescriptor()!.relayId);

    const firstId = volunteers[0].getRelayDescriptor()!.relayId;
    const oldReceipt = controller.getReplicaReceipts(record.publicationId)
      .find(receipt => receipt.responderRelayId === firstId)!;
    await volunteers[0].stop({ graceful: false });
    rmSync(`${VOLUNTEER_DIRS[0]}/relay-operations.ndjson`, { force: true });
    volunteers[0] = createVolunteer(0);
    await volunteers[0].start();
    await waitFor(() => volunteers[0].getStats().active_publications === 1);
    await waitFor(() => controller.getReplicaReceipts(record.publicationId)
      .some(receipt => receipt.responderRelayId === firstId
        && receipt.requestId !== oldReceipt.requestId));
    expect(controller.getReplicaPlacementStatus(record.publicationId)?.confirmedReplicaCount).toBe(5);

    const matchingKeys = generatePublicationKeyMaterial();
    const matching = createPublicationRecord({
      groupId: 'public', fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0x35), itemType: 'need',
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    }, matchingKeys);
    expect((await request(BASE, serializePublicationOperationFrame(
      createPublicationOperationFrame(matching),
    ))).payload).toMatchObject({ status: 'ok' });
    await waitFor(() => controller.getReplicaPlacementStatus(matching.publicationId)?.targetConfirmed === true);
    await waitFor(() => volunteers.slice(0, 5)
      .every(volunteer => volunteer.getStats().active_publications === 2));
    const noticeIds = await fetch(BASE, record, keys);
    expect(noticeIds).toHaveLength(1);
    await waitFor(() => volunteers.slice(0, 5)
      .every(volunteer => volunteer.getStats().mailbox_envelopes > 0));
    for (let index = 0; index < 5; index++) {
      expect(await fetch(BASE + index + 1, record, keys)).toContain(noticeIds[0]);
    }

    const tombstone = createPublicationTombstone(
      record, 'withdrawn', keys.signingKeyPair, Date.now(),
    );
    expect((await request(BASE, serializePublicationOperationFrame(
      createPublicationOperationFrame(tombstone),
    ))).payload).toMatchObject({ status: 'ok' });
    await waitFor(() => volunteers.slice(0, 5)
      .every(volunteer => volunteer.getStats().active_publications === 1));
    expect(volunteers[5].getStats().active_publications).toBe(0);
  }, 30_000);
});
