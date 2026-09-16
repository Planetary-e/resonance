import { describe, expect, it } from 'vitest';
import {
  createPublicationRecord,
  createPublicationTombstone,
  createRelayReplicaInventoryRequestV1,
  createRelayReplicaInventoryResponseV1,
  createRelayReplicaPutV1,
  createRelayReplicaReceiptV1,
  generateIdentity,
  generatePublicationKeyMaterial,
  type RelayReplicaReceiptV1,
} from '@resonance/core';
import {
  ReplicaInventoryScheduler,
  ReplicaPlacementTracker,
  createReplicaPlacementIntent,
} from '../replica-placement.js';

const NOW = 1_800_000_000_000;
const POLICY = { desiredReplicaCount: 5, minimumHealthyReplicaCount: 3 };

function publication() {
  const keys = generatePublicationKeyMaterial();
  return {
    keys,
    operation: createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0x7a),
      itemType: 'offer',
      createdAt: NOW,
      expiresAt: NOW + 86_400_000,
    }, keys),
  };
}

describe('ReplicaPlacementTracker', () => {
  it('counts only receipt-confirmed selected targets for the current operation', () => {
    const local = generateIdentity();
    const firstTarget = generateIdentity();
    const secondTarget = generateIdentity();
    const unexpectedTarget = generateIdentity();
    const { operation } = publication();
    const tracker = new ReplicaPlacementTracker(local.did);
    const intent = createReplicaPlacementIntent(
      operation,
      [firstTarget.did, secondTarget.did],
      POLICY,
      1,
      NOW,
    );
    expect(tracker.applyIntent(intent)).toBe(true);

    const request = createRelayReplicaPutV1(operation, local, NOW, NOW + 30_000);
    const firstReceipt = createRelayReplicaReceiptV1(
      request,
      firstTarget,
      { status: 'stored' },
      NOW + 1,
    );
    expect(tracker.canRecordReceipt(firstReceipt)).toBe(true);
    expect(tracker.recordReceipt(firstReceipt)).toBe(true);

    const unexpectedReceipt = createRelayReplicaReceiptV1(
      request,
      unexpectedTarget,
      { status: 'stored' },
      NOW + 2,
    );
    expect(tracker.canRecordReceipt(unexpectedReceipt)).toBe(false);

    const otherSender = generateIdentity();
    const foreignRequest = createRelayReplicaPutV1(operation, otherSender, NOW, NOW + 30_000);
    const foreignReceipt = createRelayReplicaReceiptV1(
      foreignRequest,
      secondTarget,
      { status: 'stored' },
      NOW + 3,
    );
    expect(tracker.canRecordReceipt(foreignReceipt)).toBe(false);

    expect(tracker.statusFor(operation.publicationId)).toMatchObject({
      confirmedRelayIds: [firstTarget.did],
      pendingRelayIds: [secondTarget.did],
      confirmedReplicaCount: 1,
      minimumConfirmed: false,
      targetConfirmed: false,
    });
  });

  it('clears prior receipts when an update or tombstone creates a new operation generation', () => {
    const local = generateIdentity();
    const target = generateIdentity();
    const { keys, operation } = publication();
    const tracker = new ReplicaPlacementTracker(local.did);
    const publicationIntent = createReplicaPlacementIntent(
      operation,
      [target.did],
      POLICY,
      1,
      NOW,
    );
    tracker.applyIntent(publicationIntent);
    const publicationRequest = createRelayReplicaPutV1(operation, local, NOW, NOW + 30_000);
    const publicationReceipt = createRelayReplicaReceiptV1(
      publicationRequest,
      target,
      { status: 'stored' },
      NOW + 1,
    );
    tracker.recordReceipt(publicationReceipt);

    const tombstone = createPublicationTombstone(operation, 'withdrawn', keys.signingKeyPair, NOW + 2);
    const tombstoneIntent = createReplicaPlacementIntent(
      tombstone,
      [target.did],
      POLICY,
      1,
      NOW + 2,
    );
    expect(tracker.applyIntent(tombstoneIntent)).toBe(true);
    expect(tracker.receiptsFor(operation.publicationId)).toEqual([]);
    expect(tracker.canRecordReceipt(publicationReceipt)).toBe(false);

    const tombstoneRequest = createRelayReplicaPutV1(tombstone, local, NOW + 2, NOW + 30_000);
    const tombstoneReceipt = createRelayReplicaReceiptV1(
      tombstoneRequest,
      target,
      { status: 'stored' },
      NOW + 3,
    );
    expect(tracker.recordReceipt(tombstoneReceipt)).toBe(true);
    expect(tracker.statusFor(operation.publicationId)?.confirmedRelayIds).toEqual([target.did]);
  });

  it('keeps durable receipt history while an absent inventory answer schedules repair', () => {
    const local = generateIdentity();
    const target = generateIdentity();
    const { operation } = publication();
    const tracker = new ReplicaPlacementTracker(local.did);
    tracker.applyIntent(createReplicaPlacementIntent(operation, [target.did], POLICY, 1, NOW));

    const placement = createRelayReplicaPutV1(operation, local, NOW, NOW + 30_000);
    const receipt = createRelayReplicaReceiptV1(placement, target, { status: 'stored' }, NOW + 1);
    expect(tracker.recordReceipt(receipt)).toBe(true);
    expect(tracker.inventoryDueReceipts(operation.publicationId, 100, NOW + 50)).toEqual([receipt]);

    const presentRequest = createRelayReplicaInventoryRequestV1(receipt, local, NOW + 101, NOW + 30_000);
    const present = createRelayReplicaInventoryResponseV1(
      presentRequest,
      target,
      { status: 'present' },
      NOW + 102,
    );
    expect(tracker.recordInventoryResponse(present)).toBe(true);
    expect(tracker.statusFor(operation.publicationId)).toMatchObject({
      confirmedRelayIds: [target.did],
      pendingRelayIds: [],
      inventoryPresentRelayIds: [target.did],
      inventoryMissingRelayIds: [],
      confirmedReplicaCount: 1,
      inventoryPresentReplicaCount: 1,
    });

    const missingRequest = createRelayReplicaInventoryRequestV1(receipt, local, NOW + 103, NOW + 30_000);
    const missing = createRelayReplicaInventoryResponseV1(
      missingRequest,
      target,
      { status: 'missing' },
      NOW + 104,
    );
    expect(tracker.recordInventoryResponse(missing)).toBe(true);
    expect(tracker.statusFor(operation.publicationId)).toMatchObject({
      confirmedRelayIds: [target.did],
      pendingRelayIds: [target.did],
      inventoryPresentRelayIds: [],
      inventoryMissingRelayIds: [target.did],
      confirmedReplicaCount: 1,
      inventoryPresentReplicaCount: 0,
    });
    expect(tracker.inventoryDueReceipts(operation.publicationId, 100, NOW + 204))
      .toEqual([receipt]);
  });

  it('rotates bounded inventory batches without starving later receipt-holders', () => {
    const local = generateIdentity();
    const target = generateIdentity();
    const receipts = [publication(), publication(), publication()].map(({ operation }, index) => {
      const request = createRelayReplicaPutV1(operation, local, NOW + index, NOW + 30_000);
      return createRelayReplicaReceiptV1(request, target, { status: 'stored' }, NOW + index + 1);
    });
    const ordered = [...receipts].sort((first, second) => (
      `${first.publicationId}\u0000${first.responderRelayId}`
        .localeCompare(`${second.publicationId}\u0000${second.responderRelayId}`)
    ));
    const scheduler = new ReplicaInventoryScheduler();

    expect(scheduler.take(receipts, 1).map(receipt => receipt.publicationId))
      .toEqual([ordered[0].publicationId]);
    expect(scheduler.take(receipts.filter(receipt => receipt !== ordered[0]), 1)
      .map(receipt => receipt.publicationId)).toEqual([ordered[1].publicationId]);
    expect(scheduler.take(receipts.filter(receipt => receipt !== ordered[0] && receipt !== ordered[1]), 1)
      .map(receipt => receipt.publicationId)).toEqual([ordered[2].publicationId]);
  });

  it('uses one deterministic order for base64url receipt keys', () => {
    const target = generateIdentity();
    const receipts = ['_', '-', '0', 'a', 'A'].map(marker => ({
      publicationId: `pub_${marker}${'a'.repeat(42)}`,
      responderRelayId: target.did,
    }) as RelayReplicaReceiptV1);
    const expected = [...receipts].sort((first, second) => {
      const firstKey = `${first.publicationId}\u0000${first.responderRelayId}`;
      const secondKey = `${second.publicationId}\u0000${second.responderRelayId}`;
      if (firstKey === secondKey) return 0;
      return firstKey < secondKey ? -1 : 1;
    });
    const scheduler = new ReplicaInventoryScheduler();

    expect(Array.from({ length: receipts.length }, () => scheduler.take(receipts, 1)[0].publicationId))
      .toEqual(expected.map(receipt => receipt.publicationId));
  });
});
