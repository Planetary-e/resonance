import { describe, expect, it } from 'vitest';
import {
  createPublicationRecord,
  createPublicationTombstone,
  createRelayReplicaPutV1,
  createRelayReplicaReceiptV1,
  generateIdentity,
  generatePublicationKeyMaterial,
} from '@resonance/core';
import {
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
});
