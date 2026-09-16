import { describe, expect, it } from 'vitest';
import {
  createChannelCloseOperationV2,
  createChannelMessageOperationV2,
  createRelationshipMailboxDepositFrameV2,
  createRelationshipMailboxDepositV2,
  createRelationshipMailboxRequestFrameV2,
  createRelationshipMailboxRequestV2,
  decryptChannelContentV2,
  decryptChannelOperationV2,
  deriveSharedSecret,
  encryptChannelOperationV2,
  generateRelationshipKeyMaterial,
  parseRelationshipMailboxDepositFrameV2,
  parseRelationshipMailboxRequestFrameV2,
  serializeRelationshipMailboxDepositFrameV2,
  serializeRelationshipMailboxRequestFrameV2,
  verifyChannelOperationV2,
  verifyRelationshipMailboxDepositV2,
  verifyRelationshipMailboxRequestV2,
} from '../index.js';

const NOW = 1_800_000_000_000;
const CHANNEL_ID = 'chn_' + 'a'.repeat(43);
const ADMISSION = {
  version: 2 as const,
  kind: 'admission-capability' as const,
  scheme: 'test-v1',
  issuer: 'community:test',
  token: 'A'.repeat(43),
  requestProof: 'B'.repeat(43),
};

describe('protocol v2 relationship mailboxes', () => {
  it('encrypts signed sequenced content for only one relationship mailbox', () => {
    const alice = generateRelationshipKeyMaterial();
    const bob = generateRelationshipKeyMaterial();
    const aliceShared = deriveSharedSecret(alice.channelKeyPair.secretKey, bob.channelKeyPair.publicKey);
    const bobShared = deriveSharedSecret(bob.channelKeyPair.secretKey, alice.channelKeyPair.publicKey);
    const content = { kind: 'disclosure' as const, text: 'I can help this weekend', level: 'general' as const, createdAt: NOW };
    const operation = createChannelMessageOperationV2(
      CHANNEL_ID, bob.relationshipId, 0, content, aliceShared, alice, NOW, NOW + 60_000,
    );
    const envelope = encryptChannelOperationV2(operation, {
      id: bob.mailboxId,
      encryptionKey: Buffer.from(bob.mailboxKeyPair.publicKey).toString('base64'),
    });

    expect(verifyChannelOperationV2(operation)).toBe(true);
    expect(decryptChannelOperationV2(envelope, bob)).toEqual(operation);
    expect(decryptChannelContentV2(operation, bobShared)).toEqual(content);
    expect(() => decryptChannelOperationV2(envelope, alice)).toThrow();
    expect(JSON.stringify(envelope)).not.toContain(CHANNEL_ID);
    expect(JSON.stringify(envelope)).not.toContain(alice.relationshipId);
  });

  it('authenticates fetch, acknowledgement, deposit, and close with relationship keys', () => {
    const alice = generateRelationshipKeyMaterial();
    const bob = generateRelationshipKeyMaterial();
    const close = createChannelCloseOperationV2(
      CHANNEL_ID, bob.relationshipId, 3, alice, NOW, NOW + 60_000,
    );
    const envelope = encryptChannelOperationV2(close, {
      id: bob.mailboxId,
      encryptionKey: Buffer.from(bob.mailboxKeyPair.publicKey).toString('base64'),
    });
    const fetch = createRelationshipMailboxRequestV2('fetch', bob, [], NOW);
    const ack = createRelationshipMailboxRequestV2('ack', bob, [envelope.envelopeId], NOW);
    const deposit = createRelationshipMailboxDepositV2(bob.relationshipId, alice, envelope, NOW);
    const fetchRaw = serializeRelationshipMailboxRequestFrameV2(
      createRelationshipMailboxRequestFrameV2(fetch, ADMISSION),
    );
    const depositRaw = serializeRelationshipMailboxDepositFrameV2(
      createRelationshipMailboxDepositFrameV2(deposit, ADMISSION),
    );

    expect(verifyRelationshipMailboxRequestV2(fetch)).toBe(true);
    expect(verifyRelationshipMailboxRequestV2(ack)).toBe(true);
    expect(verifyRelationshipMailboxDepositV2(deposit)).toBe(true);
    expect(parseRelationshipMailboxRequestFrameV2(fetchRaw).request).toEqual(fetch);
    expect(parseRelationshipMailboxDepositFrameV2(depositRaw).request).toEqual(deposit);
    expect(parseRelationshipMailboxRequestFrameV2(fetchRaw).admission).toEqual(ADMISSION);
    expect(parseRelationshipMailboxDepositFrameV2(depositRaw).admission).toEqual(ADMISSION);
    expect(depositRaw).not.toContain(CHANNEL_ID);
    expect(depositRaw).not.toContain('pub_');
    expect(depositRaw).not.toContain('did:key:');
  });

  it('rejects operation and mailbox metadata tampering', () => {
    const alice = generateRelationshipKeyMaterial();
    const bob = generateRelationshipKeyMaterial();
    const shared = deriveSharedSecret(alice.channelKeyPair.secretKey, bob.channelKeyPair.publicKey);
    const operation = createChannelMessageOperationV2(
      CHANNEL_ID,
      bob.relationshipId,
      0,
      { kind: 'disclosure', text: 'hello', level: 'specific', createdAt: NOW },
      shared,
      alice,
      NOW,
      NOW + 60_000,
    );
    expect(verifyChannelOperationV2({ ...operation, sequence: 1 })).toBe(false);
    const envelope = encryptChannelOperationV2(operation, {
      id: bob.mailboxId,
      encryptionKey: Buffer.from(bob.mailboxKeyPair.publicKey).toString('base64'),
    });
    const deposit = createRelationshipMailboxDepositV2(bob.relationshipId, alice, envelope, NOW);
    expect(verifyRelationshipMailboxDepositV2({ ...deposit, recipientRelationshipId: alice.relationshipId }))
      .toBe(false);
  });
});
