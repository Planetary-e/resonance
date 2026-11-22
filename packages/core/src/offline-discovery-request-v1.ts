import { timingSafeEqual } from 'node:crypto';
import {
  decodeBase64,
  decodeUTF8,
  encodeBase64,
  sha512,
  sign,
  verify,
  type SigningKeyPair,
} from './crypto.js';
import {
  createLeasedIndexGenerationIdV1,
  isLeasedIndexActiveV1,
  verifyLeasedIndexV1,
  type LeasedIndexV1,
} from './leased-index-v1.js';

export const OFFLINE_DISCOVERY_REQUEST_V1_VERSION = 1 as const;
export const OFFLINE_DISCOVERY_REQUEST_KIND = 'offline-discovery-request' as const;
export const MAX_OFFLINE_DISCOVERY_REQUEST_BYTES = 4096;
export const MAX_OFFLINE_DISCOVERY_STORED_ENVELOPE_BYTES = 16 * 1024;
export const MAX_OFFLINE_DISCOVERY_REQUEST_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export const OFFLINE_DISCOVERY_MAX_LOGICAL_REQUESTS = 16;
export const OFFLINE_DISCOVERY_MAX_INCLUSIVE_BYTES = 4 * 1024 * 1024;
export const OFFLINE_DISCOVERY_REQUEST_RESERVE = Object.freeze({
  activeAndDrainingEnvelopesAndAcks: 40_960,
  depositAndAckJournals: 114_688,
  admissionAndReplay: 12_288,
  recipientAndStorageDedup: 1_024,
  activeAndDrainingAuthentication: 12_288,
  conflictAndQuarantine: 20_480,
  replicaReceipts: 5_120,
  temporaryMetadata: 16_384,
});
export const OFFLINE_DISCOVERY_FIXED_RESERVE = Object.freeze({
  withdrawalTombstone: 8_192,
  quotaSnapshots: 32_768,
  antiEntropyAndCompaction: 8_192,
  leaseAndWriterMetadata: 4_096,
});
export const OFFLINE_DISCOVERY_REQUEST_RESERVE_BYTES = 223_232;
export const OFFLINE_DISCOVERY_FIXED_RESERVE_BYTES = 53_248;
export const OFFLINE_DISCOVERY_MODELED_PEAK_BYTES = 3_624_960;
export const OFFLINE_DISCOVERY_HEADROOM_BYTES = 569_344;

const REQUEST_SIGNATURE_DOMAIN = 'resonance:offline-discovery-request:v1';
const REQUEST_ID_DOMAIN = 'resonance:offline-discovery-request-id:v1';
const ENVELOPE_ID_DOMAIN = 'resonance:offline-discovery-envelope:v1';
const ACK_ID_DOMAIN = 'resonance:offline-discovery-ack:v1';
const STABLE_BODY_KEYS = [
  'clientLeaseId',
  'createdAt',
  'expiresAt',
  'kind',
  'payload',
  'replyCapability',
  'requestNonce',
  'senderRequestKey',
  'version',
];
const BODY_KEYS = [
  ...STABLE_BODY_KEYS,
  'generationId',
  'leaseSequence',
  'mailboxEncryptionKey',
  'mailboxId',
  'publicationId',
  'requestId',
  'semanticRevision',
];
const OPTIONAL_LINK_KEYS = ['previousEnvelopeId', 'previousGenerationId'];

export interface OfflineDiscoveryRequestStableBodyV1 {
  version: typeof OFFLINE_DISCOVERY_REQUEST_V1_VERSION;
  kind: typeof OFFLINE_DISCOVERY_REQUEST_KIND;
  requestNonce: string;
  createdAt: number;
  expiresAt: number;
  senderRequestKey: string;
  clientLeaseId: string;
  payload: string;
  replyCapability: string;
}

export interface OfflineDiscoveryRequestBodyV1 extends OfflineDiscoveryRequestStableBodyV1 {
  requestId: string;
  publicationId: string;
  leaseSequence: number;
  semanticRevision: number;
  generationId: string;
  mailboxId: string;
  mailboxEncryptionKey: string;
  previousGenerationId?: string;
  previousEnvelopeId?: string;
}

