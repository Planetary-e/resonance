import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../crypto.js';
import {
  createPublicationRecord,
  generatePublicationKeyMaterial,
} from '../protocol-v2.js';
import {
  createRelayReplicaPutFrameV1,
  createRelayReplicaPutV1,
  createRelayReplicaInventoryRequestFrameV1,
  createRelayReplicaInventoryRequestV1,
  createRelayReplicaInventoryResponseFrameV1,
  createRelayReplicaInventoryResponseV1,
  createRelayReplicaReceiptFrameV1,
  createRelayReplicaReceiptV1,
  isDurabilityReceiptV1,
  isRelayReplicaInventoryRequestActiveV1,
  isRelayReplicaPutActiveV1,
  parseRelayReplicaInventoryRequestFrameV1,
  parseRelayReplicaInventoryResponseFrameV1,
  parseRelayReplicaPutFrameV1,
  parseRelayReplicaReceiptFrameV1,
  serializeRelayReplicaInventoryRequestFrameV1,
  serializeRelayReplicaInventoryResponseFrameV1,
  serializeRelayReplicaPutFrameV1,
  serializeRelayReplicaReceiptFrameV1,
  verifyRelayReplicaInventoryRequestV1,
  verifyRelayReplicaInventoryResponseV1,
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
      reason: 'capacity-exhausted',
    }, NOW + 1);

    const tampered = structuredClone(request);
    tampered.operation.sequence += 1;
    expect(verifyRelayReplicaPutV1(tampered)).toBe(false);
    expect(isRelayReplicaPutActiveV1(request, request.expiresAt)).toBe(false);
    expect(isDurabilityReceiptV1(receipt)).toBe(false);

    const otherRequest = createRelayReplicaPutV1(publication(), sender, NOW, NOW + 30_000);
    expect(verifyRelayReplicaReceiptV1(receipt, otherRequest)).toBe(false);
    expect(receipt.reason).toBe('capacity-exhausted');
    expect(() => createRelayReplicaReceiptV1(request, responder, {
      status: 'stored',
      reason: 'invalid',
    }, NOW + 1)).toThrow('Invalid replica receipt input');
    expect(() => createRelayReplicaReceiptV1(request, responder, {
      status: 'rejected',
    }, NOW + 1)).toThrow('Invalid replica receipt input');
  });

  it('authorizes a signed exact inventory check with the target relay receipt', () => {
    const sender = generateIdentity();
    const responder = generateIdentity();
    const otherResponder = generateIdentity();
    const operation = publication();
    const placement = createRelayReplicaPutV1(operation, sender, NOW, NOW + 30_000);
    const receipt = createRelayReplicaReceiptV1(placement, responder, { status: 'stored' }, NOW + 1);
    const request = createRelayReplicaInventoryRequestV1(receipt, sender, NOW + 2, NOW + 30_000);
    const response = createRelayReplicaInventoryResponseV1(
      request,
      responder,
      { status: 'present' },
      NOW + 3,
    );

    expect(verifyRelayReplicaInventoryRequestV1(request)).toBe(true);
    expect(isRelayReplicaInventoryRequestActiveV1(request, NOW + 3)).toBe(true);
    expect(verifyRelayReplicaInventoryResponseV1(response, request)).toBe(true);
    expect(response).toMatchObject({
      senderRelayId: sender.did,
      responderRelayId: responder.did,
      publicationId: operation.publicationId,
      operationSignature: operation.signature,
      status: 'present',
    });

    const tampered = structuredClone(request);
    tampered.receipt.operationSignature = 'A'.repeat(88);
    expect(verifyRelayReplicaInventoryRequestV1(tampered)).toBe(false);

    const otherRequest = createRelayReplicaInventoryRequestV1(receipt, sender, NOW + 4, NOW + 30_000);
    expect(verifyRelayReplicaInventoryResponseV1(response, otherRequest)).toBe(false);
    expect(() => createRelayReplicaInventoryResponseV1(
      request,
      otherResponder,
      { status: 'missing' },
      NOW + 3,
    )).toThrow('Invalid replica inventory response input');
  });

  it('round-trips strict bounded request and receipt frames', () => {
    const sender = generateIdentity();
    const responder = generateIdentity();
    const request = createRelayReplicaPutV1(
      publication(),
      sender,
      NOW,
      NOW + 30_000,
    );
    const receipt = createRelayReplicaReceiptV1(
      request,
      responder,
      { status: 'already-stored' },
      NOW + 1,
    );
    const putFrame = createRelayReplicaPutFrameV1(request);
    const receiptFrame = createRelayReplicaReceiptFrameV1(receipt);
    const inventoryRequest = createRelayReplicaInventoryRequestV1(
      receipt,
      sender,
      NOW + 2,
      NOW + 30_000,
    );
    const inventoryResponse = createRelayReplicaInventoryResponseV1(
      inventoryRequest,
      responder,
      { status: 'missing' },
      NOW + 3,
    );
    const inventoryRequestFrame = createRelayReplicaInventoryRequestFrameV1(inventoryRequest);
    const inventoryResponseFrame = createRelayReplicaInventoryResponseFrameV1(inventoryResponse);

    expect(parseRelayReplicaPutFrameV1(serializeRelayReplicaPutFrameV1(putFrame))).toEqual(putFrame);
    expect(parseRelayReplicaReceiptFrameV1(serializeRelayReplicaReceiptFrameV1(receiptFrame)))
      .toEqual(receiptFrame);
    expect(parseRelayReplicaInventoryRequestFrameV1(
      serializeRelayReplicaInventoryRequestFrameV1(inventoryRequestFrame),
    )).toEqual(inventoryRequestFrame);
    expect(parseRelayReplicaInventoryResponseFrameV1(
      serializeRelayReplicaInventoryResponseFrameV1(inventoryResponseFrame),
    )).toEqual(inventoryResponseFrame);
    expect(() => parseRelayReplicaPutFrameV1(JSON.stringify({ ...putFrame, extra: true }))).toThrow();
    expect(() => parseRelayReplicaReceiptFrameV1(JSON.stringify({ ...receiptFrame, extra: true }))).toThrow();
    expect(() => parseRelayReplicaInventoryRequestFrameV1(
      JSON.stringify({ ...inventoryRequestFrame, extra: true }),
    )).toThrow();
    expect(() => parseRelayReplicaInventoryResponseFrameV1(
      JSON.stringify({ ...inventoryResponseFrame, extra: true }),
    )).toThrow();
  });
});
