import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMailboxRequest, createMailboxRequestFrame,
  createPublicationOperationFrame, createPublicationRecord, createPublicationTombstone,
  createRelayContactHintV1, generatePublicationKeyMaterial,
  createChannelMessageOperationV2, createPairwiseChannelId,
  createRelationshipMailboxDepositFrameV2, createRelationshipMailboxDepositV2,
  createRelationshipMailboxRequestFrameV2, createRelationshipMailboxRequestV2,
  encryptChannelOperationV2, generateRelationshipKeyMaterial,
  parseMessage, serializeMailboxRequestFrame, serializePublicationOperationFrame,
  serializeRelationshipMailboxDepositFrameV2, serializeRelationshipMailboxRequestFrameV2,
  type Message, type PublicationKeyMaterial, type PublicationRecord, type RelationshipKeyMaterial,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '../server.js';
import { loadOrCreateRelayIdentity } from '../relay-identity-store.js';

const RUN_DIR = mkdtempSync(join(tmpdir(), 'resonance-reverse-placement-'));
const CONTROLLER_DIR = join(RUN_DIR, 'controller');
const VOLUNTEER_DIRS = Array.from({ length: 6 }, (_, index) => join(RUN_DIR, `volunteer-${index}`));
let controllerEndpoint: string, controllerPort: number;
let controller: RelayServer;
const volunteers: RelayServer[] = [];

function createVolunteer(index: number): RelayServer {
  return createRelayServer({
    maxSearchesPerMin: 1_000,
    port: 0,
    host: '127.0.0.1',
    persistDir: VOLUNTEER_DIRS[index],
    relayDiscovery: {
      endpoints: [], reachability: 'outbound-only', supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      descriptorLifetimeMs: 60_000,
    },
    relayLinks: {
      targets: [createRelayContactHintV1('configured', controllerEndpoint)],
      handshakeTimeoutMs: 15_000, heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 15_000, reconnectBaseMs: 50, reconnectMaxMs: 200,
    },
    relayLinkHeartbeatIntervalMs: 1_000,
    relayLinkHeartbeatTimeoutMs: 15_000,
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for reverse-link placement');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function fetchRelationship(port: number, keys: RelationshipKeyMaterial): Promise<string[]> {
  const response = await request(port, serializeRelationshipMailboxRequestFrameV2(
    createRelationshipMailboxRequestFrameV2(createRelationshipMailboxRequestV2('fetch', keys)),
  )) as Message<{ envelopes: Array<{ envelopeId: string }> }>;
  return response.payload.envelopes.map(envelope => envelope.envelopeId);
}

function request(port: number, raw: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error(`request to ${port} timed out`)); }, 15_000);
    socket.on('open', () => socket.send(raw));
    socket.on('message', data => {
      clearTimeout(timer);
      socket.close();
      resolve(parseMessage(data.toString()));
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('close', (code, reason) => {
      clearTimeout(timer);
      reject(new Error(`request to ${port} closed before response (${code}: ${reason.toString()})`));
    });
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
  // Establish approved identities before the controller binds its OS-assigned port.
  const approvedIds = VOLUNTEER_DIRS.slice(0, 5).map(directory => loadOrCreateRelayIdentity(directory).did);
  controller = createRelayServer({
    maxSearchesPerMin: 1_000,
    port: 0, host: '127.0.0.1', persistDir: CONTROLLER_DIR,
    desiredReplicaCount: 5, minimumHealthyReplicaCount: 3,
    inboundReplicaTargetIds: approvedIds,
    replicaRepairIntervalMs: 250, replicaInventoryIntervalMs: 2_000,
    relayLinkHeartbeatIntervalMs: 1_000, relayLinkHeartbeatTimeoutMs: 15_000,
    relayDiscovery: {
      endpoints: ['ws://127.0.0.1:0/'], reachability: 'direct',
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      descriptorLifetimeMs: 60_000,
    },
  });
  await controller.start();
  controllerEndpoint = controller.getRelayDescriptor()!.endpoints[0];
  controllerPort = controller.getListeningPort()!;
  for (let index = 0; index < 6; index++) volunteers.push(createVolunteer(index));
  for (const volunteer of volunteers) await volunteer.start();
});

