import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import {
  createPublicationRecord,
  createPublicationTombstone,
  createMatchNoticeMessage,
  createMatchOperationV2,
  encodeBase64,
  generateIdentity,
  generatePublicationKeyMaterial,
} from '@resonance/core';
import { openStoreAsync } from '../store.js';

const temporaryDirectories: string[] = [];

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'resonance-publications-'));
  temporaryDirectories.push(directory);
  return join(directory, 'resonance.db');
}

function randomKey(): Uint8Array {
  return nacl.randomBytes(nacl.secretbox.keyLength);
}

function fixture() {
  const keys = generatePublicationKeyMaterial();
  const record = createPublicationRecord({
    groupId: 'public',
    fingerprintEpoch: 'pilot-static-v1',
    fingerprint: new Uint8Array(64).fill(0x5a),
    itemType: 'need',
    createdAt: 1_800_000_000_000,
    expiresAt: 1_800_086_400_000,
  }, keys);
  return { keys, record };
}

async function insertItemAndPublication(path: string, key: Uint8Array) {
  const store = await openStoreAsync(path, key);
  const { keys, record } = fixture();
  store.insertItem({
    id: 'item-1',
    type: 'need',
    rawText: 'Need a bicycle repair',
    embedding: new Float32Array([0.25, 0.75]),
    privacyLevel: 'medium',
  });
  store.insertPublication('item-1', record, keys);
  return { store, keys, record };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('protocol v2 publication storage', () => {
  it('restores publication signing and mailbox secrets after restart', async () => {
    const path = temporaryDatabase();
    const key = randomKey();
    const { store, keys, record } = await insertItemAndPublication(path, key);
    store.close();

    const reopened = await openStoreAsync(path, key);
    const stored = reopened.getPublicationForItem('item-1');
    expect(stored?.record).toEqual(record);
    expect(stored?.keys.signingKeyPair.secretKey).toEqual(keys.signingKeyPair.secretKey);
    expect(stored?.keys.mailboxKeyPair.secretKey).toEqual(keys.mailboxKeyPair.secretKey);
    expect(reopened.getPublication(record.publicationId)?.itemId).toBe('item-1');
    reopened.close();
  });

  it('does not store private key material in plaintext', async () => {
    const path = temporaryDatabase();
    const key = randomKey();
    const { store, keys } = await insertItemAndPublication(path, key);
    store.close();

    const bytes = readFileSync(path);
    expect(bytes.includes(Buffer.from(keys.signingKeyPair.secretKey))).toBe(false);
    expect(bytes.includes(Buffer.from(keys.mailboxKeyPair.secretKey))).toBe(false);
    expect(bytes.toString('utf8')).not.toContain(encodeBase64(keys.signingKeyPair.secretKey));
    expect(bytes.toString('utf8')).not.toContain(encodeBase64(keys.mailboxKeyPair.secretKey));
  });

  it('fails closed when publication secrets are opened with the wrong key', async () => {
    const path = temporaryDatabase();
    const { store } = await insertItemAndPublication(path, randomKey());
    store.close();

    const reopened = await openStoreAsync(path, randomKey());
    expect(() => reopened.getPublicationForItem('item-1')).toThrow('Decryption failed');
    reopened.close();
  });

  it('persists an owner-signed tombstone for retry after restart', async () => {
    const path = temporaryDatabase();
    const key = randomKey();
    const { store, keys, record } = await insertItemAndPublication(path, key);
    const tombstone = createPublicationTombstone(record, 'withdrawn', keys.signingKeyPair, record.createdAt + 1);
    store.setPublicationTombstone('item-1', tombstone);
    store.close();

    const reopened = await openStoreAsync(path, key);
    expect(reopened.getPublicationForItem('item-1')?.tombstone).toEqual(tombstone);
    reopened.close();
  });

  it('persists a decrypted match before ACK without exposing its relationship in plaintext', async () => {
    const path = temporaryDatabase();
    const key = randomKey();
    const { store, record } = await insertItemAndPublication(path, key);
    const partnerKeys = generatePublicationKeyMaterial();
    const partner = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0x5a),
      itemType: 'offer',
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    }, partnerKeys);
    const relay = generateIdentity();
    const operation = createMatchOperationV2(record, partner, relay, {
      createdAt: record.createdAt + 1,
      expiresAt: record.createdAt + 60_000,
    });
    const notice = createMatchNoticeMessage(record, partner, operation, relay);
    const otherRelay = generateIdentity();
    const otherOperation = createMatchOperationV2(record, partner, otherRelay, {
      createdAt: record.createdAt + 2,
      expiresAt: record.createdAt + 59_000,
    });
    const otherNotice = createMatchNoticeMessage(record, partner, otherOperation, otherRelay);

    expect(store.insertMailboxMatch('item-1', notice)).toBe(true);
    expect(store.insertMailboxMatch('item-1', notice)).toBe(false);
    expect(store.insertMailboxMatch('item-1', otherNotice)).toBe(false);
    store.close();

    const bytes = readFileSync(path).toString('utf8');
    expect(bytes).not.toContain(partner.publicationId);
    expect(bytes).not.toContain(partner.mailbox.id);

    const reopened = await openStoreAsync(path, key);
    expect(reopened.insertMailboxMatch('item-1', otherNotice)).toBe(false);
    const matches = reopened.listMailboxMatches();
    expect(matches).toHaveLength(1);
    expect(matches[0].notice).toEqual(notice);
    expect(matches[0].partnerPublicationId).toBe(partner.publicationId);
    reopened.close();
  });
});
