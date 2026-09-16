/** Signed publication replica placement and durability receipts for relay links. */

import {
  decodeBase64,
  decodeUTF8,
  didToPublicKey,
  encodeBase64,
  generateSigningKeyPair,
  publicKeyToDid,
  sign,
  verify,
  type Identity,
} from './crypto.js';
import {
  verifyPublicationOperation,
  type PublicationOperation,
} from './protocol-v2.js';
import { MAX_RELAY_DISCOVERY_FRAME_BYTES } from './relay-discovery.js';

export const RELAY_REPLICATION_VERSION = 1 as const;
export const RELAY_REPLICA_PUT_FRAME_TYPE = 'relay_replica_put' as const;
export const RELAY_REPLICA_RECEIPT_FRAME_TYPE = 'relay_replica_receipt' as const;
export const RELAY_REPLICA_INVENTORY_REQUEST_FRAME_TYPE = 'relay_replica_inventory_request' as const;
export const RELAY_REPLICA_INVENTORY_RESPONSE_FRAME_TYPE = 'relay_replica_inventory_response' as const;
export const RELAY_REPLICA_RECONCILIATION_REQUEST_FRAME_TYPE = 'relay_replica_reconciliation_request' as const;
export const RELAY_REPLICA_RECONCILIATION_RESPONSE_FRAME_TYPE = 'relay_replica_reconciliation_response' as const;
export const MAX_RELAY_REPLICA_REQUEST_LIFETIME_MS = 60_000;

const PUT_DOMAIN = 'resonance:relay-replication:v1:put';
const RECEIPT_DOMAIN = 'resonance:relay-replication:v1:receipt';
const INVENTORY_REQUEST_DOMAIN = 'resonance:relay-replication:v1:inventory-request';
const INVENTORY_RESPONSE_DOMAIN = 'resonance:relay-replication:v1:inventory-response';
const RECONCILIATION_REQUEST_DOMAIN = 'resonance:relay-replication:v1:reconciliation-request';
const RECONCILIATION_RESPONSE_DOMAIN = 'resonance:relay-replication:v1:reconciliation-response';
const PUT_BODY_KEYS = [
  'createdAt',
  'expiresAt',
  'kind',
  'operation',
  'requestId',
  'senderRelayId',
  'version',
] as const;
const PUT_KEYS = [...PUT_BODY_KEYS, 'signature'] as const;
const RECEIPT_BODY_KEYS = [
  'createdAt',
  'kind',
  'operationKind',
  'operationSequence',
  'operationSignature',
  'publicationId',
  'reason',
  'requestId',
  'responderRelayId',
  'senderRelayId',
  'status',
  'version',
] as const;
const RECEIPT_KEYS = [...RECEIPT_BODY_KEYS, 'signature'] as const;
const INVENTORY_REQUEST_BODY_KEYS = [
  'createdAt',
  'expiresAt',
  'kind',
  'receipt',
  'requestId',
  'senderRelayId',
  'targetRelayId',
  'version',
] as const;
const INVENTORY_REQUEST_KEYS = [...INVENTORY_REQUEST_BODY_KEYS, 'signature'] as const;
const INVENTORY_RESPONSE_BODY_KEYS = [
  'createdAt',
  'kind',
  'operationKind',
  'operationSequence',
  'operationSignature',
  'publicationId',
  'reason',
  'requestId',
  'responderRelayId',
  'senderRelayId',
  'status',
  'version',
] as const;
const INVENTORY_RESPONSE_KEYS = [...INVENTORY_RESPONSE_BODY_KEYS, 'signature'] as const;
const RECONCILIATION_REQUEST_BODY_KEYS = [
  'createdAt',
  'expiresAt',
  'kind',
  'receipt',
  'requestId',
  'senderRelayId',
  'targetRelayId',
  'version',
] as const;
const RECONCILIATION_REQUEST_KEYS = [...RECONCILIATION_REQUEST_BODY_KEYS, 'signature'] as const;
const RECONCILIATION_RESPONSE_BODY_KEYS = [
  'createdAt',
  'kind',
  'operation',
  'publicationId',
  'reason',
  'rejectionRequestId',
  'rejectionSignature',
  'requestId',
  'responderRelayId',
  'senderRelayId',
  'status',
  'version',
] as const;
const RECONCILIATION_RESPONSE_KEYS = [...RECONCILIATION_RESPONSE_BODY_KEYS, 'signature'] as const;

export type RelayReplicaReceiptStatusV1 = 'stored' | 'already-stored' | 'rejected';
export type RelayReplicaInventoryStatusV1 = 'present' | 'missing' | 'rejected';
export type RelayReplicaReconciliationStatusV1 = 'operation' | 'missing' | 'rejected';
export type RelayReplicaRejectionReasonV1 =
  | 'expired'
  | 'unsupported-group'
  | 'capacity-exhausted'
  | 'rate-limited'
  | 'stale'
  | 'conflict'
  | 'terminal'
  | 'invalid'
  | 'persistence-failed';
export type RelayReplicaInventoryRejectionReasonV1 = 'rate-limited';
export type RelayReplicaReconciliationRejectionReasonV1 = 'rate-limited';