afterAll(async () => {
  await Promise.all(volunteers.map(volunteer => volunteer.stop({ graceful: false })));
  await controller?.stop({ graceful: false });
  rmSync(RUN_DIR, { recursive: true, force: true });
});

describe('reverse-link placement onto NAT-style volunteers', () => {
  it('places a relationship mailbox through approved volunteers’ outbound links', async () => {
    await waitFor(() => controller.getRelayLinkStatus().inboundRelayIds.length === 6);
    const sender = generateRelationshipKeyMaterial();
    const recipient = generateRelationshipKeyMaterial();
    const operation = createChannelMessageOperationV2(
      createPairwiseChannelId('match_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sender.relationshipId, recipient.relationshipId),
      recipient.relationshipId, 1,
      { kind: 'disclosure', text: 'reverse link', level: 'general', createdAt: Date.now() },
      randomBytes(32), sender,
    );
    const envelope = encryptChannelOperationV2(operation, {
      id: recipient.mailboxId,
      encryptionKey: Buffer.from(recipient.mailboxKeyPair.publicKey).toString('base64'),
    });
    expect((await request(controllerPort, serializeRelationshipMailboxDepositFrameV2(
      createRelationshipMailboxDepositFrameV2(createRelationshipMailboxDepositV2(
        recipient.relationshipId, sender, envelope,
      )),
    ))).payload).toMatchObject({ status: 'ok' });
    await waitFor(async () => (await Promise.all(
      [0, 1, 2, 3, 4].map(index => fetchRelationship(volunteers[index].getListeningPort()!, recipient)),
    )).every(ids => ids.includes(envelope.envelopeId)));
    expect(await fetchRelationship(volunteers[5].getListeningPort()!, recipient)).toEqual([]);
  }, 60_000);

  it('reaches five signed receipts and repairs a lost volunteer over its outbound link', async () => {
    await waitFor(() => controller.getRelayLinkStatus().inboundRelayIds.length === 6);
    expect(controller.getRelayLinkStatus().connectedRelayIds).toHaveLength(0);
    const now = Date.now();
    const keys = generatePublicationKeyMaterial();
    const record = createPublicationRecord({
      groupId: 'public', fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0x35), itemType: 'offer',
      createdAt: now, expiresAt: now + 600_000,
    }, keys);
    expect((await request(controllerPort, serializePublicationOperationFrame(
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
      createdAt: Date.now(), expiresAt: Date.now() + 600_000,
    }, matchingKeys);
    expect((await request(controllerPort, serializePublicationOperationFrame(
      createPublicationOperationFrame(matching),
    ))).payload).toMatchObject({ status: 'ok' });
    await waitFor(() => controller.getReplicaPlacementStatus(matching.publicationId)?.targetConfirmed === true);
    await waitFor(() => volunteers.slice(0, 5)
      .every(volunteer => volunteer.getStats().active_publications === 2));
    const noticeIds = await fetch(controllerPort, record, keys);
    expect(noticeIds).toHaveLength(1);
    await waitFor(() => volunteers.slice(0, 5)
      .every(volunteer => volunteer.getStats().mailbox_envelopes > 0));
    for (let index = 0; index < 5; index++) {
      expect(await fetch(volunteers[index].getListeningPort()!, record, keys)).toContain(noticeIds[0]);
    }

    const tombstone = createPublicationTombstone(
      record, 'withdrawn', keys.signingKeyPair, Date.now(),
    );
    expect((await request(controllerPort, serializePublicationOperationFrame(
      createPublicationOperationFrame(tombstone),
    ))).payload).toMatchObject({ status: 'ok' });
    await waitFor(() => volunteers.slice(0, 5)
      .every(volunteer => volunteer.getStats().active_publications === 1));
    expect(volunteers[5].getStats().active_publications).toBe(0);
  }, 180_000);
});
