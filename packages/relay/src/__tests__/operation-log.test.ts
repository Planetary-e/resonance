import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMatchNoticeMessage,
  createMatchOperationV2,
  createPublicationRecord,
  createRelayReplicaPutV1,
  createRelayReplicaReceiptV1,
  encryptMatchNotice,
  generateIdentity,
  generatePublicationKeyMaterial,
} from '@resonance/core';
import {
  RelayOperationLog,
  RELAY_OPERATION_LOG_FILENAME,
  type RelayOperationLogEntry,
} from '../operation-log.js';
import { compactPublicationHistory } from '../journal-compaction.js';
import { PublicationOperationStore } from '../publication-store.js';
import { ReplicaStorageLedger, publicationStorageReservationBytes } from '../replica-storage-ledger.js';
import { createReplicaPlacementIntent } from '../replica-placement.js';

const NOW = 1_800_000_000_000;
const temporaryDirectories: string[] = [];

function fixture() {
  const relay = generateIdentity();
  const input = {
    groupId: 'public', fingerprintEpoch: '2026-09', fingerprint: new Uint8Array(64).fill(0xa5),
    createdAt: NOW, expiresAt: NOW + 86_400_000,
  };
  const needKeys = generatePublicationKeyMaterial();
  const need = createPublicationRecord({ ...input, itemType: 'need' }, needKeys);
  const offer = createPublicationRecord(
    { ...input, itemType: 'offer' }, generatePublicationKeyMaterial(),
  );
  const operation = createMatchOperationV2(need, offer, relay, {
    createdAt: NOW + 1, expiresAt: NOW + 60_000,
  });
  const envelopes = [
    encryptMatchNotice(createMatchNoticeMessage(need, offer, operation, relay), need),
    encryptMatchNotice(createMatchNoticeMessage(offer, need, operation, relay), offer),
  ] as const;
  return { need, needKeys, offer, operation, envelopes };
}

function directory(): string {
  const result = mkdtempSync(join(tmpdir(), 'resonance-operation-log-'));
  temporaryDirectories.push(result);
  return result;
}

