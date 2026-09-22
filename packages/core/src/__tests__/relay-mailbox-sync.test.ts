import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../crypto.js';
import { createMailboxEnvelopeId } from '../mailbox-v2.js';
import { createPublicationRecord, generatePublicationKeyMaterial } from '../protocol-v2.js';
import { createRelayReplicaPutV1, createRelayReplicaReceiptV1 } from '../relay-replication.js';
import {
  createRelayMailboxSyncRequestV1, createRelayMailboxSyncResponseV1,
  parseRelayMailboxSyncRequestFrameV1, parseRelayMailboxSyncResponseFrameV1,
  serializeRelayMailboxSyncRequestFrameV1, serializeRelayMailboxSyncResponseFrameV1,
  verifyRelayMailboxSyncRequestV1, verifyRelayMailboxSyncResponseV1,
} from '../relay-mailbox-sync.js';

const NOW = 1_800_000_000_000;

describe('signed mailbox anti-entropy', () => {
  it('binds bounded tombstone pages and replies to a target-signed publication receipt', () => {
    const controller = generateIdentity();
    const replica = generateIdentity();
    const record = createPublicationRecord({
      groupId: 'public', fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0x27), itemType: 'need',
      createdAt: NOW, expiresAt: NOW + 86_400_000,
    }, generatePublicationKeyMaterial());
    const put = createRelayReplicaPutV1(record, controller, NOW, NOW + 30_000);
    const receipt = createRelayReplicaReceiptV1(put, replica, { status: 'stored' }, NOW + 1);
    const event = {
      kind: 'ack' as const, mailboxId: record.mailbox.id,
      envelopeId: createMailboxEnvelopeId('match_test', record.mailbox.id),
      expiresAt: NOW + 60_000,
    };
    const request = createRelayMailboxSyncRequestV1(receipt, 0, [event], controller, NOW + 2);
    const response = createRelayMailboxSyncResponseV1(request, 'ok', [event], 0, replica, NOW + 3);

    expect(verifyRelayMailboxSyncRequestV1(request, NOW + 3)).toBe(true);
    expect(verifyRelayMailboxSyncResponseV1(response, request)).toBe(true);
    expect(parseRelayMailboxSyncRequestFrameV1(serializeRelayMailboxSyncRequestFrameV1(request)))
      .toEqual(request);
    expect(parseRelayMailboxSyncResponseFrameV1(serializeRelayMailboxSyncResponseFrameV1(response)))
      .toEqual(response);
    expect(verifyRelayMailboxSyncRequestV1(request, request.expiresAt)).toBe(false);
    expect(verifyRelayMailboxSyncResponseV1({ ...response, nextCursor: 99 }, request)).toBe(false);
    expect(verifyRelayMailboxSyncResponseV1(response, {
      ...request, signature: response.signature,
    })).toBe(false);
    expect(() => createRelayMailboxSyncRequestV1(
      receipt, 0, Array.from({ length: 9 }, () => event), controller, NOW + 2,
    )).toThrow();
  });
});
