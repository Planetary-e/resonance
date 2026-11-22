import { randomBytes } from 'node:crypto';
import {
  decodeBase64,
  decodeUTF8,
  didToPublicKey,
  encodeBase64,
  sign,
  verify,
  type Identity,
  type SigningKeyPair,
} from './crypto.js';
import { verifyAdmissionCapabilityV2, type AdmissionCapabilityV2 } from './admission-v2.js';
import {
  createLeasedIndexGenerationIdV1,
  parseLeasedIndexOperationV1,
  verifyLeasedIndexV1,
  verifyLeasedIndexWithdrawalV1,
  type LeasedIndexKeyMaterialV1,
  type LeasedIndexV1,
} from './leased-index-v1.js';
import { parseOfflineDiscoveryDepositV1, parseOfflineDiscoveryAckV1 } from './offline-discovery-mailbox-v1.js';
import { parseContentChannelOperationV2 } from './content-delivery-v1.js';
import type { OfflineDiscoverySyncEventV1 } from './offline-discovery-mailbox-v1.js';
import type { RelationshipKeyMaterial } from './relationship-v2.js';

export const CLIENT_HELD_RESPONSE_MESSAGE_TYPE = 'client-held-response' as const;
export const MAX_CLIENT_HELD_RPC_BYTES = 262_144;
export const CLIENT_HELD_RPC_LIFETIME_MS = 60_000;

export const LEASED_INDEX_OPERATION_FRAME_TYPE = 'leased_index_operation' as const;
export const LEASED_INDEX_LOOKUP_FRAME_TYPE = 'leased_index_lookup' as const;
export const LEASED_INDEX_SEARCH_FRAME_TYPE = 'leased_index_search' as const;
export const OFFLINE_DEPOSIT_FRAME_TYPE = 'offline_discovery_deposit' as const;
export const OFFLINE_FETCH_FRAME_TYPE = 'offline_discovery_fetch' as const;
export const OFFLINE_ACK_FRAME_TYPE = 'offline_discovery_ack' as const;
export const CLIENT_HELD_REPAIR_FRAME_TYPE = 'client_held_repair' as const;
export const OFFLINE_SYNC_FRAME_TYPE = 'offline_discovery_sync' as const;
export const CONTENT_SEND_FRAME_TYPE = 'content_operation_send' as const;
export const CONTENT_POLL_FRAME_TYPE = 'content_operation_poll' as const;

export interface LeasedIndexOperationFrameV1 {
  type: typeof LEASED_INDEX_OPERATION_FRAME_TYPE;
  operationBytes: string;
  admission?: AdmissionCapabilityV2;
}

export interface LeasedIndexLookupRequestV1 {
  version: 1;
  kind: 'leased-index-lookup';
  requestId: string;
  publicationId: string;
  generationId?: string;
  requesterKey: string;
  createdAt: number;
  expiresAt: number;
  signature: string;
}

export interface LeasedIndexSearchRequestV1 {
  version: 1;
  kind: 'leased-index-search';
  requestId: string;
  groupId: string;
  itemType: 'need' | 'offer';
  fingerprintEpoch: string;
  fingerprint: string;
  limit: number;
  requesterKey: string;
  createdAt: number;
  expiresAt: number;
  signature: string;
}

export interface OfflineFetchRequestV1 {
  version: 1;
  kind: 'offline-discovery-fetch';
  requestId: string;
  clientLeaseId: string;
  publicationId: string;
  generationId: string;
  mailboxId: string;
  publicationKey: string;
  createdAt: number;
  expiresAt: number;
  signature: string;
}

export interface ContentPollRequestV1 {
  version: 1;
  kind: 'content-operation-poll';
  pollId: string;
  channelId: string;
  relationshipId: string;
  relationshipKey: string;
  createdAt: number;
  expiresAt: number;
  signature: string;
}

interface RelayRepairCommon {
  version: 1;
  requestId: string;
  senderRelayId: string;
  targetRelayId: string;
  createdAt: number;
  expiresAt: number;
}

