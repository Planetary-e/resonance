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
    expect(store.enqueue(value)).toBe('duplicate');
    expect(store.hasAcknowledgedEnvelope(value.mailboxId, value.envelopeId, NOW + 2)).toBe(true);
    expect(store.retainedBytes).toBeGreaterThan(0);
  });

  it('charges pending envelopes and acknowledged IDs to one retained-state budget', () => {
    const value = envelope();
    const store = new MailboxStore();
    const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
    expect(store.canEnqueue([value], size - 1)).toBe(false);
    expect(store.canEnqueue([value], size)).toBe(true);
    store.enqueue(value);
    expect(store.retainedBytes).toBe(size);
    expect(store.canEnqueue([value], size)).toBe(true);
    store.acknowledge(value.mailboxId, [value.envelopeId]);
    expect(store.retainedBytes).toBeLessThan(size);
    expect(store.canEnqueue([value], store.retainedBytes)).toBe(true);
    expect(store.purgeExpired(value.expiresAt)).toBe(1);
    expect(store.retainedBytes).toBe(0);
    expect(store.hasAcknowledgedEnvelope(value.mailboxId, value.envelopeId, value.expiresAt)).toBe(false);
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

  it('persists acknowledgement deduplication through a store restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-mailboxes-'));
    temporaryDirectories.push(directory);
    const value = envelope();
    const store = new MailboxStore();
    store.enqueue(value);
    store.acknowledge(value.mailboxId, [value.envelopeId]);
    store.save(directory);

    const restored = new MailboxStore();
    restored.load(directory);
    expect(restored.retainedBytes).toBe(store.retainedBytes);
    expect(restored.enqueue(value)).toBe('duplicate');
    expect(restored.fetch(value.mailboxId, NOW + 2)).toEqual([]);
  });

  it('keeps a replicated acknowledgement that arrives before its encrypted envelope', () => {
    const value = envelope();
    const store = new MailboxStore();
    expect(store.canApplyReplicatedAcknowledgement(
      value.mailboxId, value.envelopeId, value.expiresAt, 1_000,
    )).toBe(true);
    expect(store.applyReplicatedAcknowledgement(
      value.mailboxId, value.envelopeId, value.expiresAt,
    )).toBe(true);
    expect(store.events(value.mailboxId, NOW + 2)).toEqual([{
      kind: 'ack', mailboxId: value.mailboxId,
      envelopeId: value.envelopeId, expiresAt: value.expiresAt,
    }]);
    expect(store.enqueue(value)).toBe('duplicate');
    expect(store.fetch(value.mailboxId, NOW + 2)).toEqual([]);
    expect(store.applyReplicatedAcknowledgement(
      value.mailboxId, value.envelopeId, value.expiresAt,
    )).toBe(false);
  });

  it('removes a same-ID notice from another relay with a later expiry', () => {
    const first = envelope();
    const later = { ...first, expiresAt: first.expiresAt + 1_000 };
    const store = new MailboxStore();
    store.enqueue(later);
    expect(store.canApplyReplicatedAcknowledgement(
      first.mailboxId, first.envelopeId, first.expiresAt, 1_000,
    )).toBe(true);
    expect(store.applyReplicatedAcknowledgement(
      first.mailboxId, first.envelopeId, first.expiresAt,
    )).toBe(true);
    expect(store.fetch(first.mailboxId, NOW + 2)).toEqual([]);
    expect(store.acknowledgementExpiry(first.mailboxId, first.envelopeId))
      .toBe(later.expiresAt);
    expect(store.applyReplicatedAcknowledgement(
      first.mailboxId, first.envelopeId, later.expiresAt + 1_000,
    )).toBe(true);
    expect(store.acknowledgementExpiry(first.mailboxId, first.envelopeId))
      .toBe(later.expiresAt + 1_000);
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
