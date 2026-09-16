/**
 * Reservation accounting for the publication state a relay agrees to retain.
 *
 * The append-only operation journal is deliberately not used as the quota
 * unit: it contains historical operations, matches, mailboxes, and placement
 * evidence and is not compacted yet. This ledger instead measures the current
 * authoritative publication state, rebuilt from that journal on every start.
 */

import { Buffer } from 'node:buffer';
import type { PublicationOperation, PublicationRecord } from '@resonance/core';

/**
 * A signed v2 tombstone has fixed-size fields apart from safe integers and is
 * below this bound. Reserving it with every live record means a full relay can
 * still accept a valid withdrawal without exceeding its promised allocation.
 */
export const TOMBSTONE_HEADROOM_BYTES = 512;

/**
 * A small portion of every relay's publication allocation is held back for a
 * terminal operation that arrives before its live predecessor. This preserves
 * withdrawal convergence when a full relay is selected after a publication
 * was created, or when it lost the earlier replica.
 */
export const FIRST_SEEN_TOMBSTONE_RESERVE_BYTES = TOMBSTONE_HEADROOM_BYTES;

/** Durable provenance for a retained publication allocation. */
export type PublicationStorageAllocationOrigin = 'local' | 'replica' | 'legacy';

/**
 * A locally accepted operation is outside inbound-peer accounting. A replica
 * is charged to the authenticated sender that first used the allocation.
 * Legacy covers a pre-attribution journal row and is one conservative virtual
 * inbound source; it deliberately has no serializable relay ID.
 */
export type PublicationStorageAllocationPrincipal =
  | { allocationOrigin: 'local'; allocationRelayId: string }
  | { allocationOrigin: 'replica'; allocationRelayId: string }
  | { allocationOrigin: 'legacy' };

/** Bytes available to ordinary live publications and updates. */
export function publicationStorageAllocatableBytes(quotaBytes: number): number {
  return Math.max(0, quotaBytes - Math.min(FIRST_SEEN_TOMBSTONE_RESERVE_BYTES, quotaBytes));
}

export type ReplicaStorageAllocation = PublicationStorageAllocationPrincipal & {
  publicationId: string;
  reservedBytes: number;
};

/** Bytes reserved for the retained state after accepting one operation. */
export function publicationStorageReservationBytes(
  operation: PublicationOperation,
  retainedRecord?: PublicationRecord,
): number {
  const operationBytes = encodedOperationBytes(operation);
  if (operation.kind === 'publication') return operationBytes + TOMBSTONE_HEADROOM_BYTES;
  return operationBytes + (retainedRecord ? encodedOperationBytes(retainedRecord) : 0);
}

export class ReplicaStorageLedger {
  private readonly allocations = new Map<string, ReplicaStorageAllocation>();
  private readonly replicaReservations = new Map<string, number>();
  private legacyReservedBytes = 0;
  private totalReservedBytes = 0;

  get reservedBytes(): number {
    return this.totalReservedBytes;
  }

  get replicaRelayCount(): number {
    return this.replicaReservations.size;
  }

  get replicaReservedBytes(): number {
    let total = 0;
    for (const reservedBytes of this.replicaReservations.values()) total += reservedBytes;
    return total;
  }

  /** Conservatively charged retained state from pre-attribution journal rows. */
  get legacyUnattributedReservedBytes(): number {
    return this.legacyReservedBytes;
  }

  reservedBytesForRelay(relayId: string): number {
    return this.replicaReservations.get(relayId) ?? 0;
  }

  allocationFor(publicationId: string): ReplicaStorageAllocation | undefined {
    const allocation = this.allocations.get(publicationId);
    return allocation ? { ...allocation } : undefined;
  }

