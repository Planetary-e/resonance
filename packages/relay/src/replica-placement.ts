/** Durable local state for selecting, tracking, and repairing relay replicas. */

import {
  decodeBase64,
  didToPublicKey,
  encodeBase64,
  isDurabilityReceiptV1,
  publicKeyToDid,
  verifyRelayReplicaReceiptV1,
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
/** Bounded, per-operation refusal history retained across restarts. */
export const MAX_PERMANENTLY_REJECTED_REPLICA_TARGETS = 64;
/** A reconciliation requirement can name only currently selected targets. */
export const MAX_RECONCILIATION_REQUIRED_REPLICA_TARGETS = MAX_REPLICA_TARGETS;

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
  /**
   * Targets removed after a signed capacity refusal for this exact operation.
   * Omitted only by journals written before capacity replacement existed.
   */
  permanentlyRejectedRelayIds?: string[];
  /**
   * Selected targets that observed a state mismatch or incompatible operation.
   * The presence of any entry quarantines automatic fan-out until reconciliation.
   * Omitted only by journals written before reconciliation quarantine existed.
   */
  reconciliationRequiredRelayIds?: string[];
  desiredReplicaCount: number;
  minimumHealthyReplicaCount: number;
  revision: number;
  updatedAt: number;
}

export interface ReplicaPlacementStatus {
  intent: ReplicaPlacementIntentV1;
  confirmedRelayIds: string[];
  pendingRelayIds: string[];
  /** Targets replaced after a signed capacity refusal for this operation. */
  permanentlyRejectedRelayIds: string[];
  /** Targets whose signed refusal requires state reconciliation before fan-out. */
  reconciliationRequiredRelayIds: string[];
  /** Automatic repair and expansion are paused for this exact operation. */
  reconciliationRequired: boolean;
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
  permanentlyRejectedRelayIds: string[] = [],
  reconciliationRequiredRelayIds: string[] = [],
): ReplicaPlacementIntentV1 {
  if (!verifyPublicationOperation(operation)) throw new Error('Invalid placement operation');
  const targets = normalizeRelayIds(targetRelayIds);
  const rejections = normalizePermanentlyRejectedRelayIds(permanentlyRejectedRelayIds);
  const reconciliationRequired = normalizeReconciliationRequiredRelayIds(reconciliationRequiredRelayIds);
  if (targets.some(relayId => rejections.includes(relayId))) {
    throw new Error('A selected placement target cannot also be permanently rejected');
  }
  if (reconciliationRequired.some(relayId => !targets.includes(relayId))) {
    throw new Error('A reconciliation target must remain selected');
  }
  const intent: ReplicaPlacementIntentV1 = {
    version: REPLICA_PLACEMENT_VERSION,
    publicationId: operation.publicationId,
    operationSequence: operation.sequence,
    operationKind: operation.kind,
    operationSignature: operation.signature,
    targetRelayIds: targets,
    permanentlyRejectedRelayIds: rejections,
    reconciliationRequiredRelayIds: reconciliationRequired,
    desiredReplicaCount: policy.desiredReplicaCount,
    minimumHealthyReplicaCount: policy.minimumHealthyReplicaCount,
    revision,
    updatedAt,
  };
  if (!verifyReplicaPlacementIntent(intent)) throw new Error('Invalid placement intent');
  return intent;
}