export interface OfflineDiscoveryRequestV1 extends OfflineDiscoveryRequestBodyV1 {
  signature: string;
}

export interface CreateOfflineDiscoveryRequestInputV1 {
  requestNonce: Uint8Array;
  createdAt: number;
  expiresAt: number;
  payload: string;
  replyCapability: string;
  previousGenerationId?: string;
  previousEnvelopeId?: string;
}

export interface OfflineDiscoveryReplicaKeyV1 {
  clientLeaseId: string;
  mailboxId: string;
  generationId: string;
  envelopeId: string;
}

export type OfflineDiscoveryReplayStatusV1 =
  | 'stored'
  | 'duplicate'
  | 'conflicting_request'
  | 'not_yet_valid'
  | 'expired';

export interface OfflineDiscoveryReplayResultV1 {
  status: OfflineDiscoveryReplayStatusV1;
  requestId: string;
  replicaKey: OfflineDiscoveryReplicaKeyV1;
  retainedBytes: number;
  conflictBytes?: Uint8Array;
}

interface RetainedOfflineRequest {
  bytes: Uint8Array;
  conflictBytes?: Uint8Array;
}

export interface OfflineDiscoveryQuotaLimitsV1 {
  maxLogicalRequests: number;
  maxInclusiveBytes: number;
}

export interface OfflineDiscoveryQuotaAdmissionV1 {
  requestId: string;
  replayBytes: Uint8Array;
  actualBytes: number;
  ackIds: readonly string[];
  generationId?: string;
}

export interface OfflineDiscoveryQuotaGenerationV1 {
  requestId: string;
  generationId: string;
  ackId: string;
  replayBytes: Uint8Array;
  actualBytes: number;
}

export interface OfflineDiscoveryQuotaSnapshotV1 extends OfflineDiscoveryQuotaLimitsV1 {
  logicalRequests: number;
  reservedBytes: number;
  actualBytes: number;
  availableReservedBytes: number;
  availableActualBytes: number;
  headroomBytes: number;
}

export type OfflineDiscoveryQuotaAdmissionStatusV1 =
  | 'admitted'
  | 'duplicate'
  | 'conflict'
  | 'request_limit'
  | 'byte_limit'
  | 'drain_required'
  | 'unknown_request';

export interface OfflineDiscoveryQuotaAdmissionResultV1 {
  status: OfflineDiscoveryQuotaAdmissionStatusV1;
  snapshot: OfflineDiscoveryQuotaSnapshotV1;
}

export interface OfflineDiscoveryMaintenanceResultV1 {
  status: 'acknowledged' | 'duplicate' | 'withdrawn' | 'unknown_ack' | 'unknown_request';
  snapshot: OfflineDiscoveryQuotaSnapshotV1;
}

interface QuotaGenerationRecord {
  generationId: string;
  ackId: string;
  replayBytes: Uint8Array;
  actualBytes: number;
}

interface QuotaConflictRecord {
  generationId: string;
  replayBytes: Uint8Array;
}

interface QuotaReservation {
  replayBytes: Uint8Array;
  actualBytes: number;
  ackIds: string[];
  acknowledgedAckIds: Set<string>;
  withdrawn: boolean;
  generations: QuotaGenerationRecord[];
  conflicts: QuotaConflictRecord[];
}