export interface RelayReplicaPutBodyV1 {
  version: typeof RELAY_REPLICATION_VERSION;
  kind: 'relay-replica-put';
  requestId: string;
  senderRelayId: string;
  operation: PublicationOperation;
  createdAt: number;
  expiresAt: number;
}

export interface RelayReplicaPutV1 extends RelayReplicaPutBodyV1 {
  signature: string;
}

export interface RelayReplicaReceiptBodyV1 {
  version: typeof RELAY_REPLICATION_VERSION;
  kind: 'relay-replica-receipt';
  requestId: string;
  senderRelayId: string;
  responderRelayId: string;
  publicationId: string;
  operationSequence: number;
  operationKind: PublicationOperation['kind'];
  operationSignature: string;
  status: RelayReplicaReceiptStatusV1;
  reason: RelayReplicaRejectionReasonV1 | null;
  createdAt: number;
}

export interface RelayReplicaReceiptV1 extends RelayReplicaReceiptBodyV1 {
  signature: string;
}

/**
 * A receipt-authorized point check for one exact replica. Carrying the
 * target's own past receipt prevents an authenticated link from becoming a
 * general publication-presence oracle.
 */
export interface RelayReplicaInventoryRequestBodyV1 {
  version: typeof RELAY_REPLICATION_VERSION;
  kind: 'relay-replica-inventory-request';
  requestId: string;
  senderRelayId: string;
  targetRelayId: string;
  receipt: RelayReplicaReceiptV1;
  createdAt: number;
  expiresAt: number;
}

export interface RelayReplicaInventoryRequestV1 extends RelayReplicaInventoryRequestBodyV1 {
  signature: string;
}

export interface RelayReplicaInventoryResponseBodyV1 {
  version: typeof RELAY_REPLICATION_VERSION;
  kind: 'relay-replica-inventory-response';
  requestId: string;
  senderRelayId: string;
  responderRelayId: string;
  publicationId: string;
  operationSequence: number;
  operationKind: PublicationOperation['kind'];
  operationSignature: string;
  status: RelayReplicaInventoryStatusV1;
  reason: RelayReplicaInventoryRejectionReasonV1 | null;
  createdAt: number;
}

export interface RelayReplicaInventoryResponseV1 extends RelayReplicaInventoryResponseBodyV1 {
  signature: string;
}

/**
 * A state request is authorized by a target-signed rejection for the same
 * exact operation. This keeps reconciliation from becoming a publication
 * lookup API for authenticated relays.
 */
export interface RelayReplicaReconciliationRequestBodyV1 {
  version: typeof RELAY_REPLICATION_VERSION;
  kind: 'relay-replica-reconciliation-request';
  requestId: string;
  senderRelayId: string;
  targetRelayId: string;
  receipt: RelayReplicaReceiptV1;
  createdAt: number;
  expiresAt: number;
}

export interface RelayReplicaReconciliationRequestV1
  extends RelayReplicaReconciliationRequestBodyV1 {
  signature: string;
}

/**
 * A target-signed answer for one prior reconciliation refusal. `operation`
 * is the target's current owner-signed state, never an inferred summary.
 */
export interface RelayReplicaReconciliationResponseBodyV1 {
  version: typeof RELAY_REPLICATION_VERSION;
  kind: 'relay-replica-reconciliation-response';
  requestId: string;
  senderRelayId: string;
  responderRelayId: string;
  publicationId: string;
  rejectionRequestId: string;
  rejectionSignature: string;
  status: RelayReplicaReconciliationStatusV1;
  operation: PublicationOperation | null;
  reason: RelayReplicaReconciliationRejectionReasonV1 | null;
  createdAt: number;
}

export interface RelayReplicaReconciliationResponseV1
  extends RelayReplicaReconciliationResponseBodyV1 {
  signature: string;
}

export interface RelayReplicaPutFrameV1 {
  type: typeof RELAY_REPLICA_PUT_FRAME_TYPE;
  request: RelayReplicaPutV1;
}

export interface RelayReplicaReceiptFrameV1 {
  type: typeof RELAY_REPLICA_RECEIPT_FRAME_TYPE;
  receipt: RelayReplicaReceiptV1;
}

export interface RelayReplicaInventoryRequestFrameV1 {
  type: typeof RELAY_REPLICA_INVENTORY_REQUEST_FRAME_TYPE;
  request: RelayReplicaInventoryRequestV1;
}

export interface RelayReplicaInventoryResponseFrameV1 {
  type: typeof RELAY_REPLICA_INVENTORY_RESPONSE_FRAME_TYPE;
  response: RelayReplicaInventoryResponseV1;
}

export interface RelayReplicaReconciliationRequestFrameV1 {
  type: typeof RELAY_REPLICA_RECONCILIATION_REQUEST_FRAME_TYPE;
  request: RelayReplicaReconciliationRequestV1;
}

export interface RelayReplicaReconciliationResponseFrameV1 {
  type: typeof RELAY_REPLICA_RECONCILIATION_RESPONSE_FRAME_TYPE;
  response: RelayReplicaReconciliationResponseV1;
}