export function verifyReplicaPlacementIntent(value: unknown): value is ReplicaPlacementIntentV1 {
  const legacyKeys = [
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
  ];
  if (!isObject(value) || !hasRequiredAndOptionalKeys(value, legacyKeys, [
    'permanentlyRejectedRelayIds',
    'reconciliationRequiredRelayIds',
  ])) return false;
  const desiredReplicaCount = value.desiredReplicaCount;
  const minimumHealthyReplicaCount = value.minimumHealthyReplicaCount;
  const revision = value.revision;
  if (!Array.isArray(value.targetRelayIds)) return false;
  const targetRelayIds = value.targetRelayIds;
  const permanentlyRejectedRelayIds = value.permanentlyRejectedRelayIds ?? [];
  const reconciliationRequiredRelayIds = value.reconciliationRequiredRelayIds ?? [];
  if (value.version !== REPLICA_PLACEMENT_VERSION
    || !isPublicationId(value.publicationId)
    || !isOperationSequence(value.operationSequence)
    || (value.operationKind !== 'publication' && value.operationKind !== 'publication-tombstone')
    || !isCanonicalBase64(value.operationSignature, 64)
    || targetRelayIds.length > MAX_REPLICA_TARGETS
    || !isStrictlySorted(targetRelayIds)
    || !targetRelayIds.every(isRelayId)
    || !isIntegerBetween(desiredReplicaCount, 1, MAX_REPLICA_TARGETS)
    || targetRelayIds.length > desiredReplicaCount
    || !isIntegerBetween(minimumHealthyReplicaCount, 1, desiredReplicaCount)
    || !isIntegerBetween(revision, 1, Number.MAX_SAFE_INTEGER)
    || !isTimestamp(value.updatedAt)
    || !Array.isArray(permanentlyRejectedRelayIds)
    || permanentlyRejectedRelayIds.length > MAX_PERMANENTLY_REJECTED_REPLICA_TARGETS
    || !isStrictlySorted(permanentlyRejectedRelayIds)
    || !permanentlyRejectedRelayIds.every(isRelayId)
    || targetRelayIds.some(relayId => permanentlyRejectedRelayIds.includes(relayId))
    || !Array.isArray(reconciliationRequiredRelayIds)
    || reconciliationRequiredRelayIds.length > MAX_RECONCILIATION_REQUIRED_REPLICA_TARGETS
    || !isStrictlySorted(reconciliationRequiredRelayIds)
    || !reconciliationRequiredRelayIds.every(isRelayId)
    || reconciliationRequiredRelayIds.some(relayId => !targetRelayIds.includes(relayId))) return false;
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
    permanentlyRejectedRelayIds: string[] = [],
    reconciliationRequiredRelayIds: string[] = [],
  ): ReplicaPlacementIntentV1 | undefined {
    const current = this.intents.get(operation.publicationId);
    const normalizedTargets = normalizeRelayIds(targetRelayIds);
    const normalizedRejections = normalizePermanentlyRejectedRelayIds(permanentlyRejectedRelayIds);
    const normalizedReconciliationRequired = normalizeReconciliationRequiredRelayIds(
      reconciliationRequiredRelayIds,
    );
    if (current && placementMatchesOperation(current, operation)
      && sameTargets(current.targetRelayIds, normalizedTargets)
      && sameTargets(current.permanentlyRejectedRelayIds ?? [], normalizedRejections)
      && sameTargets(
        current.reconciliationRequiredRelayIds ?? [],
        normalizedReconciliationRequired,
      )
      && current.desiredReplicaCount === policy.desiredReplicaCount
      && current.minimumHealthyReplicaCount === policy.minimumHealthyReplicaCount) {
      return undefined;
    }
    const revision = current && placementMatchesOperation(current, operation)
      ? current.revision + 1
      : 1;
    return createReplicaPlacementIntent(
      operation,
      normalizedTargets,
      policy,
      revision,
      updatedAt,
      normalizedRejections,
      normalizedReconciliationRequired,
    );
  }

  applyIntent(intent: ReplicaPlacementIntentV1): boolean {
    if (!verifyReplicaPlacementIntent(intent)) return false;
    const normalizedIntent = copyIntent(intent);
    const current = this.intents.get(intent.publicationId);
    if (current) {
      const comparison = compareOperationReference(intent, current);
      if (comparison < 0 || (comparison === 0 && intent.revision <= current.revision)) return false;
      if (comparison === 0 && intent.operationSignature !== current.operationSignature) return false;
    }
    const changedOperation = !current
      || !sameOperationReference(intent, current);
    this.intents.set(intent.publicationId, normalizedIntent);
    if (changedOperation) {
      this.receipts.delete(intent.publicationId);
      this.inventory.delete(intent.publicationId);
    } else {
      this.pruneUnselectedEvidence(intent.publicationId, normalizedIntent.targetRelayIds);
    }
    return true;
  }

  canRecordReceipt(receipt: unknown): receipt is RelayReplicaReceiptV1 {
    if (!isDurabilityReceiptV1(receipt)) return false;
    // Only a positive fsync acknowledgement is durability evidence. Rejected
    // responses remain transport diagnostics and must leave the target pending
    // for later retry, capacity replacement, or reconciliation policy.
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

  /**
   * Capacity replacement is safe only when a currently selected target signed
   * an exact-operation capacity refusal.
   */
  canRecordPermanentRejection(receipt: unknown): receipt is RelayReplicaReceiptV1 {
    if (!verifyRelayReplicaReceiptV1(receipt) || !isPermanentReplicaRejection(receipt)) return false;
    if (this.localRelayId !== undefined && receipt.senderRelayId !== this.localRelayId) return false;
    const intent = this.intents.get(receipt.publicationId);
    if (!intent
      || intent.operationSequence !== receipt.operationSequence
      || intent.operationKind !== receipt.operationKind
      || intent.operationSignature !== receipt.operationSignature
      || !intent.targetRelayIds.includes(receipt.responderRelayId)
      || (intent.permanentlyRejectedRelayIds ?? []).includes(receipt.responderRelayId)
      || (intent.reconciliationRequiredRelayIds ?? []).length > 0
      || (intent.permanentlyRejectedRelayIds ?? []).length
        >= MAX_PERMANENTLY_REJECTED_REPLICA_TARGETS) return false;
    return true;
  }

  /**
   * A signed mismatch can prove that this relay has an older view of the
   * owner's operation. Persist that evidence and pause all automatic fan-out
   * for the exact operation rather than amplifying it to fresh volunteers.
   */
  canRecordReconciliationRequirement(receipt: unknown): receipt is RelayReplicaReceiptV1 {
    if (!verifyRelayReplicaReceiptV1(receipt)
      || !isReconciliationRequiredReplicaRejection(receipt)) return false;
    if (this.localRelayId !== undefined && receipt.senderRelayId !== this.localRelayId) return false;
    const intent = this.intents.get(receipt.publicationId);
    if (!intent
      || intent.operationSequence !== receipt.operationSequence
      || intent.operationKind !== receipt.operationKind
      || intent.operationSignature !== receipt.operationSignature
      || !intent.targetRelayIds.includes(receipt.responderRelayId)
      || (intent.reconciliationRequiredRelayIds ?? []).includes(receipt.responderRelayId)) return false;
    return true;
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
      || (intent.reconciliationRequiredRelayIds ?? []).length > 0
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
    if ((this.intents.get(publicationId)?.reconciliationRequiredRelayIds ?? []).length > 0) return [];
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
    const reconciliationRequiredRelayIds = [...(intent.reconciliationRequiredRelayIds ?? [])];
    const reconciliationRequired = reconciliationRequiredRelayIds.length > 0;
    const inventoryPresentRelayIds = intent.targetRelayIds.filter(relayId => (
      observations?.get(relayId)?.status === 'present'
    ));
    const inventoryMissingRelayIds = intent.targetRelayIds.filter(relayId => (
      observations?.get(relayId)?.status === 'missing'
    ));
    const inventoryCheckedRelayIds = intent.targetRelayIds.filter(relayId => observations?.has(relayId));
    const missing = new Set(inventoryMissingRelayIds);
    const pendingRelayIds = reconciliationRequired
      ? []
      : intent.targetRelayIds.filter(relayId => !confirmed.has(relayId) || missing.has(relayId));
    return {
      intent: copyIntent(intent),
      confirmedRelayIds,
      pendingRelayIds,
      permanentlyRejectedRelayIds: [...(intent.permanentlyRejectedRelayIds ?? [])],
      reconciliationRequiredRelayIds,
      reconciliationRequired,
      inventoryPresentRelayIds,
      inventoryMissingRelayIds,
      inventoryCheckedRelayIds,
      confirmedReplicaCount: confirmedRelayIds.length,
      inventoryPresentReplicaCount: inventoryPresentRelayIds.length,
      minimumConfirmed: !reconciliationRequired
        && confirmedRelayIds.length >= intent.minimumHealthyReplicaCount,
      targetConfirmed: !reconciliationRequired
        && confirmedRelayIds.length >= intent.desiredReplicaCount,
    };
  }

  private pruneUnselectedEvidence(publicationId: string, targetRelayIds: string[]): void {
    const selected = new Set(targetRelayIds);
    const receipts = this.receipts.get(publicationId);
    if (receipts) {
      for (const relayId of receipts.keys()) {
        if (!selected.has(relayId)) receipts.delete(relayId);
      }
      if (receipts.size === 0) this.receipts.delete(publicationId);
    }
    const inventory = this.inventory.get(publicationId);
    if (inventory) {
      for (const relayId of inventory.keys()) {
        if (!selected.has(relayId)) inventory.delete(relayId);
      }
      if (inventory.size === 0) this.inventory.delete(publicationId);
    }
  }
}