export interface ClientHeldRepairRequestV1 extends RelayRepairCommon {
  kind: 'client-held-repair';
  publicationId: string;
  generationId: string | null;
  operationBytes: string;
  signature: string;
}

export interface OfflineSyncRequestV1 extends RelayRepairCommon {
  kind: 'offline-discovery-sync';
  clientLeaseId: string;
  cursor: number;
  events: OfflineDiscoverySyncEventV1[];
  signature: string;
}

export type ClientHeldFrameV1 =
  | LeasedIndexOperationFrameV1
  | { type: typeof LEASED_INDEX_LOOKUP_FRAME_TYPE; request: LeasedIndexLookupRequestV1; admission?: AdmissionCapabilityV2 }
  | { type: typeof LEASED_INDEX_SEARCH_FRAME_TYPE; request: LeasedIndexSearchRequestV1; admission?: AdmissionCapabilityV2 }
  | { type: typeof OFFLINE_DEPOSIT_FRAME_TYPE; depositBytes: string; admission?: AdmissionCapabilityV2 }
  | { type: typeof OFFLINE_FETCH_FRAME_TYPE; request: OfflineFetchRequestV1; admission?: AdmissionCapabilityV2 }
  | { type: typeof OFFLINE_ACK_FRAME_TYPE; ackBytes: string }
  | { type: typeof CLIENT_HELD_REPAIR_FRAME_TYPE; request: ClientHeldRepairRequestV1 }
  | { type: typeof OFFLINE_SYNC_FRAME_TYPE; request: OfflineSyncRequestV1 }
  | { type: typeof CONTENT_SEND_FRAME_TYPE; operationBytes: string; admission?: AdmissionCapabilityV2 }
  | { type: typeof CONTENT_POLL_FRAME_TYPE; request: ContentPollRequestV1; admission?: AdmissionCapabilityV2 };

export type ClientHeldResponsePayloadV1 =
  | { requestId: string; kind: 'lookup'; operationBytes: string | null }
  | { requestId: string; kind: 'search'; operationBytes: string[] }
  | { requestId: string; kind: 'offline-fetch'; depositBytes: string[] }
  | { requestId: string; kind: 'offline-deposit'; status: string; receipt?: unknown }
  | { requestId: string; kind: 'sync'; events: OfflineDiscoverySyncEventV1[]; nextCursor: number }
  | { requestId: string; kind: 'content'; operationBytes: string };

export function createLeasedIndexOperationFrameV1(
  operationBytes: string,
  admission?: AdmissionCapabilityV2,
): LeasedIndexOperationFrameV1 {
  parseLeasedIndexOperationV1(operationBytes);
  if (admission && !verifyAdmissionCapabilityV2(admission)) throw new Error('Invalid admission capability');
  return {
    type: LEASED_INDEX_OPERATION_FRAME_TYPE,
    operationBytes,
    ...(admission ? { admission } : {}),
  };
}

