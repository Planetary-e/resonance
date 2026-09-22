import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConsentOfferV2,
  createDeterministicMatchId,
  createMailboxDepositRequest,
  createMailboxRequest,
  createMatchNoticeMessage,
  createMatchOperationV2,
  createPublicationRecord,
  encryptMatchNotice,
  encryptRelationshipMessage,
  generateIdentity,
  generatePublicationKeyMaterial,
  generateRelationshipKeyMaterial,
} from '@resonance/core';
import { compactMailboxHistory } from '../mailbox-journal-compaction.js';
import { MailboxStore } from '../mailbox-store.js';
import { RelayOperationLog } from '../operation-log.js';

const NOW = 1_800_000_000_000;
const directories: string[] = [];

function fixture() {
  const aliceKeys = generatePublicationKeyMaterial();
  const bobKeys = generatePublicationKeyMaterial();
  const base = {
    groupId: 'public', fingerprintEpoch: '2026-09',
    fingerprint: new Uint8Array(64).fill(0xa5),
    createdAt: NOW, expiresAt: NOW + 86_400_000,
  };
  const alice = createPublicationRecord({ ...base, itemType: 'offer' }, aliceKeys);
  const bob = createPublicationRecord({ ...base, itemType: 'need' }, bobKeys);
  return { alice, bob, aliceKeys, bobKeys };
}

function logAndStore() {
  const dir = mkdtempSync(join(tmpdir(), 'resonance-mailbox-compaction-'));
  directories.push(dir);
  const log = new RelayOperationLog(dir);
  log.load();
  return { log, store: new MailboxStore() };
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('mailbox journal compaction', () => {
  it('keeps signed deposits and acknowledgements until deduplication expires', () => {
    const { alice, bob, aliceKeys, bobKeys } = fixture();
    const { log, store } = logAndStore();
    const matchId = createDeterministicMatchId(alice.publicationId, bob.publicationId);
    const offer = createConsentOfferV2(
      matchId, alice, bob, aliceKeys, generateRelationshipKeyMaterial(), NOW + 1, NOW + 60_000,
    );
    const envelope = encryptRelationshipMessage(offer, bob);
    const deposit = createMailboxDepositRequest(matchId, alice, bob, aliceKeys, envelope, NOW + 2);
    const acknowledgement = createMailboxRequest('ack', bob, bobKeys, [envelope.envelopeId], NOW + 3);
    log.append({ kind: 'mailbox-deposit', request: deposit });
    store.enqueue(envelope);
    log.append({ kind: 'mailbox-ack', request: acknowledgement });
    store.acknowledge(envelope.mailboxId, [envelope.envelopeId]);

    expect(compactMailboxHistory(log.entries, store, NOW + 4)).toHaveLength(2);
    store.purgeExpired(envelope.expiresAt);
    expect(compactMailboxHistory(log.entries, store, envelope.expiresAt)).toEqual([]);
  });

  it('retains acknowledgements for match notices that replay from signed match events', () => {
    const { alice, bob, bobKeys } = fixture();
    const { log, store } = logAndStore();
    const relay = generateIdentity();
    const operation = createMatchOperationV2(alice, bob, relay, {
      createdAt: NOW + 1, expiresAt: NOW + 60_000,
    });
    const envelopes = [
      encryptMatchNotice(createMatchNoticeMessage(alice, bob, operation, relay), alice),
      encryptMatchNotice(createMatchNoticeMessage(bob, alice, operation, relay), bob),
    ] as const;
    const acknowledgement = createMailboxRequest(
      'ack', bob, bobKeys, [envelopes[1].envelopeId], NOW + 3,
    );
    log.append({ kind: 'match', operation, envelopes: [...envelopes] });
    for (const envelope of envelopes) store.enqueue(envelope);
    log.append({ kind: 'mailbox-ack', request: acknowledgement });
    store.acknowledge(envelopes[1].mailboxId, [envelopes[1].envelopeId]);

    expect(compactMailboxHistory(log.entries, store, NOW + 4).map(record => record.entry.kind))
      .toEqual(['match', 'mailbox-ack']);
    store.purgeExpired(NOW + 60_000);
    expect(compactMailboxHistory(log.entries, store, NOW + 60_000).map(record => record.entry.kind))
      .toEqual(['match']);
  });
});
