/** Signed, target-bound search exchanges over authenticated relay links. */

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
import { verifyAdmissionCapabilityV2, type AdmissionCapabilityV2 } from './admission-v2.js';
import { MAX_RELAY_DISCOVERY_FRAME_BYTES } from './relay-discovery.js';
import {
  isSearchRequestActiveV2,
  verifySearchRequestV2,
  verifySearchResponsePayloadV2,
  type SearchRequestV2,
  type SearchResultV2,
} from './search-v2.js';

export const RELAY_QUERY_VERSION = 1 as const;
export const RELAY_QUERY_REQUEST_FRAME_TYPE = 'relay_query_request' as const;
export const RELAY_QUERY_RESPONSE_FRAME_TYPE = 'relay_query_response' as const;
/** Two relay-link edges at most: the receiving relay and one further peer. */
export const MAX_RELAY_QUERY_HOPS = 2;
export const MAX_RELAY_QUERY_LIFETIME_MS = 5_000;

const REQUEST_DOMAIN = 'resonance:relay-query:v1:request';
const RESPONSE_DOMAIN = 'resonance:relay-query:v1:response';

export interface RelayQueryRequestV1 {
  version: typeof RELAY_QUERY_VERSION;
  kind: 'relay-query-request';
  requestId: string;
  senderRelayId: string;
  targetRelayId: string;
  search: SearchRequestV2;
  admission?: AdmissionCapabilityV2;
  /** Further relay-link edges the recipient may traverse. */
  remainingHops: number;
  createdAt: number;
  expiresAt: number;
  signature: string;
}

export type RelayQueryStatusV1 =
  | 'ok' | 'duplicate' | 'rate-limited' | 'admission-required'
  | 'admission-rejected' | 'unavailable';

export interface RelayQueryResponseV1 {
  version: typeof RELAY_QUERY_VERSION;
  kind: 'relay-query-response';
  requestId: string;
  requestSignature: string;
  searchId: string;
  senderRelayId: string;
  targetRelayId: string;
  status: RelayQueryStatusV1;
  results: SearchResultV2[];
  createdAt: number;
  signature: string;
}

export interface RelayQueryRequestFrameV1 {
  type: typeof RELAY_QUERY_REQUEST_FRAME_TYPE;
  request: RelayQueryRequestV1;
}

export interface RelayQueryResponseFrameV1 {
  type: typeof RELAY_QUERY_RESPONSE_FRAME_TYPE;
  response: RelayQueryResponseV1;
}

export function createRelayQueryRequestV1(
  search: SearchRequestV2,
  targetRelayId: string,
  identity: Identity,
  remainingHops: number,
  admission?: AdmissionCapabilityV2,
  createdAt = Date.now(),
  expiresAt = Math.min(search.expiresAt, createdAt + MAX_RELAY_QUERY_LIFETIME_MS),
): RelayQueryRequestV1 {
  const body = {
    version: RELAY_QUERY_VERSION,
    kind: 'relay-query-request' as const,
    requestId: opaqueRequestId(generateSigningKeyPair().publicKey),
    senderRelayId: identity.did,
    targetRelayId,
    search,
    ...(admission === undefined ? {} : { admission }),
    remainingHops,
    createdAt,
    expiresAt,
  };
  if (!isRequestBody(body) || !isSearchRequestActiveV2(search, createdAt)
    || identity.secretKey.length !== 64
    || publicKeyToDid(identity.publicKey) !== identity.did) {
    throw new Error('Invalid relay query request input');
  }
  return { ...body, signature: encodeBase64(sign(signable(REQUEST_DOMAIN, body), identity.secretKey)) };
}

export function verifyRelayQueryRequestV1(value: unknown): value is RelayQueryRequestV1 {
  if (!isObject(value) || !hasKeys(value,
    ['createdAt', 'expiresAt', 'kind', 'remainingHops', 'requestId', 'search',
      'senderRelayId', 'signature', 'targetRelayId', 'version'], ['admission'])) return false;
  const { signature, ...body } = value;
  if (!isCanonicalSignature(signature) || !isRequestBody(body)) return false;
  try {
    return verify(signable(REQUEST_DOMAIN, body), decodeBase64(signature), didToPublicKey(body.senderRelayId));
  } catch { return false; }
}

