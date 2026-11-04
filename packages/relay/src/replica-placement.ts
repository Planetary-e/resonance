/** Durable local state for selecting, tracking, and repairing relay replicas. */

import {
  decodeRelayReplicaInventoryBatchPresenceV1,
  decodeBase64,
  didToPublicKey,
  encodeBase64,
  isDurabilityReceiptV1,
  isRelayReplicaReconciliationReceiptV1,
  publicKeyToDid,
  verifyRelayReplicaReceiptV1,
  verifyRelayReplicaInventoryBatchResponseV1,
  verifyRelayReplicaInventoryResponseV1,
  verifyPublicationOperation,
  type PublicationOperation,
  type RelayReplicaInventoryBatchResponseV1,
  type RelayReplicaInventoryResponseV1,
  type RelayReplicaReceiptV1,
} from '@resonance/core';

interface ReplicaInventoryObservation {
  status: 'present' | 'missing' | 'rejected';
  createdAt: number;
  evidenceSignature: string;
}

export const REPLICA_PLACEMENT_VERSION = 1 as const;
export const DEFAULT_DESIRED_REPLICA_COUNT = 5;
export const DEFAULT_MINIMUM_HEALTHY_REPLICA_COUNT = 3;
export const MAX_REPLICA_TARGETS = 5;
/** Bounded, per-operation target exclusion history retained across restarts. */
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
   * Targets removed after signed capacity refusal or graceful retirement for
   * this exact operation. Omitted only by older journals.
   */
  permanentlyRejectedRelayIds?: string[];
  /**
   * Selected targets that observed a state mismatch or incompatible operation.
   * The presence of any entry quarantines automatic fan-out until reconciliation.
   * Omitted only by journals written before reconciliation quarantine existed.
   */
  reconciliationRequiredRelayIds?: string[];
  /**
   * Signed, target-scoped capabilities for the subset of quarantines that
   * arise from a divergent owner state. Older ID-only quarantines stay safe
   * but cannot make a later state request.
   */
  reconciliationRequirements?: ReplicaReconciliationRequirementV1[];
  desiredReplicaCount: number;
  minimumHealthyReplicaCount: number;
  revision: number;
  updatedAt: number;
}

export interface ReplicaReconciliationRequirementV1 {
  relayId: string;
  rejection: RelayReplicaReceiptV1;
}