export function createRelayReplicaPutV1(
  operation: PublicationOperation,
  identity: Identity,
  createdAt = Date.now(),
  expiresAt = createdAt + 30_000,
): RelayReplicaPutV1 {
  const body: RelayReplicaPutBodyV1 = {
    version: RELAY_REPLICATION_VERSION,
    kind: 'relay-replica-put',
    requestId: opaqueRequestId(generateSigningKeyPair().publicKey),
    senderRelayId: identity.did,
    operation,
    createdAt,
    expiresAt,
  };
  if (!isRelayReplicaPutBody(body) || !identityMatches(identity)) {
    throw new Error('Invalid replica placement input');
  }
  return {
    ...body,
    signature: encodeBase64(sign(signable(PUT_DOMAIN, body), identity.secretKey)),
  };
}

export function verifyRelayReplicaPutV1(value: unknown): value is RelayReplicaPutV1 {
  if (!isObject(value) || !hasOnlyKeys(value, PUT_KEYS)) return false;
  const { signature, ...body } = value;
  if (!isCanonicalBase64(signature, 64) || !isRelayReplicaPutBody(body)) return false;
  try {
    return verify(signable(PUT_DOMAIN, body), decodeBase64(signature), didToPublicKey(body.senderRelayId));
  } catch {
    return false;
  }
}

export function isRelayReplicaPutActiveV1(value: unknown, now: number): value is RelayReplicaPutV1 {
  return isTimestamp(now)
    && verifyRelayReplicaPutV1(value)
    && now >= value.createdAt
    && now < value.expiresAt;
}

export function createRelayReplicaReceiptV1(
  request: RelayReplicaPutV1,
  identity: Identity,
  result: {
    status: RelayReplicaReceiptStatusV1;
    reason?: RelayReplicaRejectionReasonV1;
  },
  createdAt = Date.now(),
): RelayReplicaReceiptV1 {
  const operation = request.operation;
  const body: RelayReplicaReceiptBodyV1 = {
    version: RELAY_REPLICATION_VERSION,
    kind: 'relay-replica-receipt',
    requestId: request.requestId,
    senderRelayId: request.senderRelayId,
    responderRelayId: identity.did,
    publicationId: operation.publicationId,
    operationSequence: operation.sequence,
    operationKind: operation.kind,
    operationSignature: operation.signature,
    status: result.status,
    reason: result.reason ?? null,
    createdAt,
  };
  if (!isRelayReplicaPutActiveV1(request, createdAt)
    || !isRelayReplicaReceiptBody(body)
    || !identityMatches(identity)) {
    throw new Error('Invalid replica receipt input');
  }
  return {
    ...body,
    signature: encodeBase64(sign(signable(RECEIPT_DOMAIN, body), identity.secretKey)),
  };
}

export function verifyRelayReplicaReceiptV1(
  value: unknown,
  request?: RelayReplicaPutV1,
): value is RelayReplicaReceiptV1 {
  if (!isObject(value) || !hasOnlyKeys(value, RECEIPT_KEYS)) return false;
  const { signature, ...body } = value;
  if (!isCanonicalBase64(signature, 64) || !isRelayReplicaReceiptBody(body)) return false;
  if (request !== undefined && (!verifyRelayReplicaPutV1(request)
    || body.requestId !== request.requestId
    || body.senderRelayId !== request.senderRelayId
    || body.publicationId !== request.operation.publicationId
    || body.operationSequence !== request.operation.sequence
    || body.operationKind !== request.operation.kind
    || body.operationSignature !== request.operation.signature
    || body.createdAt < request.createdAt
    || body.createdAt >= request.expiresAt)) return false;
  try {
    return verify(
      signable(RECEIPT_DOMAIN, body),
      decodeBase64(signature),
      didToPublicKey(body.responderRelayId),
    );
  } catch {
    return false;
  }
}

export function isDurabilityReceiptV1(value: unknown): value is RelayReplicaReceiptV1 {
  return verifyRelayReplicaReceiptV1(value)
    && (value.status === 'stored' || value.status === 'already-stored');
}

/**
 * Only these state-evaluation refusals authorize a target to disclose its
 * current owner-signed operation. Capacity and admission failures do not.
 */
export function isRelayReplicaReconciliationReceiptV1(
  value: unknown,
): value is RelayReplicaReceiptV1 {
  return verifyRelayReplicaReceiptV1(value)
    && value.status === 'rejected'
    && (value.reason === 'stale' || value.reason === 'conflict' || value.reason === 'terminal');
}

export function createRelayReplicaInventoryRequestV1(
  receipt: RelayReplicaReceiptV1,
  identity: Identity,
  createdAt = Date.now(),
  expiresAt = createdAt + 30_000,
): RelayReplicaInventoryRequestV1 {
  const body: RelayReplicaInventoryRequestBodyV1 = {
    version: RELAY_REPLICATION_VERSION,
    kind: 'relay-replica-inventory-request',
    requestId: opaqueRequestId(generateSigningKeyPair().publicKey, 'rri'),
    senderRelayId: identity.did,
    targetRelayId: receipt.responderRelayId,
    receipt,
    createdAt,
    expiresAt,
  };
  if (!isRelayReplicaInventoryRequestBody(body) || !identityMatches(identity)) {
    throw new Error('Invalid replica inventory request input');
  }
  return {
    ...body,
    signature: encodeBase64(sign(signable(INVENTORY_REQUEST_DOMAIN, body), identity.secretKey)),
  };
}

