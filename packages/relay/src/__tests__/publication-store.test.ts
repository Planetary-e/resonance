import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPublicationRecord,
  createPublicationTombstone,
  generatePublicationKeyMaterial,
} from '@resonance/core';
import { PublicationOperationStore } from '../publication-store.js';

const temporaryDirectories: string[] = [];

function fixture(sequence = 0, groupId = 'public') {
  const keys = generatePublicationKeyMaterial();
  const record = createPublicationRecord({
    groupId,
    fingerprintEpoch: 'pilot-static-v1',
    fingerprint: new Uint8Array(64).fill(0xa5),
    itemType: 'offer',
    createdAt: 1_800_000_000_000,
    expiresAt: 1_800_086_400_000,
    sequence,
  }, keys);
  return { keys, record };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('PublicationOperationStore', () => {
  it('accepts a new operation and makes an exact retry idempotent', () => {
    const { record } = fixture();
    const store = new PublicationOperationStore();

    expect(store.evaluate(record).status).toBe('accepted');
    expect(store.liveRecordCount).toBe(0);
    expect(store.apply(record).status).toBe('accepted');
    expect(store.liveRecordCount).toBe(1);
    expect(store.apply(structuredClone(record)).status).toBe('duplicate');
    expect(store.size).toBe(1);
    expect(store.liveRecordCount).toBe(1);
  });

  it('rejects stale and conflicting signed revisions', () => {
    const { keys, record } = fixture();
    const revision = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0x3c),
      itemType: 'offer',
      createdAt: record.createdAt + 1,
      expiresAt: record.expiresAt + 1,
      sequence: 1,
    }, keys);
    const conflict = createPublicationRecord({
      groupId: 'community:other',
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0x3c),
      itemType: 'offer',
      createdAt: record.createdAt + 1,
      expiresAt: record.expiresAt + 1,
      sequence: 1,
    }, keys);
    const store = new PublicationOperationStore();

    expect(store.apply(revision).status).toBe('accepted');
    expect(store.apply(record).status).toBe('stale');
    expect(store.apply(conflict).status).toBe('conflict');
  });

  it('treats a tombstone as terminal', () => {
    const { keys, record } = fixture();
    const tombstone = createPublicationTombstone(record, 'withdrawn', keys.signingKeyPair, record.createdAt + 1);
    const future = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0xa5),
      itemType: 'offer',
      createdAt: record.createdAt + 2,
      expiresAt: record.expiresAt + 2,
      sequence: 2,
    }, keys);
    const store = new PublicationOperationStore();

    expect(store.apply(record).status).toBe('accepted');
    expect(store.apply(tombstone).status).toBe('accepted');
    expect(store.apply(future).status).toBe('terminal');
    expect(store.get(record.publicationId)).toEqual(tombstone);
    expect(store.getRecord(record.publicationId)).toEqual(record);
    expect(store.liveRecordCount).toBe(0);
  });

  it('lets a valid tombstone absorb a higher live revision received first', () => {
    const { keys, record } = fixture();
    const newerLive = createPublicationRecord({
      groupId: 'public',
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0xa6),
      itemType: 'offer',
      createdAt: record.createdAt + 2,
      expiresAt: record.expiresAt + 2,
      sequence: 2,
    }, keys);
    const earlierTombstone = createPublicationTombstone(
      record,
      'withdrawn',
      keys.signingKeyPair,
      record.createdAt + 1,
    );
    const store = new PublicationOperationStore();

    expect(store.apply(newerLive).status).toBe('accepted');
    expect(store.apply(earlierTombstone).status).toBe('accepted');
    expect(store.get(record.publicationId)).toEqual(earlierTombstone);
  });

  it('persists and verifies the latest operation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-relay-publications-'));
    temporaryDirectories.push(directory);
    const { record } = fixture();
    const store = new PublicationOperationStore();
    store.apply(record);
    store.save(directory);

    const restored = new PublicationOperationStore();
    restored.load(directory);
    expect(restored.get(record.publicationId)).toEqual(record);
  });

  it('retains the last record with a persisted tombstone for mailbox authentication', () => {
    const directory = mkdtempSync(join(tmpdir(), 'resonance-relay-publications-'));
    temporaryDirectories.push(directory);
    const { keys, record } = fixture();
    const tombstone = createPublicationTombstone(record, 'withdrawn', keys.signingKeyPair, record.createdAt + 1);
    const store = new PublicationOperationStore();
    store.apply(record);
    store.apply(tombstone);
    store.save(directory);

    const restored = new PublicationOperationStore();
    restored.load(directory);
    expect(restored.get(record.publicationId)).toEqual(tombstone);
    expect(restored.getRecord(record.publicationId)).toEqual(record);
  });

  it('reports active records, individual expiry, and retained tombstones separately', () => {
    const active = fixture();
    const expired = fixture();
    const tombstoned = fixture();
    const tombstone = createPublicationTombstone(
      tombstoned.record,
      'withdrawn',
      tombstoned.keys.signingKeyPair,
      tombstoned.record.createdAt + 1,
    );
    const store = new PublicationOperationStore();
    store.apply(active.record);
    store.apply(expired.record);
    store.apply(tombstoned.record);
    store.apply(tombstone);

    const beforeExpiry = active.record.expiresAt - 1;
    expect(store.activeRecords(beforeExpiry)).toHaveLength(2);
    expect(store.nextExpiryAfter(beforeExpiry)).toBe(active.record.expiresAt);
    expect(store.expiredPublicationIds(active.record.expiresAt)).toEqual(
      [active.record.publicationId, expired.record.publicationId].sort((a, b) => a.localeCompare(b)),
    );
    expect(store.tombstoneCount).toBe(1);
    expect(store.size).toBe(3);
  });
});
