/** Durable local state for selecting, tracking, and repairing relay replicas. */

import {
  decodeBase64,
  didToPublicKey,
  encodeBase64,
  isDurabilityReceiptV1,
  publicKeyToDid,
  verifyRelayReplicaInventoryResponseV1,
  verifyPublicationOperation,
  type PublicationOperation,
  type RelayReplicaInventoryResponseV1,
  type RelayReplicaReceiptV1,
} from '@resonance/core';

export const REPLICA_PLACEMENT_VERSION = 1 as const;
export const DEFAULT_DESIRED_REPLICA_COUNT = 5;
export const DEFAULT_MINIMUM_HEALTHY_REPLICA_COUNT = 3;
export const MAX_REPLICA_TARGETS = 5;

export interface ReplicaPlacementPolicy {
  desiredReplicaCount: number;
  minimumHealthyReplicaCount: number;
}

export interface ReplicaPlacementIntentV1 {
  version: typeof REPLICA_PLACEMENT_VERSION;
  publicationId: string;
  operationSequence: number;
  operationKind: PublicationOperation['kind'];
  operationSignature: string;
  targetRelayIds: string[];
  desiredReplicaCount: number;
  minimumHealthyReplicaCount: number;
  revision: number;
  updatedAt: number;
}

export interface ReplicaPlacementStatus {
  intent: ReplicaPlacementIntentV1;
  confirmedRelayIds: string[];
  pendingRelayIds: string[];
  /** Targets whose exact current operation was recently checked over a relay link. */
  inventoryPresentRelayIds: string[];
  /** Targets that signed a response saying the exact operation is no longer present. */
  inventoryMissingRelayIds: string[];
  /** Targets that answered a current inventory request, including rate limits. */
  inventoryCheckedRelayIds: string[];
  confirmedReplicaCount: number;
  inventoryPresentReplicaCount: number;
  minimumConfirmed: boolean;
  targetConfirmed: boolean;
}

export function createReplicaPlacementIntent(
  operation: PublicationOperation,
  targetRelayIds: string[],
  policy: ReplicaPlacementPolicy,
  revision: number,
  updatedAt = Date.now(),
): ReplicaPlacementIntentV1 {
  if (!verifyPublicationOperation(operation)) throw new Error('Invalid placement operation');
  const intent: ReplicaPlacementIntentV1 = {
    version: REPLICA_PLACEMENT_VERSION,
    publicationId: operation.publicationId,
    operationSequence: operation.sequence,
    operationKind: operation.kind,
    operationSignature: operation.signature,
    targetRelayIds: normalizeRelayIds(targetRelayIds),
    desiredReplicaCount: policy.desiredReplicaCount,
    minimumHealthyReplicaCount: policy.minimumHealthyReplicaCount,
    revision,
    updatedAt,
  };
  if (!verifyReplicaPlacementIntent(intent)) throw new Error('Invalid placement intent');
  return intent;
}

export function verifyReplicaPlacementIntent(value: unknown): value is ReplicaPlacementIntentV1 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'desiredReplicaCount',
    'minimumHealthyReplicaCount',
    'operationKind',
    'operationSequence',
    'operationSignature',
    'publicationId',
    'revision',
    'targetRelayIds',
    'updatedAt',
    'version',
  ])) return false;
  const desiredReplicaCount = value.desiredReplicaCount;
  const minimumHealthyReplicaCount = value.minimumHealthyReplicaCount;
  const revision = value.revision;
  if (value.version !== REPLICA_PLACEMENT_VERSION
    || !isPublicationId(value.publicationId)
    || !isOperationSequence(value.operationSequence)
    || (value.operationKind !== 'publication' && value.operationKind !== 'publication-tombstone')
    || !isCanonicalBase64(value.operationSignature, 64)
    || !Array.isArray(value.targetRelayIds)
    || value.targetRelayIds.length > MAX_REPLICA_TARGETS
    || !isStrictlySorted(value.targetRelayIds)
    || !value.targetRelayIds.every(isRelayId)
    || !isIntegerBetween(desiredReplicaCount, 1, MAX_REPLICA_TARGETS)
    || value.targetRelayIds.length > desiredReplicaCount
    || !isIntegerBetween(minimumHealthyReplicaCount, 1, desiredReplicaCount)
    || !isIntegerBetween(revision, 1, Number.MAX_SAFE_INTEGER)
    || !isTimestamp(value.updatedAt)) return false;
  return true;
}