export function createLeasedIndexLookupRequestV1(input: {
  publicationId: string;
  generationId?: string;
  createdAt: number;
  expiresAt: number;
}, keys: SigningKeyPair): LeasedIndexLookupRequestV1 {
  const body = {
    version: 1 as const,
    kind: 'leased-index-lookup' as const,
    requestId: requestId(),
    publicationId: input.publicationId,
    ...(input.generationId ? { generationId: input.generationId } : {}),
    requesterKey: encodeBase64(keys.publicKey),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  return signBody(body, keys);
}

export function verifyLeasedIndexLookupRequestV1(value: unknown): value is LeasedIndexLookupRequestV1 {
  if (!isObject(value)) return false;
  const linked = 'generationId' in value;
  if (!hasOnlyKeys(value, [
    'createdAt', 'expiresAt', 'kind', 'publicationId', 'requestId', 'requesterKey', 'signature', 'version',
    ...(linked ? ['generationId'] : []),
  ])) return false;
  const { signature, ...body } = value;
  return isBase64(signature, 64)
    && body.version === 1 && body.kind === 'leased-index-lookup'
    && isOpaque(body.requestId, 'rpc') && isOpaque(body.publicationId, 'pub')
    && (!linked || isOpaque(body.generationId, 'gen'))
    && isBase64(body.requesterKey, 32) && validTimes(body)
    && verifySignedBody(body, signature, body.requesterKey);
}

export function createLeasedIndexSearchRequestV1(input: {
  groupId: string;
  itemType: 'need' | 'offer';
  fingerprintEpoch: string;
  fingerprint: Uint8Array;
  limit: number;
  createdAt: number;
  expiresAt: number;
}, keys: SigningKeyPair): LeasedIndexSearchRequestV1 {
  const body = {
    version: 1 as const,
    kind: 'leased-index-search' as const,
    requestId: requestId(),
    groupId: input.groupId,
    itemType: input.itemType,
    fingerprintEpoch: input.fingerprintEpoch,
    fingerprint: encodeBase64(input.fingerprint),
    limit: input.limit,
    requesterKey: encodeBase64(keys.publicKey),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  const request = signBody(body, keys);
  if (!verifyLeasedIndexSearchRequestV1(request)) throw new Error('Invalid leased index search');
  return request;
}

export function verifyLeasedIndexSearchRequestV1(value: unknown): value is LeasedIndexSearchRequestV1 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'createdAt', 'expiresAt', 'fingerprint', 'fingerprintEpoch', 'groupId', 'itemType', 'kind',
    'limit', 'requestId', 'requesterKey', 'signature', 'version',
  ])) return false;
  const { signature, ...body } = value;
  return isBase64(signature, 64) && body.version === 1 && body.kind === 'leased-index-search'
    && isOpaque(body.requestId, 'rpc') && isName(body.groupId) && isName(body.fingerprintEpoch)
    && (body.itemType === 'need' || body.itemType === 'offer') && isBase64(body.fingerprint, 64)
    && typeof body.limit === 'number' && Number.isSafeInteger(body.limit) && body.limit >= 1 && body.limit <= 10
    && isBase64(body.requesterKey, 32) && validTimes(body)
    && verifySignedBody(body, signature, body.requesterKey);
}

export function createOfflineFetchRequestV1(input: {
  index: LeasedIndexV1;
  createdAt: number;
  expiresAt: number;
}, keys: LeasedIndexKeyMaterialV1): OfflineFetchRequestV1 {
  if (!verifyLeasedIndexV1(input.index) || keys.publicationId !== input.index.publicationId
    || encodeBase64(keys.signingKeyPair.publicKey) !== input.index.publicationKey
    || input.expiresAt > input.index.expiresAt) throw new Error('Invalid offline fetch input');
  const body = {
    version: 1 as const,
    kind: 'offline-discovery-fetch' as const,
    requestId: requestId(),
    clientLeaseId: input.index.clientLeaseId,
    publicationId: input.index.publicationId,
    generationId: createLeasedIndexGenerationIdV1(input.index),
    mailboxId: input.index.mailbox.id,
    publicationKey: input.index.publicationKey,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  return signBody(body, keys.signingKeyPair);
}

export function verifyOfflineFetchRequestV1(value: unknown): value is OfflineFetchRequestV1 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'clientLeaseId', 'createdAt', 'expiresAt', 'generationId', 'kind', 'mailboxId', 'publicationId',
    'publicationKey', 'requestId', 'signature', 'version',
  ])) return false;
  const { signature, ...body } = value;
  return isBase64(signature, 64) && body.version === 1 && body.kind === 'offline-discovery-fetch'
    && isOpaque(body.requestId, 'rpc') && isOpaque(body.clientLeaseId, 'lease')
    && isOpaque(body.publicationId, 'pub') && isOpaque(body.generationId, 'gen')
    && isOpaque(body.mailboxId, 'mbx')
    && isBase64(body.publicationKey, 32) && validTimes(body)
    && body.publicationId === idFromKey('pub', body.publicationKey)
    && verifySignedBody(body, signature, body.publicationKey);
}

