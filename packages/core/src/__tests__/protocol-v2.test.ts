import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair } from '../crypto.js';
import {
  createPublicationRecord,
  createPublicationOperationFrame,
  createPublicationTombstone,
  generatePublicationKeyMaterial,
  isPublicationActive,
  parsePublicationOperation,
  parsePublicationOperationFrame,
  serializePublicationOperationFrame,
  verifyPublicationOperation,
  verifyPublicationRecord,
  verifyPublicationTombstone,
  type PublicationRecord,
} from '../protocol-v2.js';

const NOW = 1_800_000_000_000;

function createRecord(): { record: PublicationRecord; keys: ReturnType<typeof generatePublicationKeyMaterial> } {
  const keys = generatePublicationKeyMaterial();
  const fingerprint = new Uint8Array(64);
  fingerprint.fill(0xa5);
  const record = createPublicationRecord({
    groupId: 'community:barcelona',
    fingerprintEpoch: '2026-09',
    fingerprint,
    itemType: 'offer',
    createdAt: NOW,
    expiresAt: NOW + 7 * 24 * 60 * 60 * 1000,
  }, keys);
  return { record, keys };
}

describe('publication key material', () => {
  it('generates independent unlinkable material for each publication', () => {
    const first = generatePublicationKeyMaterial();
    const second = generatePublicationKeyMaterial();

    expect(first.publicationId).not.toBe(second.publicationId);
    expect(first.mailboxId).not.toBe(second.mailboxId);
    expect(first.signingKeyPair.publicKey).not.toEqual(second.signingKeyPair.publicKey);
    expect(first.mailboxKeyPair.publicKey).not.toEqual(second.mailboxKeyPair.publicKey);
    expect(first).not.toHaveProperty('did');
    expect(first.signingKeyPair).not.toHaveProperty('did');
  });
});

describe('publication records', () => {
  it('creates a valid signed record without a user DID', () => {
    const { record } = createRecord();

    expect(verifyPublicationRecord(record)).toBe(true);
    expect(JSON.stringify(record)).not.toContain('did:key:');
    expect(record.fingerprint.bits).toBe(512);
    expect(record.sequence).toBe(0);
  });

  it('rejects changes to signed discovery data', () => {
    const { record } = createRecord();
    const tampered = structuredClone(record);
    tampered.fingerprint.value = tampered.fingerprint.value.replace(/^./, 'A');

    expect(verifyPublicationRecord(tampered)).toBe(false);
  });

  it('rejects unknown fields instead of silently accepting unsigned semantics', () => {
    const { record } = createRecord();
    const extended = { ...record, ownerDid: 'did:key:tracking-id' };

    expect(verifyPublicationRecord(extended)).toBe(false);
  });

  it('verifies independently of object key insertion order', () => {
    const { record } = createRecord();
    const reordered = {
      signature: record.signature,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      itemType: record.itemType,
      fingerprint: {
        value: record.fingerprint.value,
        epoch: record.fingerprint.epoch,
        bits: record.fingerprint.bits,
        algorithm: record.fingerprint.algorithm,
      },
      groupId: record.groupId,
      mailbox: {
        encryptionKey: record.mailbox.encryptionKey,
        id: record.mailbox.id,
      },
      publicationKey: record.publicationKey,
      sequence: record.sequence,
      publicationId: record.publicationId,
      kind: record.kind,
      version: record.version,
    };

    expect(verifyPublicationRecord(reordered)).toBe(true);
  });

  it('keeps expiry policy separate from cryptographic validity', () => {
    const { record } = createRecord();

    expect(isPublicationActive(record, NOW)).toBe(true);
    expect(isPublicationActive(record, record.expiresAt)).toBe(false);
    expect(verifyPublicationRecord(record)).toBe(true);
  });

  it('rejects invalid expiry ranges when creating a record', () => {
    const keys = generatePublicationKeyMaterial();

    expect(() => createPublicationRecord({
      groupId: 'community:barcelona',
      fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64),
      itemType: 'need',
      createdAt: NOW,
      expiresAt: NOW,
    }, keys)).toThrow('Invalid publication record input');
  });
});

describe('publication tombstones', () => {
  it('creates an owner-authorized tombstone at the next sequence', () => {
    const { record, keys } = createRecord();
    const tombstone = createPublicationTombstone(record, 'withdrawn', keys.signingKeyPair, NOW + 1);

    expect(tombstone.sequence).toBe(record.sequence + 1);
    expect(verifyPublicationTombstone(tombstone)).toBe(true);
    expect(verifyPublicationOperation(tombstone)).toBe(true);
    expect(parsePublicationOperation(JSON.stringify(tombstone))).toEqual(tombstone);
  });

  it('rejects a tombstone signed by a different publication key', () => {
    const { record } = createRecord();

    expect(() => createPublicationTombstone(
      record,
      'withdrawn',
      generateSigningKeyPair(),
      NOW + 1,
    )).toThrow('does not own');
  });

  it('rejects a modified tombstone', () => {
    const { record, keys } = createRecord();
    const tombstone = createPublicationTombstone(record, 'withdrawn', keys.signingKeyPair, NOW + 1);

    expect(verifyPublicationTombstone({ ...tombstone, reason: 'superseded' })).toBe(false);
  });
});

describe('publication operation frames', () => {
  it('round-trips a self-authenticating operation without a sender DID', () => {
    const { record } = createRecord();
    const frame = createPublicationOperationFrame(record);
    const serialized = serializePublicationOperationFrame(frame);
    const parsed = parsePublicationOperationFrame(serialized);

    expect(parsed).toEqual(frame);
    expect(serialized).not.toContain('"from"');
    expect(serialized).not.toContain('did:key:');
  });

  it('rejects a frame containing a modified operation', () => {
    const { record } = createRecord();
    const frame = createPublicationOperationFrame(record);
    const tampered = structuredClone(frame);
    tampered.operation.sequence += 1;

    expect(() => parsePublicationOperationFrame(JSON.stringify(tampered))).toThrow('Invalid publication operation frame');
  });
});