export function placementMatchesOperation(
  intent: ReplicaPlacementIntentV1,
  operation: PublicationOperation,
): boolean {
  return verifyReplicaPlacementIntent(intent)
    && verifyPublicationOperation(operation)
    && intent.publicationId === operation.publicationId
    && intent.operationSequence === operation.sequence
    && intent.operationKind === operation.kind
    && intent.operationSignature === operation.signature;
}

export class ReplicaPlacementTracker {
  private readonly intents = new Map<string, ReplicaPlacementIntentV1>();
  private readonly receipts = new Map<string, Map<string, RelayReplicaReceiptV1>>();
  private readonly inventory = new Map<string, Map<string, RelayReplicaInventoryResponseV1>>();

  constructor(private readonly localRelayId?: string) {}

  getIntent(publicationId: string): ReplicaPlacementIntentV1 | undefined {
    const intent = this.intents.get(publicationId);
    return intent ? copyIntent(intent) : undefined;
  }

  listIntents(): ReplicaPlacementIntentV1[] {
    return [...this.intents.values()]
      .sort((first, second) => first.publicationId.localeCompare(second.publicationId))
      .map(copyIntent);
  }

  nextIntent(
    operation: PublicationOperation,
    targetRelayIds: string[],
    policy: ReplicaPlacementPolicy,
    updatedAt = Date.now(),
  ): ReplicaPlacementIntentV1 | undefined {
    const current = this.intents.get(operation.publicationId);
    const normalizedTargets = normalizeRelayIds(targetRelayIds);
    if (current && placementMatchesOperation(current, operation)
      && sameTargets(current.targetRelayIds, normalizedTargets)
      && current.desiredReplicaCount === policy.desiredReplicaCount
      && current.minimumHealthyReplicaCount === policy.minimumHealthyReplicaCount) {
      return undefined;
    }
    const revision = current && placementMatchesOperation(current, operation)
      ? current.revision + 1
      : 1;
    return createReplicaPlacementIntent(operation, normalizedTargets, policy, revision, updatedAt);
  }

  applyIntent(intent: ReplicaPlacementIntentV1): boolean {
    if (!verifyReplicaPlacementIntent(intent)) return false;
    const current = this.intents.get(intent.publicationId);
    if (current) {
      const comparison = compareOperationReference(intent, current);
      if (comparison < 0 || (comparison === 0 && intent.revision <= current.revision)) return false;
      if (comparison === 0 && intent.operationSignature !== current.operationSignature) return false;
    }
    const changedOperation = !current
      || !sameOperationReference(intent, current);
    this.intents.set(intent.publicationId, copyIntent(intent));
    if (changedOperation) {
      this.receipts.delete(intent.publicationId);
      this.inventory.delete(intent.publicationId);
    }
    return true;
  }

  canRecordReceipt(receipt: unknown): receipt is RelayReplicaReceiptV1 {
    if (!isDurabilityReceiptV1(receipt)) return false;
    // Only a positive fsync acknowledgement is durability evidence. Rejected
    // responses remain transport diagnostics and must leave the target pending
    // for later retry or replacement policy.
    if (receipt.status !== 'stored' && receipt.status !== 'already-stored') return false;
    if (this.localRelayId !== undefined && receipt.senderRelayId !== this.localRelayId) return false;
    const intent = this.intents.get(receipt.publicationId);
    if (!intent
      || intent.operationSequence !== receipt.operationSequence
      || intent.operationKind !== receipt.operationKind
      || intent.operationSignature !== receipt.operationSignature
      || !intent.targetRelayIds.includes(receipt.responderRelayId)) return false;
    const current = this.receipts.get(receipt.publicationId)?.get(receipt.responderRelayId);
    return !current
      || receipt.createdAt > current.createdAt
      || receipt.signature !== current.signature;
  }

