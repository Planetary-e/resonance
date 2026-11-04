import { describe, expect, it } from 'vitest';
import {
  createPublicationRecord,
  createPublicationTombstone,
  generatePublicationKeyMaterial,
} from '@resonance/core';
import {
  FIRST_SEEN_TOMBSTONE_RESERVE_BYTES,
  ReplicaStorageLedger,
  TOMBSTONE_HEADROOM_BYTES,
  publicationStorageReservationBytes,
} from '../replica-storage-ledger.js';

const NOW = 1_800_000_000_000;

function replicaAllocation(relayId: string) {
  return { allocationOrigin: 'replica' as const, allocationRelayId: relayId };
}

function localAllocation(relayId: string) {
  return { allocationOrigin: 'local' as const, allocationRelayId: relayId };
}

function publication() {
  const keys = generatePublicationKeyMaterial();
  const operation = createPublicationRecord({
    groupId: 'public',
    fingerprintEpoch: '2026-09',
    fingerprint: new Uint8Array(64).fill(0x47),
    itemType: 'offer',
    createdAt: NOW,
    expiresAt: NOW + 86_400_000,
  }, keys);
  return { keys, operation };
}

describe('ReplicaStorageLedger', () => {
  it('reserves bounded tombstone headroom with each live publication', () => {
    const { keys, operation } = publication();
    const tombstone = createPublicationTombstone(
      operation,
      'withdrawn',
      keys.signingKeyPair,
      NOW + 1,
    );

    const liveReservation = publicationStorageReservationBytes(operation);
    const tombstoneReservation = publicationStorageReservationBytes(tombstone, operation);
    expect(liveReservation).toBeGreaterThan(TOMBSTONE_HEADROOM_BYTES);
    expect(tombstoneReservation).toBeLessThanOrEqual(liveReservation);
    expect(Buffer.byteLength(JSON.stringify(tombstone), 'utf8')).toBeLessThan(TOMBSTONE_HEADROOM_BYTES);
  });

  it('enforces global and per-relay reservations while preserving the first owner', () => {
    const ledger = new ReplicaStorageLedger();
    const firstRelay = 'did:key:first';
    const secondRelay = 'did:key:second';

    expect(ledger.canReserve('pub_first', 1_200, replicaAllocation(firstRelay), 10_000, 2_000)).toBe(true);
    ledger.record('pub_first', 1_200, replicaAllocation(firstRelay));
    expect(ledger.reservedBytes).toBe(1_200);
    expect(ledger.reservedBytesForRelay(firstRelay)).toBe(1_200);

    expect(ledger.canReserve('pub_second', 400, replicaAllocation(firstRelay), 10_000, 2_000)).toBe(false);
    expect(ledger.canReserve('pub_second', 400, replicaAllocation(secondRelay), 10_000, 2_000)).toBe(true);
    ledger.record('pub_second', 400, replicaAllocation(secondRelay));
    expect(ledger.replicaReservedBytes).toBe(1_600);

    // An update arriving from another relay cannot transfer the original
    // allocation or evade the first relay's ceiling.
    expect(ledger.canReserve('pub_first', 1_600, replicaAllocation(secondRelay), 10_000, 2_000)).toBe(false);
    expect(ledger.canReserve('pub_first', 1_400, replicaAllocation(secondRelay), 10_000, 2_000)).toBe(true);
    ledger.record('pub_first', 1_400, replicaAllocation(secondRelay));
    expect(ledger.allocationFor('pub_first')).toEqual({
      publicationId: 'pub_first',
      allocationOrigin: 'replica',
      allocationRelayId: firstRelay,
      reservedBytes: 1_400,
    });
    expect(ledger.reservedBytesForRelay(firstRelay)).toBe(1_400);
    expect(ledger.reservedBytesForRelay(secondRelay)).toBe(400);

    // Lowering a local limit does not prevent a currently over-limit peer
    // from submitting a smaller state or terminal withdrawal.
    expect(ledger.canReserve('pub_first', 1_300, replicaAllocation(firstRelay), 50, 50)).toBe(true);
  });

  it('holds a bounded global reserve for a first-seen tombstone', () => {
    const ledger = new ReplicaStorageLedger();
    const relay = 'did:key:source';
    const quotaBytes = 1_512;

    // Ordinary allocations stop before the withdrawal reserve.
    expect(ledger.canReserve('live', 1_000, replicaAllocation(relay), quotaBytes, quotaBytes)).toBe(true);
    ledger.record('live', 1_000, replicaAllocation(relay));
    expect(ledger.canReserve('new-live', 1, replicaAllocation(relay), quotaBytes, quotaBytes)).toBe(false);

    // A valid, first-seen terminal operation can consume only that reserve.
    expect(ledger.canReserve(
      'missing-publication',
      FIRST_SEEN_TOMBSTONE_RESERVE_BYTES - 1,
      replicaAllocation(relay),
      quotaBytes,
      quotaBytes,
      true,
    )).toBe(true);
    expect(ledger.canReserve(
      'missing-publication',
      FIRST_SEEN_TOMBSTONE_RESERVE_BYTES - 1,
      replicaAllocation(relay),
      quotaBytes,
      quotaBytes,
      false,
    )).toBe(false);
  });

  it('excludes newly local state while conservatively capping legacy state', () => {
    const localRelay = 'did:key:local-relay';
    const remoteRelay = 'did:key:later-carrier';
    const ledger = new ReplicaStorageLedger();

    // The local relay's own allocation always consumes global capacity but is
    // intentionally outside the inbound-relay allocation cap.
    expect(ledger.canReserve('local', 1_200, localAllocation(localRelay), 10_000, 1)).toBe(true);
    ledger.record('local', 1_200, localAllocation(localRelay));
    expect(ledger.reservedBytes).toBe(1_200);
    expect(ledger.replicaReservedBytes).toBe(0);
    expect(ledger.replicaRelayCount).toBe(0);

    // Fieldless historical journal rows map to one virtual inbound owner.
    // A later carrier cannot move it or grow it beyond today's cap, but a
    // shrinking update remains possible so a relay can converge.
    ledger.record('legacy', 1_200, { allocationOrigin: 'legacy' });
    expect(ledger.legacyUnattributedReservedBytes).toBe(1_200);
    expect(ledger.replicaRelayCount).toBe(0);
    expect(ledger.canReserve('legacy', 1_201, replicaAllocation(remoteRelay), 10_000, 1_700)).toBe(false);
    expect(ledger.canReserve('legacy', 1_000, replicaAllocation(remoteRelay), 10_000, 1_700)).toBe(true);
    ledger.record('legacy', 1_000, replicaAllocation(remoteRelay));
    expect(ledger.allocationFor('legacy')).toEqual({
      publicationId: 'legacy',
      allocationOrigin: 'legacy',
      reservedBytes: 1_000,
    });
  });
});