  canReserve(
    publicationId: string,
    reservedBytes: number,
    allocation: PublicationStorageAllocationPrincipal,
    quotaBytes: number,
    maxReplicaBytesPerRelay: number,
    allowFirstSeenTombstoneReserve = false,
  ): boolean {
    if (!isByteCount(reservedBytes)
      || !isAllocationPrincipal(allocation)
      || !isByteCount(quotaBytes)
      || !isByteCount(maxReplicaBytesPerRelay)) return false;
    const current = this.allocations.get(publicationId);
    // The first accepted operation owns a replica allocation through updates
    // and its terminal tombstone. Do not let a later carrier move that cost.
    const owner = current ? principalFor(current) : allocation;
    const priorBytes = current?.reservedBytes ?? 0;
    const growsAllocation = reservedBytes > priorBytes;
    const projectedTotal = this.totalReservedBytes - priorBytes + reservedBytes;
    // Ordinary writes cannot consume the protected withdrawal reserve. The
    // caller may use it only after verifying that this is a valid first-seen
    // tombstone; the absence check here prevents it from being reused by an
    // update to an existing allocation.
    const totalQuota = allowFirstSeenTombstoneReserve && !current
      ? quotaBytes
      : publicationStorageAllocatableBytes(quotaBytes);
    // An operator can lower a quota below existing reservations. Keep accepting
    // an owner-authorized update or withdrawal that does not grow its current
    // allocation so a relay can converge back under the new limit.
    if (!Number.isSafeInteger(projectedTotal)
      || (projectedTotal > totalQuota && (!current || growsAllocation))) return false;
    if (owner.allocationOrigin === 'local') return true;
    const projectedForRelay = this.reservedBytesForPrincipal(owner) - priorBytes + reservedBytes;
    // Preserve the per-relay cap as well. Its ordinary allocation leaves the
    // same small headroom so a full source can still send a first-seen
    // withdrawal. The global quota above keeps this reserve bounded across
    // all relay identities.
    const relayQuota = allowFirstSeenTombstoneReserve && !current
      ? maxReplicaBytesPerRelay
      : publicationStorageAllocatableBytes(maxReplicaBytesPerRelay);
    return Number.isSafeInteger(projectedForRelay)
      && (projectedForRelay <= relayQuota || (current !== undefined && !growsAllocation));
  }

  record(
    publicationId: string,
    reservedBytes: number,
    allocation: PublicationStorageAllocationPrincipal,
  ): void {
    if (!isByteCount(reservedBytes) || !isAllocationPrincipal(allocation)) {
      throw new Error('Invalid publication storage reservation');
    }
    const current = this.allocations.get(publicationId);
    const owner = current ? principalFor(current) : allocation;
    if (current) this.remove(current);
    const next: ReplicaStorageAllocation = { publicationId, reservedBytes, ...owner };
    this.allocations.set(publicationId, next);
    this.totalReservedBytes += reservedBytes;
    this.addReservation(owner, reservedBytes);
  }

  private remove(allocation: ReplicaStorageAllocation): void {
    this.totalReservedBytes -= allocation.reservedBytes;
    this.addReservation(principalFor(allocation), -allocation.reservedBytes);
  }

  private addReservation(
    allocation: PublicationStorageAllocationPrincipal,
    changeBytes: number,
  ): void {
    if (allocation.allocationOrigin === 'local') return;
    if (allocation.allocationOrigin === 'legacy') {
      this.legacyReservedBytes += changeBytes;
      return;
    }
    const remaining = this.reservedBytesForRelay(allocation.allocationRelayId) + changeBytes;
    if (remaining <= 0) this.replicaReservations.delete(allocation.allocationRelayId);
    else this.replicaReservations.set(allocation.allocationRelayId, remaining);
  }

  private reservedBytesForPrincipal(allocation: PublicationStorageAllocationPrincipal): number {
    if (allocation.allocationOrigin === 'local') return 0;
    if (allocation.allocationOrigin === 'legacy') return this.legacyReservedBytes;
    return this.reservedBytesForRelay(allocation.allocationRelayId);
  }
}

function principalFor(allocation: ReplicaStorageAllocation): PublicationStorageAllocationPrincipal {
  if (allocation.allocationOrigin === 'legacy') return { allocationOrigin: 'legacy' };
  return {
    allocationOrigin: allocation.allocationOrigin,
    allocationRelayId: allocation.allocationRelayId,
  };
}

function encodedOperationBytes(operation: PublicationOperation): number {
  return Buffer.byteLength(JSON.stringify(operation), 'utf8');
}

function isByteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isAllocationPrincipal(value: unknown): value is PublicationStorageAllocationPrincipal {
  if (!isObject(value) || typeof value.allocationOrigin !== 'string') return false;
  if (value.allocationOrigin === 'legacy') return !('allocationRelayId' in value);
  return (value.allocationOrigin === 'local' || value.allocationOrigin === 'replica')
    && typeof value.allocationRelayId === 'string'
    && value.allocationRelayId.length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