export function verifyRelayReplicaInventoryRequestV1(
  value: unknown,
): value is RelayReplicaInventoryRequestV1 {
  if (!isObject(value) || !hasOnlyKeys(value, INVENTORY_REQUEST_KEYS)) return false;
  const { signature, ...body } = value;
  if (!isCanonicalBase64(signature, 64) || !isRelayReplicaInventoryRequestBody(body)) return false;
  try {
    return verify(
      signable(INVENTORY_REQUEST_DOMAIN, body),
      decodeBase64(signature),
      didToPublicKey(body.senderRelayId),
    );
  } catch {
    return false;
  }
}

export function isRelayReplicaInventoryRequestActiveV1(
  value: unknown,
  now: number,
): value is RelayReplicaInventoryRequestV1 {
  return isTimestamp(now)
    && verifyRelayReplicaInventoryRequestV1(value)
    && now >= value.createdAt
    && now < value.expiresAt;
}

export function createRelayReplicaInventoryResponseV1(
  request: RelayReplicaInventoryRequestV1,
  identity: Identity,
  result: {
    status: RelayReplicaInventoryStatusV1;
    reason?: RelayReplicaInventoryRejectionReasonV1;
  },
  createdAt = Date.now(),
): RelayReplicaInventoryResponseV1 {
  const receipt = request.receipt;
  const body: RelayReplicaInventoryResponseBodyV1 = {
    version: RELAY_REPLICATION_VERSION,
    kind: 'relay-replica-inventory-response',
    requestId: request.requestId,
    senderRelayId: request.senderRelayId,
    responderRelayId: identity.did,
    publicationId: receipt.publicationId,
    operationSequence: receipt.operationSequence,
    operationKind: receipt.operationKind,
    operationSignature: receipt.operationSignature,
    status: result.status,
    reason: result.reason ?? null,
    createdAt,
  };
  if (!isRelayReplicaInventoryRequestActiveV1(request, createdAt)
    || request.targetRelayId !== identity.did
    || !isRelayReplicaInventoryResponseBody(body)
    || !identityMatches(identity)) {
    throw new Error('Invalid replica inventory response input');
  }
  return {
    ...body,
    signature: encodeBase64(sign(signable(INVENTORY_RESPONSE_DOMAIN, body), identity.secretKey)),
  };
}

export function verifyRelayReplicaInventoryResponseV1(
  value: unknown,
  request?: RelayReplicaInventoryRequestV1,
): value is RelayReplicaInventoryResponseV1 {
  if (!isObject(value) || !hasOnlyKeys(value, INVENTORY_RESPONSE_KEYS)) return false;
  const { signature, ...body } = value;
  if (!isCanonicalBase64(signature, 64) || !isRelayReplicaInventoryResponseBody(body)) return false;
  if (request !== undefined && (!verifyRelayReplicaInventoryRequestV1(request)
    || body.requestId !== request.requestId
    || body.senderRelayId !== request.senderRelayId
    || body.responderRelayId !== request.targetRelayId
    || body.publicationId !== request.receipt.publicationId
    || body.operationSequence !== request.receipt.operationSequence
    || body.operationKind !== request.receipt.operationKind
    || body.operationSignature !== request.receipt.operationSignature
    || body.createdAt < request.createdAt
    || body.createdAt >= request.expiresAt)) return false;
  try {
    return verify(
      signable(INVENTORY_RESPONSE_DOMAIN, body),
      decodeBase64(signature),
      didToPublicKey(body.responderRelayId),
    );
  } catch {
    return false;
  }
}

export function createRelayReplicaReconciliationRequestV1(
  receipt: RelayReplicaReceiptV1,
  identity: Identity,
  createdAt = Date.now(),
  expiresAt = createdAt + 30_000,
): RelayReplicaReconciliationRequestV1 {
  const body: RelayReplicaReconciliationRequestBodyV1 = {
    version: RELAY_REPLICATION_VERSION,
    kind: 'relay-replica-reconciliation-request',
    requestId: opaqueRequestId(generateSigningKeyPair().publicKey, 'rrc'),
    senderRelayId: identity.did,
    targetRelayId: receipt.responderRelayId,
    receipt,
    createdAt,
    expiresAt,
  };
  if (!isRelayReplicaReconciliationRequestBody(body) || !identityMatches(identity)) {
    throw new Error('Invalid replica reconciliation request input');
  }
  return {
    ...body,
    signature: encodeBase64(sign(signable(RECONCILIATION_REQUEST_DOMAIN, body), identity.secretKey)),
  };
}