export interface ReplicaPlacementStatus {
  intent: ReplicaPlacementIntentV1;
  confirmedRelayIds: string[];
  pendingRelayIds: string[];
  /** Targets replaced after signed capacity refusal or graceful retirement. */
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
  reconciliationRequirements: ReplicaReconciliationRequirementV1[] = [],
): ReplicaPlacementIntentV1 {
  if (!verifyPublicationOperation(operation)) throw new Error('Invalid placement operation');
  const targets = normalizeRelayIds(targetRelayIds);
  const rejections = normalizePermanentlyRejectedRelayIds(permanentlyRejectedRelayIds);
  const reconciliationRequired = normalizeReconciliationRequiredRelayIds(reconciliationRequiredRelayIds);
  const requirements = normalizeReconciliationRequirements(reconciliationRequirements);
  if (targets.some(relayId => rejections.includes(relayId))) {
    throw new Error('A selected placement target cannot also be permanently rejected');
  }
  if (reconciliationRequired.some(relayId => !targets.includes(relayId))) {
    throw new Error('A reconciliation target must remain selected');
  }
  if (requirements.some(requirement => !reconciliationRequired.includes(requirement.relayId)
    || !targets.includes(requirement.relayId)
    || !receiptMatchesOperation(requirement.rejection, operation))) {
    throw new Error('Invalid reconciliation requirement');
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
    reconciliationRequirements: requirements,
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
    'reconciliationRequirements',
  ])) return false;
  const desiredReplicaCount = value.desiredReplicaCount;
  const minimumHealthyReplicaCount = value.minimumHealthyReplicaCount;
  const revision = value.revision;
  if (!Array.isArray(value.targetRelayIds)) return false;
  const targetRelayIds = value.targetRelayIds;
  const permanentlyRejectedRelayIds = value.permanentlyRejectedRelayIds ?? [];
  const reconciliationRequiredRelayIds = value.reconciliationRequiredRelayIds ?? [];
  const reconciliationRequirements = value.reconciliationRequirements ?? [];
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
    || reconciliationRequiredRelayIds.some(relayId => !targetRelayIds.includes(relayId))
    || !Array.isArray(reconciliationRequirements)
    || reconciliationRequirements.length > MAX_RECONCILIATION_REQUIRED_REPLICA_TARGETS
    || !isStrictlySorted(reconciliationRequirements.map(requirement => (
      isObject(requirement) && typeof requirement.relayId === 'string' ? requirement.relayId : ''
    )))
    || !reconciliationRequirements.every(isReplicaReconciliationRequirement)
    || reconciliationRequirements.some(requirement => (
      !reconciliationRequiredRelayIds.includes(requirement.relayId)
      || !targetRelayIds.includes(requirement.relayId)
      || !receiptMatchesReference(
        requirement.rejection,
        value.publicationId,
        value.operationSequence,
        value.operationKind,
        value.operationSignature,
      )
    ))) return false;
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
  private readonly inventory = new Map<string, Map<string, ReplicaInventoryObservation>>();

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
    reconciliationRequirements: ReplicaReconciliationRequirementV1[] = [],
  ): ReplicaPlacementIntentV1 | undefined {
    const current = this.intents.get(operation.publicationId);
    const normalizedTargets = normalizeRelayIds(targetRelayIds);
    const normalizedRejections = normalizePermanentlyRejectedRelayIds(permanentlyRejectedRelayIds);
    const normalizedReconciliationRequired = normalizeReconciliationRequiredRelayIds(
      reconciliationRequiredRelayIds,
    );
    const normalizedRequirements = normalizeReconciliationRequirements(reconciliationRequirements);
    if (current && placementMatchesOperation(current, operation)
      && sameTargets(current.targetRelayIds, normalizedTargets)
      && sameTargets(current.permanentlyRejectedRelayIds ?? [], normalizedRejections)
      && sameTargets(
        current.reconciliationRequiredRelayIds ?? [],
        normalizedReconciliationRequired,
      )
      && sameReconciliationRequirements(
        current.reconciliationRequirements ?? [],
        normalizedRequirements,
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
      normalizedRequirements,
    );
  }

  applyIntent(intent: ReplicaPlacementIntentV1): boolean {
    if (!verifyReplicaPlacementIntent(intent)) return false;
    if (this.localRelayId !== undefined && (intent.reconciliationRequirements ?? [])
      .some(requirement => requirement.rejection.senderRelayId !== this.localRelayId)) return false;
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

  reconciliationRequirementsFor(publicationId: string): ReplicaReconciliationRequirementV1[] {
    return copyReconciliationRequirements(
      this.intents.get(publicationId)?.reconciliationRequirements ?? [],
    );
  }

  retireIntentIfMatches(operation: PublicationOperation): boolean {
    const current = this.intents.get(operation.publicationId);
    if (!current || !placementMatchesOperation(current, operation)) return false;
    this.intents.delete(operation.publicationId);
    this.receipts.delete(operation.publicationId);
    this.inventory.delete(operation.publicationId);
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
      || (response.createdAt === current.createdAt
        && response.signature !== current.evidenceSignature);
  }

  recordInventoryResponse(response: RelayReplicaInventoryResponseV1): boolean {
    if (!this.canRecordInventoryResponse(response)) return false;
    let byRelay = this.inventory.get(response.publicationId);
    if (!byRelay) {
      byRelay = new Map();
      this.inventory.set(response.publicationId, byRelay);
    }
    byRelay.set(response.responderRelayId, {
      status: response.status,
      createdAt: response.createdAt,
      evidenceSignature: response.signature,
    });
    return true;
  }

  /**
   * Records a target-signed bitmap only for durability receipts that still
   * belong to the current local placement generation. The batch cannot create
   * evidence for an arbitrary publication because every bit is bound to a
   * receipt previously signed by the responding target.
   */
  recordInventoryBatchResponse(response: RelayReplicaInventoryBatchResponseV1): number {
    if (!verifyRelayReplicaInventoryBatchResponseV1(response)
      || response.status !== 'inventory'
      || (this.localRelayId !== undefined && response.senderRelayId !== this.localRelayId)) {
      return 0;
    }
    const presence = decodeRelayReplicaInventoryBatchPresenceV1(response);
    const receiptsBySignature = new Map<string, RelayReplicaReceiptV1>();
    for (const receipts of this.receipts.values()) {
      for (const receipt of receipts.values()) {
        if (receipt.senderRelayId === response.senderRelayId
          && receipt.responderRelayId === response.responderRelayId) {
          receiptsBySignature.set(receipt.signature, receipt);
        }
      }
    }

    let recorded = 0;
    for (const [index, receiptSignature] of response.receiptSignatures.entries()) {
      const receipt = receiptsBySignature.get(receiptSignature);
      if (!receipt || response.createdAt < receipt.createdAt) continue;
      const intent = this.intents.get(receipt.publicationId);
      if (!intent
        || (intent.reconciliationRequiredRelayIds ?? []).length > 0
        || intent.operationSequence !== receipt.operationSequence
        || intent.operationKind !== receipt.operationKind
        || intent.operationSignature !== receipt.operationSignature
        || !intent.targetRelayIds.includes(response.responderRelayId)) continue;
      const current = this.inventory.get(receipt.publicationId)?.get(response.responderRelayId);
      if (current
        && (response.createdAt < current.createdAt
          || (response.createdAt === current.createdAt
            && response.signature === current.evidenceSignature))) continue;
      let byRelay = this.inventory.get(receipt.publicationId);
      if (!byRelay) {
        byRelay = new Map();
        this.inventory.set(receipt.publicationId, byRelay);
      }
      byRelay.set(response.responderRelayId, {
        status: presence[index] ? 'present' : 'missing',
        createdAt: response.createdAt,
        evidenceSignature: response.signature,
      });
      recorded++;
    }
    return recorded;
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

/**
 * Limits durable, target-authorized state reads without starving later
 * quarantined publications when many volunteers are temporarily unavailable.
 */
export class ReplicaReconciliationScheduler {
  private cursor: string | undefined;
  private readonly attempts = new Map<string, {
    attempts: number;
    nextEligibleAt: number;
  }>();

  constructor(
    private readonly initialRetryDelayMs = 1_000,
    private readonly maximumRetryDelayMs = 5 * 60_000,
  ) {
    if (!Number.isSafeInteger(initialRetryDelayMs) || initialRetryDelayMs < 1
      || !Number.isSafeInteger(maximumRetryDelayMs) || maximumRetryDelayMs < initialRetryDelayMs) {
      throw new Error('Invalid replica reconciliation retry delays');
    }
  }

  take(
    requirements: readonly ReplicaReconciliationRequirementV1[],
    limit: number,
    now = Date.now(),
  ): ReplicaReconciliationRequirementV1[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Replica reconciliation batch limit must be a positive integer');
    }
    if (!isTimestamp(now)) throw new Error('Invalid replica reconciliation time');
    const copiedRequirements = copyReconciliationRequirements(requirements);
    const activeAttemptKeys = new Set(copiedRequirements.map(reconciliationRequirementAttemptKey));
    for (const key of this.attempts.keys()) {
      if (!activeAttemptKeys.has(key)) this.attempts.delete(key);
    }
    const ordered = copiedRequirements.filter(requirement => {
      const attempt = this.attempts.get(reconciliationRequirementAttemptKey(requirement));
      return attempt === undefined || attempt.nextEligibleAt <= now;
    }).sort((first, second) => (
      reconciliationRequirementKey(first).localeCompare(reconciliationRequirementKey(second))
    ));
    if (ordered.length === 0) return [];
    const cursor = this.cursor;
    const firstAfterCursor = cursor === undefined
      ? 0
      : ordered.findIndex(requirement => reconciliationRequirementKey(requirement) > cursor);
    const start = firstAfterCursor === -1 ? 0 : firstAfterCursor;
    const count = Math.min(limit, ordered.length);
    const selected = Array.from({ length: count }, (_, index) => (
      ordered[(start + index) % ordered.length]
    ));
    this.cursor = reconciliationRequirementKey(selected[selected.length - 1]);
    for (const requirement of selected) {
      const key = reconciliationRequirementAttemptKey(requirement);
      const previousAttempts = this.attempts.get(key)?.attempts ?? 0;
      const attempts = previousAttempts + 1;
      const delay = Math.min(
        this.maximumRetryDelayMs,
        this.initialRetryDelayMs * 2 ** Math.min(previousAttempts, 30),
      );
      this.attempts.set(key, { attempts, nextEligibleAt: now + delay });
    }
    return copyReconciliationRequirements(selected);
  }
}

function compareOperationReference(
  first: ReplicaPlacementIntentV1,
  second: ReplicaPlacementIntentV1,
): number {
  if (first.operationKind === 'publication-tombstone'
    && second.operationKind !== 'publication-tombstone') return 1;
  if (first.operationKind !== 'publication-tombstone'
    && second.operationKind === 'publication-tombstone') return -1;
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

function normalizeReconciliationRequirements(
  values: ReplicaReconciliationRequirementV1[],
): ReplicaReconciliationRequirementV1[] {
  if (!Array.isArray(values) || values.length > MAX_RECONCILIATION_REQUIRED_REPLICA_TARGETS) {
    throw new Error('Invalid reconciliation requirements');
  }
  if (!values.every(isReplicaReconciliationRequirement)) {
    throw new Error('Invalid reconciliation requirements');
  }
  const normalized = values.map(requirement => ({
    relayId: requirement.relayId,
    rejection: { ...requirement.rejection },
  })).sort((first, second) => first.relayId.localeCompare(second.relayId));
  if (!isStrictlySorted(normalized.map(requirement => requirement.relayId))) {
    throw new Error('Invalid reconciliation requirements');
  }
  return normalized;
}

function isReplicaReconciliationRequirement(
  value: unknown,
): value is ReplicaReconciliationRequirementV1 {
  return isObject(value)
    && hasRequiredAndOptionalKeys(value, ['rejection', 'relayId'], [])
    && isRelayId(value.relayId)
    && isRelayReplicaReconciliationReceiptV1(value.rejection)
    && value.relayId === value.rejection.responderRelayId;
}

function receiptMatchesOperation(
  receipt: RelayReplicaReceiptV1,
  operation: PublicationOperation,
): boolean {
  return receiptMatchesReference(
    receipt,
    operation.publicationId,
    operation.sequence,
    operation.kind,
    operation.signature,
  );
}

function receiptMatchesReference(
  receipt: RelayReplicaReceiptV1,
  publicationId: unknown,
  sequence: unknown,
  kind: unknown,
  signature: unknown,
): boolean {
  return receipt.publicationId === publicationId
    && receipt.operationSequence === sequence
    && receipt.operationKind === kind
    && receipt.operationSignature === signature;
}

function copyIntent(value: ReplicaPlacementIntentV1): ReplicaPlacementIntentV1 {
  return {
    ...value,
    targetRelayIds: [...value.targetRelayIds],
    permanentlyRejectedRelayIds: [...(value.permanentlyRejectedRelayIds ?? [])],
    reconciliationRequiredRelayIds: [...(value.reconciliationRequiredRelayIds ?? [])],
    reconciliationRequirements: copyReconciliationRequirements(value.reconciliationRequirements ?? []),
  };
}

function copyReconciliationRequirements(
  values: readonly ReplicaReconciliationRequirementV1[],
): ReplicaReconciliationRequirementV1[] {
  return values.map(requirement => ({
    relayId: requirement.relayId,
    rejection: { ...requirement.rejection },
  }));
}

function sameTargets(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function sameReconciliationRequirements(
  first: readonly ReplicaReconciliationRequirementV1[],
  second: readonly ReplicaReconciliationRequirementV1[],
): boolean {
  return first.length === second.length && first.every((value, index) => (
    value.relayId === second[index]?.relayId
    && value.rejection.signature === second[index]?.rejection.signature
  ));
}

function inventoryReceiptKey(receipt: RelayReplicaReceiptV1): string {
  return `${receipt.publicationId}\u0000${receipt.responderRelayId}`;
}

function reconciliationRequirementKey(requirement: ReplicaReconciliationRequirementV1): string {
  return `${requirement.rejection.publicationId}\u0000${requirement.relayId}`;
}

function reconciliationRequirementAttemptKey(requirement: ReplicaReconciliationRequirementV1): string {
  return `${reconciliationRequirementKey(requirement)}\u0000${requirement.rejection.signature}`;
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
