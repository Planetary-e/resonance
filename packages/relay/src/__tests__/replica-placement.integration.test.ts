import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import WebSocket from 'ws';
import {
  createPublicationOperationFrame,
  createPublicationRecord,
  createRelayContactHintV1,
  generatePublicationKeyMaterial,
  serializePublicationOperationFrame,
  type PublicationOperation,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '../server.js';

const BASE_PORT = 26_000 + Math.floor(Math.random() * 1_000);
const SOURCE_PORT = BASE_PORT;
const TARGET_PORTS = [1, 2, 3, 4, 5, 6].map(offset => BASE_PORT + offset);
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const SOURCE_DIR = `/tmp/resonance-placement-source-${RUN_ID}`;
const TARGET_DIRS = TARGET_PORTS.map(port => `/tmp/resonance-placement-target-${port}-${RUN_ID}`);

let source: RelayServer;
const targets: RelayServer[] = [];
const startedTargets = new Set<RelayServer>();
let sourceStarted = false;

function targetEndpoint(port: number): string {
  return `ws://127.0.0.1:${port}/`;
}

function createTarget(index: number): RelayServer {
  const port = TARGET_PORTS[index];
  return createRelayServer({
    port,
    host: '127.0.0.1',
    persistDir: TARGET_DIRS[index],
    relayDiscovery: {
      endpoints: [targetEndpoint(port)],
      reachability: 'direct',
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      descriptorLifetimeMs: 60_000,
    },
    relayLinkHeartbeatIntervalMs: 100,
    relayLinkHeartbeatTimeoutMs: 1_500,
  });
}

function createSource(): RelayServer {
  return createRelayServer({
    port: SOURCE_PORT,
    host: '127.0.0.1',
    persistDir: SOURCE_DIR,
    desiredReplicaCount: 5,
    minimumHealthyReplicaCount: 3,
    replicaRepairIntervalMs: 100,
    replicaInventoryIntervalMs: 100,
    relayDiscovery: {
      endpoints: [],
      reachability: 'outbound-only',
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      descriptorLifetimeMs: 60_000,
    },
    relayLinks: {
      targets: TARGET_PORTS.map(port => createRelayContactHintV1('configured', targetEndpoint(port))),
      maxConnections: 6,
      handshakeTimeoutMs: 1_000,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 1_500,
      replicaRequestTimeoutMs: 1_000,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
    },
    relayLinkHeartbeatIntervalMs: 100,
    relayLinkHeartbeatTimeoutMs: 1_500,
  });
}

function submit(operation: PublicationOperation): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${SOURCE_PORT}/`);
    const timer = setTimeout(() => reject(new Error('publication submission timed out')), 3_000);
    ws.on('open', () => {
      ws.send(serializePublicationOperationFrame(createPublicationOperationFrame(operation)));
    });
    ws.on('message', () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

beforeAll(async () => {
  for (let index = 0; index < TARGET_PORTS.length; index++) targets.push(createTarget(index));
  await Promise.all(targets.slice(0, 3).map(target => target.start()));
  for (const target of targets.slice(0, 3)) startedTargets.add(target);
  source = createSource();
  await source.start();
  sourceStarted = true;
});

afterAll(async () => {
  if (sourceStarted) await source.stop({ graceful: false });
  await Promise.all([...startedTargets].map(target => target.stop({ graceful: false })));
  rmSync(SOURCE_DIR, { recursive: true, force: true });
  for (const directory of TARGET_DIRS) rmSync(directory, { recursive: true, force: true });
});

describe('durable replica placement', () => {
  it('repairs from three receipt-confirmed configured relays to five and survives restart', async () => {
    await waitFor(() => source.getRelayLinkStatus().connectedRelayIds.length === 3);
    const keys = generatePublicationKeyMaterial();
    const now = Date.now();
    const operation = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0x42),
      itemType: 'need',
      createdAt: now,
      expiresAt: now + 60_000,
    }, keys);

    await submit(operation);
    await waitFor(() => {
      const status = source.getReplicaPlacementStatus(operation.publicationId);
      return status?.confirmedReplicaCount === 3 && status.minimumConfirmed;
    });
    const initial = source.getReplicaPlacementStatus(operation.publicationId)!;
    expect(initial.intent.targetRelayIds).toHaveLength(3);
    expect(initial.targetConfirmed).toBe(false);
    expect(source.getStats()).toMatchObject({
      durability_receipts: 3,
      placement_intents: 1,
      minimum_confirmed_placements: 1,
    });

    await Promise.all(targets.slice(3).map(target => target.start()));
    for (const target of targets.slice(3)) startedTargets.add(target);
    await waitFor(() => source.getRelayLinkStatus().connectedRelayIds.length === 6, 15_000);
    await waitFor(() => source.getReplicaPlacementStatus(operation.publicationId)?.targetConfirmed === true, 15_000);
    const repaired = source.getReplicaPlacementStatus(operation.publicationId)!;
    expect(repaired.confirmedReplicaCount).toBe(5);
    expect(repaired.intent.targetRelayIds).toHaveLength(5);
    await waitFor(() => {
      const selected = new Set(
        source.getReplicaPlacementStatus(operation.publicationId)?.intent.targetRelayIds ?? [],
      );
      return targets.every(target => !selected.has(target.getRelayDescriptor()!.relayId)
        || target.getStats().active_publications === 1);
    });

    const lostTarget = targets[0];
    const lostTargetId = lostTarget.getRelayDescriptor()!.relayId;
    const oldReceipt = source.getReplicaReceipts(operation.publicationId)
      .find(receipt => receipt.responderRelayId === lostTargetId)!;
    // Simulate an abrupt loss: a graceful stop intentionally asks the source
    // to retire this relay from the exact placement generation.
    await lostTarget.stop({ graceful: false });
    startedTargets.delete(lostTarget);
    rmSync(`${TARGET_DIRS[0]}/relay-operations.ndjson`, { force: true });

    const recoveredTarget = createTarget(0);
    targets[0] = recoveredTarget;
    await recoveredTarget.start();
    startedTargets.add(recoveredTarget);
    expect(recoveredTarget.getRelayDescriptor()!.relayId).toBe(lostTargetId);
    expect(recoveredTarget.getStats().active_publications).toBe(0);

    await waitFor(() => source.getRelayLinkStatus().connectedRelayIds.length === 6, 15_000);
    await waitFor(() => recoveredTarget.getStats().active_publications === 1, 15_000);
    await waitFor(() => source.getReplicaReceipts(operation.publicationId)
      .some(receipt => receipt.responderRelayId === lostTargetId
        && receipt.requestId !== oldReceipt.requestId), 15_000);
    expect(source.getReplicaPlacementStatus(operation.publicationId)).toMatchObject({
      confirmedReplicaCount: 5,
      inventoryMissingRelayIds: [],
    });

    await source.stop();
    source = createSource();
    await source.start();
    await waitFor(() => source.getReplicaPlacementStatus(operation.publicationId)?.confirmedReplicaCount === 5);
    expect(source.getReplicaPlacementStatus(operation.publicationId)).toMatchObject({
      minimumConfirmed: true,
      targetConfirmed: true,
      confirmedReplicaCount: 5,
    });
    expect(source.getReplicaReceipts(operation.publicationId)).toHaveLength(5);
  }, 30_000);

  it('replaces a receipt-confirmed relay after its signed graceful handoff', async () => {
    await waitFor(() => source.getRelayLinkStatus().connectedRelayIds.length === 6, 15_000);
    const now = Date.now();
    const operation = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0x53),
      itemType: 'offer',
      createdAt: now,
      expiresAt: now + 60_000,
    }, generatePublicationKeyMaterial());

    await submit(operation);
    await waitFor(() => source.getReplicaPlacementStatus(operation.publicationId)?.targetConfirmed === true, 15_000);
    const before = source.getReplicaPlacementStatus(operation.publicationId)!;
    const selected = new Set(before.intent.targetRelayIds);
    const retiringTarget = targets.find(target => (
      selected.has(target.getRelayDescriptor()!.relayId)
    ))!;
    const retiringRelayId = retiringTarget.getRelayDescriptor()!.relayId;
    const spareRelayId = targets.map(target => target.getRelayDescriptor()!.relayId)
      .find(relayId => !selected.has(relayId))!;

    await retiringTarget.stop();
    startedTargets.delete(retiringTarget);

    await waitFor(() => {
      const status = source.getReplicaPlacementStatus(operation.publicationId);
      return status?.targetConfirmed === true
        && status.intent.targetRelayIds.includes(spareRelayId)
        && !status.intent.targetRelayIds.includes(retiringRelayId);
    }, 15_000);
    expect(source.getReplicaPlacementStatus(operation.publicationId)).toMatchObject({
      confirmedReplicaCount: 5,
      minimumConfirmed: true,
      targetConfirmed: true,
      permanentlyRejectedRelayIds: [retiringRelayId],
    });
  }, 30_000);
});

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for durable replica placement');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