export function createContentPollRequestV1(input: {
  channelId: string;
  createdAt: number;
  expiresAt: number;
}, keys: RelationshipKeyMaterial): ContentPollRequestV1 {
  const body = {
    version: 1 as const,
    kind: 'content-operation-poll' as const,
    pollId: requestId(),
    channelId: input.channelId,
    relationshipId: keys.relationshipId,
    relationshipKey: encodeBase64(keys.signingKeyPair.publicKey),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  const request = signBody(body, keys.signingKeyPair);
  if (!verifyContentPollRequestV1(request)) throw new Error('Invalid content poll');
  return request;
}

export function verifyContentPollRequestV1(value: unknown): value is ContentPollRequestV1 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'channelId', 'createdAt', 'expiresAt', 'kind', 'pollId', 'relationshipId',
    'relationshipKey', 'signature', 'version',
  ])) return false;
  const { signature, ...body } = value;
  return isBase64(signature, 64) && body.version === 1 && body.kind === 'content-operation-poll'
    && isOpaque(body.pollId, 'rpc') && isOpaque(body.channelId, 'chn')
    && isOpaque(body.relationshipId, 'rel') && isBase64(body.relationshipKey, 32)
    && body.relationshipId === idFromKey('rel', body.relationshipKey) && validTimes(body)
    && verifySignedBody(body, signature, body.relationshipKey);
}

export function createClientHeldRepairRequestV1(input: {
  targetRelayId: string;
  operationBytes: string;
  createdAt: number;
  expiresAt: number;
}, identity: Identity): ClientHeldRepairRequestV1 {
  const operation = parseLeasedIndexOperationV1(input.operationBytes);
  const body = {
    version: 1 as const,
    kind: 'client-held-repair' as const,
    requestId: requestId(),
    senderRelayId: identity.did,
    targetRelayId: input.targetRelayId,
    publicationId: operation.publicationId,
    generationId: operation.kind === 'leased-discovery-index'
      ? createLeasedIndexGenerationIdV1(operation)
      : null,
    operationBytes: input.operationBytes,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  return signRelayBody(body, identity);
}

export function verifyClientHeldRepairRequestV1(value: unknown): value is ClientHeldRepairRequestV1 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'createdAt', 'expiresAt', 'generationId', 'kind', 'operationBytes', 'publicationId',
    'requestId', 'senderRelayId', 'signature', 'targetRelayId', 'version',
  ])) return false;
  const { signature, ...body } = value;
  try {
    const operation = parseLeasedIndexOperationV1(body.operationBytes as string);
    return body.version === 1 && body.kind === 'client-held-repair'
      && isOpaque(body.requestId, 'rpc') && isOpaque(body.publicationId, 'pub')
      && operation.publicationId === body.publicationId
      && (operation.kind === 'leased-discovery-index'
        ? body.generationId === createLeasedIndexGenerationIdV1(operation)
        : body.generationId === null)
      && isRelayId(body.senderRelayId) && isRelayId(body.targetRelayId)
      && body.senderRelayId !== body.targetRelayId && validTimes(body)
      && isBase64(signature, 64)
      && verify(signable('resonance:client-held-repair:v1', body), decodeBase64(signature), didToPublicKey(body.senderRelayId));
  } catch {
    return false;
  }
}

