import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMatchNoticeMessage,
  createMatchOperationV2,
  createPublicationRecord,
  createPublicationTombstone,
  createRelayReplicaPutV1,
  createRelayReplicaReceiptV1,
  createRelayReplicaReconciliationRequestV1,
  createRelayReplicaReconciliationResponseV1,
  encryptMatchNotice,
  generateIdentity,
  generatePublicationKeyMaterial,
  verifyMatchOperationAgainstPublicationsV2,
} from '@resonance/core';
import {
  compactMatchHistory,
  compactPlacementHistory,
  compactReconciliationHistory,
} from '../evidence-journal-compaction.js';
import { compactPublicationHistory } from '../journal-compaction.js';
import { MatchOperationStore } from '../match-operation-store.js';
import { RelayOperationLog } from '../operation-log.js';
import { PublicationOperationStore } from '../publication-store.js';
import { ReplicaStorageLedger, publicationStorageReservationBytes } from '../replica-storage-ledger.js';
import { createReplicaPlacementIntent, ReplicaPlacementTracker } from '../replica-placement.js';
import { createRelayServer } from '../server.js';

const NOW = 1_800_000_000_000;
const directories: string[] = [];

function journal(): RelayOperationLog {
  const directory = mkdtempSync(join(tmpdir(), 'resonance-evidence-compaction-'));
  directories.push(directory);
  const log = new RelayOperationLog(directory);
  log.load();
  return log;
}