export function createOfflineDiscoveryRequestV1(
  input: CreateOfflineDiscoveryRequestInputV1,
  index: LeasedIndexV1,
  sender: SigningKeyPair,
): OfflineDiscoveryRequestV1 {
  if (!verifyLeasedIndexV1(index) || !(input.requestNonce instanceof Uint8Array)) {
    throw new Error('Invalid offline discovery request input');
  }
  const stableBody: OfflineDiscoveryRequestStableBodyV1 = {
    version: OFFLINE_DISCOVERY_REQUEST_V1_VERSION,
    kind: OFFLINE_DISCOVERY_REQUEST_KIND,
    requestNonce: encodeBase64(input.requestNonce),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    senderRequestKey: encodeBase64(sender.publicKey),
    clientLeaseId: index.clientLeaseId,
    payload: input.payload,
    replyCapability: input.replyCapability,
  };
  const body: OfflineDiscoveryRequestBodyV1 = {
    ...stableBody,
    requestId: createOfflineDiscoveryRequestIdV1(stableBody),
    publicationId: index.publicationId,
    leaseSequence: index.leaseSequence,
    semanticRevision: index.semanticRevision,
    generationId: createLeasedIndexGenerationIdV1(index),
    mailboxId: index.mailbox.id,
    mailboxEncryptionKey: index.mailbox.encryptionKey,
    ...(input.previousGenerationId !== undefined || input.previousEnvelopeId !== undefined ? {
      previousGenerationId: input.previousGenerationId,
      previousEnvelopeId: input.previousEnvelopeId,
    } : {}),
  };
  if (!isOfflineDiscoveryRequestBody(body)) throw new Error('Invalid offline discovery request input');
  const request = {
    ...body,
    signature: encodeBase64(sign(signableRequest(body), sender.secretKey)),
  };
  if (serializedSize(request) > MAX_OFFLINE_DISCOVERY_REQUEST_BYTES) {
    throw new Error('Offline discovery request exceeds size limit');
  }
  return request;
}

export function createOfflineDiscoveryRequestIdV1(
  stableBody: OfflineDiscoveryRequestStableBodyV1,
): string {
  if (!isStableBody(stableBody)) throw new Error('Invalid offline discovery stable body');
  return derivedId('oreq', `${REQUEST_ID_DOMAIN}\n${canonicalize(stableBody)}`);
}

export function verifyOfflineDiscoveryRequestV1(value: unknown): value is OfflineDiscoveryRequestV1 {
  if (!isObject(value)) return false;
  const hasPrevious = 'previousGenerationId' in value || 'previousEnvelopeId' in value;
  if (!hasOnlyKeys(value, [...BODY_KEYS, ...(hasPrevious ? OPTIONAL_LINK_KEYS : []), 'signature'])) return false;
  const { signature, ...body } = value;
  if (typeof signature !== 'string' || !isBase64OfLength(signature, 64)
    || !isOfflineDiscoveryRequestBody(body)) return false;
  try {
    return verify(
      signableRequest(body),
      decodeBase64(signature),
      decodeBase64(body.senderRequestKey),
    ) && serializedSize(value) <= MAX_OFFLINE_DISCOVERY_REQUEST_BYTES;
  } catch {
    return false;
  }
}

export function verifyOfflineDiscoveryRequestAgainstIndexV1(
  request: OfflineDiscoveryRequestV1,
  index: LeasedIndexV1,
  now: number,
): boolean {
  return verifyOfflineDiscoveryRequestV1(request)
    && isLeasedIndexActiveV1(index, now)
    && isOfflineDiscoveryRequestActiveV1(request, now)
    && request.publicationId === index.publicationId
    && request.clientLeaseId === index.clientLeaseId
    && request.leaseSequence === index.leaseSequence
    && request.semanticRevision === index.semanticRevision
    && request.generationId === createLeasedIndexGenerationIdV1(index)
    && request.mailboxId === index.mailbox.id
    && request.mailboxEncryptionKey === index.mailbox.encryptionKey;
}

export function isOfflineDiscoveryRequestActiveV1(
  request: OfflineDiscoveryRequestV1,
  now: number,
): boolean {
  return isTimestamp(now)
    && verifyOfflineDiscoveryRequestV1(request)
    && now >= request.createdAt
    && now < request.expiresAt;
}

export function serializeOfflineDiscoveryRequestV1(request: OfflineDiscoveryRequestV1): string {
  if (!verifyOfflineDiscoveryRequestV1(request)) {
    throw new Error('Cannot serialize an invalid offline discovery request');
  }
  return canonicalize(request);
}