export function verifyRelayReplicaReconciliationRequestV1(
  value: unknown,
): value is RelayReplicaReconciliationRequestV1 {
  if (!isObject(value) || !hasOnlyKeys(value, RECONCILIATION_REQUEST_KEYS)) return false;
  const { signature, ...body } = value;
  if (!isCanonicalBase64(signature, 64) || !isRelayReplicaReconciliationRequestBody(body)) return false;
  try {
    return verify(
      signable(RECONCILIATION_REQUEST_DOMAIN, body),
      decodeBase64(signature),
      didToPublicKey(body.senderRelayId),
    );
  } catch {
    return false;
  }
}

export function isRelayReplicaReconciliationRequestActiveV1(
  value: unknown,
  now: number,
): value is RelayReplicaReconciliationRequestV1 {
  return isTimestamp(now)
    && verifyRelayReplicaReconciliationRequestV1(value)
    && now >= value.createdAt
    && now < value.expiresAt;
}

export function createRelayReplicaReconciliationResponseV1(
  request: RelayReplicaReconciliationRequestV1,
  identity: Identity,
  result: {
    status: RelayReplicaReconciliationStatusV1;
    operation?: PublicationOperation;
    reason?: RelayReplicaReconciliationRejectionReasonV1;
  },
  createdAt = Date.now(),
): RelayReplicaReconciliationResponseV1 {
  const body: RelayReplicaReconciliationResponseBodyV1 = {
    version: RELAY_REPLICATION_VERSION,
    kind: 'relay-replica-reconciliation-response',
    requestId: request.requestId,
    senderRelayId: request.senderRelayId,
    responderRelayId: identity.did,
    publicationId: request.receipt.publicationId,
    rejectionRequestId: request.receipt.requestId,
    rejectionSignature: request.receipt.signature,
    status: result.status,
    operation: result.operation ?? null,
    reason: result.reason ?? null,
    createdAt,
  };
  if (!isRelayReplicaReconciliationRequestActiveV1(request, createdAt)
    || request.targetRelayId !== identity.did
    || !isRelayReplicaReconciliationResponseBody(body)
    || !identityMatches(identity)) {
    throw new Error('Invalid replica reconciliation response input');
  }
  return {
    ...body,
    signature: encodeBase64(sign(signable(RECONCILIATION_RESPONSE_DOMAIN, body), identity.secretKey)),
  };
}

export function verifyRelayReplicaReconciliationResponseV1(
  value: unknown,
  request?: RelayReplicaReconciliationRequestV1,
): value is RelayReplicaReconciliationResponseV1 {
  if (!isObject(value) || !hasOnlyKeys(value, RECONCILIATION_RESPONSE_KEYS)) return false;
  const { signature, ...body } = value;
  if (!isCanonicalBase64(signature, 64) || !isRelayReplicaReconciliationResponseBody(body)) return false;
  if (request !== undefined && (!verifyRelayReplicaReconciliationRequestV1(request)
    || body.requestId !== request.requestId
    || body.senderRelayId !== request.senderRelayId
    || body.responderRelayId !== request.targetRelayId
    || body.publicationId !== request.receipt.publicationId
    || body.rejectionRequestId !== request.receipt.requestId
    || body.rejectionSignature !== request.receipt.signature
    || body.createdAt < request.createdAt
    || body.createdAt >= request.expiresAt)) return false;
  try {
    return verify(
      signable(RECONCILIATION_RESPONSE_DOMAIN, body),
      decodeBase64(signature),
      didToPublicKey(body.responderRelayId),
    );
  } catch {
    return false;
  }
}

export function createRelayReplicaPutFrameV1(request: RelayReplicaPutV1): RelayReplicaPutFrameV1 {
  if (!verifyRelayReplicaPutV1(request)) throw new Error('Cannot frame an invalid replica placement');
  return { type: RELAY_REPLICA_PUT_FRAME_TYPE, request };
}

export function createRelayReplicaReceiptFrameV1(
  receipt: RelayReplicaReceiptV1,
): RelayReplicaReceiptFrameV1 {
  if (!verifyRelayReplicaReceiptV1(receipt)) throw new Error('Cannot frame an invalid replica receipt');
  return { type: RELAY_REPLICA_RECEIPT_FRAME_TYPE, receipt };
}

export function createRelayReplicaInventoryRequestFrameV1(
  request: RelayReplicaInventoryRequestV1,
): RelayReplicaInventoryRequestFrameV1 {
  if (!verifyRelayReplicaInventoryRequestV1(request)) {
    throw new Error('Cannot frame an invalid replica inventory request');
  }
  return { type: RELAY_REPLICA_INVENTORY_REQUEST_FRAME_TYPE, request };
}

export function createRelayReplicaInventoryResponseFrameV1(
  response: RelayReplicaInventoryResponseV1,
): RelayReplicaInventoryResponseFrameV1 {
  if (!verifyRelayReplicaInventoryResponseV1(response)) {
    throw new Error('Cannot frame an invalid replica inventory response');
  }
  return { type: RELAY_REPLICA_INVENTORY_RESPONSE_FRAME_TYPE, response };
}