afterEach(() => {
  for (const value of temporaryDirectories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('RelayOperationLog', () => {
  it('fsyncs replayable publication and atomic match records', () => {
    const dir = directory();
    const { need, operation, envelopes } = fixture();
    const sourceRelay = generateIdentity();
    const log = new RelayOperationLog(dir);
    log.load();
    log.append({
      kind: 'publication',
      operation: need,
      allocationOrigin: 'replica',
      allocationRelayId: sourceRelay.did,
    }, NOW + 2);
    log.append({ kind: 'match', operation, envelopes: [...envelopes] }, NOW + 3);

    const restored = new RelayOperationLog(dir);
    expect(restored.load()).toHaveLength(2);
    expect(restored.entries[0].entry).toEqual({
      kind: 'publication',
      operation: need,
      allocationOrigin: 'replica',
      allocationRelayId: sourceRelay.did,
    });
    expect(restored.entries[1].entry).toEqual({ kind: 'match', operation, envelopes: [...envelopes] });
    expect(readFileSync(join(dir, RELAY_OPERATION_LOG_FILENAME), 'utf8').endsWith('\n')).toBe(true);
  });

  it('rejects corruption in a completed record', () => {
    const dir = directory();
    const { need } = fixture();
    const log = new RelayOperationLog(dir);
    log.load();
    log.append({ kind: 'publication', operation: need }, NOW + 2);
    appendFileSync(join(dir, RELAY_OPERATION_LOG_FILENAME), '{}\n');

    expect(() => new RelayOperationLog(dir).load()).toThrow('sequence 2');
  });

  it('truncates an incomplete tail and continues the sequence safely', () => {
    const dir = directory();
    const { need } = fixture();
    const path = join(dir, RELAY_OPERATION_LOG_FILENAME);
    const log = new RelayOperationLog(dir);
    log.load();
    log.append({ kind: 'publication', operation: need }, NOW + 2);
    appendFileSync(path, '{"version":1,"sequence":2');

    const restored = new RelayOperationLog(dir);
    expect(restored.load()).toHaveLength(1);
    restored.append({ kind: 'publication', operation: need }, NOW + 3);
    expect(new RelayOperationLog(dir).load().map(record => record.sequence)).toEqual([1, 2]);
  });

  it('atomically replaces retained events with a newly verifiable sequence', () => {
    const dir = directory();
    const { need, operation, envelopes } = fixture();
    const log = new RelayOperationLog(dir);
    log.load();
    log.append({ kind: 'publication', operation: need }, NOW + 1);
    const retainedPublication = log.append({ kind: 'publication', operation: need }, NOW + 2);
    const retainedMatch = log.append({ kind: 'match', operation, envelopes: [...envelopes] }, NOW + 3);

    log.compact([retainedPublication, retainedMatch]);
    expect(log.length).toBe(2);
    expect(new RelayOperationLog(dir).load().map(record => ({
      sequence: record.sequence,
      committedAt: record.committedAt,
      entry: record.entry,
    }))).toEqual([
      { sequence: 1, committedAt: NOW + 2, entry: retainedPublication.entry },
      { sequence: 2, committedAt: NOW + 3, entry: retainedMatch.entry },
    ]);
    log.append({ kind: 'publication', operation: need }, NOW + 4);
    expect(new RelayOperationLog(dir).load().map(record => record.sequence)).toEqual([1, 2, 3]);
  });

  it('ignores an interrupted temporary compaction and replays the original journal', () => {
    const dir = directory();
    const { need } = fixture();
    const log = new RelayOperationLog(dir);
    log.load();
    log.append({ kind: 'publication', operation: need }, NOW + 1);
    writeFileSync(join(dir, `${RELAY_OPERATION_LOG_FILENAME}.compact-interrupted`), '{"version":1');

    expect(new RelayOperationLog(dir).load().map(record => record.entry)).toEqual([
      { kind: 'publication', operation: need },
    ]);
  });

  it('preserves match-dependent publication history while compacting unrelated updates', () => {
    const dir = directory();
    const { need, needKeys, offer, operation, envelopes } = fixture();
    const needUpdate = createPublicationRecord({
      groupId: need.groupId, fingerprintEpoch: need.fingerprint.epoch,
      fingerprint: new Uint8Array(64).fill(0xa6), itemType: need.itemType,
      createdAt: need.createdAt + 1, expiresAt: need.expiresAt,
      sequence: need.sequence + 1,
    }, needKeys);
    const otherKeys = generatePublicationKeyMaterial();
    const other = createPublicationRecord({
      groupId: 'public', fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0xb5), itemType: 'offer',
      createdAt: NOW, expiresAt: NOW + 86_400_000,
    }, otherKeys);
    const otherUpdate = createPublicationRecord({
      groupId: other.groupId, fingerprintEpoch: other.fingerprint.epoch,
      fingerprint: new Uint8Array(64).fill(0xb6), itemType: other.itemType,
      createdAt: other.createdAt + 1, expiresAt: other.expiresAt,
      sequence: other.sequence + 1,
    }, otherKeys);
    const log = new RelayOperationLog(dir);
    log.load();
    const publications = new PublicationOperationStore();
    const allocations = new ReplicaStorageLedger();
    const owner = generateIdentity();
    const retain = (record: typeof need) => {
      publications.apply(record);
      allocations.record(record.publicationId, publicationStorageReservationBytes(record), {
        allocationOrigin: 'replica', allocationRelayId: owner.did,
      });
      log.append({
        kind: 'publication', operation: record,
        allocationOrigin: 'replica', allocationRelayId: owner.did,
      });
    };
    retain(need);
    retain(offer);
    log.append({ kind: 'match', operation, envelopes: [...envelopes] });
    retain(needUpdate);
    retain(other);
    retain(otherUpdate);

    const compacted = compactPublicationHistory(log.entries, publications, allocations);
    expect(compacted.map(record => record.entry)).toEqual([
      log.entries[0].entry, log.entries[1].entry, log.entries[2].entry,
      log.entries[3].entry, log.entries[5].entry,
    ]);
  });

  it('accepts an unmarked historic allocation ID without treating it as new provenance', () => {
    const dir = directory();
    const { need } = fixture();
    const sourceRelay = generateIdentity();
    const log = new RelayOperationLog(dir);
    log.load();
    log.append({ kind: 'publication', operation: need, allocationRelayId: sourceRelay.did });

    expect(new RelayOperationLog(dir).load()[0]?.entry).toEqual({
      kind: 'publication', operation: need, allocationRelayId: sourceRelay.did,
    });
  });

  it('rejects a malformed legacy provenance row', () => {
    const dir = directory();
    const { need } = fixture();
    const sourceRelay = generateIdentity();
    const log = new RelayOperationLog(dir);
    log.load();

    expect(() => log.append({
      kind: 'publication',
      operation: need,
      allocationOrigin: 'legacy',
      allocationRelayId: sourceRelay.did,
    } as unknown as RelayOperationLogEntry)).toThrow('Invalid relay operation log entry');
  });

  it('persists replayable placement intent and positive durability receipt records', () => {
    const dir = directory();
    const { need } = fixture();
    const sender = generateIdentity();
    const target = generateIdentity();
    const log = new RelayOperationLog(dir);
    log.load();
    const intent = createReplicaPlacementIntent(
      need,
      [target.did],
      { desiredReplicaCount: 5, minimumHealthyReplicaCount: 3 },
      1,
      NOW + 1,
    );
    const request = createRelayReplicaPutV1(need, sender, NOW + 1, NOW + 30_000);
    const receipt = createRelayReplicaReceiptV1(request, target, { status: 'stored' }, NOW + 2);

    log.append({ kind: 'placement-intent', intent }, NOW + 2);
    log.append({ kind: 'placement-receipt', receipt }, NOW + 3);

    expect(new RelayOperationLog(dir).load().map(record => record.entry)).toEqual([
      { kind: 'placement-intent', intent },
      { kind: 'placement-receipt', receipt },
    ]);
  });
});
