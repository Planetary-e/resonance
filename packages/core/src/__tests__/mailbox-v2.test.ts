import { describe, expect, it } from 'vitest';
import {
  createDeterministicMatchId,
  createMailboxRequest,
  createMailboxRequestFrame,
  createMatchOperationV2,
  createMatchNoticeMessage,
  createPublicationRecord,
  decryptMatchNotice,
  encryptMatchNotice,
  generateIdentity,
  generatePublicationKeyMaterial,
  parseMailboxRequestFrame,
  serializeMailboxRequestFrame,
  verifyMailboxRequest,
  verifyMatchNoticeMessage,
} from '../index.js';

const NOW = 1_800_000_000_000;
const ADMISSION = {
  version: 2 as const,
  kind: 'admission-capability' as const,
  scheme: 'test-v1',
  issuer: 'community:test',
  token: 'A'.repeat(43),
  requestProof: 'B'.repeat(43),
};

function publication(itemType: 'need' | 'offer', fill: number) {
  const keys = generatePublicationKeyMaterial();
  const record = createPublicationRecord({
    groupId: 'public',
    fingerprintEpoch: 'pilot-static-v1',
    fingerprint: new Uint8Array(64).fill(fill),
    itemType,
    createdAt: NOW,
    expiresAt: NOW + 86_400_000,
  }, keys);
  return { keys, record };
}

describe('protocol v2 match mailboxes', () => {
  it('derives the same match ID regardless of publication order', () => {
    const first = publication('need', 1);
    const second = publication('offer', 2);
    expect(createDeterministicMatchId(first.record.publicationId, second.record.publicationId))
      .toBe(createDeterministicMatchId(second.record.publicationId, first.record.publicationId));
  });

  it('encrypts a relay-signed notice for exactly one publication mailbox', () => {
    const recipient = publication('need', 1);
    const partner = publication('offer', 2);
    const relay = generateIdentity();
    const operation = createMatchOperationV2(recipient.record, partner.record, relay, {
      createdAt: NOW + 1, expiresAt: NOW + 60_000,
    });
    const notice = createMatchNoticeMessage(
      recipient.record,
      partner.record,
      operation,
      relay,
    );
    const envelope = encryptMatchNotice(notice, recipient.record);
    const serialized = JSON.stringify(envelope);

    expect(verifyMatchNoticeMessage(notice)).toBe(true);
    expect(serialized).not.toContain(partner.record.publicationId);
    expect(serialized).not.toContain(notice.payload.matchId);
    expect(decryptMatchNotice(envelope, recipient.keys)).toEqual(notice);
    expect(() => decryptMatchNotice(envelope, partner.keys)).toThrow('does not belong');
  });

  it('rejects modified ciphertext', () => {
    const recipient = publication('need', 1);
    const partner = publication('offer', 2);
    const relay = generateIdentity();
    const operation = createMatchOperationV2(recipient.record, partner.record, relay, {
      createdAt: NOW + 1, expiresAt: NOW + 60_000,
    });
    const notice = createMatchNoticeMessage(
      recipient.record, partner.record, operation, relay,
    );
    const envelope = encryptMatchNotice(notice, recipient.record);
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`;
    expect(() => decryptMatchNotice(envelope, recipient.keys)).toThrow();
  });
});

describe('publication-scoped mailbox requests', () => {
  it('signs and round-trips fetch and acknowledgement requests', () => {
    const recipient = publication('need', 1);
    const fetch = createMailboxRequest('fetch', recipient.record, recipient.keys, [], NOW);
    const ack = createMailboxRequest(
      'ack',
      recipient.record,
      recipient.keys,
      ['env_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
      NOW,
    );

    expect(verifyMailboxRequest(fetch)).toBe(true);
    expect(verifyMailboxRequest(ack)).toBe(true);
    const serialized = serializeMailboxRequestFrame(createMailboxRequestFrame(fetch, ADMISSION));
    expect(parseMailboxRequestFrame(serialized).request).toEqual(fetch);
    expect(parseMailboxRequestFrame(serialized).admission).toEqual(ADMISSION);
    expect(serialized).not.toContain('did:key:');
  });

  it('rejects request changes and a publication key from another record', () => {
    const recipient = publication('need', 1);
    const other = publication('need', 2);
    const request = createMailboxRequest('fetch', recipient.record, recipient.keys, [], NOW);

    expect(verifyMailboxRequest({ ...request, mailboxId: other.record.mailbox.id })).toBe(false);
    expect(() => createMailboxRequest('fetch', recipient.record, other.keys, [], NOW)).toThrow('does not own');
  });
});