function publication(itemType: 'need' | 'offer', fingerprint = 0xa5) {
  const keys = generatePublicationKeyMaterial();
  const record = createPublicationRecord({
    groupId: 'public', fingerprintEpoch: '2026-09',
    fingerprint: new Uint8Array(64).fill(fingerprint), itemType,
    createdAt: NOW, expiresAt: NOW + 86_400_000,
  }, keys);
  return { keys, record };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('relay evidence journal compaction', () => {
  it('starts and restarts from a compacted match checkpoint without issuing another notice', async () => {
    const log = journal();
    const directory = directories[directories.length - 1];
    const now = Date.now();
    const relay = generateIdentity();
    const needKeys = generatePublicationKeyMaterial();
    const offerKeys = generatePublicationKeyMaterial();
    const base = {
      groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
      fingerprint: new Uint8Array(64).fill(0xa5),
      expiresAt: now + 86_400_000,
    };
    const need = createPublicationRecord({
      ...base, itemType: 'need', createdAt: now - 120_000,
    }, needKeys);
    const offer = createPublicationRecord({
      ...base, itemType: 'offer', createdAt: now - 120_000,
    }, offerKeys);
    const revisedNeed = createPublicationRecord({
      ...base, itemType: 'need', sequence: 1, createdAt: now - 90_000,
    }, needKeys);
    const first = createMatchOperationV2(need, offer, relay, {
      createdAt: now - 80_000, expiresAt: now - 60_000,
    });
    const second = createMatchOperationV2(revisedNeed, offer, relay, {
      createdAt: now - 50_000, expiresAt: now - 1_000,
    });
    const notices = (currentNeed: typeof need, match: typeof first) => [
      encryptMatchNotice(createMatchNoticeMessage(currentNeed, offer, match, relay), currentNeed),
      encryptMatchNotice(createMatchNoticeMessage(offer, currentNeed, match, relay), offer),
    ] as const;
    for (const record of [need, offer]) {
      log.append({ kind: 'publication', operation: record, allocationOrigin: 'local', allocationRelayId: relay.did });
    }
    log.append({ kind: 'match', operation: first, envelopes: [...notices(need, first)] });
    log.append({ kind: 'publication', operation: revisedNeed, allocationOrigin: 'local', allocationRelayId: relay.did });
    log.append({ kind: 'match', operation: second, envelopes: [...notices(revisedNeed, second)] });

    for (let restart = 0; restart < 2; restart++) {
      const server = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: directory });
      try {
        await server.start();
      } finally {
        await server.stop();
      }
      const entries = new RelayOperationLog(directory).load();
      expect(entries.map(record => record.entry.kind)).toEqual([
        'publication', 'publication', 'match-checkpoint',
      ]);
    }
  });

  it('drops expired match generations and retains a replayable signed checkpoint for an active pair', () => {
    const log = journal();
    const relay = generateIdentity();
    const need = publication('need');
    const offer = publication('offer');
    const revisedNeed = createPublicationRecord({
      groupId: 'public', fingerprintEpoch: '2026-09',
      fingerprint: new Uint8Array(64).fill(0xa5), itemType: 'need',
      sequence: 1, createdAt: NOW + 2, expiresAt: NOW + 86_400_000,
    }, need.keys);
    const first = createMatchOperationV2(need.record, offer.record, relay, {
      createdAt: NOW + 1, expiresAt: NOW + 30_000,
    });
    const second = createMatchOperationV2(revisedNeed, offer.record, relay, {
      createdAt: NOW + 3, expiresAt: NOW + 60_000,
    });
    const firstEnvelopes = [
      encryptMatchNotice(createMatchNoticeMessage(need.record, offer.record, first, relay), need.record),
      encryptMatchNotice(createMatchNoticeMessage(offer.record, need.record, first, relay), offer.record),
    ] as const;
    const secondEnvelopes = [
      encryptMatchNotice(createMatchNoticeMessage(revisedNeed, offer.record, second, relay), revisedNeed),
      encryptMatchNotice(createMatchNoticeMessage(offer.record, revisedNeed, second, relay), offer.record),
    ] as const;
    const publications = new PublicationOperationStore();
    const matches = new MatchOperationStore();
    const allocations = new ReplicaStorageLedger();
    for (const record of [need.record, offer.record]) {
      log.append({ kind: 'publication', operation: record, allocationOrigin: 'local', allocationRelayId: relay.did });
      publications.apply(record);
      allocations.record(record.publicationId, publicationStorageReservationBytes(record), {
        allocationOrigin: 'local', allocationRelayId: relay.did,
      });
    }
    log.append({ kind: 'match', operation: first, envelopes: [...firstEnvelopes] });
    matches.apply(first);
    log.append({ kind: 'publication', operation: revisedNeed, allocationOrigin: 'local', allocationRelayId: relay.did });
    publications.apply(revisedNeed);
    allocations.record(revisedNeed.publicationId, publicationStorageReservationBytes(revisedNeed), {
      allocationOrigin: 'local', allocationRelayId: relay.did,
    });
    log.append({ kind: 'match', operation: second, envelopes: [...secondEnvelopes] });
    matches.apply(second);

    const duringDelivery = compactMatchHistory(log.entries, matches, publications, NOW + 45_000);
    expect(duringDelivery.filter(record => record.entry.kind === 'match')).toHaveLength(1);
    expect(duringDelivery.some(record => record.entry.kind === 'match'
      && record.entry.operation.operationId === second.operationId)).toBe(true);

    const matchesRetained = compactMatchHistory(log.entries, matches, publications, NOW + 60_000);
    const retained = compactPublicationHistory(matchesRetained, publications, allocations);
    expect(retained.map(record => record.entry.kind)).toEqual([
      'publication', 'publication', 'match-checkpoint',
    ]);
    const retainedPublicationSignatures = retained.flatMap(record => (
      record.entry.kind === 'publication' ? [record.entry.operation.signature] : []
    ));
    expect(retainedPublicationSignatures).toContain(revisedNeed.signature);
    expect(retainedPublicationSignatures).not.toContain(need.record.signature);
    const beforeBytes = log.byteLength;
    log.compact(retained);
    expect(log.byteLength).toBeLessThan(beforeBytes);

    const replayed = new PublicationOperationStore();
    const replayedMatches = new MatchOperationStore();
    for (const { entry } of log.load()) {
      if (entry.kind === 'publication') replayed.apply(entry.operation);
      if (entry.kind === 'match-checkpoint') {
        const [firstRef, secondRef] = entry.operation.publications;
        expect(verifyMatchOperationAgainstPublicationsV2(
          entry.operation,
          replayed.getRecord(firstRef.publicationId)!,
          replayed.getRecord(secondRef.publicationId)!,
          0.5,
        )).toBe(true);
        replayedMatches.apply(entry.operation);
      }
    }
    expect(replayedMatches.hasGeneration(second)).toBe(true);
  });

  it('drops expired match evidence for a withdrawn pair while preserving its terminal publication', () => {
    const log = journal();
    const relay = generateIdentity();
    const need = publication('need');
    const offer = publication('offer');
    const operation = createMatchOperationV2(need.record, offer.record, relay, {
      createdAt: NOW + 1, expiresAt: NOW + 60_000,
    });
    const envelopes = [
      encryptMatchNotice(createMatchNoticeMessage(need.record, offer.record, operation, relay), need.record),
      encryptMatchNotice(createMatchNoticeMessage(offer.record, need.record, operation, relay), offer.record),
    ] as const;
    const tombstone = createPublicationTombstone(
      need.record, 'withdrawn', need.keys.signingKeyPair, NOW + 2,
    );
    const publications = new PublicationOperationStore();
    const matches = new MatchOperationStore();
    const allocations = new ReplicaStorageLedger();
    for (const record of [need.record, offer.record]) {
      log.append({ kind: 'publication', operation: record });
      publications.apply(record);
      allocations.record(record.publicationId, publicationStorageReservationBytes(record), {
        allocationOrigin: 'legacy',
      });
    }
    log.append({ kind: 'match', operation, envelopes: [...envelopes] });
    matches.apply(operation);
    log.append({ kind: 'publication', operation: tombstone });
    publications.apply(tombstone);
    allocations.record(tombstone.publicationId,
      publicationStorageReservationBytes(tombstone, need.record), {
        allocationOrigin: 'legacy',
      });

    const retained = compactPublicationHistory(
      compactMatchHistory(log.entries, matches, publications, NOW + 60_000),
      publications, allocations,
    );
    expect(retained.map(record => record.entry.kind)).toEqual([
      'publication', 'publication', 'publication',
    ]);
    log.compact(retained);
    const replayed = new PublicationOperationStore();
    for (const { entry } of log.load()) {
      if (entry.kind === 'publication') replayed.apply(entry.operation);
    }
    expect(replayed.get(need.record.publicationId)?.signature).toBe(tombstone.signature);
    expect(replayed.getRecord(need.record.publicationId)?.signature).toBe(need.record.signature);
  });

  it('replays only the current placement intent and selected durability receipts', () => {
    const log = journal();
    const sender = generateIdentity();
    const firstTarget = generateIdentity();
    const retiredTarget = generateIdentity();
    const newTarget = generateIdentity();
    const { record } = publication('need');
    const publications = new PublicationOperationStore();
    publications.apply(record);
    log.append({ kind: 'publication', operation: record });
    const placements = new ReplicaPlacementTracker(sender.did);
    const policy = { desiredReplicaCount: 3, minimumHealthyReplicaCount: 2 };
    const firstIntent = createReplicaPlacementIntent(
      record, [firstTarget.did, retiredTarget.did], policy, 1, NOW + 1,
    );
    log.append({ kind: 'placement-intent', intent: firstIntent });
    expect(placements.applyIntent(firstIntent)).toBe(true);
    const request = createRelayReplicaPutV1(record, sender, NOW + 1, NOW + 30_000);
    const firstReceipt = createRelayReplicaReceiptV1(
      request, firstTarget, { status: 'stored' }, NOW + 2,
    );
    const retiredReceipt = createRelayReplicaReceiptV1(
      request, retiredTarget, { status: 'stored' }, NOW + 2,
    );
    for (const receipt of [firstReceipt, retiredReceipt]) {
      log.append({ kind: 'placement-receipt', receipt });
      expect(placements.recordReceipt(receipt)).toBe(true);
    }
    const nextIntent = createReplicaPlacementIntent(
      record, [firstTarget.did, newTarget.did], policy, 2, NOW + 3,
    );
    log.append({ kind: 'placement-intent', intent: nextIntent });
    expect(placements.applyIntent(nextIntent)).toBe(true);
    const newReceipt = createRelayReplicaReceiptV1(
      request, newTarget, { status: 'stored' }, NOW + 4,
    );
    log.append({ kind: 'placement-receipt', receipt: newReceipt });
    expect(placements.recordReceipt(newReceipt)).toBe(true);

    const retained = compactPlacementHistory(log.entries, placements, publications);
    expect(retained.map(record => record.entry.kind)).toEqual([
      'publication', 'placement-intent', 'placement-receipt', 'placement-receipt',
    ]);
    const beforeBytes = log.byteLength;
    log.compact(retained);
    expect(log.byteLength).toBeLessThan(beforeBytes);
    const replayed = new ReplicaPlacementTracker(sender.did);
    for (const { entry } of log.load()) {
      if (entry.kind === 'placement-intent') expect(replayed.applyIntent(entry.intent)).toBe(true);
      if (entry.kind === 'placement-receipt') expect(replayed.recordReceipt(entry.receipt)).toBe(true);
    }
    expect(replayed.getIntent(record.publicationId)?.revision).toBe(2);
    expect(replayed.statusFor(record.publicationId)?.confirmedRelayIds).toEqual(
      [firstTarget.did, newTarget.did].sort(),
    );
    expect(replayed.statusFor(record.publicationId)?.minimumConfirmed).toBe(true);
  });

  it('folds an adopted tombstone into signed publication state without losing its predecessor or allocation', () => {
    const log = journal();
    const sender = generateIdentity();
    const target = generateIdentity();
    const { record, keys } = publication('offer');
    const tombstone = createPublicationTombstone(
      record, 'withdrawn', keys.signingKeyPair, NOW + 1,
    );
    const request = createRelayReplicaPutV1(record, sender, NOW, NOW + 30_000);
    const rejection = createRelayReplicaReceiptV1(
      request, target, { status: 'rejected', reason: 'terminal' }, NOW + 1,
    );
    const reconciliationRequest = createRelayReplicaReconciliationRequestV1(
      rejection, sender, NOW + 2, NOW + 30_000,
    );
    const response = createRelayReplicaReconciliationResponseV1(
      reconciliationRequest, target, { status: 'operation', operation: tombstone }, NOW + 3,
    );
    const allocation = { allocationOrigin: 'replica' as const, allocationRelayId: sender.did };
    log.append({ kind: 'publication', operation: record, ...allocation });
    log.append({ kind: 'reconciliation-adoption', rejection, response, allocation });
    const publications = new PublicationOperationStore();
    publications.apply(record);
    publications.apply(tombstone);
    const allocations = new ReplicaStorageLedger();
    allocations.record(record.publicationId,
      publicationStorageReservationBytes(record), allocation);
    allocations.record(record.publicationId,
      publicationStorageReservationBytes(tombstone, record), allocation);

    const retained = compactPublicationHistory(
      compactReconciliationHistory(log.entries), publications, allocations,
    );
    expect(retained.map(record => record.entry.kind)).toEqual(['publication', 'publication']);
    log.compact(retained);
    const replayed = new PublicationOperationStore();
    const replayedAllocations = new ReplicaStorageLedger();
    for (const { entry } of log.load()) {
      expect(entry.kind).toBe('publication');
      if (entry.kind !== 'publication') continue;
      replayed.apply(entry.operation);
      replayedAllocations.record(entry.operation.publicationId,
        publicationStorageReservationBytes(
          entry.operation, replayed.getRecord(entry.operation.publicationId),
        ), allocation);
    }
    expect(replayed.get(record.publicationId)?.signature).toBe(tombstone.signature);
    expect(replayed.getRecord(record.publicationId)?.signature).toBe(record.signature);
    expect(replayedAllocations.allocationFor(record.publicationId)).toMatchObject(allocation);
  });
});
