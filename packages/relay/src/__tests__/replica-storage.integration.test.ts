import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import {
  createPublicationRecord,
  createPublicationOperationFrame,
  createPublicationTombstone,
  createRelayContactHintV1,
  createRelayDescriptorV1,
  generateIdentity,
  generatePublicationKeyMaterial,
  serializePublicationOperationFrame,
  verifyRelayReplicaReceiptV1,
  type Identity,
  type PublicationOperation,
} from '@resonance/core';
import { connectRelayLinkV1 } from '../relay-link-client.js';
import {
  RelayOperationLog,
  type RelayPublicationOperationLogEntry,
} from '../operation-log.js';
import { RELAY_IDENTITY_FILENAME } from '../relay-identity-store.js';
import {
  FIRST_SEEN_TOMBSTONE_RESERVE_BYTES,
  publicationStorageAllocatableBytes,
  publicationStorageReservationBytes,
} from '../replica-storage-ledger.js';
import { createRelayServer, type RelayServer } from '../server.js';

const BASE_PORT = 28_000 + Math.floor(Math.random() * 500);
const temporaryDirectories: string[] = [];

function publicationWithKeys(marker: number) {
  const keys = generatePublicationKeyMaterial();
  const operation = createPublicationRecord({
    groupId: 'public',
    fingerprintEpoch: '2026-09',
    fingerprint: new Uint8Array(64).fill(marker),
    itemType: 'offer',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  }, keys);
  return { keys, operation };
}

function publication(marker: number): PublicationOperation {
  return publicationWithKeys(marker).operation;
}

function createTarget(
  port: number,
  directory: string,
  quotaBytes: number,
  maxReplicaBytesPerRelay = quotaBytes,
): RelayServer {
  return createRelayServer({
    port,
    host: '127.0.0.1',
    persistDir: directory,
    publicationStorageQuotaBytes: quotaBytes,
    maxReplicaStorageBytesPerRelay: maxReplicaBytesPerRelay,
    relayDiscovery: {
      endpoints: [`ws://127.0.0.1:${port}/`],
      reachability: 'direct',
      supportedGroups: ['public'],
      storage: { capacityBytes: quotaBytes, availableBytes: quotaBytes },
      descriptorLifetimeMs: 60_000,
    },
    relayLinkHeartbeatIntervalMs: 100,
    relayLinkHeartbeatTimeoutMs: 1_500,
  });
}

function sourceDescriptor(identity: Identity) {
  const now = Date.now();
  return createRelayDescriptorV1({
    sequence: now,
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
    storage: { capacityBytes: 1_000_000, availableBytes: 1_000_000 },
    issuedAt: now,
    expiresAt: now + 60_000,
  }, identity);
}

async function connectSource(port: number, identity: Identity) {
  return connectRelayLinkV1(
    createRelayContactHintV1('configured', `ws://127.0.0.1:${port}/`),
    sourceDescriptor(identity),
    identity,
    {
      handshakeTimeoutMs: 1_000,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 1_500,
      replicaRequestTimeoutMs: 1_000,
    },
  );
}