export function createOfflineSyncRequestV1(input: {
  targetRelayId: string;
  clientLeaseId: string;
  cursor: number;
  events: OfflineDiscoverySyncEventV1[];
  createdAt: number;
  expiresAt: number;
}, identity: Identity): OfflineSyncRequestV1 {
  const body = {
    version: 1 as const,
    kind: 'offline-discovery-sync' as const,
    requestId: requestId(),
    senderRelayId: identity.did,
    targetRelayId: input.targetRelayId,
    clientLeaseId: input.clientLeaseId,
    cursor: input.cursor,
    events: input.events,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  const request = signRelayBody(body, identity);
  if (!verifyOfflineSyncRequestV1(request)) throw new Error('Invalid offline sync request');
  return request;
}

export function verifyOfflineSyncRequestV1(value: unknown): value is OfflineSyncRequestV1 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'clientLeaseId', 'createdAt', 'cursor', 'events', 'expiresAt', 'kind', 'requestId',
    'senderRelayId', 'signature', 'targetRelayId', 'version',
  ])) return false;
  const { signature, ...body } = value;
  try {
    return body.version === 1 && body.kind === 'offline-discovery-sync'
      && isOpaque(body.requestId, 'rpc') && isOpaque(body.clientLeaseId, 'lease')
      && isRelayId(body.senderRelayId) && isRelayId(body.targetRelayId)
      && body.senderRelayId !== body.targetRelayId && validTimes(body)
      && typeof body.cursor === 'number' && Number.isSafeInteger(body.cursor) && body.cursor >= 0
      && Array.isArray(body.events) && body.events.length <= 8 && body.events.every(isSyncEvent)
      && isBase64(signature, 64)
      && verify(signable('resonance:offline-sync:v1', body), decodeBase64(signature), didToPublicKey(body.senderRelayId));
  } catch {
    return false;
  }
}

export function parseClientHeldFrameV1(raw: string): ClientHeldFrameV1 {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_CLIENT_HELD_RPC_BYTES) {
    throw new Error('Invalid client-held RPC');
  }
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || typeof value.type !== 'string') throw new Error('Invalid client-held RPC');
  switch (value.type) {
    case LEASED_INDEX_OPERATION_FRAME_TYPE:
      if (!hasOnlyKeys(value, ['operationBytes', 'type', ...('admission' in value ? ['admission'] : [])])
        || typeof value.operationBytes !== 'string') throw new Error('Invalid leased operation frame');
      return createLeasedIndexOperationFrameV1(value.operationBytes, value.admission as AdmissionCapabilityV2 | undefined);
    case LEASED_INDEX_LOOKUP_FRAME_TYPE:
      if (!hasOnlyKeys(value, ['request', 'type', ...('admission' in value ? ['admission'] : [])])
        || !verifyLeasedIndexLookupRequestV1(value.request)
        || (value.admission && !verifyAdmissionCapabilityV2(value.admission))) throw new Error('Invalid leased lookup');
      return { type: value.type, request: value.request,
        ...(value.admission ? { admission: value.admission as AdmissionCapabilityV2 } : {}) };
    case LEASED_INDEX_SEARCH_FRAME_TYPE:
      if (!hasOnlyKeys(value, ['request', 'type', ...('admission' in value ? ['admission'] : [])])
        || !verifyLeasedIndexSearchRequestV1(value.request)
        || (value.admission && !verifyAdmissionCapabilityV2(value.admission))) throw new Error('Invalid leased search');
      return { type: value.type, request: value.request,
        ...(value.admission ? { admission: value.admission as AdmissionCapabilityV2 } : {}) };
    case OFFLINE_DEPOSIT_FRAME_TYPE:
      if (!hasOnlyKeys(value, ['depositBytes', 'type', ...('admission' in value ? ['admission'] : [])])
        || typeof value.depositBytes !== 'string') throw new Error('Invalid offline deposit frame');
      parseOfflineDiscoveryDepositV1(value.depositBytes);
      if (value.admission && !verifyAdmissionCapabilityV2(value.admission)) throw new Error('Invalid admission');
      return { type: value.type, depositBytes: value.depositBytes, ...(value.admission ? { admission: value.admission as AdmissionCapabilityV2 } : {}) };
    case OFFLINE_FETCH_FRAME_TYPE:
      if (!hasOnlyKeys(value, ['request', 'type', ...('admission' in value ? ['admission'] : [])])
        || !verifyOfflineFetchRequestV1(value.request)
        || (value.admission && !verifyAdmissionCapabilityV2(value.admission))) throw new Error('Invalid offline fetch');
      return { type: value.type, request: value.request,
        ...(value.admission ? { admission: value.admission as AdmissionCapabilityV2 } : {}) };
    case OFFLINE_ACK_FRAME_TYPE:
      if (!hasOnlyKeys(value, ['ackBytes', 'type']) || typeof value.ackBytes !== 'string') throw new Error('Invalid offline ACK');
      parseOfflineDiscoveryAckV1(value.ackBytes);
      return { type: value.type, ackBytes: value.ackBytes };
    case CLIENT_HELD_REPAIR_FRAME_TYPE:
      if (!hasOnlyKeys(value, ['request', 'type']) || !verifyClientHeldRepairRequestV1(value.request)) throw new Error('Invalid repair frame');
      return { type: value.type, request: value.request };
    case OFFLINE_SYNC_FRAME_TYPE:
      if (!hasOnlyKeys(value, ['request', 'type']) || !verifyOfflineSyncRequestV1(value.request)) throw new Error('Invalid sync frame');
      return { type: value.type, request: value.request };
    case CONTENT_SEND_FRAME_TYPE:
      if (!hasOnlyKeys(value, ['operationBytes', 'type', ...('admission' in value ? ['admission'] : [])])
        || typeof value.operationBytes !== 'string') throw new Error('Invalid content send frame');
      parseContentChannelOperationV2(value.operationBytes);
      if (value.admission && !verifyAdmissionCapabilityV2(value.admission)) throw new Error('Invalid admission');
      return { type: value.type, operationBytes: value.operationBytes, ...(value.admission ? { admission: value.admission as AdmissionCapabilityV2 } : {}) };
    case CONTENT_POLL_FRAME_TYPE:
      if (!hasOnlyKeys(value, ['request', 'type', ...('admission' in value ? ['admission'] : [])])
        || !verifyContentPollRequestV1(value.request)
        || (value.admission && !verifyAdmissionCapabilityV2(value.admission))) throw new Error('Invalid content poll');
      return { type: value.type, request: value.request,
        ...(value.admission ? { admission: value.admission as AdmissionCapabilityV2 } : {}) };
    default:
      throw new Error('Unknown client-held RPC');
  }
}