export function parseOfflineDiscoveryRequestV1(raw: string): OfflineDiscoveryRequestV1 {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_OFFLINE_DISCOVERY_REQUEST_BYTES) {
    throw new Error('Invalid offline discovery request');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Invalid offline discovery request'); }
  if (!verifyOfflineDiscoveryRequestV1(parsed)) throw new Error('Invalid offline discovery request');
  return parsed;
}

export function createOfflineDiscoveryEnvelopeIdV1(
  request: OfflineDiscoveryRequestV1,
): string {
  if (!verifyOfflineDiscoveryRequestV1(request)) throw new Error('Invalid offline discovery request');
  return envelopeIdFromParts(
    request.clientLeaseId,
    request.mailboxId,
    request.generationId,
    request.requestId,
  );
}

export function createOfflineDiscoveryReplicaKeyV1(
  request: OfflineDiscoveryRequestV1,
): OfflineDiscoveryReplicaKeyV1 {
  return {
    clientLeaseId: request.clientLeaseId,
    mailboxId: request.mailboxId,
    generationId: request.generationId,
    envelopeId: createOfflineDiscoveryEnvelopeIdV1(request),
  };
}

export function createOfflineDiscoveryAckIdV1(request: OfflineDiscoveryRequestV1): string {
  return createOfflineDiscoveryAckIdForReplicaKeyV1(createOfflineDiscoveryReplicaKeyV1(request));
}

export function createOfflineDiscoveryAckIdForReplicaKeyV1(
  replicaKey: OfflineDiscoveryReplicaKeyV1,
): string {
  return derivedId('oack', `${ACK_ID_DOMAIN}\n${canonicalize(replicaKey)}`);
}

export class OfflineDiscoveryRequestReplayV1 {
  private readonly records = new Map<string, RetainedOfflineRequest>();
  private retainedBytes = 0;

  submit(raw: string | Uint8Array, now: number): OfflineDiscoveryReplayResultV1 {
    const bytes = exactBytes(raw);
    const request = parseOfflineDiscoveryRequestV1(encodeUTF8Fatal(bytes));
    const replicaKey = createOfflineDiscoveryReplicaKeyV1(request);
    const key = canonicalize(replicaKey);
    const prior = this.records.get(key);
    const base = {
      requestId: request.requestId,
      replicaKey,
      retainedBytes: this.retainedBytes,
    };
    if (prior && bytesEqual(prior.bytes, bytes)) return { ...base, status: 'duplicate' };
    if (prior?.conflictBytes && bytesEqual(prior.conflictBytes, bytes)) {
      return {
        ...base,
        status: 'conflicting_request',
        conflictBytes: Uint8Array.from(prior.conflictBytes),
      };
    }
    if (!isTimestamp(now) || now < request.createdAt || now >= request.expiresAt) {
      return {
        ...base,
        status: isTimestamp(now) && now < request.createdAt ? 'not_yet_valid' : 'expired',
      };
    }
    if (prior) {
      if (!prior.conflictBytes) {
        prior.conflictBytes = Uint8Array.from(bytes);
        this.retainedBytes += bytes.byteLength;
      }
      return {
        ...base,
        status: 'conflicting_request',
        retainedBytes: this.retainedBytes,
        conflictBytes: Uint8Array.from(prior.conflictBytes),
      };
    }
    this.records.set(key, { bytes: Uint8Array.from(bytes) });
    this.retainedBytes += bytes.byteLength;
    return { ...base, status: 'stored', retainedBytes: this.retainedBytes };
  }

  get sizeBytes(): number {
    return this.retainedBytes;
  }
}

export class OfflineDiscoveryQuotaLedgerV1 {
  private readonly reservations = new Map<string, QuotaReservation>();
  private readonly ackOwners = new Map<string, string>();
  private limits: OfflineDiscoveryQuotaLimitsV1;
  private reservedBytes = OFFLINE_DISCOVERY_FIXED_RESERVE_BYTES;
  private actualBytes = OFFLINE_DISCOVERY_FIXED_RESERVE_BYTES;

