import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import WebSocket from 'ws';
import {
  createPublicationOperationFrame,
  createPublicationRecord,
  createPublicationTombstone,
  createRelayContactHintV1,
  generatePublicationKeyMaterial,
  serializePublicationOperationFrame,
  type PublicationOperation,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '../server.js';

const BASE_PORT = 29_000 + Math.floor(Math.random() * 500);
const SOURCE_PORT = BASE_PORT;
const CAPACITY_PORT = BASE_PORT + 1;
const TERMINAL_PORT = BASE_PORT + 2;
const HEALTHY_PORT = BASE_PORT + 3;
const REPLACEMENT_PORT = BASE_PORT + 4;
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const SOURCE_DIR = `/tmp/resonance-replacement-source-${RUN_ID}`;
const CAPACITY_DIR = `/tmp/resonance-replacement-capacity-${RUN_ID}`;
const TERMINAL_DIR = `/tmp/resonance-replacement-terminal-${RUN_ID}`;
const HEALTHY_DIR = `/tmp/resonance-replacement-healthy-${RUN_ID}`;
const REPLACEMENT_DIR = `/tmp/resonance-replacement-new-${RUN_ID}`;
const CAPACITY_QUOTA_BYTES = (64 * 1024) + 512;

function endpoint(port: number): string {
  return `ws://127.0.0.1:${port}/`;
}

function createTarget(
  port: number,
  persistDir: string,
  quotaBytes = 1_000_000,
): RelayServer {
  return createRelayServer({
    port,
    host: '127.0.0.1',
    persistDir,
    maxPublishesPerMin: 1_000,
    publicationStorageQuotaBytes: quotaBytes,
    relayDiscovery: {
      endpoints: [endpoint(port)],
      reachability: 'direct',
      supportedGroups: ['public'],
      storage: { capacityBytes: quotaBytes, availableBytes: quotaBytes },
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
    desiredReplicaCount: 2,
    minimumHealthyReplicaCount: 1,
    replicaRepairIntervalMs: 100,
    replicaInventoryIntervalMs: 500,
    relayDiscovery: {
      endpoints: [],
      reachability: 'outbound-only',
      supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      descriptorLifetimeMs: 60_000,
    },
    relayLinks: {
      targets: [CAPACITY_PORT, TERMINAL_PORT, HEALTHY_PORT, REPLACEMENT_PORT].map(port => (
        createRelayContactHintV1('configured', endpoint(port))
      )),
      maxConnections: 4,
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

function submit(port: number, operation: PublicationOperation): Promise<{ status: string; message?: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint(port));
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('Timed out waiting for publication acknowledgement'));
    }, 3_000);
    socket.once('open', () => {
      socket.send(serializePublicationOperationFrame(createPublicationOperationFrame(operation)));
    });
    socket.once('message', (data: Buffer) => {
      clearTimeout(timeout);
      socket.close();
      resolve((JSON.parse(data.toString()) as { payload: { status: string; message?: string } }).payload);
    });
    socket.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

afterEach(() => {
  for (const directory of [SOURCE_DIR, CAPACITY_DIR, TERMINAL_DIR, HEALTHY_DIR, REPLACEMENT_DIR]) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('capacity replacement and reconciliation quarantine', () => {
  it('durably replaces a capacity-constrained configured target when another volunteer appears', async () => {
    const keys = generatePublicationKeyMaterial();
    const now = Date.now();
    const operation = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0x66),
      itemType: 'offer',
      createdAt: now,
      expiresAt: now + 60_000,
    }, keys);
    const capacityTarget = createTarget(CAPACITY_PORT, CAPACITY_DIR, CAPACITY_QUOTA_BYTES);
    const healthyTarget = createTarget(HEALTHY_PORT, HEALTHY_DIR);
    const replacementTarget = createTarget(REPLACEMENT_PORT, REPLACEMENT_DIR);
    let source: RelayServer | undefined;
    let capacityStarted = false;
    let healthyStarted = false;
    let replacementStarted = false;
    let sourceStarted = false;

    try {
      await capacityTarget.start();
      capacityStarted = true;
      await healthyTarget.start();
      healthyStarted = true;
      expect(capacityTarget.getRelayDescriptor()?.storage.availableBytes).toBe(64 * 1024);
      const healthyRelayId = healthyTarget.getRelayDescriptor()!.relayId;
      const replacementRelayId = replacementTarget.getRelayDescriptor()!.relayId;
      const capacityRelayId = capacityTarget.getRelayDescriptor()!.relayId;

      source = createSource();
      await source.start();
      sourceStarted = true;
      await waitFor(() => source!.getRelayLinkStatus().connectedRelayIds.length === 2);
      // The source has already authenticated a descriptor reporting one
      // coarse 64 KiB storage bucket. Filling it immediately afterward leaves
      // that signed hint cached for the replacement refusal below.
      await fillTargetToCapacity(capacityTarget, CAPACITY_PORT);
      expect(capacityTarget.getStats().publication_storage_available_bytes)
        .toBeLessThan(CAPACITY_QUOTA_BYTES);
      await expect(submit(SOURCE_PORT, operation)).resolves.toMatchObject({ status: 'ok' });

      await waitFor(() => {
        const status = source!.getReplicaPlacementStatus(operation.publicationId);
        return status?.permanentlyRejectedRelayIds.includes(capacityRelayId) === true
          && !status.intent.targetRelayIds.includes(capacityRelayId)
          && status.confirmedRelayIds.includes(healthyRelayId);
      });
      expect(source.getReplicaPlacementStatus(operation.publicationId)).toMatchObject({
        permanentlyRejectedRelayIds: [capacityRelayId],
        confirmedRelayIds: [healthyRelayId],
        intent: {
          targetRelayIds: [healthyRelayId],
          permanentlyRejectedRelayIds: [capacityRelayId],
        },
      });

      // The exclusion survives a process restart. It is scoped to this exact
      // operation, so the source does not re-add the capacity target while it
      // waits for another configured volunteer.
      await source.stop();
      sourceStarted = false;
      source = createSource();
      await source.start();
      sourceStarted = true;
      await waitFor(() => source!.getRelayLinkStatus().connectedRelayIds.length === 2);
      expect(source.getReplicaPlacementStatus(operation.publicationId)).toMatchObject({
        permanentlyRejectedRelayIds: [capacityRelayId],
        intent: {
          targetRelayIds: [healthyRelayId],
        },
      });

      await replacementTarget.start();
      replacementStarted = true;
      await waitFor(() => source!.getRelayLinkStatus().connectedRelayIds.length === 3, 8_000);
      await waitFor(() => {
        const status = source!.getReplicaPlacementStatus(operation.publicationId);
        return status?.confirmedRelayIds.length === 2
          && status.intent.targetRelayIds.includes(healthyRelayId)
          && status.intent.targetRelayIds.includes(replacementRelayId);
      }, 8_000);
      expect(source.getReplicaPlacementStatus(operation.publicationId)).toMatchObject({
        permanentlyRejectedRelayIds: [capacityRelayId],
        confirmedRelayIds: [healthyRelayId, replacementRelayId].sort(),
        targetConfirmed: true,
      });
      expect(replacementTarget.getStats().active_publications).toBe(1);
    } finally {
      if (sourceStarted && source) await source.stop();
      if (replacementStarted) await replacementTarget.stop();
      if (healthyStarted) await healthyTarget.stop();
      if (capacityStarted) await capacityTarget.stop();
    }
  }, 20_000);

  it('quarantines an older operation after a signed stale refusal across restart and a late peer', async () => {
    const keys = generatePublicationKeyMaterial();
    const now = Date.now();
    const operation = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0x67),
      itemType: 'offer',
      createdAt: now,
      expiresAt: now + 60_000,
    }, keys);
    const tombstone = createPublicationTombstone(
      operation,
      'withdrawn',
      keys.signingKeyPair,
      now + 1,
    );
    const terminalTarget = createTarget(TERMINAL_PORT, TERMINAL_DIR);
    const lateTarget = createTarget(HEALTHY_PORT, HEALTHY_DIR);
    let source: RelayServer | undefined;
    let terminalStarted = false;
    let lateStarted = false;
    let sourceStarted = false;

    try {
      await terminalTarget.start();
      terminalStarted = true;
      await expect(submit(TERMINAL_PORT, tombstone)).resolves.toMatchObject({ status: 'ok' });
      const terminalRelayId = terminalTarget.getRelayDescriptor()!.relayId;
      const lateRelayId = lateTarget.getRelayDescriptor()!.relayId;

      source = createSource();
      await source.start();
      sourceStarted = true;
      await waitFor(() => source!.getRelayLinkStatus().connectedRelayIds.length === 1);
      await expect(submit(SOURCE_PORT, operation)).resolves.toMatchObject({ status: 'ok' });
      await waitFor(() => source!.getReplicaPlacementStatus(operation.publicationId)
        ?.reconciliationRequired === true);
      expect(source.getReplicaPlacementStatus(operation.publicationId)).toMatchObject({
        reconciliationRequired: true,
        reconciliationRequiredRelayIds: [terminalRelayId],
        pendingRelayIds: [],
        intent: { targetRelayIds: [terminalRelayId] },
      });

      await source.stop();
      sourceStarted = false;
      source = createSource();
      await source.start();
      sourceStarted = true;
      await waitFor(() => source!.getRelayLinkStatus().connectedRelayIds.length === 1);
      expect(source.getReplicaPlacementStatus(operation.publicationId)).toMatchObject({
        reconciliationRequired: true,
        reconciliationRequiredRelayIds: [terminalRelayId],
        intent: { targetRelayIds: [terminalRelayId] },
      });

      await lateTarget.start();
      lateStarted = true;
      await waitFor(() => source!.getRelayLinkStatus().connectedRelayIds.length === 2, 8_000);
      await pause(500);
      expect(source.getReplicaPlacementStatus(operation.publicationId)).toMatchObject({
        reconciliationRequired: true,
        intent: { targetRelayIds: [terminalRelayId] },
      });
      expect(lateTarget.getStats()).toMatchObject({
        active_publications: 0,
        retained_tombstones: 0,
        journal_entries: 0,
      });

      // A newer owner-signed operation clears the exact-operation quarantine
      // and can safely converge the withdrawal to the late volunteer.
      await expect(submit(SOURCE_PORT, tombstone)).resolves.toMatchObject({ status: 'ok' });
      await waitFor(() => {
        const status = source!.getReplicaPlacementStatus(operation.publicationId);
        return status?.reconciliationRequired === false
          && status.targetConfirmed
          && status.intent.targetRelayIds.includes(terminalRelayId)
          && status.intent.targetRelayIds.includes(lateRelayId);
      }, 8_000);
      expect(lateTarget.getStats()).toMatchObject({
        active_publications: 0,
        retained_tombstones: 1,
      });
    } finally {
      if (sourceStarted && source) await source.stop();
      if (lateStarted) await lateTarget.stop();
      if (terminalStarted) await terminalTarget.stop();
    }
  }, 20_000);
});

async function fillTargetToCapacity(target: RelayServer, port: number): Promise<void> {
  for (let index = 0; index < 128; index++) {
    if (target.getStats().publication_storage_available_bytes === 0) return;
    const keys = generatePublicationKeyMaterial();
    const now = Date.now();
    const filler = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(index),
      itemType: 'offer',
      createdAt: now,
      expiresAt: now + 60_000,
    }, keys);
    const result = await submit(port, filler);
    if (result.message === 'capacity-exhausted') return;
    if (result.status !== 'ok') throw new Error(`Cannot fill target storage: ${result.message ?? result.status}`);
  }
  throw new Error('Target did not reach its configured publication storage quota');
}

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for permanent replica replacement');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
