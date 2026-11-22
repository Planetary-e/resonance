import { describe, expect, it } from 'vitest';
import {
  createContentChannelOperationV2,
  createContentGrantV1,
  createContentRequestV1,
  createContentResponseV1,
  createLeasedIndexV1,
  createOriginalCommitmentV1,
  decryptContentChannelOperationV2,
  deriveSharedSecret,
  generateLeasedIndexKeyMaterialV1,
  generateOriginalCommitmentKeyV1,
  generateRelationshipKeyMaterial,
  parseContentChannelOperationV2,
  serializeContentChannelOperationV2,
  verifyContentGrantForRequestV1,
  verifyContentGrantV1,
  verifyContentRequestV1,
  verifyContentResponseForRequestV1,
  verifyContentResponseV1,
} from '../index.js';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function fixture() {
  const owner = generateLeasedIndexKeyMaterialV1();
  const requester = generateLeasedIndexKeyMaterialV1();
  const originalBytes = new TextEncoder().encode('exact original content');
  const commitmentKey = generateOriginalCommitmentKeyV1();
  const index = createLeasedIndexV1({
    groupId: 'public',
    itemType: 'offer',
    derivationId: 'fixed-v1',
    fingerprintEpoch: 'epoch-1',
    fingerprint: new Uint8Array(64).fill(1),
    originalCommitment: createOriginalCommitmentV1(originalBytes, commitmentKey),
    createdAt: NOW,
    expiresAt: NOW + 7 * DAY,
  }, owner);
  const ownerRelationship = generateRelationshipKeyMaterial();
  const requesterRelationship = generateRelationshipKeyMaterial();
  const sharedKey = deriveSharedSecret(
    requesterRelationship.channelKeyPair.secretKey,
    ownerRelationship.channelKeyPair.publicKey,
  );
  const request = createContentRequestV1({
    channelId: `chn_${'C'.repeat(43)}`,
    requesterRelationshipId: requesterRelationship.relationshipId,
    index,
    createdAt: NOW + 1,
    expiresAt: NOW + DAY,
  }, requester);
  const grant = createContentGrantV1(request, index, owner, NOW + 2, NOW + 3_600_000);
  const response = createContentResponseV1({
    grant,
    index,
    originalBytes,
    commitmentKey,
    owner,
    createdAt: NOW + 3,
  });
  return {
    owner,
    requester,
    originalBytes,
    commitmentKey,
    index,
    ownerRelationship,
    requesterRelationship,
    sharedKey,
    request,
    grant,
    response,
  };
}

describe('signed content delivery records', () => {
  it('verifies the request, grant, exact original, and commitment key chain', () => {
    const { request, grant, response, originalBytes } = fixture();
    expect(verifyContentRequestV1(request)).toBe(true);
    expect(verifyContentGrantV1(grant)).toBe(true);
    expect(verifyContentGrantForRequestV1(grant, request)).toBe(true);
    expect(verifyContentResponseV1(response)).toBe(true);
    expect(verifyContentResponseForRequestV1(response, request)).toBe(true);
    expect(new TextDecoder().decode(Buffer.from(response.originalBytes, 'base64'))).toBe('exact original content');
  });

  it('rejects unknown fields, wrong signatures, and changed content', () => {
    const { request, grant, response } = fixture();
    expect(verifyContentRequestV1({ ...request, originalBytes: 'public' })).toBe(false);
    expect(verifyContentRequestV1({ ...request, generationId: `gen_${'A'.repeat(43)}` })).toBe(false);
    expect(verifyContentGrantV1({ ...grant, requesterPublicationId: `pub_${'A'.repeat(43)}` })).toBe(false);
    expect(verifyContentResponseV1({
      ...response,
      originalBytes: Buffer.from('changed original').toString('base64'),
    })).toBe(false);
  });

  it('refuses grants beyond lease/request expiry and wrong original commitments', () => {
    const { request, index, owner, grant, originalBytes } = fixture();
    expect(() => createContentGrantV1(request, index, owner, NOW + 2, index.expiresAt + 1)).toThrow();
    expect(() => createContentGrantV1(request, index, owner, NOW + 2, request.expiresAt + 1)).toThrow();
    expect(() => createContentResponseV1({
      grant,
      index,
      originalBytes,
      commitmentKey: generateOriginalCommitmentKeyV1(),
      owner,
      createdAt: NOW + 3,
    })).toThrow('Invalid content response input');
  });
});

describe('channel-encrypted content response', () => {
  it('uses a signed sequenced channel operation and decrypts only for the channel key', () => {
    const env = fixture();
    const operation = createContentChannelOperationV2({
      record: env.response,
      recipientRelationshipId: env.requesterRelationship.relationshipId,
      sequence: 7,
      sharedKey: env.sharedKey,
      relationshipKeys: env.ownerRelationship,
      createdAt: env.response.createdAt,
      expiresAt: env.response.expiresAt,
    });
    const serialized = serializeContentChannelOperationV2(operation);
    expect(serialized).not.toContain('exact original content');
    expect(serialized).not.toContain(env.response.originalBytes);
    expect(decryptContentChannelOperationV2(
      parseContentChannelOperationV2(serialized),
      env.sharedKey,
    )).toEqual(env.response);
    expect(() => decryptContentChannelOperationV2(operation, new Uint8Array(32))).toThrow();
  });
});
