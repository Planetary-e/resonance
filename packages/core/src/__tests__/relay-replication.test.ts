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
  createRelayReplicaInventoryBatchRequestFrameV1,
  createRelayReplicaInventoryBatchRequestV1,
  createRelayReplicaInventoryBatchResponseFrameV1,
  createRelayReplicaInventoryBatchResponseV1,
  createRelayReplicaInventoryResponseFrameV1,
  createRelayReplicaInventoryResponseV1,
  createRelayReplicaReconciliationRequestFrameV1,
  createRelayReplicaReconciliationRequestV1,
  createRelayReplicaReconciliationResponseFrameV1,
  createRelayReplicaReconciliationResponseV1,
  createRelayReplicaReceiptFrameV1,
  createRelayReplicaReceiptV1,
  decodeRelayReplicaInventoryBatchPresenceV1,
  isDurabilityReceiptV1,
  isRelayReplicaInventoryRequestActiveV1,
  isRelayReplicaInventoryBatchRequestActiveV1,
  isRelayReplicaReconciliationReceiptV1,
  isRelayReplicaReconciliationRequestActiveV1,
  isRelayReplicaPutActiveV1,
  parseRelayReplicaInventoryRequestFrameV1,
  parseRelayReplicaInventoryResponseFrameV1,
  parseRelayReplicaInventoryBatchRequestFrameV1,
  parseRelayReplicaInventoryBatchResponseFrameV1,
  parseRelayReplicaReconciliationRequestFrameV1,
  parseRelayReplicaReconciliationResponseFrameV1,
  parseRelayReplicaPutFrameV1,
  parseRelayReplicaReceiptFrameV1,
  serializeRelayReplicaInventoryRequestFrameV1,
  serializeRelayReplicaInventoryResponseFrameV1,
  serializeRelayReplicaInventoryBatchRequestFrameV1,
  serializeRelayReplicaInventoryBatchResponseFrameV1,
  serializeRelayReplicaReconciliationRequestFrameV1,
  serializeRelayReplicaReconciliationResponseFrameV1,
  serializeRelayReplicaPutFrameV1,
  serializeRelayReplicaReceiptFrameV1,
  verifyRelayReplicaInventoryRequestV1,
  verifyRelayReplicaInventoryResponseV1,
  verifyRelayReplicaInventoryBatchRequestV1,
  verifyRelayReplicaInventoryBatchResponseV1,
  verifyRelayReplicaReconciliationRequestV1,
  verifyRelayReplicaReconciliationResponseV1,
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

  it('checks a bounded receipt-authorized batch with one signed presence bitmap', () => {
    const sender = generateIdentity();
    const responder = generateIdentity();
    const receipts = [publication(), publication()].map((operation, index) => {
      const placement = createRelayReplicaPutV1(operation, sender, NOW + index, NOW + 30_000);
      return createRelayReplicaReceiptV1(
        placement,
        responder,
        { status: 'stored' },
        NOW + index + 1,
      );
    });
    const request = createRelayReplicaInventoryBatchRequestV1(
      [...receipts].reverse(),
      sender,
      NOW + 3,
      NOW + 30_000,
    );
    const response = createRelayReplicaInventoryBatchResponseV1(
      request,
      responder,
      { status: 'inventory', present: [true, false] },
      NOW + 4,
    );

    expect(verifyRelayReplicaInventoryBatchRequestV1(request)).toBe(true);
    expect(isRelayReplicaInventoryBatchRequestActiveV1(request, NOW + 4)).toBe(true);
    expect(request.receipts.map(receipt => receipt.publicationId))
      .toEqual([...request.receipts].map(receipt => receipt.publicationId).sort());
    expect(verifyRelayReplicaInventoryBatchResponseV1(response, request)).toBe(true);
    expect(decodeRelayReplicaInventoryBatchPresenceV1(response)).toEqual([true, false]);

    const requestFrame = createRelayReplicaInventoryBatchRequestFrameV1(request);
    const responseFrame = createRelayReplicaInventoryBatchResponseFrameV1(response);
    expect(parseRelayReplicaInventoryBatchRequestFrameV1(
      serializeRelayReplicaInventoryBatchRequestFrameV1(requestFrame),
    )).toEqual(requestFrame);
    expect(parseRelayReplicaInventoryBatchResponseFrameV1(
      serializeRelayReplicaInventoryBatchResponseFrameV1(responseFrame),
    )).toEqual(responseFrame);

    const tampered = structuredClone(response);
    tampered.presentBitmap = 'Aw';
    expect(verifyRelayReplicaInventoryBatchResponseV1(tampered, request)).toBe(false);
    expect(() => createRelayReplicaInventoryBatchRequestV1(
      Array.from({ length: 65 }, () => receipts[0]),
      sender,
      NOW + 3,
      NOW + 30_000,
    )).toThrow('Invalid replica inventory batch request input');
  });

  it('authorizes a read-only current-state response only with a signed state refusal', () => {
    const sender = generateIdentity();
    const responder = generateIdentity();
    const keys = generatePublicationKeyMaterial();
    const operation = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0xb1),
      itemType: 'offer',
      createdAt: NOW,
      expiresAt: NOW + 86_400_000,
    }, keys);
    const current = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0xb2),
      itemType: 'offer',
      createdAt: NOW + 1,
      expiresAt: NOW + 86_400_000,
      sequence: 1,
    }, keys);
    const placement = createRelayReplicaPutV1(operation, sender, NOW, NOW + 30_000);
    const stale = createRelayReplicaReceiptV1(
      placement,
      responder,
      { status: 'rejected', reason: 'stale' },
      NOW + 1,
    );
    const request = createRelayReplicaReconciliationRequestV1(stale, sender, NOW + 2, NOW + 30_000);
    const response = createRelayReplicaReconciliationResponseV1(
      request,
      responder,
      { status: 'operation', operation: current },
      NOW + 3,
    );

    expect(isRelayReplicaReconciliationReceiptV1(stale)).toBe(true);
    expect(verifyRelayReplicaReconciliationRequestV1(request)).toBe(true);
    expect(isRelayReplicaReconciliationRequestActiveV1(request, NOW + 3)).toBe(true);
    expect(verifyRelayReplicaReconciliationResponseV1(response, request)).toBe(true);
    expect(response).toMatchObject({
      senderRelayId: sender.did,
      responderRelayId: responder.did,
      publicationId: operation.publicationId,
      rejectionRequestId: stale.requestId,
      rejectionSignature: stale.signature,
      status: 'operation',
      operation: current,
    });

    const tampered = structuredClone(response);
    tampered.rejectionSignature = 'A'.repeat(88);
    expect(verifyRelayReplicaReconciliationResponseV1(tampered, request)).toBe(false);

    const capacity = createRelayReplicaReceiptV1(
      placement,
      responder,
      { status: 'rejected', reason: 'capacity-exhausted' },
      NOW + 4,
    );
    expect(isRelayReplicaReconciliationReceiptV1(capacity)).toBe(false);
    expect(() => createRelayReplicaReconciliationRequestV1(capacity, sender, NOW + 5, NOW + 30_000))
      .toThrow('Invalid replica reconciliation request input');
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
    const rejection = createRelayReplicaReceiptV1(
      request,
      responder,
      { status: 'rejected', reason: 'stale' },
      NOW + 2,
    );
    const reconciliationRequest = createRelayReplicaReconciliationRequestV1(
      rejection,
      sender,
      NOW + 3,
      NOW + 30_000,
    );
    const reconciliationResponse = createRelayReplicaReconciliationResponseV1(
      reconciliationRequest,
      responder,
      { status: 'missing' },
      NOW + 4,
    );
    const inventoryRequestFrame = createRelayReplicaInventoryRequestFrameV1(inventoryRequest);
    const inventoryResponseFrame = createRelayReplicaInventoryResponseFrameV1(inventoryResponse);
    const reconciliationRequestFrame = createRelayReplicaReconciliationRequestFrameV1(
      reconciliationRequest,
    );
    const reconciliationResponseFrame = createRelayReplicaReconciliationResponseFrameV1(
      reconciliationResponse,
    );

    expect(parseRelayReplicaPutFrameV1(serializeRelayReplicaPutFrameV1(putFrame))).toEqual(putFrame);
    expect(parseRelayReplicaReceiptFrameV1(serializeRelayReplicaReceiptFrameV1(receiptFrame)))
      .toEqual(receiptFrame);
    expect(parseRelayReplicaInventoryRequestFrameV1(
      serializeRelayReplicaInventoryRequestFrameV1(inventoryRequestFrame),
    )).toEqual(inventoryRequestFrame);
    expect(parseRelayReplicaInventoryResponseFrameV1(
      serializeRelayReplicaInventoryResponseFrameV1(inventoryResponseFrame),
    )).toEqual(inventoryResponseFrame);
    expect(parseRelayReplicaReconciliationRequestFrameV1(
      serializeRelayReplicaReconciliationRequestFrameV1(reconciliationRequestFrame),
    )).toEqual(reconciliationRequestFrame);
    expect(parseRelayReplicaReconciliationResponseFrameV1(
      serializeRelayReplicaReconciliationResponseFrameV1(reconciliationResponseFrame),
    )).toEqual(reconciliationResponseFrame);
    expect(() => parseRelayReplicaPutFrameV1(JSON.stringify({ ...putFrame, extra: true }))).toThrow();
    expect(() => parseRelayReplicaReceiptFrameV1(JSON.stringify({ ...receiptFrame, extra: true }))).toThrow();
    expect(() => parseRelayReplicaInventoryRequestFrameV1(
      JSON.stringify({ ...inventoryRequestFrame, extra: true }),
    )).toThrow();
    expect(() => parseRelayReplicaInventoryResponseFrameV1(
      JSON.stringify({ ...inventoryResponseFrame, extra: true }),
    )).toThrow();
    expect(() => parseRelayReplicaReconciliationRequestFrameV1(
      JSON.stringify({ ...reconciliationRequestFrame, extra: true }),
    )).toThrow();
    expect(() => parseRelayReplicaReconciliationResponseFrameV1(
      JSON.stringify({ ...reconciliationResponseFrame, extra: true }),
    )).toThrow();
  });
});
