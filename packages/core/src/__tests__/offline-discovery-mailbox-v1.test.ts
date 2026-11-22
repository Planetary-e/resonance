import { describe, expect, it } from 'vitest';
import {
  createLeasedIndexV1,
  createOfflineDiscoveryAckV1,
  createOfflineDiscoveryDepositV1,
  createOfflineDiscoveryReceiptV1,
  createOfflineDiscoveryRequestV1,
  createOriginalCommitmentV1,
  decryptOfflineDiscoveryEnvelopeV1,
  encryptOfflineDiscoveryRequestV1,
  generateIdentity,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
  generateSigningKeyPair,
  offlineDiscoveryAdmissionBindingV1,
  parseOfflineDiscoveryAckV1,
  parseOfflineDiscoveryDepositV1,
  serializeOfflineDiscoveryAckV1,
  serializeOfflineDiscoveryDepositV1,
  verifyOfflineDiscoveryAckForDepositV1,
  verifyOfflineDiscoveryAckV1,
  verifyOfflineDiscoveryDepositV1,
  verifyOfflineDiscoveryEnvelopeV1,
  verifyOfflineDiscoveryReceiptForDepositV1,
  verifyOfflineDiscoveryReceiptV1,
} from '../index.js';
import { decodeBase64 } from '../crypto.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function fixture() {
  const keys = generateLeasedIndexKeyMaterialV1();
  const makeIndex = (leaseSequence: number) => createLeasedIndexV1({
    leaseSequence,
    semanticRevision: 0,
    groupId: 'public',
    itemType: 'need',
    derivationId: 'fixed-v1',
    fingerprintEpoch: 'epoch-1',
    fingerprint: new Uint8Array(64).fill(1),
    originalCommitment: createOriginalCommitmentV1(new Uint8Array(8), generateOriginalCommitmentKeyV1()),
    createdAt: NOW,
    expiresAt: NOW + 7 * DAY,
  }, keys);
  const index = makeIndex(0);
  const refreshedIndex = makeIndex(1);
  const sender = generateSigningKeyPair();
  const input = {
    requestNonce: new Uint8Array(16).fill(3),
    createdAt: NOW,
    expiresAt: NOW + DAY,
    payload: 'fixed request',
    replyCapability: 'reply-capability',
  };
  const request = createOfflineDiscoveryRequestV1(input, index, sender);
  const envelope = encryptOfflineDiscoveryRequestV1(request);
  const deposit = createOfflineDiscoveryDepositV1(envelope, request, sender);
  return { keys, index, refreshedIndex, sender, input, request, envelope, deposit };
}

describe('encrypted offline discovery envelope', () => {
  it('uses fixed padding, fresh encryption, and strict round-trip bindings', () => {
    const { keys, request, envelope, deposit } = fixture();
    expect(decodeBase64(envelope.ciphertext)).toHaveLength(8192 + 16);
    expect(Buffer.byteLength(serializeOfflineDiscoveryDepositV1(deposit))).toBeLessThan(16 * 1024 + 8192);
    expect(verifyOfflineDiscoveryEnvelopeV1(envelope)).toBe(true);
    expect(decryptOfflineDiscoveryEnvelopeV1(envelope, keys.mailboxKeyPair)).toEqual(request);
    expect(encryptOfflineDiscoveryRequestV1(request).ciphertext).not.toBe(envelope.ciphertext);
  });

  it('rejects modified ciphertext, wrong keys, and outer changes', () => {
    const { keys, envelope } = fixture();
    const changed = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -4)}AAAA` };
    expect(verifyOfflineDiscoveryEnvelopeV1(changed)).toBe(true);
    expect(() => decryptOfflineDiscoveryEnvelopeV1(changed, keys.mailboxKeyPair)).toThrow();
    expect(() => decryptOfflineDiscoveryEnvelopeV1(envelope, generateLeasedIndexKeyMaterialV1().mailboxKeyPair)).toThrow();
    expect(() => decryptOfflineDiscoveryEnvelopeV1({
      ...envelope,
      requestId: `oreq_${'A'.repeat(43)}`,
    }, keys.mailboxKeyPair)).toThrow('bindings differ');
  });
});

describe('signed deposit, ACK, and replica receipt', () => {
  it('round-trips an exact signed deposit and admission binding', () => {
    const { deposit } = fixture();
    expect(verifyOfflineDiscoveryDepositV1(deposit)).toBe(true);
    expect(parseOfflineDiscoveryDepositV1(serializeOfflineDiscoveryDepositV1(deposit))).toEqual(deposit);
    expect(offlineDiscoveryAdmissionBindingV1(deposit)).toMatch(/^admreq_/);
    expect(verifyOfflineDiscoveryDepositV1({ ...deposit, generationId: `gen_${'A'.repeat(43)}` })).toBe(false);
  });

  it('binds owner-signed ACKs to the exact generation', () => {
    const { keys, request, index, refreshedIndex, input, sender, envelope, deposit } = fixture();
    const ack = createOfflineDiscoveryAckV1(request, index, keys, NOW + 1);
    expect(verifyOfflineDiscoveryAckV1(ack)).toBe(true);
    expect(parseOfflineDiscoveryAckV1(serializeOfflineDiscoveryAckV1(ack))).toEqual(ack);
    expect(verifyOfflineDiscoveryAckForDepositV1(ack, deposit, index)).toBe(true);
    const refreshedRequest = createOfflineDiscoveryRequestV1({
      ...input,
      previousGenerationId: request.generationId,
      previousEnvelopeId: envelope.envelopeId,
    }, refreshedIndex, sender);
    const refreshedAck = createOfflineDiscoveryAckV1(refreshedRequest, refreshedIndex, keys, NOW + 2);
    expect(refreshedAck.ackId).not.toBe(ack.ackId);
    expect(verifyOfflineDiscoveryAckV1({ ...ack, generationId: refreshedAck.generationId })).toBe(false);
  });

  it('signs receipts over the exact ciphertext, generation, and request expiry', () => {
    const { deposit } = fixture();
    const other = fixture().deposit;
    const relay = generateIdentity();
    const receipt = createOfflineDiscoveryReceiptV1(deposit, 'stored', relay, NOW + 1);
    expect(verifyOfflineDiscoveryReceiptV1(receipt)).toBe(true);
    expect(verifyOfflineDiscoveryReceiptForDepositV1(receipt, deposit)).toBe(true);
    expect(verifyOfflineDiscoveryReceiptForDepositV1(receipt, other)).toBe(false);
    expect(verifyOfflineDiscoveryReceiptV1({ ...receipt, status: 'queued' })).toBe(false);
  });
});