export function createRelayReplicaReconciliationRequestFrameV1(
  request: RelayReplicaReconciliationRequestV1,
): RelayReplicaReconciliationRequestFrameV1 {
  if (!verifyRelayReplicaReconciliationRequestV1(request)) {
    throw new Error('Cannot frame an invalid replica reconciliation request');
  }
  return { type: RELAY_REPLICA_RECONCILIATION_REQUEST_FRAME_TYPE, request };
}

export function createRelayReplicaReconciliationResponseFrameV1(
  response: RelayReplicaReconciliationResponseV1,
): RelayReplicaReconciliationResponseFrameV1 {
  if (!verifyRelayReplicaReconciliationResponseV1(response)) {
    throw new Error('Cannot frame an invalid replica reconciliation response');
  }
  return { type: RELAY_REPLICA_RECONCILIATION_RESPONSE_FRAME_TYPE, response };
}

export function serializeRelayReplicaPutFrameV1(frame: RelayReplicaPutFrameV1): string {
  if (frame.type !== RELAY_REPLICA_PUT_FRAME_TYPE || !verifyRelayReplicaPutV1(frame.request)) {
    throw new Error('Invalid replica placement frame');
  }
  return serializeBounded(frame);
}

export function serializeRelayReplicaReceiptFrameV1(frame: RelayReplicaReceiptFrameV1): string {
  if (frame.type !== RELAY_REPLICA_RECEIPT_FRAME_TYPE || !verifyRelayReplicaReceiptV1(frame.receipt)) {
    throw new Error('Invalid replica receipt frame');
  }
  return serializeBounded(frame);
}

export function serializeRelayReplicaInventoryRequestFrameV1(
  frame: RelayReplicaInventoryRequestFrameV1,
): string {
  if (frame.type !== RELAY_REPLICA_INVENTORY_REQUEST_FRAME_TYPE
    || !verifyRelayReplicaInventoryRequestV1(frame.request)) {
    throw new Error('Invalid replica inventory request frame');
  }
  return serializeBounded(frame);
}

export function serializeRelayReplicaInventoryResponseFrameV1(
  frame: RelayReplicaInventoryResponseFrameV1,
): string {
  if (frame.type !== RELAY_REPLICA_INVENTORY_RESPONSE_FRAME_TYPE
    || !verifyRelayReplicaInventoryResponseV1(frame.response)) {
    throw new Error('Invalid replica inventory response frame');
  }
  return serializeBounded(frame);
}

export function serializeRelayReplicaReconciliationRequestFrameV1(
  frame: RelayReplicaReconciliationRequestFrameV1,
): string {
  if (frame.type !== RELAY_REPLICA_RECONCILIATION_REQUEST_FRAME_TYPE
    || !verifyRelayReplicaReconciliationRequestV1(frame.request)) {
    throw new Error('Invalid replica reconciliation request frame');
  }
  return serializeBounded(frame);
}

export function serializeRelayReplicaReconciliationResponseFrameV1(
  frame: RelayReplicaReconciliationResponseFrameV1,
): string {
  if (frame.type !== RELAY_REPLICA_RECONCILIATION_RESPONSE_FRAME_TYPE
    || !verifyRelayReplicaReconciliationResponseV1(frame.response)) {
    throw new Error('Invalid replica reconciliation response frame');
  }
  return serializeBounded(frame);
}

export function parseRelayReplicaPutFrameV1(raw: string): RelayReplicaPutFrameV1 {
  const parsed = parseBounded(raw);
  if (!isObject(parsed)
    || !hasOnlyKeys(parsed, ['request', 'type'])
    || parsed.type !== RELAY_REPLICA_PUT_FRAME_TYPE
    || !verifyRelayReplicaPutV1(parsed.request)) {
    throw new Error('Invalid replica placement frame');
  }
  return parsed as unknown as RelayReplicaPutFrameV1;
}

export function parseRelayReplicaReceiptFrameV1(raw: string): RelayReplicaReceiptFrameV1 {
  const parsed = parseBounded(raw);
  if (!isObject(parsed)
    || !hasOnlyKeys(parsed, ['receipt', 'type'])
    || parsed.type !== RELAY_REPLICA_RECEIPT_FRAME_TYPE
    || !verifyRelayReplicaReceiptV1(parsed.receipt)) {
    throw new Error('Invalid replica receipt frame');
  }
  return parsed as unknown as RelayReplicaReceiptFrameV1;
}

export function parseRelayReplicaInventoryRequestFrameV1(raw: string): RelayReplicaInventoryRequestFrameV1 {
  const parsed = parseBounded(raw);
  if (!isObject(parsed)
    || !hasOnlyKeys(parsed, ['request', 'type'])
    || parsed.type !== RELAY_REPLICA_INVENTORY_REQUEST_FRAME_TYPE
    || !verifyRelayReplicaInventoryRequestV1(parsed.request)) {
    throw new Error('Invalid replica inventory request frame');
  }
  return parsed as unknown as RelayReplicaInventoryRequestFrameV1;
}

