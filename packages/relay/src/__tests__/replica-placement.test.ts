import { describe, expect, it } from 'vitest';
import {
  createPublicationRecord,
  createPublicationTombstone,
  createRelayReplicaInventoryBatchRequestV1,
  createRelayReplicaInventoryBatchResponseV1,
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
  ReplicaReconciliationScheduler,
  ReplicaPlacementTracker,
  MAX_PERMANENTLY_REJECTED_REPLICA_TARGETS,
  createReplicaPlacementIntent,
  isPermanentReplicaRejection,
  isReconciliationRequiredReplicaRejection,
  verifyReplicaPlacementIntent,
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

    const rejectedReceipt = createRelayReplicaReceiptV1(
      request,
      secondTarget,
      { status: 'rejected', reason: 'capacity-exhausted' },
      NOW + 2,
    );
    expect(tracker.canRecordReceipt(rejectedReceipt)).toBe(false);
    expect(tracker.recordReceipt(rejectedReceipt)).toBe(false);

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

  it('replaces only capacity-constrained targets and clears that exclusion for an update', () => {
    const local = generateIdentity();
    const rejectedTarget = generateIdentity();
    const replacementTarget = generateIdentity();
    const { keys, operation } = publication();
    const tracker = new ReplicaPlacementTracker(local.did);
    expect(tracker.applyIntent(createReplicaPlacementIntent(
      operation,
      [rejectedTarget.did, replacementTarget.did],
      POLICY,
      1,
      NOW,
    ))).toBe(true);

    const request = createRelayReplicaPutV1(operation, local, NOW, NOW + 30_000);
    const capacityRefusal = createRelayReplicaReceiptV1(
      request,
      rejectedTarget,
      { status: 'rejected', reason: 'capacity-exhausted' },
      NOW + 1,
    );
    const temporaryRefusal = createRelayReplicaReceiptV1(
      request,
      replacementTarget,
      { status: 'rejected', reason: 'rate-limited' },
      NOW + 2,
    );
    const staleRefusal = createRelayReplicaReceiptV1(
      request,
      replacementTarget,
      { status: 'rejected', reason: 'stale' },
      NOW + 3,
    );
    expect(isPermanentReplicaRejection(capacityRefusal)).toBe(true);
    expect(isPermanentReplicaRejection(temporaryRefusal)).toBe(false);
    expect(isPermanentReplicaRejection(staleRefusal)).toBe(false);
    expect(isReconciliationRequiredReplicaRejection(staleRefusal)).toBe(true);
    expect(tracker.canRecordPermanentRejection(capacityRefusal)).toBe(true);
    expect(tracker.canRecordPermanentRejection(temporaryRefusal)).toBe(false);
    expect(tracker.canRecordPermanentRejection(staleRefusal)).toBe(false);

    const replacement = tracker.nextIntent(
      operation,
      [replacementTarget.did],
      POLICY,
      NOW + 4,
      [rejectedTarget.did],
    )!;
    expect(tracker.applyIntent(replacement)).toBe(true);
    expect(tracker.statusFor(operation.publicationId)).toMatchObject({
      permanentlyRejectedRelayIds: [rejectedTarget.did],
      pendingRelayIds: [replacementTarget.did],
      intent: {
        targetRelayIds: [replacementTarget.did],
        permanentlyRejectedRelayIds: [rejectedTarget.did],
      },
    });
    expect(tracker.canRecordPermanentRejection(capacityRefusal)).toBe(false);

    const update = createPublicationRecord({
      groupId: operation.groupId,
      fingerprintEpoch: operation.fingerprint.epoch,
      fingerprint: new Uint8Array(64).fill(0x7b),
      itemType: operation.itemType,
      createdAt: operation.createdAt + 1,
      expiresAt: operation.expiresAt,
      sequence: operation.sequence + 1,
    }, keys);
    const updateIntent = tracker.nextIntent(
      update,
      [rejectedTarget.did, replacementTarget.did],
      POLICY,
    )!;
    expect(updateIntent.permanentlyRejectedRelayIds).toEqual([]);
  });

  it('durably quarantines a divergent operation and resets only for a newer operation', () => {
    const local = generateIdentity();
    const staleTarget = generateIdentity();
    const healthyTarget = generateIdentity();
    const { keys, operation } = publication();
    const tracker = new ReplicaPlacementTracker(local.did);
    expect(tracker.applyIntent(createReplicaPlacementIntent(
      operation,
      [staleTarget.did, healthyTarget.did],
      POLICY,
      1,
      NOW,
    ))).toBe(true);

    const request = createRelayReplicaPutV1(operation, local, NOW, NOW + 30_000);
    const stale = createRelayReplicaReceiptV1(
      request,
      staleTarget,
      { status: 'rejected', reason: 'stale' },
      NOW + 1,
    );
    expect(tracker.canRecordReconciliationRequirement(stale)).toBe(true);
    const quarantined = tracker.nextIntent(
      operation,
      [staleTarget.did, healthyTarget.did],
      POLICY,
      NOW + 2,
      [],
      [staleTarget.did],
    )!;
    expect(tracker.applyIntent(quarantined)).toBe(true);
    expect(tracker.statusFor(operation.publicationId)).toMatchObject({
      reconciliationRequired: true,
      reconciliationRequiredRelayIds: [staleTarget.did],
      pendingRelayIds: [],
      minimumConfirmed: false,
      targetConfirmed: false,
    });
    expect(tracker.canRecordReconciliationRequirement(stale)).toBe(false);

    const update = createPublicationRecord({
      groupId: operation.groupId,
      fingerprintEpoch: operation.fingerprint.epoch,
      fingerprint: new Uint8Array(64).fill(0x7c),
      itemType: operation.itemType,
      createdAt: operation.createdAt + 1,
      expiresAt: operation.expiresAt,
      sequence: operation.sequence + 1,
    }, keys);
    const updateIntent = tracker.nextIntent(
      update,
      [staleTarget.did, healthyTarget.did],
      POLICY,
    )!;
    expect(updateIntent.reconciliationRequiredRelayIds).toEqual([]);
  });

  it('retains a signed state-refusal capability and retires it only with its exact operation', () => {
    const local = generateIdentity();
    const target = generateIdentity();
    const { operation } = publication();
    const tracker = new ReplicaPlacementTracker(local.did);
    const request = createRelayReplicaPutV1(operation, local, NOW, NOW + 30_000);
    const rejection = createRelayReplicaReceiptV1(
      request,
      target,
      { status: 'rejected', reason: 'stale' },
      NOW + 1,
    );
    const intent = createReplicaPlacementIntent(
      operation,
      [target.did],
      POLICY,
      1,
      NOW + 2,
      [],
      [target.did],
      [{ relayId: target.did, rejection }],
    );

    expect(tracker.applyIntent(intent)).toBe(true);
    expect(tracker.reconciliationRequirementsFor(operation.publicationId)).toEqual([
      { relayId: target.did, rejection },
    ]);
    expect(tracker.retireIntentIfMatches(structuredClone(operation))).toBe(true);
    expect(tracker.statusFor(operation.publicationId)).toBeUndefined();
  });

  it('stops automatic capacity replacement cleanly when refusal history reaches its bound', () => {
    const local = generateIdentity();
    const selectedTarget = generateIdentity();
    const { operation } = publication();
    const priorCapacityTargets = Array.from(
      { length: MAX_PERMANENTLY_REJECTED_REPLICA_TARGETS },
      () => generateIdentity().did,
    ).sort();
    const tracker = new ReplicaPlacementTracker(local.did);
    expect(tracker.applyIntent(createReplicaPlacementIntent(
      operation,
      [selectedTarget.did],
      POLICY,
      1,
      NOW,
      priorCapacityTargets,
    ))).toBe(true);

    const request = createRelayReplicaPutV1(operation, local, NOW, NOW + 30_000);
    const capacity = createRelayReplicaReceiptV1(
      request,
      selectedTarget,
      { status: 'rejected', reason: 'capacity-exhausted' },
      NOW + 1,
    );
    expect(tracker.canRecordPermanentRejection(capacity)).toBe(false);
    expect(tracker.nextIntent(
      operation,
      [selectedTarget.did],
      POLICY,
      NOW + 2,
      priorCapacityTargets,
    )).toBeUndefined();
  });

  it('accepts pre-refusal and pre-quarantine placement intents and normalizes them in memory', () => {
    const { operation } = publication();
    const target = generateIdentity();
    const current = createReplicaPlacementIntent(operation, [target.did], POLICY, 1, NOW);
    const {
      permanentlyRejectedRelayIds: _ignoredRefusal,
      reconciliationRequiredRelayIds: _ignoredReconciliation,
      ...legacy
    } = current;
    const tracker = new ReplicaPlacementTracker();

    expect(verifyReplicaPlacementIntent(legacy)).toBe(true);
    expect(tracker.applyIntent(legacy)).toBe(true);
    expect(tracker.getIntent(operation.publicationId)?.permanentlyRejectedRelayIds).toEqual([]);
    expect(tracker.getIntent(operation.publicationId)?.reconciliationRequiredRelayIds).toEqual([]);

    const { reconciliationRequiredRelayIds: _ignored, ...refusalOnly } = current;
    expect(verifyReplicaPlacementIntent(refusalOnly)).toBe(true);
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
    const ordered = [...receipts].sort((first, second) => {
      const firstKey = `${first.publicationId}\u0000${first.responderRelayId}`;
      const secondKey = `${second.publicationId}\u0000${second.responderRelayId}`;
      if (firstKey === secondKey) return 0;
      return firstKey < secondKey ? -1 : 1;
    });
    const scheduler = new ReplicaInventoryScheduler();

    expect(scheduler.take(receipts, 1).map(receipt => receipt.publicationId))
      .toEqual([ordered[0].publicationId]);
    expect(scheduler.take(receipts.filter(receipt => receipt !== ordered[0]), 1)
      .map(receipt => receipt.publicationId)).toEqual([ordered[1].publicationId]);
    expect(scheduler.take(receipts.filter(receipt => receipt !== ordered[0] && receipt !== ordered[1]), 1)
      .map(receipt => receipt.publicationId)).toEqual([ordered[2].publicationId]);
  });

  it('applies each bit in a signed inventory batch to its current receipt', () => {
    const local = generateIdentity();
    const target = generateIdentity();
    const operations = [publication().operation, publication().operation];
    const tracker = new ReplicaPlacementTracker(local.did);
    const receipts = operations.map((operation, index) => {
      expect(tracker.applyIntent(createReplicaPlacementIntent(
        operation,
        [target.did],
        POLICY,
        1,
        NOW + index,
      ))).toBe(true);
      const placement = createRelayReplicaPutV1(operation, local, NOW + index, NOW + 30_000);
      const receipt = createRelayReplicaReceiptV1(
        placement,
        target,
        { status: 'stored' },
        NOW + index + 1,
      );
      expect(tracker.recordReceipt(receipt)).toBe(true);
      return receipt;
    });
    const request = createRelayReplicaInventoryBatchRequestV1(
      receipts,
      local,
      NOW + 3,
      NOW + 30_000,
    );
    const response = createRelayReplicaInventoryBatchResponseV1(
      request,
      target,
      { status: 'inventory', present: [true, false] },
      NOW + 4,
    );

    expect(tracker.recordInventoryBatchResponse(response)).toBe(2);
    expect(tracker.statusFor(request.receipts[0].publicationId)).toMatchObject({
      inventoryPresentRelayIds: [target.did],
      inventoryMissingRelayIds: [],
      pendingRelayIds: [],
    });
    expect(tracker.statusFor(request.receipts[1].publicationId)).toMatchObject({
      inventoryPresentRelayIds: [],
      inventoryMissingRelayIds: [target.did],
      pendingRelayIds: [target.did],
    });
    const newerRequest = createRelayReplicaInventoryBatchRequestV1(
      receipts,
      local,
      NOW + 5,
      NOW + 30_000,
    );
    const newerResponse = createRelayReplicaInventoryBatchResponseV1(
      newerRequest,
      target,
      { status: 'inventory', present: [false, false] },
      NOW + 6,
    );
    expect(tracker.recordInventoryBatchResponse(newerResponse)).toBe(2);
    expect(tracker.recordInventoryBatchResponse(response)).toBe(0);
    expect(tracker.statusFor(request.receipts[0].publicationId)?.inventoryMissingRelayIds)
      .toEqual([target.did]);
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

  it('backs off repeated reconciliation reads while allowing a new refusal immediately', () => {
    const local = generateIdentity();
    const target = generateIdentity();
    const { operation } = publication();
    const request = createRelayReplicaPutV1(operation, local, NOW, NOW + 30_000);
    const firstRejection = createRelayReplicaReceiptV1(
      request,
      target,
      { status: 'rejected', reason: 'stale' },
      NOW + 1,
    );
    const scheduler = new ReplicaReconciliationScheduler(100, 400);
    const firstRequirement = { relayId: target.did, rejection: firstRejection };

    expect(scheduler.take([firstRequirement], 1, NOW)).toEqual([firstRequirement]);
    expect(scheduler.take([firstRequirement], 1, NOW + 99)).toEqual([]);
    expect(scheduler.take([firstRequirement], 1, NOW + 100)).toEqual([firstRequirement]);
    expect(scheduler.take([firstRequirement], 1, NOW + 299)).toEqual([]);
    expect(scheduler.take([firstRequirement], 1, NOW + 300)).toEqual([firstRequirement]);

    const secondRejection = createRelayReplicaReceiptV1(
      request,
      target,
      { status: 'rejected', reason: 'stale' },
      NOW + 2,
    );
    const secondRequirement = { relayId: target.did, rejection: secondRejection };
    expect(scheduler.take([secondRequirement], 1, NOW + 301)).toEqual([secondRequirement]);
  });
});
