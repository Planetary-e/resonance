import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMatchNoticeMessage,
  createMatchOperationV2,
  createPublicationRecord,
  encryptMatchNotice,
  generateIdentity,
  generatePublicationKeyMaterial,
} from '@resonance/core';
import { MailboxStore } from '../mailbox-store.js';

const NOW = 1_800_000_000_000;
const temporaryDirectories: string[] = [];

function envelope(expiresAt = NOW + 60_000) {
  const recipientKeys = generatePublicationKeyMaterial();
  const partnerKeys = generatePublicationKeyMaterial();
  const recipient = createPublicationRecord({
    groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: new Uint8Array(64),
    itemType: 'need', createdAt: NOW, expiresAt: NOW + 86_400_000,
  }, recipientKeys);
  const partner = createPublicationRecord({
    groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: new Uint8Array(64),
    itemType: 'offer', createdAt: NOW, expiresAt: NOW + 86_400_000,
  }, partnerKeys);
  const relay = generateIdentity();
  const operation = createMatchOperationV2(recipient, partner, relay, {
    createdAt: NOW + 1, expiresAt,
  });
  const notice = createMatchNoticeMessage(recipient, partner, operation, relay);
  return encryptMatchNotice(notice, recipient);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('MailboxStore', () => {
  it('deduplicates, fetches, and independently acknowledges envelopes', () => {
    const value = envelope();
    const store = new MailboxStore();
    expect(store.enqueue(value)).toBe('accepted');
    expect(store.enqueue(value)).toBe('duplicate');
    expect(store.fetch(value.mailboxId, NOW + 2)).toEqual([value]);
    expect(store.acknowledge(value.mailboxId, [value.envelopeId])).toBe(1);
    expect(store.fetch(value.mailboxId, NOW + 2)).toEqual([]);
  });

  it('expires undelivered envelopes by their own TTL', () => {
    const value = envelope(NOW + 10);
    const store = new MailboxStore();
    store.enqueue(value);
    expect(store.fetch(value.mailboxId, NOW + 10)).toEqual([]);
  });

  it('persists only encrypted envelopes across restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-mailboxes-'));
    temporaryDirectories.push(directory);
    const value = envelope();
    const store = new MailboxStore();
    store.enqueue(value);
    store.save(directory);

    const restored = new MailboxStore();
    restored.load(directory);
    expect(restored.fetch(value.mailboxId, NOW + 2)).toEqual([value]);
  });

  it('bounds one fetch so the result can be acknowledged in one request', () => {
    const store = new MailboxStore();
    const base = envelope();
    const values = Array.from({ length: 101 }, (_, index) => ({
      ...base,
      mailboxId: 'mbx_' + 'a'.repeat(43),
      envelopeId: `env_${index.toString(36).padStart(43, 'a')}`,
    }));
    for (const value of values) store.enqueue(value);
    expect(store.fetch(values[0].mailboxId, NOW + 2)).toHaveLength(100);
  });
});
