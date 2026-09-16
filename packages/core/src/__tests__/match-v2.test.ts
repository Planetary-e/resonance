import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../crypto.js';
import {
  createMatchOperationV2,
  verifyMatchOperationAgainstPublicationsV2,
  verifyMatchOperationV2,
} from '../match-v2.js';
import {
  createPublicationRecord,
  generatePublicationKeyMaterial,
  type PublicationRecord,
} from '../protocol-v2.js';

const NOW = 1_800_000_000_000;

function publication(itemType: 'need' | 'offer', byte: number, sequence = 0): PublicationRecord {
  const fingerprint = new Uint8Array(64);
  fingerprint.fill(byte);
  return createPublicationRecord({
    groupId: 'community:barcelona',
    fingerprintEpoch: '2026-09',
    fingerprint,
    itemType,
    sequence,
    createdAt: NOW,
    expiresAt: NOW + 86_400_000,
  }, generatePublicationKeyMaterial());
}

describe('match operations v2', () => {
  it('signs a match bound to exact publication revisions', () => {
    const need = publication('need', 0xaa);
    const offer = publication('offer', 0xaa);
    const operation = createMatchOperationV2(need, offer, generateIdentity(), {
      createdAt: NOW + 1,
      expiresAt: NOW + 60_000,
    });

    expect(verifyMatchOperationV2(operation)).toBe(true);
    expect(verifyMatchOperationAgainstPublicationsV2(operation, need, offer, 0.7)).toBe(true);
    expect(operation.publications.map(value => value.publicationId)).toEqual(
      [need.publicationId, offer.publicationId].sort(),
    );
    expect(operation.similarity).toBe(1);
  });

  it('uses one logical match ID while keeping relay attestations distinct', () => {
    const need = publication('need', 0xaa);
    const offer = publication('offer', 0xaa);
    const first = createMatchOperationV2(need, offer, generateIdentity(), { createdAt: NOW + 1 });
    const second = createMatchOperationV2(offer, need, generateIdentity(), { createdAt: NOW + 1 });

    expect(first.matchId).toBe(second.matchId);
    expect(first.operationId).not.toBe(second.operationId);
    expect(first.relayId).not.toBe(second.relayId);
  });

  it('rejects tampering and a different publication revision', () => {
    const need = publication('need', 0xaa);
    const offer = publication('offer', 0xaa);
    const operation = createMatchOperationV2(need, offer, generateIdentity(), { createdAt: NOW + 1 });
    const tampered = { ...operation, similarity: 0.5 };
    const revisedNeed = { ...need, sequence: 1 };

    expect(verifyMatchOperationV2(tampered)).toBe(false);
    expect(verifyMatchOperationAgainstPublicationsV2(operation, revisedNeed, offer, 0.7)).toBe(false);
  });

  it('rejects incompatible publications and threshold failures', () => {
    const need = publication('need', 0x00);
    const offer = publication('offer', 0xff);
    const operation = createMatchOperationV2(need, offer, generateIdentity(), { createdAt: NOW + 1 });

    expect(verifyMatchOperationAgainstPublicationsV2(operation, need, offer, 0.7)).toBe(false);
    expect(() => createMatchOperationV2(need, publication('need', 0x00), generateIdentity()))
      .toThrow('not compatible');
  });
});