  constructor(limits: OfflineDiscoveryQuotaLimitsV1 = {
    maxLogicalRequests: OFFLINE_DISCOVERY_MAX_LOGICAL_REQUESTS,
    maxInclusiveBytes: OFFLINE_DISCOVERY_MAX_INCLUSIVE_BYTES,
  }) {
    validateLimits(limits);
    if (limits.maxInclusiveBytes < OFFLINE_DISCOVERY_FIXED_RESERVE_BYTES) {
      throw new Error('Quota is below fixed accepted obligations');
    }
    this.limits = { ...limits };
  }

  checkAdmission(input: OfflineDiscoveryQuotaAdmissionV1): OfflineDiscoveryQuotaAdmissionResultV1 {
    validateAdmission(input);
    const prior = this.reservations.get(input.requestId);
    if (prior) {
      if (input.generationId !== undefined) {
        const generation = prior.generations.find(item => item.generationId === input.generationId);
        if (generation) {
          const duplicate = generation.actualBytes === input.actualBytes
            && generation.ackId === input.ackIds[0]
            && bytesEqual(generation.replayBytes, input.replayBytes);
          return { status: duplicate ? 'duplicate' : 'conflict', snapshot: this.snapshot() };
        }
      }
      const duplicate = bytesEqual(prior.replayBytes, input.replayBytes)
        && prior.actualBytes === input.actualBytes
        && sameStrings(prior.ackIds, input.ackIds);
      return { status: duplicate ? 'duplicate' : 'conflict', snapshot: this.snapshot() };
    }
    if (this.reservations.size >= this.limits.maxLogicalRequests) {
      return { status: 'request_limit', snapshot: this.snapshot() };
    }
    if (this.reservedBytes + OFFLINE_DISCOVERY_REQUEST_RESERVE_BYTES > this.limits.maxInclusiveBytes
      || this.actualBytes + input.actualBytes > this.limits.maxInclusiveBytes) {
      return { status: 'byte_limit', snapshot: this.snapshot() };
    }
    return { status: 'admitted', snapshot: this.snapshot() };
  }

  admit(input: OfflineDiscoveryQuotaAdmissionV1): OfflineDiscoveryQuotaAdmissionResultV1 {
    const checked = this.checkAdmission(input);
    if (checked.status !== 'admitted') return checked;
    const replayBytes = Uint8Array.from(input.replayBytes);
    const ackIds = [...input.ackIds];
    const generations = input.generationId === undefined ? [] : [{
      generationId: input.generationId,
      ackId: ackIds[0],
      replayBytes,
      actualBytes: input.actualBytes,
    }];
    this.reservations.set(input.requestId, {
      replayBytes,
      actualBytes: input.actualBytes,
      ackIds,
      acknowledgedAckIds: new Set(),
      withdrawn: false,
      generations,
      conflicts: [],
    });
    for (const ackId of ackIds) this.ackOwners.set(ackId, input.requestId);
    this.reservedBytes += OFFLINE_DISCOVERY_REQUEST_RESERVE_BYTES;
    this.actualBytes += input.actualBytes;
    return { status: 'admitted', snapshot: this.snapshot() };
  }

  checkRedeposit(input: OfflineDiscoveryQuotaGenerationV1): OfflineDiscoveryQuotaAdmissionResultV1 {
    validateGeneration(input);
    const prior = this.reservations.get(input.requestId);
    if (!prior) return { status: 'unknown_request', snapshot: this.snapshot() };
    const generation = prior.generations.find(item => item.generationId === input.generationId);
    if (generation) {
      const duplicate = generation.ackId === input.ackId
        && generation.actualBytes === input.actualBytes
        && bytesEqual(generation.replayBytes, input.replayBytes);
      return { status: duplicate ? 'duplicate' : 'conflict', snapshot: this.snapshot() };
    }
    const active = prior.generations.filter(item => !prior.acknowledgedAckIds.has(item.ackId)).length;
    if (active >= 2) return { status: 'drain_required', snapshot: this.snapshot() };
    if (this.actualBytes + input.actualBytes > this.limits.maxInclusiveBytes) {
      return { status: 'byte_limit', snapshot: this.snapshot() };
    }
    return { status: 'admitted', snapshot: this.snapshot() };
  }

