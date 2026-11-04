/** Retain only relay evidence that can still affect replay, delivery, or repair. */

import { isDeepStrictEqual } from 'node:util';
import { isPublicationActive } from '@resonance/core';
import type { MatchOperationStore } from './match-operation-store.js';
import type { RelayOperationLogRecord, RelayOperationLogEntry } from './operation-log.js';
import type { PublicationOperationStore } from './publication-store.js';
import { placementMatchesOperation, type ReplicaPlacementIntentV1, type ReplicaPlacementTracker } from './replica-placement.js';

type RetainedRecord = Pick<RelayOperationLogRecord, 'committedAt' | 'entry'>;

/**
 * A signed match remains necessary while either notice might be delivered.
 * Once both notice lifetimes end, its current generation needs only the signed
 * decision to prevent a restarted relay from notifying the same live pair
 * again. Older generations and inactive pairs then have no future effect.
 */
export function compactMatchHistory(
  records: readonly RetainedRecord[],
  matches: MatchOperationStore,
  publications: PublicationOperationStore,
  now = Date.now(),
): RetainedRecord[] {
  return records.flatMap(record => {
    const { entry } = record;
    if (entry.kind !== 'match' && entry.kind !== 'match-checkpoint') return [record];
    const operation = entry.operation;
    const current = matches.get(operation.matchId);
    const deliveryPending = entry.kind === 'match'
      && entry.envelopes.some(envelope => envelope.expiresAt > now);
    if (deliveryPending) return [record];
    if (current?.operationId !== operation.operationId) return [];
    const pairActive = operation.publications.every(reference => {
      const publication = publications.get(reference.publicationId);
      return publication?.kind === 'publication' && isPublicationActive(publication, now);
    });
    if (!pairActive) return [];
    if (entry.kind === 'match-checkpoint') return [record];
    return [{ committedAt: record.committedAt, entry: {
      kind: 'match-checkpoint', operation,
    } as RelayOperationLogEntry }];
  });
}

/**
 * A successful reconciliation already authenticated the owner's operation.
 * After adoption, the rejection and one-time target response are no longer
 * needed to replay that state. Preserve the adopted operation and its original
 * allocation principal before publication-history compaction.
 */
export function compactReconciliationHistory(records: readonly RetainedRecord[]): RetainedRecord[] {
  return records.map(record => {
    const { entry } = record;
    if (entry.kind !== 'reconciliation-adoption') return record;
    const operation = entry.response.operation;
    if (!operation) throw new Error('Cannot compact empty reconciliation adoption');
    const allocation = entry.allocation;
    const publicationEntry: RelayOperationLogEntry = allocation.allocationOrigin === 'legacy'
      ? { kind: 'publication', operation, allocationOrigin: 'legacy' }
      : {
        kind: 'publication', operation,
        allocationOrigin: allocation.allocationOrigin,
        allocationRelayId: allocation.allocationRelayId,
      };
    return { committedAt: record.committedAt, entry: publicationEntry };
  });
}

/**
 * The tracker is the replayed placement state. Old revisions, retired
 * operations, and receipts for deselected targets cannot authorize repair.
 * Put the retained intent before its receipts: a receipt may have been written
 * before a later revision of the same intent.
 */
export function compactPlacementHistory(
  records: readonly RetainedRecord[],
  placements: ReplicaPlacementTracker,
  publications: PublicationOperationStore,
): RetainedRecord[] {
  const intents = new Map<string, RetainedRecord[]>();
  const receipts = new Map<string, RetainedRecord>();
  const others: RetainedRecord[] = [];
  for (const record of records) {
    if (record.entry.kind === 'placement-intent') {
      const id = record.entry.intent.publicationId;
      const candidates = intents.get(id) ?? [];
      candidates.push(record);
      intents.set(id, candidates);
    } else if (record.entry.kind === 'placement-receipt') {
      receipts.set(record.entry.receipt.signature, record);
    } else {
      others.push(record);
    }
  }

  for (const intent of placements.listIntents()) {
    const operation = publications.get(intent.publicationId);
    if (!operation || !placementMatchesOperation(intent, operation)) continue;
    const saved = intents.get(intent.publicationId)?.find(record => (
      record.entry.kind === 'placement-intent'
      && sameIntent(record.entry.intent, intent)
    ));
    if (!saved) throw new Error(`Missing current placement intent for ${intent.publicationId}`);
    others.push(saved);
    for (const receipt of placements.receiptsFor(intent.publicationId)) {
      const savedReceipt = receipts.get(receipt.signature);
      if (!savedReceipt) throw new Error(`Missing current placement receipt for ${intent.publicationId}`);
      others.push(savedReceipt);
    }
  }
  return others;
}

function sameIntent(first: ReplicaPlacementIntentV1, second: ReplicaPlacementIntentV1): boolean {
  return isDeepStrictEqual({
    ...first,
    permanentlyRejectedRelayIds: first.permanentlyRejectedRelayIds ?? [],
    reconciliationRequiredRelayIds: first.reconciliationRequiredRelayIds ?? [],
    reconciliationRequirements: first.reconciliationRequirements ?? [],
  }, second);
}