export function parseClientHeldResponsePayloadV1(
  value: unknown,
  requestId: string,
  kind: ClientHeldResponsePayloadV1['kind'],
): ClientHeldResponsePayloadV1 {
  if (!isObject(value) || value.requestId !== requestId || value.kind !== kind) {
    throw new Error('Client-held response does not match request');
  }
  if (kind === 'lookup') {
    if (!hasOnlyKeys(value, ['kind', 'operationBytes', 'requestId'])
      || (value.operationBytes !== null && typeof value.operationBytes !== 'string')) throw new Error('Invalid lookup response');
    if (value.operationBytes !== null) parseLeasedIndexOperationV1(value.operationBytes);
  } else if (kind === 'search') {
    if (!hasOnlyKeys(value, ['kind', 'operationBytes', 'requestId']) || !Array.isArray(value.operationBytes)
      || value.operationBytes.length > 10) throw new Error('Invalid search response');
    value.operationBytes.forEach(bytes => parseLeasedIndexOperationV1(bytes));
  } else if (kind === 'offline-fetch') {
    if (!hasOnlyKeys(value, ['depositBytes', 'kind', 'requestId']) || !Array.isArray(value.depositBytes)
      || value.depositBytes.length > 64) throw new Error('Invalid offline fetch response');
    value.depositBytes.forEach(bytes => parseOfflineDiscoveryDepositV1(bytes));
  } else if (kind === 'sync') {
    if (!hasOnlyKeys(value, ['events', 'kind', 'nextCursor', 'requestId'])
      || !Array.isArray(value.events) || value.events.length > 8 || !value.events.every(isSyncEvent)
      || !Number.isSafeInteger(value.nextCursor)) throw new Error('Invalid sync response');
  } else if (kind === 'content') {
    if (!hasOnlyKeys(value, ['kind', 'operationBytes', 'requestId']) || typeof value.operationBytes !== 'string') {
      throw new Error('Invalid content response');
    }
    parseContentChannelOperationV2(value.operationBytes);
  } else if (kind === 'offline-deposit') {
    if (!hasOnlyKeys(value, ['kind', 'requestId', 'status', ...('receipt' in value ? ['receipt'] : [])])
      || typeof value.status !== 'string') throw new Error('Invalid offline deposit response');
  }
  return value as ClientHeldResponsePayloadV1;
}