  recordReceipt(receipt: RelayReplicaReceiptV1): boolean {
    if (!this.canRecordReceipt(receipt)) return false;
    let byRelay = this.receipts.get(receipt.publicationId);
    if (!byRelay) {
      byRelay = new Map();
      this.receipts.set(receipt.publicationId, byRelay);
    }
    byRelay.set(receipt.responderRelayId, { ...receipt });
    // A fresh durable write supersedes any older missing/current observation.
    const observations = this.inventory.get(receipt.publicationId);
    observations?.delete(receipt.responderRelayId);
    if (observations?.size === 0) this.inventory.delete(receipt.publicationId);
    return true;
  }

  canRecordInventoryResponse(response: unknown): response is RelayReplicaInventoryResponseV1 {
    if (!verifyRelayReplicaInventoryResponseV1(response)) return false;
    if (this.localRelayId !== undefined && response.senderRelayId !== this.localRelayId) return false;
    const intent = this.intents.get(response.publicationId);
    if (!intent
      || intent.operationSequence !== response.operationSequence
      || intent.operationKind !== response.operationKind
      || intent.operationSignature !== response.operationSignature
      || !intent.targetRelayIds.includes(response.responderRelayId)) return false;
    const receipt = this.receipts.get(response.publicationId)?.get(response.responderRelayId);
    if (!receipt
      || receipt.senderRelayId !== response.senderRelayId
      || receipt.operationSequence !== response.operationSequence
      || receipt.operationKind !== response.operationKind
      || receipt.operationSignature !== response.operationSignature
      || response.createdAt < receipt.createdAt) return false;
    const current = this.inventory.get(response.publicationId)?.get(response.responderRelayId);
    return !current
      || response.createdAt > current.createdAt
      || response.signature !== current.signature;
  }

  recordInventoryResponse(response: RelayReplicaInventoryResponseV1): boolean {
    if (!this.canRecordInventoryResponse(response)) return false;
    let byRelay = this.inventory.get(response.publicationId);
    if (!byRelay) {
      byRelay = new Map();
      this.inventory.set(response.publicationId, byRelay);
    }
    byRelay.set(response.responderRelayId, { ...response });
    return true;
  }

  receiptsFor(publicationId: string): RelayReplicaReceiptV1[] {
    return [...(this.receipts.get(publicationId)?.values() ?? [])]
      .sort((first, second) => first.responderRelayId.localeCompare(second.responderRelayId))
      .map(receipt => ({ ...receipt }));
  }

  inventoryDueReceipts(
    publicationId: string,
    maximumAgeMs: number,
    now = Date.now(),
  ): RelayReplicaReceiptV1[] {
    if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 0
      || !Number.isSafeInteger(now) || now < 0) return [];
    const observations = this.inventory.get(publicationId);
    return this.receiptsFor(publicationId).filter(receipt => {
      const observation = observations?.get(receipt.responderRelayId);
      // Observations are deliberately memory-only. Without one, including
      // after a restart, the target is unknown and should be checked on the
      // next repair pass instead of treating the old receipt as current.
      return observation === undefined || now - observation.createdAt >= maximumAgeMs;
    });
  }

  statusFor(publicationId: string): ReplicaPlacementStatus | undefined {
    const intent = this.intents.get(publicationId);
    if (!intent) return undefined;
    const confirmedRelayIds = this.receiptsFor(publicationId)
      .filter(receipt => intent.targetRelayIds.includes(receipt.responderRelayId))
      .map(receipt => receipt.responderRelayId)
      .sort();
    const confirmed = new Set(confirmedRelayIds);
    const observations = this.inventory.get(publicationId);
    const inventoryPresentRelayIds = intent.targetRelayIds.filter(relayId => (
      observations?.get(relayId)?.status === 'present'
    ));
    const inventoryMissingRelayIds = intent.targetRelayIds.filter(relayId => (
      observations?.get(relayId)?.status === 'missing'
    ));
    const inventoryCheckedRelayIds = intent.targetRelayIds.filter(relayId => observations?.has(relayId));
    const missing = new Set(inventoryMissingRelayIds);
    const pendingRelayIds = intent.targetRelayIds.filter(relayId => !confirmed.has(relayId) || missing.has(relayId));
    return {
      intent: copyIntent(intent),
      confirmedRelayIds,
      pendingRelayIds,
      inventoryPresentRelayIds,
      inventoryMissingRelayIds,
      inventoryCheckedRelayIds,
      confirmedReplicaCount: confirmedRelayIds.length,
      inventoryPresentReplicaCount: inventoryPresentRelayIds.length,
      minimumConfirmed: confirmedRelayIds.length >= intent.minimumHealthyReplicaCount,
      targetConfirmed: confirmedRelayIds.length >= intent.desiredReplicaCount,
    };
  }
}