export function parseRelayReplicaInventoryResponseFrameV1(raw: string): RelayReplicaInventoryResponseFrameV1 {
  const parsed = parseBounded(raw);
  if (!isObject(parsed)
    || !hasOnlyKeys(parsed, ['response', 'type'])
    || parsed.type !== RELAY_REPLICA_INVENTORY_RESPONSE_FRAME_TYPE
    || !verifyRelayReplicaInventoryResponseV1(parsed.response)) {
    throw new Error('Invalid replica inventory response frame');
  }
  return parsed as unknown as RelayReplicaInventoryResponseFrameV1;
}

export function parseRelayReplicaReconciliationRequestFrameV1(
  raw: string,
): RelayReplicaReconciliationRequestFrameV1 {
  const parsed = parseBounded(raw);
  if (!isObject(parsed)
    || !hasOnlyKeys(parsed, ['request', 'type'])
    || parsed.type !== RELAY_REPLICA_RECONCILIATION_REQUEST_FRAME_TYPE
    || !verifyRelayReplicaReconciliationRequestV1(parsed.request)) {
    throw new Error('Invalid replica reconciliation request frame');
  }
  return parsed as unknown as RelayReplicaReconciliationRequestFrameV1;
}

export function parseRelayReplicaReconciliationResponseFrameV1(
  raw: string,
): RelayReplicaReconciliationResponseFrameV1 {
  const parsed = parseBounded(raw);
  if (!isObject(parsed)
    || !hasOnlyKeys(parsed, ['response', 'type'])
    || parsed.type !== RELAY_REPLICA_RECONCILIATION_RESPONSE_FRAME_TYPE
    || !verifyRelayReplicaReconciliationResponseV1(parsed.response)) {
    throw new Error('Invalid replica reconciliation response frame');
  }
  return parsed as unknown as RelayReplicaReconciliationResponseFrameV1;
}

function isRelayReplicaPutBody(value: unknown): value is RelayReplicaPutBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value, PUT_BODY_KEYS)) return false;
  if (value.version !== RELAY_REPLICATION_VERSION || value.kind !== 'relay-replica-put') return false;
  if (!isOpaqueRequestId(value.requestId) || !isRelayId(value.senderRelayId)) return false;
  if (!verifyPublicationOperation(value.operation)) return false;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt)) return false;
  return value.expiresAt > value.createdAt
    && value.expiresAt - value.createdAt <= MAX_RELAY_REPLICA_REQUEST_LIFETIME_MS;
}

function isRelayReplicaReceiptBody(value: unknown): value is RelayReplicaReceiptBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value, RECEIPT_BODY_KEYS)) return false;
  if (value.version !== RELAY_REPLICATION_VERSION || value.kind !== 'relay-replica-receipt') return false;
  if (!isOpaqueRequestId(value.requestId)
    || !isRelayId(value.senderRelayId)
    || !isRelayId(value.responderRelayId)) return false;
  if (typeof value.publicationId !== 'string' || !/^pub_[A-Za-z0-9_-]{43}$/.test(value.publicationId)) return false;
  if (!Number.isSafeInteger(value.operationSequence) || (value.operationSequence as number) < 0) return false;
  if (value.operationKind !== 'publication' && value.operationKind !== 'publication-tombstone') return false;
  if (!isCanonicalBase64(value.operationSignature, 64)) return false;
  if (value.status !== 'stored' && value.status !== 'already-stored' && value.status !== 'rejected') return false;
  if (value.status === 'rejected') {
    if (!isRejectionReason(value.reason)) return false;
  } else if (value.reason !== null) return false;
  return isTimestamp(value.createdAt);
}

function isRelayReplicaInventoryRequestBody(
  value: unknown,
): value is RelayReplicaInventoryRequestBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value, INVENTORY_REQUEST_BODY_KEYS)) return false;
  if (value.version !== RELAY_REPLICATION_VERSION || value.kind !== 'relay-replica-inventory-request') {
    return false;
  }
  if (!isOpaqueRequestId(value.requestId, 'rri')
    || !isRelayId(value.senderRelayId)
    || !isRelayId(value.targetRelayId)
    || !isDurabilityReceiptV1(value.receipt)
    || !isTimestamp(value.createdAt)
    || !isTimestamp(value.expiresAt)) return false;
  return value.receipt.senderRelayId === value.senderRelayId
    && value.receipt.responderRelayId === value.targetRelayId
    && value.expiresAt > value.createdAt
    && value.expiresAt - value.createdAt <= MAX_RELAY_REPLICA_REQUEST_LIFETIME_MS;
}

function isRelayReplicaInventoryResponseBody(
  value: unknown,
): value is RelayReplicaInventoryResponseBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value, INVENTORY_RESPONSE_BODY_KEYS)) return false;
  if (value.version !== RELAY_REPLICATION_VERSION || value.kind !== 'relay-replica-inventory-response') {
    return false;
  }
  if (!isOpaqueRequestId(value.requestId, 'rri')
    || !isRelayId(value.senderRelayId)
    || !isRelayId(value.responderRelayId)) return false;
  if (typeof value.publicationId !== 'string' || !/^pub_[A-Za-z0-9_-]{43}$/.test(value.publicationId)) return false;
  if (!Number.isSafeInteger(value.operationSequence) || (value.operationSequence as number) < 0) return false;
  if (value.operationKind !== 'publication' && value.operationKind !== 'publication-tombstone') return false;
  if (!isCanonicalBase64(value.operationSignature, 64) || !isInventoryStatus(value.status)) return false;
  if (value.status === 'rejected') {
    if (value.reason !== 'rate-limited') return false;
  } else if (value.reason !== null) return false;
  return isTimestamp(value.createdAt);
}