  redeposit(input: OfflineDiscoveryQuotaGenerationV1): OfflineDiscoveryQuotaAdmissionResultV1 {
    const checked = this.checkRedeposit(input);
    if (checked.status !== 'admitted') return checked;
    const prior = this.reservations.get(input.requestId)!;
    prior.generations.push({
      generationId: input.generationId,
      ackId: input.ackId,
      replayBytes: Uint8Array.from(input.replayBytes),
      actualBytes: input.actualBytes,
    });
    prior.ackIds.push(input.ackId);
    this.ackOwners.set(input.ackId, input.requestId);
    this.actualBytes += input.actualBytes;
    return { status: 'admitted', snapshot: this.snapshot() };
  }

  chargeConflict(input: OfflineDiscoveryQuotaGenerationV1): OfflineDiscoveryQuotaAdmissionResultV1 {
    validateGeneration(input);
    const prior = this.reservations.get(input.requestId);
    if (!prior) return { status: 'unknown_request', snapshot: this.snapshot() };
    if (!prior.generations.some(item => item.generationId === input.generationId)) {
      return { status: 'unknown_request', snapshot: this.snapshot() };
    }
    const conflict = prior.conflicts.find(item => item.generationId === input.generationId);
    if (conflict) return { status: 'conflict', snapshot: this.snapshot() };
    if (this.actualBytes + input.actualBytes > this.limits.maxInclusiveBytes) {
      return { status: 'byte_limit', snapshot: this.snapshot() };
    }
    prior.conflicts.push({ generationId: input.generationId, replayBytes: Uint8Array.from(input.replayBytes) });
    this.actualBytes += input.actualBytes;
    return { status: 'conflict', snapshot: this.snapshot() };
  }

  acknowledge(ackId: string): OfflineDiscoveryMaintenanceResultV1 {
    if (!isOpaqueId(ackId, 'oack')) return { status: 'unknown_ack', snapshot: this.snapshot() };
    const owner = this.ackOwners.get(ackId);
    if (!owner) return { status: 'unknown_ack', snapshot: this.snapshot() };
    const reservation = this.reservations.get(owner)!;
    const duplicate = reservation.acknowledgedAckIds.has(ackId);
    reservation.acknowledgedAckIds.add(ackId);
    return { status: duplicate ? 'duplicate' : 'acknowledged', snapshot: this.snapshot() };
  }

  withdraw(requestId: string): OfflineDiscoveryMaintenanceResultV1 {
    if (!isOpaqueId(requestId, 'oreq')) {
      return { status: 'unknown_request', snapshot: this.snapshot() };
    }
    const reservation = this.reservations.get(requestId);
    if (!reservation) return { status: 'unknown_request', snapshot: this.snapshot() };
    const duplicate = reservation.withdrawn;
    reservation.withdrawn = true;
    return { status: duplicate ? 'duplicate' : 'withdrawn', snapshot: this.snapshot() };
  }

  setLimits(limits: OfflineDiscoveryQuotaLimitsV1): void {
    validateLimits(limits);
    if (limits.maxLogicalRequests < this.reservations.size
      || limits.maxInclusiveBytes < Math.max(this.reservedBytes, this.actualBytes)) {
      throw new Error('Cannot lower quota below accepted obligations');
    }
    this.limits = { ...limits };
  }

  snapshot(): OfflineDiscoveryQuotaSnapshotV1 {
    return {
      ...this.limits,
      logicalRequests: this.reservations.size,
      reservedBytes: this.reservedBytes,
      actualBytes: this.actualBytes,
      availableReservedBytes: this.limits.maxInclusiveBytes - this.reservedBytes,
      availableActualBytes: this.limits.maxInclusiveBytes - this.actualBytes,
      headroomBytes: this.limits.maxInclusiveBytes - Math.max(this.reservedBytes, this.actualBytes),
    };
  }
}