/**
 * Selects a bounded, fair batch of receipt-authorized point checks. The cursor
 * is keyed by the stable publication/relay pair instead of a numeric offset so
 * completed checks dropping out of the next batch cannot starve later records.
 */
export class ReplicaInventoryScheduler {
  private cursor: string | undefined;

  take(receipts: readonly RelayReplicaReceiptV1[], limit: number): RelayReplicaReceiptV1[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Replica inventory batch limit must be a positive integer');
    }
    const ordered = [...receipts].sort((first, second) => (
      compareInventoryReceiptKeys(inventoryReceiptKey(first), inventoryReceiptKey(second))
    ));
    if (ordered.length === 0) return [];
    const cursor = this.cursor;
    const firstAfterCursor = cursor === undefined
      ? 0
      : ordered.findIndex(receipt => (
        compareInventoryReceiptKeys(inventoryReceiptKey(receipt), cursor) > 0
      ));
    const start = firstAfterCursor === -1 ? 0 : firstAfterCursor;
    const count = Math.min(limit, ordered.length);
    const selected = Array.from({ length: count }, (_, index) => (
      ordered[(start + index) % ordered.length]
    ));
    this.cursor = inventoryReceiptKey(selected[selected.length - 1]);
    return selected.map(receipt => ({ ...receipt }));
  }
}

function compareOperationReference(
  first: ReplicaPlacementIntentV1,
  second: ReplicaPlacementIntentV1,
): number {
  if (first.operationSequence !== second.operationSequence) {
    return first.operationSequence < second.operationSequence ? -1 : 1;
  }
  if (first.operationSignature === second.operationSignature) return 0;
  return -1;
}

function sameOperationReference(
  first: ReplicaPlacementIntentV1,
  second: ReplicaPlacementIntentV1,
): boolean {
  return first.publicationId === second.publicationId
    && first.operationSequence === second.operationSequence
    && first.operationKind === second.operationKind
    && first.operationSignature === second.operationSignature;
}

function normalizeRelayIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_REPLICA_TARGETS) {
    throw new Error('Invalid placement targets');
  }
  const normalized = [...values].sort();
  if (!normalized.every(isRelayId) || !isStrictlySorted(normalized)) {
    throw new Error('Invalid placement targets');
  }
  return normalized;
}

function copyIntent(value: ReplicaPlacementIntentV1): ReplicaPlacementIntentV1 {
  return { ...value, targetRelayIds: [...value.targetRelayIds] };
}

function sameTargets(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function inventoryReceiptKey(receipt: RelayReplicaReceiptV1): string {
  return `${receipt.publicationId}\u0000${receipt.responderRelayId}`;
}

function compareInventoryReceiptKeys(first: string, second: string): number {
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

function isPublicationId(value: unknown): value is string {
  return typeof value === 'string' && /^pub_[A-Za-z0-9_-]{43}$/.test(value);
}

function isOperationSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRelayId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256) return false;
  try {
    const key = didToPublicKey(value);
    return key.length === 32 && publicKeyToDid(key) === value;
  } catch {
    return false;
  }
}

function isCanonicalBase64(value: unknown, length: number): value is string {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const decoded = decodeBase64(value);
    return decoded.length === length && encodeBase64(decoded) === value;
  } catch {
    return false;
  }
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isStrictlySorted(values: string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}