function isRelayReplicaReconciliationRequestBody(
  value: unknown,
): value is RelayReplicaReconciliationRequestBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value, RECONCILIATION_REQUEST_BODY_KEYS)) return false;
  if (value.version !== RELAY_REPLICATION_VERSION
    || value.kind !== 'relay-replica-reconciliation-request') return false;
  if (!isOpaqueRequestId(value.requestId, 'rrc')
    || !isRelayId(value.senderRelayId)
    || !isRelayId(value.targetRelayId)
    || !isRelayReplicaReconciliationReceiptV1(value.receipt)
    || !isTimestamp(value.createdAt)
    || !isTimestamp(value.expiresAt)) return false;
  return value.receipt.senderRelayId === value.senderRelayId
    && value.receipt.responderRelayId === value.targetRelayId
    && value.expiresAt > value.createdAt
    && value.expiresAt - value.createdAt <= MAX_RELAY_REPLICA_REQUEST_LIFETIME_MS;
}

function isRelayReplicaReconciliationResponseBody(
  value: unknown,
): value is RelayReplicaReconciliationResponseBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value, RECONCILIATION_RESPONSE_BODY_KEYS)) return false;
  if (value.version !== RELAY_REPLICATION_VERSION
    || value.kind !== 'relay-replica-reconciliation-response') return false;
  if (!isOpaqueRequestId(value.requestId, 'rrc')
    || !isRelayId(value.senderRelayId)
    || !isRelayId(value.responderRelayId)
    || !isOpaqueRequestId(value.rejectionRequestId)
    || !isCanonicalBase64(value.rejectionSignature, 64)
    || typeof value.publicationId !== 'string'
    || !/^pub_[A-Za-z0-9_-]{43}$/.test(value.publicationId)
    || !isReconciliationStatus(value.status)
    || !isTimestamp(value.createdAt)) return false;
  if (value.status === 'operation') {
    return value.reason === null
      && verifyPublicationOperation(value.operation)
      && value.operation.publicationId === value.publicationId;
  }
  if (value.operation !== null) return false;
  if (value.status === 'rejected') return value.reason === 'rate-limited';
  return value.reason === null;
}

function isRejectionReason(value: unknown): value is RelayReplicaRejectionReasonV1 {
  return value === 'expired'
    || value === 'unsupported-group'
    || value === 'capacity-exhausted'
    || value === 'rate-limited'
    || value === 'stale'
    || value === 'conflict'
    || value === 'terminal'
    || value === 'invalid'
    || value === 'persistence-failed';
}

function isInventoryStatus(value: unknown): value is RelayReplicaInventoryStatusV1 {
  return value === 'present' || value === 'missing' || value === 'rejected';
}

function isReconciliationStatus(value: unknown): value is RelayReplicaReconciliationStatusV1 {
  return value === 'operation' || value === 'missing' || value === 'rejected';
}

function identityMatches(identity: Identity): boolean {
  return identity.publicKey.length === 32
    && identity.secretKey.length === 64
    && identity.did === publicKeyToDid(identity.publicKey)
    && equalBytes(identity.secretKey.subarray(32), identity.publicKey);
}

function opaqueRequestId(bytes: Uint8Array, prefix = 'rrq'): string {
  return `${prefix}_${encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function isOpaqueRequestId(value: unknown, prefix = 'rrq'): value is string {
  return typeof value === 'string'
    && new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(value);
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

function signable(domain: string, body: object): Uint8Array {
  return decodeUTF8(`${domain}\n${canonicalize(body)}`);
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
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new Error(`Cannot canonicalize ${typeof value}`);
}

function serializeBounded(
  value:
    | RelayReplicaPutFrameV1
    | RelayReplicaReceiptFrameV1
    | RelayReplicaInventoryRequestFrameV1
    | RelayReplicaInventoryResponseFrameV1
    | RelayReplicaReconciliationRequestFrameV1
    | RelayReplicaReconciliationResponseFrameV1,
): string {
  const raw = JSON.stringify(value);
  if (decodeUTF8(raw).length > MAX_RELAY_DISCOVERY_FRAME_BYTES) {
    throw new Error('Relay replication frame exceeds the maximum size');
  }
  return raw;
}

function parseBounded(raw: string): unknown {
  if (typeof raw !== 'string' || decodeUTF8(raw).length > MAX_RELAY_DISCOVERY_FRAME_BYTES) {
    throw new Error('Relay replication frame exceeds the maximum size');
  }
  return JSON.parse(raw) as unknown;
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

function equalBytes(first: Uint8Array, second: Uint8Array): boolean {
  return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