function submitLocalPublication(
  port: number,
  operation: PublicationOperation,
): Promise<{ status: string; message?: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('Timed out waiting for publication acknowledgement'));
    }, 2_000);
    socket.once('open', () => {
      socket.send(serializePublicationOperationFrame(createPublicationOperationFrame(operation)));
    });
    socket.once('message', (data: Buffer) => {
      clearTimeout(timeout);
      socket.close();
      const parsed = JSON.parse(data.toString()) as {
        payload: { status: string; message?: string };
      };
      resolve(parsed.payload);
    });
    socket.once('error', (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('replica storage quotas', () => {
  it('returns a signed capacity rejection without journaling an over-quota replica', async () => {
    const port = BASE_PORT;
    const directory = `/tmp/resonance-replica-storage-${Date.now()}-one`;
    temporaryDirectories.push(directory);
    const { keys, operation: first } = publicationWithKeys(0x31);
    const quotaBytes = publicationStorageReservationBytes(first)
      + FIRST_SEEN_TOMBSTONE_RESERVE_BYTES;
    const allocatableQuotaBytes = publicationStorageAllocatableBytes(quotaBytes);
    let target = createTarget(port, directory, quotaBytes);
    let tombstoneBytes = 0;
    const source = generateIdentity();
    await target.start();
    const link = await connectSource(port, source);
    try {
      const stored = await link.placeReplica(first);
      expect(stored.status).toBe('stored');
      expect(target.getStats()).toMatchObject({
        journal_entries: 1,
        publication_storage_quota_bytes: quotaBytes,
        publication_storage_withdrawal_reserve_bytes: FIRST_SEEN_TOMBSTONE_RESERVE_BYTES,
        publication_storage_reserved_bytes: allocatableQuotaBytes,
        publication_storage_available_bytes: 0,
        replica_storage_reserved_bytes: allocatableQuotaBytes,
        replica_storage_relays: 1,
      });
      expect(target.getRelayDescriptor()?.storage.availableBytes).toBe(0);

      const duplicate = await link.placeReplica(first);
      expect(duplicate.status).toBe('already-stored');

      const rejected = await link.placeReplica(publication(0x32));
      expect(verifyRelayReplicaReceiptV1(rejected)).toBe(true);
      expect(rejected).toMatchObject({ status: 'rejected', reason: 'capacity-exhausted' });
      expect(target.getStats().journal_entries).toBe(1);

      const tombstone = createPublicationTombstone(first, 'withdrawn', keys.signingKeyPair, Date.now());
      tombstoneBytes = publicationStorageReservationBytes(tombstone, first);
      expect((await link.placeReplica(tombstone)).status).toBe('stored');
      expect(target.getStats()).toMatchObject({
        journal_entries: 2,
        retained_tombstones: 1,
        publication_storage_reserved_bytes: tombstoneBytes,
        publication_storage_available_bytes: allocatableQuotaBytes - tombstoneBytes,
      });
    } finally {
      link.close();
      await link.closed;
      await target.stop();
    }

    target = createTarget(port, directory, quotaBytes);
    await target.start();
    try {
      expect(target.getStats()).toMatchObject({
        journal_entries: 2,
        retained_tombstones: 1,
        publication_storage_reserved_bytes: tombstoneBytes,
        publication_storage_available_bytes: allocatableQuotaBytes - tombstoneBytes,
        replica_storage_reserved_bytes: tombstoneBytes,
      });
      // Public descriptors round capacity to coarse 64 KiB buckets.
      expect(target.getRelayDescriptor()?.storage.availableBytes).toBe(0);
    } finally {
      await target.stop();
    }
  });

  it('caps each replica relay independently while allowing another volunteer allocation', async () => {
    const port = BASE_PORT + 1;
    const directory = `/tmp/resonance-replica-storage-${Date.now()}-two`;
    temporaryDirectories.push(directory);
    const first = publication(0x41);
    const second = publication(0x42);
    const firstBytes = publicationStorageReservationBytes(first);
    const secondBytes = publicationStorageReservationBytes(second);
    const target = createTarget(
      port,
      directory,
      firstBytes + secondBytes + FIRST_SEEN_TOMBSTONE_RESERVE_BYTES,
      Math.max(firstBytes, secondBytes) + FIRST_SEEN_TOMBSTONE_RESERVE_BYTES,
    );
    const firstSource = generateIdentity();
    const secondSource = generateIdentity();
    await target.start();
    const firstLink = await connectSource(port, firstSource);
    const secondLink = await connectSource(port, secondSource);
    try {
      expect((await firstLink.placeReplica(first)).status).toBe('stored');
      expect(await firstLink.placeReplica(second)).toMatchObject({
        status: 'rejected',
        reason: 'capacity-exhausted',
      });
      expect((await secondLink.placeReplica(second)).status).toBe('stored');
      expect(target.getStats()).toMatchObject({
        publication_storage_available_bytes: 0,
        replica_storage_relays: 2,
      });
    } finally {
      firstLink.close();
      secondLink.close();
      await Promise.all([firstLink.closed, secondLink.closed]);
      await target.stop();
    }
  });

  it('keeps bounded room for a first-seen tombstone when ordinary capacity is full', async () => {
    const port = BASE_PORT + 10;
    const directory = `/tmp/resonance-replica-storage-${Date.now()}-withdrawal`;
    temporaryDirectories.push(directory);
    const { operation: live } = publicationWithKeys(0x43);
    const { keys: absentKeys, operation: absentLive } = publicationWithKeys(0x44);
    const absentTombstone = createPublicationTombstone(
      absentLive,
      'withdrawn',
      absentKeys.signingKeyPair,
      Date.now(),
    );
    const liveBytes = publicationStorageReservationBytes(live);
    const absentTombstoneBytes = publicationStorageReservationBytes(absentTombstone);
    expect(absentTombstoneBytes).toBeLessThanOrEqual(FIRST_SEEN_TOMBSTONE_RESERVE_BYTES);
    const quotaBytes = liveBytes + FIRST_SEEN_TOMBSTONE_RESERVE_BYTES;
    const target = createTarget(port, directory, quotaBytes);
    const source = generateIdentity();
    await target.start();
    const link = await connectSource(port, source);
    try {
      expect((await link.placeReplica(live)).status).toBe('stored');
      expect(target.getStats().publication_storage_available_bytes).toBe(0);

      // The relay has no record for this publication. It must still retain
      // the signed terminal operation, otherwise a later stale live replica
      // could survive a withdrawal merely because the relay was full.
      expect((await link.placeReplica(absentTombstone)).status).toBe('stored');
      expect(target.getStats()).toMatchObject({
        journal_entries: 2,
        retained_tombstones: 1,
        publication_storage_reserved_bytes: liveBytes + absentTombstoneBytes,
        publication_storage_available_bytes: 0,
        replica_storage_reserved_bytes: liveBytes + absentTombstoneBytes,
      });
      expect(await link.placeReplica(publication(0x45))).toMatchObject({
        status: 'rejected',
        reason: 'capacity-exhausted',
      });
    } finally {
      link.close();
      await link.closed;
      await target.stop();
    }
  });

  it('persists the first replica relay as the allocation owner across a forwarded update', async () => {
    const port = BASE_PORT + 20;
    const directory = `/tmp/resonance-replica-storage-${Date.now()}-owner`;
    const compactedDirectory = `${directory}-compacted`;
    temporaryDirectories.push(directory, compactedDirectory);
    const { keys, operation: first } = publicationWithKeys(0x46);
    const forwardedUpdate = createPublicationRecord({
      groupId: first.groupId,
      fingerprintEpoch: first.fingerprint.epoch,
      fingerprint: new Uint8Array(64).fill(0x47),
      itemType: first.itemType,
      createdAt: first.createdAt + 1,
      expiresAt: first.expiresAt,
      sequence: first.sequence + 1,
    }, keys);
    const another = publication(0x48);
    const forwardedBytes = publicationStorageReservationBytes(forwardedUpdate);
    const anotherBytes = publicationStorageReservationBytes(another);
    const quotaBytes = forwardedBytes + anotherBytes + FIRST_SEEN_TOMBSTONE_RESERVE_BYTES;
    const perRelayQuotaBytes = Math.max(forwardedBytes, anotherBytes)
      + FIRST_SEEN_TOMBSTONE_RESERVE_BYTES;
    const sourceA = generateIdentity();
    const sourceB = generateIdentity();
    const target = createTarget(port, directory, quotaBytes, perRelayQuotaBytes);
    await target.start();
    const firstLink = await connectSource(port, sourceA);
    const forwardingLink = await connectSource(port, sourceB);
    try {
      expect((await firstLink.placeReplica(first)).status).toBe('stored');
      expect((await forwardingLink.placeReplica(forwardedUpdate)).status).toBe('stored');
    } finally {
      firstLink.close();
      forwardingLink.close();
      await Promise.all([firstLink.closed, forwardingLink.closed]);
      await target.stop();
    }

    const publicationEntries = new RelayOperationLog(directory).load()
      .map(record => record.entry)
      .filter((entry): entry is Extract<typeof entry, { kind: 'publication' }> => (
        entry.kind === 'publication'
      ));
    const latest = publicationEntries.at(-1);
    expect(latest).toMatchObject({
      kind: 'publication',
      operation: forwardedUpdate,
      allocationOrigin: 'replica',
      allocationRelayId: sourceA.did,
    });
    if (!latest) throw new Error('Expected compactable publication entry');

    // Startup rewrites the superseded row while retaining A as the durable
    // allocation owner. The compacted journal must replay identically again.
    const restarted = createTarget(port, directory, quotaBytes, perRelayQuotaBytes);
    await restarted.start();
    try {
      expect(new RelayOperationLog(directory).load().map(record => record.entry)).toEqual([latest]);
      expect(restarted.getStats()).toMatchObject({
        journal_entries: 1,
        replica_storage_reserved_bytes: forwardedBytes,
        replica_storage_relays: 1,
      });
    } finally {
      await restarted.stop();
    }

    // A compactor may retain only the current operation. Its durable owner
    // must still be A, leaving B's per-relay budget available after restart.
    const compactedLog = new RelayOperationLog(compactedDirectory);
    compactedLog.load();
    compactedLog.append(latest);
    const compacted = createTarget(port + 1, compactedDirectory, quotaBytes, perRelayQuotaBytes);
    await compacted.start();
    const retriedForwardingLink = await connectSource(port + 1, sourceB);
    try {
      expect((await retriedForwardingLink.placeReplica(another)).status).toBe('stored');
      expect(compacted.getStats()).toMatchObject({
        replica_storage_relays: 2,
        replica_storage_reserved_bytes: forwardedBytes + anotherBytes,
      });
    } finally {
      retriedForwardingLink.close();
      await retriedForwardingLink.closed;
      await compacted.stop();
    }
  });

  it('refuses a quota that would overstate the configured available capacity', () => {
    const directory = `/tmp/resonance-replica-storage-${Date.now()}-config`;
    temporaryDirectories.push(directory);
    expect(() => createRelayServer({
      port: BASE_PORT + 30,
      host: '127.0.0.1',
      persistDir: directory,
      publicationStorageQuotaBytes: 900_000,
      relayDiscovery: {
        endpoints: [`ws://127.0.0.1:${BASE_PORT + 30}/`],
        reachability: 'direct',
        supportedGroups: ['public'],
        storage: { capacityBytes: 1_000_000, availableBytes: 100_000 },
      },
    })).toThrow('availability');
  });

  it('coarsens and rate-limits public capacity updates', async () => {
    const port = BASE_PORT + 31;
    const directory = `/tmp/resonance-replica-storage-${Date.now()}-descriptor`;
    temporaryDirectories.push(directory);
    const live = publication(0x49);
    const liveBytes = publicationStorageReservationBytes(live);
    expect(liveBytes).toBeLessThan(64 * 1024);
    // The first write crosses a 64 KiB bucket, but cannot change the public
    // descriptor until its one-minute storage refresh interval has elapsed.
    const quotaBytes = liveBytes + (64 * 1024) - 1 + FIRST_SEEN_TOMBSTONE_RESERVE_BYTES;
    const target = createTarget(port, directory, quotaBytes);
    const source = generateIdentity();
    await target.start();
    const before = target.getRelayDescriptor();
    const link = await connectSource(port, source);
    try {
      expect(before?.storage.availableBytes).toBe(64 * 1024);
      expect((await link.placeReplica(live)).status).toBe('stored');
      expect(target.getStats().publication_storage_available_bytes).toBe((64 * 1024) - 1);
      expect(target.getRelayDescriptor()).toEqual(before);
      expect(target.getRelayDescriptor((before?.issuedAt ?? 0) + 60_001)?.storage.availableBytes)
        .toBe(0);
    } finally {
      link.close();
      await link.closed;
      await target.stop();
    }
  });

  it('rejects a full local write before it can journal an orphan placement intent', async () => {
    const port = BASE_PORT + 2;
    const directory = `/tmp/resonance-replica-storage-${Date.now()}-local`;
    temporaryDirectories.push(directory);
    const target = createRelayServer({
      port,
      host: '127.0.0.1',
      persistDir: directory,
      publicationStorageQuotaBytes: 1,
      relayDiscovery: {
        endpoints: [`ws://127.0.0.1:${port}/`],
        reachability: 'direct',
        supportedGroups: ['public'],
        storage: { capacityBytes: 1, availableBytes: 1 },
      },
      relayLinks: {
        targets: [createRelayContactHintV1('configured', `ws://127.0.0.1:${port + 100}/`)],
        maxConnections: 1,
        reconnectBaseMs: 50,
        reconnectMaxMs: 100,
      },
      relayLinkHeartbeatIntervalMs: 100,
      relayLinkHeartbeatTimeoutMs: 1_500,
    });
    await target.start();
    try {
      await expect(submitLocalPublication(port, publication(0x51))).resolves.toMatchObject({
        status: 'error',
        message: 'capacity-exhausted',
      });
      expect(target.getStats()).toMatchObject({
        journal_entries: 0,
        placement_intents: 0,
        publication_storage_reserved_bytes: 0,
      });
    } finally {
      await target.stop();
    }
  });

  it('records new local allocations without consuming an inbound relay budget', async () => {
    const port = BASE_PORT + 40;
    const directory = `/tmp/resonance-replica-storage-${Date.now()}-local-owner`;
    temporaryDirectories.push(directory);
    const local = publication(0x52);
    const quotaBytes = publicationStorageReservationBytes(local)
      + FIRST_SEEN_TOMBSTONE_RESERVE_BYTES;
    let target = createTarget(port, directory, quotaBytes, 1);
    await target.start();
    const relayId = target.getRelayDescriptor()?.relayId;
    expect(relayId).toBeDefined();
    try {
      await expect(submitLocalPublication(port, local)).resolves.toMatchObject({ status: 'ok' });
      expect(target.getStats()).toMatchObject({
        publication_storage_reserved_bytes: publicationStorageAllocatableBytes(quotaBytes),
        replica_storage_reserved_bytes: 0,
        replica_storage_relays: 0,
        legacy_unattributed_storage_reserved_bytes: 0,
      });
      expect(new RelayOperationLog(directory).load()[0]?.entry).toMatchObject({
        kind: 'publication',
        operation: local,
        allocationOrigin: 'local',
        allocationRelayId: relayId,
      });
    } finally {
      await target.stop();
    }

    // A recovered relay can lose and recreate its infrastructure identity.
    // The durable local tag must keep its existing state out of the inbound
    // per-relay budget even after that identity changes.
    rmSync(join(directory, RELAY_IDENTITY_FILENAME), { force: true });
    target = createTarget(port, directory, quotaBytes, 1);
    await target.start();
    try {
      expect(target.getRelayDescriptor()?.relayId).not.toBe(relayId);
      expect(target.getStats()).toMatchObject({
        replica_storage_reserved_bytes: 0,
        replica_storage_relays: 0,
        legacy_unattributed_storage_reserved_bytes: 0,
      });
    } finally {
      await target.stop();
    }
  });

  it('conservatively caps and preserves unmarked legacy allocations', async () => {
    const port = BASE_PORT + 41;
    const directory = `/tmp/resonance-replica-storage-${Date.now()}-legacy`;
    const compactedDirectory = `${directory}-compacted`;
    temporaryDirectories.push(directory, compactedDirectory);
    const { keys, operation: first } = publicationWithKeys(0x53);
    const forwardedUpdate = createPublicationRecord({
      groupId: first.groupId,
      fingerprintEpoch: first.fingerprint.epoch,
      fingerprint: new Uint8Array(64).fill(0x54),
      itemType: first.itemType,
      createdAt: first.createdAt + 1,
      expiresAt: first.expiresAt,
      sequence: 1_000_000_000,
    }, keys);
    const compatibleUpdate = createPublicationRecord({
      groupId: first.groupId,
      fingerprintEpoch: first.fingerprint.epoch,
      fingerprint: new Uint8Array(64).fill(0x55),
      itemType: first.itemType,
      createdAt: first.createdAt + 1,
      expiresAt: first.expiresAt,
      sequence: first.sequence + 1,
    }, keys);
    const firstBytes = publicationStorageReservationBytes(first);
    const forwardedBytes = publicationStorageReservationBytes(forwardedUpdate);
    const compatibleBytes = publicationStorageReservationBytes(compatibleUpdate);
    const tombstone = createPublicationTombstone(
      compatibleUpdate,
      'withdrawn',
      keys.signingKeyPair,
      Date.now(),
    );
    const tombstoneBytes = publicationStorageReservationBytes(tombstone, compatibleUpdate);
    expect(forwardedBytes).toBeGreaterThan(firstBytes);
    expect(compatibleBytes).toBeLessThanOrEqual(firstBytes);

    // This is a valid pre-v0.3 journal row: its source was never persisted.
    const legacyLog = new RelayOperationLog(directory);
    legacyLog.load();
    legacyLog.append({ kind: 'publication', operation: first });

    const quotaBytes = forwardedBytes + FIRST_SEEN_TOMBSTONE_RESERVE_BYTES;
    const perRelayQuotaBytes = firstBytes + FIRST_SEEN_TOMBSTONE_RESERVE_BYTES;
    const source = generateIdentity();
    let target = createTarget(port, directory, quotaBytes, perRelayQuotaBytes);
    await target.start();
    const link = await connectSource(port, source);
    let compactableUpdate: RelayPublicationOperationLogEntry | undefined;
    try {
      expect(target.getStats()).toMatchObject({
        legacy_unattributed_storage_reserved_bytes: firstBytes,
        replica_storage_reserved_bytes: 0,
        replica_storage_relays: 0,
      });

      // A later carrier cannot grow the historical allocation past the
      // conservative legacy bucket's cap.
      expect(await link.placeReplica(forwardedUpdate)).toMatchObject({
        status: 'rejected',
        reason: 'capacity-exhausted',
      });
      expect((await link.placeReplica(compatibleUpdate)).status).toBe('stored');
      const afterUpdate = new RelayOperationLog(directory).load()
        .map(record => record.entry)
        .filter((entry): entry is Extract<typeof entry, { kind: 'publication' }> => (
          entry.kind === 'publication'
        ));
      compactableUpdate = afterUpdate.at(-1);
      expect(compactableUpdate).toEqual({
        kind: 'publication',
        operation: compatibleUpdate,
        allocationOrigin: 'legacy',
      });

      // New journal rows explicitly preserve legacy provenance. A compacted
      // tombstone must still retain this last live state for accounting.
      expect((await link.placeReplica(tombstone)).status).toBe('stored');
      const publications = new RelayOperationLog(directory).load()
        .map(record => record.entry)
        .filter((entry): entry is Extract<typeof entry, { kind: 'publication' }> => (
          entry.kind === 'publication'
        ));
      expect(publications.at(-1)).toEqual({
        kind: 'publication',
        operation: tombstone,
        allocationOrigin: 'legacy',
      });
      expect(target.getStats()).toMatchObject({
        legacy_unattributed_storage_reserved_bytes: tombstoneBytes,
        replica_storage_reserved_bytes: 0,
        replica_storage_relays: 0,
      });
    } finally {
      link.close();
      await link.closed;
      await target.stop();
    }

    target = createTarget(port, directory, quotaBytes, perRelayQuotaBytes);
    await target.start();
    try {
      expect(new RelayOperationLog(directory).load().map(record => record.entry)).toEqual([
        { kind: 'publication', operation: compatibleUpdate, allocationOrigin: 'legacy' },
        { kind: 'publication', operation: tombstone, allocationOrigin: 'legacy' },
      ]);
      expect(target.getStats()).toMatchObject({
        journal_entries: 2,
        retained_tombstones: 1,
        legacy_unattributed_storage_reserved_bytes: tombstoneBytes,
        replica_storage_reserved_bytes: 0,
        replica_storage_relays: 0,
      });
    } finally {
      await target.stop();
    }

    // Replay the rewritten file itself, then verify a stale live copy cannot
    // revive the withdrawal after both the first row and its history are gone.
    target = createTarget(port, directory, quotaBytes, perRelayQuotaBytes);
    await target.start();
    const staleLink = await connectSource(port, source);
    try {
      expect(target.getStats()).toMatchObject({
        journal_entries: 2,
        retained_tombstones: 1,
        legacy_unattributed_storage_reserved_bytes: tombstoneBytes,
      });
      expect(await staleLink.placeReplica(first)).toMatchObject({
        status: 'rejected', reason: 'terminal',
      });
    } finally {
      staleLink.close();
      await staleLink.closed;
      await target.stop();
    }

    if (!compactableUpdate) throw new Error('Expected compactable legacy update');
    const compactedLog = new RelayOperationLog(compactedDirectory);
    compactedLog.load();
    compactedLog.append(compactableUpdate);
    const compacted = createTarget(port + 1, compactedDirectory, quotaBytes, perRelayQuotaBytes);
    await compacted.start();
    try {
      expect(compacted.getStats()).toMatchObject({
        legacy_unattributed_storage_reserved_bytes: compatibleBytes,
        replica_storage_reserved_bytes: 0,
        replica_storage_relays: 0,
      });
    } finally {
      await compacted.stop();
    }
  });

  it('does not expose exact allocation statistics without an administrator key', async () => {
    const port = BASE_PORT + 43;
    const directory = `/tmp/resonance-replica-storage-${Date.now()}-private-stats`;
    temporaryDirectories.push(directory);
    const target = createTarget(port, directory, 1_000_000);
    await target.start();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/stats`);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'stats_disabled' });
    } finally {
      await target.stop();
    }
  });
});