/**
 * The receiver emits `capacity-exhausted` only after it has evaluated the
 * operation against its current state. It therefore cannot mask a newer
 * owner-signed operation and is the only rejection that may safely replace a
 * target before reconciliation exists.
 */
export function isPermanentReplicaRejection(receipt: RelayReplicaReceiptV1): boolean {
  return receipt.status === 'rejected' && receipt.reason === 'capacity-exhausted';
}

/**
 * These refusals either prove a conflicting owner operation or occur before
 * the receiver evaluates its state. The source must not fan out the older
 * operation until a later local revision or explicit reconciliation resolves
 * the discrepancy.
 */
export function isReconciliationRequiredReplicaRejection(receipt: RelayReplicaReceiptV1): boolean {
  return receipt.status === 'rejected'
    && (receipt.reason === 'unsupported-group'
      || receipt.reason === 'stale'
      || receipt.reason === 'conflict'
      || receipt.reason === 'terminal'
      || receipt.reason === 'invalid');
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

function normalizePermanentlyRejectedRelayIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_PERMANENTLY_REJECTED_REPLICA_TARGETS) {
    throw new Error('Invalid permanently rejected placement targets');
  }
  const normalized = [...values].sort();
  if (!normalized.every(isRelayId) || !isStrictlySorted(normalized)) {
    throw new Error('Invalid permanently rejected placement targets');
  }
  return normalized;
}

function normalizeReconciliationRequiredRelayIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_RECONCILIATION_REQUIRED_REPLICA_TARGETS) {
    throw new Error('Invalid reconciliation-required placement targets');
  }
  const normalized = [...values].sort();
  if (!normalized.every(isRelayId) || !isStrictlySorted(normalized)) {
    throw new Error('Invalid reconciliation-required placement targets');
  }
  return normalized;
}

function copyIntent(value: ReplicaPlacementIntentV1): ReplicaPlacementIntentV1 {
  return {
    ...value,
    targetRelayIds: [...value.targetRelayIds],
    permanentlyRejectedRelayIds: [...(value.permanentlyRejectedRelayIds ?? [])],
    reconciliationRequiredRelayIds: [...(value.reconciliationRequiredRelayIds ?? [])],
  };
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

function hasRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && actual.every(key => allowed.has(key));
}

function isStrictlySorted(values: string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}
