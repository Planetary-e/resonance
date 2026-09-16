import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../crypto.js';
import {
  createPublicationRecord,
  generatePublicationKeyMaterial,
} from '../protocol-v2.js';
import {
  createRelayReplicaPutFrameV1,
  createRelayReplicaPutV1,
  createRelayReplicaReceiptFrameV1,
  createRelayReplicaReceiptV1,
  isDurabilityReceiptV1,
  isRelayReplicaPutActiveV1,
  parseRelayReplicaPutFrameV1,
  parseRelayReplicaReceiptFrameV1,
  serializeRelayReplicaPutFrameV1,
  serializeRelayReplicaReceiptFrameV1,
  verifyRelayReplicaPutV1,
  verifyRelayReplicaReceiptV1,
} from '../relay-replication.js';

const NOW = 1_800_000_000_000;

function publication() {
  return createPublicationRecord({
    groupId: 'public',
    fingerprintEpoch: '2026-09',
    fingerprint: new Uint8Array(64).fill(0xa5),
    itemType: 'offer',
    createdAt: NOW,
    expiresAt: NOW + 86_400_000,
  }, generatePublicationKeyMaterial());
}

describe('relay replica placement', () => {
  it('binds a signed durability receipt to the exact owner-signed operation', () => {
    const sender = generateIdentity();
    const responder = generateIdentity();
    const operation = publication();
    const request = createRelayReplicaPutV1(operation, sender, NOW, NOW + 30_000);
    const receipt = createRelayReplicaReceiptV1(request, responder, { status: 'stored' }, NOW + 1);

    expect(verifyRelayReplicaPutV1(request)).toBe(true);
    expect(isRelayReplicaPutActiveV1(request, NOW + 1)).toBe(true);
    expect(verifyRelayReplicaReceiptV1(receipt, request)).toBe(true);
    expect(isDurabilityReceiptV1(receipt)).toBe(true);
    expect(receipt.publicationId).toBe(operation.publicationId);
    expect(receipt.operationSignature).toBe(operation.signature);
    expect(receipt.responderRelayId).toBe(responder.did);
  });

  it('rejects tampering, mismatched requests, and invalid receipt results', () => {
    const sender = generateIdentity();
    const responder = generateIdentity();
    const request = createRelayReplicaPutV1(publication(), sender, NOW, NOW + 30_000);
    const receipt = createRelayReplicaReceiptV1(request, responder, {
      status: 'rejected',
      reason: 'unsupported-group',
    }, NOW + 1);

    const tampered = structuredClone(request);
    tampered.operation.sequence += 1;
    expect(verifyRelayReplicaPutV1(tampered)).toBe(false);
    expect(isRelayReplicaPutActiveV1(request, request.expiresAt)).toBe(false);
    expect(isDurabilityReceiptV1(receipt)).toBe(false);

    const otherRequest = createRelayReplicaPutV1(publication(), sender, NOW, NOW + 30_000);
    expect(verifyRelayReplicaReceiptV1(receipt, otherRequest)).toBe(false);
    expect(() => createRelayReplicaReceiptV1(request, responder, {
      status: 'stored',
      reason: 'invalid',
    }, NOW + 1)).toThrow('Invalid replica receipt input');
    expect(() => createRelayReplicaReceiptV1(request, responder, {
      status: 'rejected',
    }, NOW + 1)).toThrow('Invalid replica receipt input');
  });

  it('round-trips strict bounded request and receipt frames', () => {
    const request = createRelayReplicaPutV1(
      publication(),
      generateIdentity(),
      NOW,
      NOW + 30_000,
    );
    const receipt = createRelayReplicaReceiptV1(
      request,
      generateIdentity(),
      { status: 'already-stored' },
      NOW + 1,
    );
    const putFrame = createRelayReplicaPutFrameV1(request);
    const receiptFrame = createRelayReplicaReceiptFrameV1(receipt);

    expect(parseRelayReplicaPutFrameV1(serializeRelayReplicaPutFrameV1(putFrame))).toEqual(putFrame);
    expect(parseRelayReplicaReceiptFrameV1(serializeRelayReplicaReceiptFrameV1(receiptFrame)))
      .toEqual(receiptFrame);
    expect(() => parseRelayReplicaPutFrameV1(JSON.stringify({ ...putFrame, extra: true }))).toThrow();
    expect(() => parseRelayReplicaReceiptFrameV1(JSON.stringify({ ...receiptFrame, extra: true }))).toThrow();
  });
});