function isSyncEvent(value: unknown): value is OfflineDiscoverySyncEventV1 {
  if (!isObject(value)) return false;
  try {
    if (value.kind === 'deposit') return isObject(value)
      && hasOnlyKeys(value, ['admission', 'deposit', 'kind'])
      && (parseOfflineDiscoveryDepositV1(serializeUnknown(value.deposit)), verifyAdmissionCapabilityV2(value.admission));
    if (value.kind === 'ack') return isObject(value)
      && hasOnlyKeys(value, ['ack', 'deposit', 'admission', 'kind'])
      && (parseOfflineDiscoveryAckV1(serializeUnknown(value.ack)),
        parseOfflineDiscoveryDepositV1(serializeUnknown(value.deposit)), verifyAdmissionCapabilityV2(value.admission));
    if (value.kind === 'withdrawal') return isObject(value)
      && hasOnlyKeys(value, ['index', 'kind', 'withdrawal'])
      && verifyLeasedIndexWithdrawalV1(value.withdrawal) && verifyLeasedIndexV1(value.index);
    return false;
  } catch {
    return false;
  }
}

function serializeUnknown(value: unknown): string {
  return JSON.stringify(value);
}

function signBody<T extends object>(body: T, keys: SigningKeyPair): T & { signature: string } {
  return {
    ...body,
    signature: encodeBase64(sign(signable(`resonance:${(body as { kind: string }).kind}:v1`, body), keys.secretKey)),
  };
}

function signRelayBody<T extends object>(body: T, identity: Identity): T & { signature: string } {
  if (!isRelayId(identity.did)) throw new Error('Invalid relay identity');
  return {
    ...body,
    signature: encodeBase64(sign(signable(`resonance:${(body as { kind: string }).kind === 'client-held-repair' ? 'client-held-repair' : 'offline-sync'}:v1`, body), identity.secretKey)),
  };
}

function verifySignedBody(body: object, signature: string, key: string): boolean {
  try {
    return verify(signable(`resonance:${(body as { kind: string }).kind}:v1`, body), decodeBase64(signature), decodeBase64(key));
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
    if (!Number.isFinite(value)) throw new Error('Invalid number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  throw new Error('Invalid canonical value');
}

function validTimes(value: Record<string, unknown>): boolean {
  return isTimestamp(value.createdAt) && isTimestamp(value.expiresAt)
    && value.expiresAt > value.createdAt
    && value.expiresAt - value.createdAt <= CLIENT_HELD_RPC_LIFETIME_MS;
}

function requestId(): string {
  return `rpc_${Buffer.from(randomBytes(32)).toString('base64url')}`;
}

function idFromKey(prefix: string, key: string): string {
  return `${prefix}_${Buffer.from(decodeBase64(key)).toString('base64url')}`;
}

function isRelayId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return didToPublicKey(value).length === 32; } catch { return false; }
}

function isBase64(value: unknown, length: number): value is string {
  if (typeof value !== 'string') return false;
  try { return decodeBase64(value).length === length && encodeBase64(decodeBase64(value)) === value; } catch { return false; }
}

function isOpaque(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(value);
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