export function isRelayQueryRequestActiveV1(value: unknown, now: number): value is RelayQueryRequestV1 {
  return isTimestamp(now) && verifyRelayQueryRequestV1(value)
    && now >= value.createdAt && now < value.expiresAt
    && isSearchRequestActiveV2(value.search, now);
}

export function createRelayQueryResponseV1(
  request: RelayQueryRequestV1,
  identity: Identity,
  status: RelayQueryStatusV1,
  results: SearchResultV2[] = [],
  createdAt = Date.now(),
): RelayQueryResponseV1 {
  if (!verifyRelayQueryRequestV1(request) || identity.did !== request.targetRelayId
    || identity.secretKey.length !== 64
    || publicKeyToDid(identity.publicKey) !== identity.did) {
    throw new Error('Invalid relay query response input');
  }
  const body = {
    version: RELAY_QUERY_VERSION,
    kind: 'relay-query-response' as const,
    requestId: request.requestId,
    requestSignature: request.signature,
    searchId: request.search.searchId,
    senderRelayId: identity.did,
    targetRelayId: request.senderRelayId,
    status,
    results,
    createdAt,
  };
  if (!isResponseBody(body) || !responseMatchesRequest(body, request)) {
    throw new Error('Invalid relay query response');
  }
  return { ...body, signature: encodeBase64(sign(signable(RESPONSE_DOMAIN, body), identity.secretKey)) };
}

export function verifyRelayQueryResponseV1(
  value: unknown,
  request?: RelayQueryRequestV1,
): value is RelayQueryResponseV1 {
  if (!isObject(value) || !hasKeys(value,
    ['createdAt', 'kind', 'requestId', 'requestSignature', 'results', 'searchId',
      'senderRelayId', 'signature', 'status', 'targetRelayId', 'version'])) return false;
  const { signature, ...body } = value;
  if (!isCanonicalSignature(signature) || !isResponseBody(body)
    || (request !== undefined && (!verifyRelayQueryRequestV1(request)
      || !responseMatchesRequest(body, request)))) return false;
  try {
    return verify(signable(RESPONSE_DOMAIN, body), decodeBase64(signature), didToPublicKey(body.senderRelayId));
  } catch { return false; }
}

export function createRelayQueryRequestFrameV1(request: RelayQueryRequestV1): RelayQueryRequestFrameV1 {
  if (!verifyRelayQueryRequestV1(request)) throw new Error('Invalid relay query request');
  return { type: RELAY_QUERY_REQUEST_FRAME_TYPE, request };
}

export function createRelayQueryResponseFrameV1(response: RelayQueryResponseV1): RelayQueryResponseFrameV1 {
  if (!verifyRelayQueryResponseV1(response)) throw new Error('Invalid relay query response');
  return { type: RELAY_QUERY_RESPONSE_FRAME_TYPE, response };
}

export function serializeRelayQueryRequestFrameV1(frame: RelayQueryRequestFrameV1): string {
  if (frame.type !== RELAY_QUERY_REQUEST_FRAME_TYPE || !verifyRelayQueryRequestV1(frame.request)) {
    throw new Error('Invalid relay query request frame');
  }
  return serializeBounded(frame);
}

export function serializeRelayQueryResponseFrameV1(frame: RelayQueryResponseFrameV1): string {
  if (frame.type !== RELAY_QUERY_RESPONSE_FRAME_TYPE || !verifyRelayQueryResponseV1(frame.response)) {
    throw new Error('Invalid relay query response frame');
  }
  return serializeBounded(frame);
}

export function parseRelayQueryRequestFrameV1(raw: string): RelayQueryRequestFrameV1 {
  const frame = parseBounded(raw);
  if (!isObject(frame) || !hasKeys(frame, ['request', 'type'])
    || frame.type !== RELAY_QUERY_REQUEST_FRAME_TYPE
    || !verifyRelayQueryRequestV1(frame.request)) throw new Error('Invalid relay query request frame');
  return frame as unknown as RelayQueryRequestFrameV1;
}

export function parseRelayQueryResponseFrameV1(raw: string): RelayQueryResponseFrameV1 {
  const frame = parseBounded(raw);
  if (!isObject(frame) || !hasKeys(frame, ['response', 'type'])
    || frame.type !== RELAY_QUERY_RESPONSE_FRAME_TYPE
    || !verifyRelayQueryResponseV1(frame.response)) throw new Error('Invalid relay query response frame');
  return frame as unknown as RelayQueryResponseFrameV1;
}

