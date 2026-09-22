/** Conservative publication-history compaction for an already replayed relay journal. */

import type { RelayOperationLogRecord, RelayPublicationOperationLogEntry } from './operation-log.js';
import type { PublicationOperationStore } from './publication-store.js';
import type { ReplicaStorageLedger } from './replica-storage-ledger.js';

/**
 * Match verification depends on publication state at the match's position in
 * the journal. Reconciliation adoption depends on its exact predecessor.
 * Keep the full publication history for either dependency until those event
 * families have their own snapshot format.
 */
export function compactPublicationHistory(
  records: readonly RelayOperationLogRecord[],
  publications: PublicationOperationStore,
  allocations: ReplicaStorageLedger,
): Pick<RelayOperationLogRecord, 'committedAt' | 'entry'>[] {
  const protectedIds = new Set<string>();
  for (const { entry } of records) {
    if (entry.kind === 'match') {
      for (const reference of entry.operation.publications) protectedIds.add(reference.publicationId);
    } else if (entry.kind === 'reconciliation-adoption') {
      protectedIds.add(entry.rejection.publicationId);
    }
  }

  const histories = new Map<string, { latestLive?: number; firstTombstone?: number }>();
  for (let index = 0; index < records.length; index++) {
    const entry = records[index].entry;
    if (entry.kind !== 'publication' || protectedIds.has(entry.operation.publicationId)) continue;
    const id = entry.operation.publicationId;
    const history = histories.get(id) ?? {};
    if (entry.operation.kind === 'publication') {
      if (history.firstTombstone === undefined) history.latestLive = index;
    } else if (history.firstTombstone === undefined) {
      history.firstTombstone = index;
    }
    histories.set(id, history);
  }

  const retainedIndices = new Set<number>();
  const compactableIds = new Set<string>();
  for (const [id, history] of histories) {
    const current = publications.get(id);
    const retainedRecord = publications.getRecord(id);
    const allocation = allocations.allocationFor(id);
    const latestLive = history.latestLive === undefined ? undefined : records[history.latestLive].entry;
    const firstTombstone = history.firstTombstone === undefined
      ? undefined : records[history.firstTombstone].entry;
    if (!current || !allocation
      || (retainedRecord?.signature !== (latestLive?.kind === 'publication' ? latestLive.operation.signature : undefined))
      || (current.kind === 'publication-tombstone'
        ? firstTombstone?.kind !== 'publication' || firstTombstone.operation.signature !== current.signature
        : latestLive?.kind !== 'publication' || latestLive.operation.signature !== current.signature)) {
      throw new Error(`Cannot compact publication history for ${id}`);
    }
    if (history.latestLive !== undefined) retainedIndices.add(history.latestLive);
    if (history.firstTombstone !== undefined) retainedIndices.add(history.firstTombstone);
    compactableIds.add(id);
  }

  return records.flatMap((record, index) => {
    const { entry } = record;
    if (entry.kind !== 'publication' || !compactableIds.has(entry.operation.publicationId)) {
      return [{ committedAt: record.committedAt, entry }];
    }
    if (!retainedIndices.has(index)) return [];
    // The first accepted operation owns the allocation through later updates.
    // Rewriting both retained rows with that principal also makes unmarked
    // historical allocations explicitly legacy after this compaction.
    const allocation = allocations.allocationFor(entry.operation.publicationId);
    if (!allocation) throw new Error('Missing publication allocation during compaction');
    const compactedEntry: RelayPublicationOperationLogEntry = allocation.allocationOrigin === 'legacy'
      ? { kind: 'publication', operation: entry.operation, allocationOrigin: 'legacy' }
      : {
        kind: 'publication', operation: entry.operation,
        allocationOrigin: allocation.allocationOrigin, allocationRelayId: allocation.allocationRelayId,
      };
    return [{ committedAt: record.committedAt, entry: compactedEntry }];
  });
}