function isStableBody(value: unknown): value is OfflineDiscoveryRequestStableBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value, STABLE_BODY_KEYS)) return false;
  return value.version === OFFLINE_DISCOVERY_REQUEST_V1_VERSION
    && value.kind === OFFLINE_DISCOVERY_REQUEST_KIND
    && isBase64OfLength(value.requestNonce, 16)
    && isTimestamp(value.createdAt)
    && isTimestamp(value.expiresAt)
    && value.expiresAt > value.createdAt
    && value.expiresAt - value.createdAt <= MAX_OFFLINE_DISCOVERY_REQUEST_LIFETIME_MS
    && isBase64OfLength(value.senderRequestKey, 32)
    && isOpaqueId(value.clientLeaseId, 'lease')
    && isBoundedPayload(value.payload)
    && isBoundedReplyCapability(value.replyCapability);
}

function isOfflineDiscoveryRequestBody(value: unknown): value is OfflineDiscoveryRequestBodyV1 {
  if (!isObject(value)) return false;
  const hasPrevious = 'previousGenerationId' in value || 'previousEnvelopeId' in value;
  if (!hasOnlyKeys(value, [...BODY_KEYS, ...(hasPrevious ? OPTIONAL_LINK_KEYS : [])])) return false;
  const stableBody: Record<string, unknown> = {};
  for (const key of STABLE_BODY_KEYS) stableBody[key] = value[key];
  if (!isStableBody(stableBody)
    || typeof value.clientLeaseId !== 'string'
    || typeof value.requestId !== 'string'
    || value.requestId !== createOfflineDiscoveryRequestIdV1(stableBody)
    || !isOpaqueId(value.publicationId, 'pub')
    || !isSafeCounter(value.leaseSequence)
    || !isSafeCounter(value.semanticRevision)
    || !isOpaqueId(value.generationId, 'gen')
    || !isOpaqueId(value.mailboxId, 'mbx')
    || !isBase64OfLength(value.mailboxEncryptionKey, 32)
    || !idMatchesKey(value.mailboxId, value.mailboxEncryptionKey)) return false;
  if (!hasPrevious) return true;
  if (!isOpaqueId(value.previousGenerationId, 'gen')
    || !isOpaqueId(value.previousEnvelopeId, 'env')
    || value.previousGenerationId === value.generationId) return false;
  return value.previousEnvelopeId === envelopeIdFromParts(
    value.clientLeaseId,
    value.mailboxId,
    value.previousGenerationId,
    value.requestId,
  );
}

function signableRequest(body: OfflineDiscoveryRequestBodyV1): Uint8Array {
  return decodeUTF8(`${REQUEST_SIGNATURE_DOMAIN}\n${canonicalize(body)}`);
}

function envelopeIdFromParts(
  clientLeaseId: string,
  mailboxId: string,
  generationId: string,
  requestId: string,
): string {
  return derivedId('env', `${ENVELOPE_ID_DOMAIN}\n${canonicalize([
    clientLeaseId,
    mailboxId,
    generationId,
    requestId,
  ])}`);
}

function validateLimits(limits: OfflineDiscoveryQuotaLimitsV1): void {
  if (!isObject(limits)
    || !hasOnlyKeys(limits, ['maxInclusiveBytes', 'maxLogicalRequests'])
    || !Number.isSafeInteger(limits.maxLogicalRequests)
    || limits.maxLogicalRequests < 0
    || limits.maxLogicalRequests > OFFLINE_DISCOVERY_MAX_LOGICAL_REQUESTS
    || !Number.isSafeInteger(limits.maxInclusiveBytes)
    || limits.maxInclusiveBytes < 0
    || limits.maxInclusiveBytes > OFFLINE_DISCOVERY_MAX_INCLUSIVE_BYTES) {
    throw new Error('Invalid offline discovery quota limits');
  }
}

