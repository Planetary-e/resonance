import { describe, expect, it } from 'vitest';
import {
  createConsentAcceptV2,
  createConsentOfferV2,
  createDeterministicMatchId,
  createMailboxDepositFrame,
  createMailboxDepositRequest,
  createPublicationRecord,
  decryptRelationshipMessage,
  encryptRelationshipMessage,
  generatePublicationKeyMaterial,
  generateRelationshipKeyMaterial,
  parseMailboxDepositFrame,
  serializeMailboxDepositFrame,
  verifyConsentAcceptV2,
  verifyConsentOfferV2,
  verifyMailboxDepositRequest,
} from '../index.js';

const NOW = 1_800_000_000_000;

function publication(itemType: 'need' | 'offer', fill: number) {
  const keys = generatePublicationKeyMaterial();
  const record = createPublicationRecord({
    groupId: 'pairwise-test',
    fingerprintEpoch: 'pilot-static-v1',
    fingerprint: new Uint8Array(64).fill(fill),
    itemType,
    createdAt: NOW,
    expiresAt: NOW + 86_400_000,
  }, keys);
  return { keys, record };
}

describe('protocol v2 pairwise consent', () => {
  it('establishes fresh relationship identities and a common channel ID', () => {
    const alice = publication('offer', 1);
    const bob = publication('need', 2);
    const aliceRelationship = generateRelationshipKeyMaterial();
    const bobRelationship = generateRelationshipKeyMaterial();
    const matchId = createDeterministicMatchId(
      alice.record.publicationId,
      bob.record.publicationId,
    );
    const offer = createConsentOfferV2(
      matchId, alice.record, bob.record, alice.keys, aliceRelationship, NOW + 1, NOW + 60_000,
    );
    const accept = createConsentAcceptV2(
      offer, bob.record, bob.keys, bobRelationship, NOW + 2, NOW + 60_000,
    );

    expect(verifyConsentOfferV2(offer)).toBe(true);
    expect(verifyConsentAcceptV2(accept)).toBe(true);
    expect(offer.senderRelationshipId).toBe(aliceRelationship.relationshipId);
    expect(accept.senderRelationshipId).toBe(bobRelationship.relationshipId);
    expect(offer.senderRelationshipId).not.toBe(accept.senderRelationshipId);
    expect(accept.recipientRelationshipId).toBe(offer.senderRelationshipId);
    expect(offer.senderMailbox.id).toBe(aliceRelationship.mailboxId);
    expect(accept.senderMailbox.id).toBe(bobRelationship.mailboxId);
    expect(offer.senderMailbox.id).not.toBe(alice.record.mailbox.id);
  });

  it('encrypts consent to one mailbox and signs opaque relay deposit metadata', () => {
    const alice = publication('offer', 1);
    const bob = publication('need', 2);
    const matchId = createDeterministicMatchId(alice.record.publicationId, bob.record.publicationId);
    const offer = createConsentOfferV2(
      matchId,
      alice.record,
      bob.record,
      alice.keys,
      generateRelationshipKeyMaterial(),
      NOW + 1,
      NOW + 60_000,
    );
    const envelope = encryptRelationshipMessage(offer, bob.record);
    const deposit = createMailboxDepositRequest(
      matchId, alice.record, bob.record, alice.keys, envelope, NOW + 2,
    );
    const serialized = serializeMailboxDepositFrame(createMailboxDepositFrame(deposit));

    expect(verifyMailboxDepositRequest(deposit)).toBe(true);
    expect(parseMailboxDepositFrame(serialized).request).toEqual(deposit);
    expect(decryptRelationshipMessage(envelope, bob.keys)).toEqual(offer);
    expect(() => decryptRelationshipMessage(envelope, alice.keys)).toThrow();
    expect(JSON.stringify(envelope)).not.toContain(offer.senderRelationshipId);
    expect(serialized).not.toContain('did:key:');
  });

  it('rejects modified consent and deposit metadata', () => {
    const alice = publication('offer', 1);
    const bob = publication('need', 2);
    const matchId = createDeterministicMatchId(alice.record.publicationId, bob.record.publicationId);
    const offer = createConsentOfferV2(
      matchId, alice.record, bob.record, alice.keys, generateRelationshipKeyMaterial(),
      NOW + 1, NOW + 60_000,
    );
    expect(verifyConsentOfferV2({ ...offer, recipientPublicationId: alice.record.publicationId })).toBe(false);

    const envelope = encryptRelationshipMessage(offer, bob.record);
    const deposit = createMailboxDepositRequest(
      matchId, alice.record, bob.record, alice.keys, envelope, NOW + 2,
    );
    expect(verifyMailboxDepositRequest({ ...deposit, recipientMailboxId: alice.record.mailbox.id }))
      .toBe(false);
  });
});