function isRequestBody(value: unknown): value is Omit<RelayQueryRequestV1, 'signature'> {
  if (!isObject(value) || !hasKeys(value,
    ['createdAt', 'expiresAt', 'kind', 'remainingHops', 'requestId', 'search',
      'senderRelayId', 'targetRelayId', 'version'], ['admission'])) return false;
  return value.version === RELAY_QUERY_VERSION && value.kind === 'relay-query-request'
    && isRequestId(value.requestId)
    && isRelayId(value.senderRelayId) && isRelayId(value.targetRelayId)
    && value.senderRelayId !== value.targetRelayId
    && verifySearchRequestV2(value.search)
    && (value.admission === undefined || verifyAdmissionCapabilityV2(value.admission))
    && Number.isSafeInteger(value.remainingHops)
    && (value.remainingHops as number) >= 0
    && (value.remainingHops as number) < MAX_RELAY_QUERY_HOPS
    && isTimestamp(value.createdAt) && isTimestamp(value.expiresAt)
    && value.createdAt >= value.search.createdAt
    && value.expiresAt <= value.search.expiresAt
    && value.expiresAt > value.createdAt
    && value.expiresAt - value.createdAt <= MAX_RELAY_QUERY_LIFETIME_MS;
}

function isResponseBody(value: unknown): value is Omit<RelayQueryResponseV1, 'signature'> {
  if (!isObject(value) || !hasKeys(value,
    ['createdAt', 'kind', 'requestId', 'requestSignature', 'results', 'searchId',
      'senderRelayId', 'status', 'targetRelayId', 'version'])) return false;
  if (value.version !== RELAY_QUERY_VERSION || value.kind !== 'relay-query-response'
    || !isRequestId(value.requestId) || !isCanonicalSignature(value.requestSignature)
    || typeof value.searchId !== 'string'
    || !isRelayId(value.senderRelayId) || !isRelayId(value.targetRelayId)
    || value.senderRelayId === value.targetRelayId
    || !isQueryStatus(value.status) || !isTimestamp(value.createdAt)
    || !Array.isArray(value.results)
    || (value.status !== 'ok' && value.results.length !== 0)) return false;
  return verifySearchResponsePayloadV2({
    version: 2, kind: 'search-response', searchId: value.searchId,
    results: value.results, createdAt: value.createdAt,
  });
}

function responseMatchesRequest(
  response: Omit<RelayQueryResponseV1, 'signature'>,
  request: RelayQueryRequestV1,
): boolean {
  return response.requestId === request.requestId
    && response.requestSignature === request.signature
    && response.searchId === request.search.searchId
    && response.senderRelayId === request.targetRelayId
    && response.targetRelayId === request.senderRelayId
    && response.createdAt >= request.createdAt
    && response.createdAt <= request.expiresAt
    && response.results.length <= request.search.k
    && response.results.every(result => result.itemType !== request.search.itemType
      && result.similarity >= request.search.threshold);
}

function isQueryStatus(value: unknown): value is RelayQueryStatusV1 {
  return value === 'ok' || value === 'duplicate' || value === 'rate-limited'
    || value === 'admission-required' || value === 'admission-rejected'
    || value === 'unavailable';
}

function opaqueRequestId(bytes: Uint8Array): string {
  return `qry_${encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^qry_[A-Za-z0-9_-]{43}$/.test(value);
}

function isRelayId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256) return false;
  try { return publicKeyToDid(didToPublicKey(value)) === value; } catch { return false; }
}

function isCanonicalSignature(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128) return false;
  try { return decodeBase64(value).length === 64 && encodeBase64(decodeBase64(value)) === value; }
  catch { return false; }
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every(key => keys.includes(key))
    && keys.every(key => required.includes(key) || optional.includes(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function serializeBounded(frame: object): string {
  const raw = JSON.stringify(frame);
  if (decodeUTF8(raw).length > MAX_RELAY_DISCOVERY_FRAME_BYTES) {
    throw new Error('Relay query frame exceeds the maximum size');
  }
  return raw;
}

function parseBounded(raw: string): unknown {
  if (typeof raw !== 'string' || decodeUTF8(raw).length > MAX_RELAY_DISCOVERY_FRAME_BYTES) {
    throw new Error('Relay query frame exceeds the maximum size');
  }
  return JSON.parse(raw) as unknown;
}