function validateAdmission(input: OfflineDiscoveryQuotaAdmissionV1): void {
  if (!isObject(input)
    || !hasOnlyKeys(input, [
      'ackIds', 'actualBytes', 'replayBytes', 'requestId',
      ...(input.generationId !== undefined ? ['generationId'] : []),
    ])
    || (input.generationId !== undefined && (!isOpaqueId(input.generationId, 'gen') || input.ackIds.length !== 1))
    || !isOpaqueId(input.requestId, 'oreq')
    || !(input.replayBytes instanceof Uint8Array)
    || input.replayBytes.byteLength === 0
    || input.replayBytes.byteLength > MAX_OFFLINE_DISCOVERY_STORED_ENVELOPE_BYTES
    || !Number.isSafeInteger(input.actualBytes)
    || input.actualBytes < 0
    || !Array.isArray(input.ackIds)
    || input.ackIds.length < 1
    || input.ackIds.length > 2
    || !input.ackIds.every((id) => isOpaqueId(id, 'oack'))
    || new Set(input.ackIds).size !== input.ackIds.length) {
    throw new Error('Invalid offline discovery quota admission');
  }
}

function validateGeneration(input: OfflineDiscoveryQuotaGenerationV1): void {
  if (!isObject(input)
    || !hasOnlyKeys(input, ['ackId', 'actualBytes', 'generationId', 'replayBytes', 'requestId'])
    || !isOpaqueId(input.requestId, 'oreq')
    || !isOpaqueId(input.generationId, 'gen')
    || !isOpaqueId(input.ackId, 'oack')
    || !(input.replayBytes instanceof Uint8Array)
    || input.replayBytes.byteLength === 0
    || input.replayBytes.byteLength > MAX_OFFLINE_DISCOVERY_STORED_ENVELOPE_BYTES
    || !Number.isSafeInteger(input.actualBytes)
    || input.actualBytes < 0) throw new Error('Invalid offline discovery generation charge');
}

function sameStrings(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalize a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new Error(`Cannot canonicalize ${typeof value}`);
}

function serializedSize(value: unknown): number {
  return Buffer.byteLength(canonicalize(value));
}

function derivedId(prefix: 'oreq' | 'env' | 'oack', input: string): string {
  const digest = sha512(decodeUTF8(input));
  const bytes = prefix === 'env' ? digest : digest.slice(0, 32);
  return `${prefix}_${encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function idMatchesKey(id: string, encodedKey: string): boolean {
  try {
    const base64url = encodeBase64(decodeBase64(encodedKey))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return id === `mbx_${base64url}`;
  } catch {
    return false;
  }
}

function isOpaqueId(value: unknown, prefix: 'pub' | 'lease' | 'gen' | 'mbx' | 'oreq' | 'env' | 'oack'): value is string {
  const length = prefix === 'env' ? 86 : 43;
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{${length}}$`).test(value);
}

function isBase64OfLength(value: unknown, length: number): value is string {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  try { return decodeBase64(value).length === length && encodeBase64(decodeBase64(value)) === value; } catch { return false; }
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafeCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedPayload(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= 2048;
}

function isBoundedReplyCapability(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && Buffer.byteLength(value) <= 1024
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactBytes(raw: string | Uint8Array): Uint8Array {
  if (typeof raw === 'string') return decodeUTF8(raw);
  if (!(raw instanceof Uint8Array) || raw.byteLength > MAX_OFFLINE_DISCOVERY_REQUEST_BYTES) {
    throw new Error('Invalid offline discovery request');
  }
  return Uint8Array.from(raw);
}

function encodeUTF8Fatal(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
    throw new Error('Invalid offline discovery request');
  }
}

function bytesEqual(first: Uint8Array, second: Uint8Array): boolean {
  return first.byteLength === second.byteLength && timingSafeEqual(Buffer.from(first), Buffer.from(second));
}
