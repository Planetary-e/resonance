/** One-use, self-authenticating search requests for protocol v2. */

import {
  decodeBase64,
  decodeUTF8,
  encodeBase64,
  generateSigningKeyPair,
  sign,
  verify,
  type SigningKeyPair,
} from './crypto.js';
import { PROTOCOL_V2_VERSION, type PublicationFingerprint } from './protocol-v2.js';
import type { ItemType } from './types.js';
import {
  verifyAdmissionCapabilityV2,
  type AdmissionCapabilityV2,
} from './admission-v2.js';

export const SEARCH_REQUEST_FRAME_TYPE = 'search_request' as const;
export const SEARCH_RESPONSE_MESSAGE_TYPE = 'search_response_v2' as const;

const SEARCH_SIGNATURE_DOMAIN = 'resonance:discovery:v2:search-request';

export interface SearchKeyMaterialV2 {
  searchId: string;
  signingKeyPair: SigningKeyPair;
}

export interface SearchRequestBodyV2 {
  version: typeof PROTOCOL_V2_VERSION;
  kind: 'search-request';
  searchId: string;
  searchKey: string;
  groupId: string;
  fingerprint: PublicationFingerprint;
  itemType: ItemType;
  k: number;
  threshold: number;
  createdAt: number;
  expiresAt: number;
}

export interface SearchRequestV2 extends SearchRequestBodyV2 {
  signature: string;
}

export interface SearchRequestFrameV2 {
  type: typeof SEARCH_REQUEST_FRAME_TYPE;
  request: SearchRequestV2;
  admission?: AdmissionCapabilityV2;
}

export interface SearchResultV2 {
  publicationId: string;
  similarity: number;
  itemType: ItemType;
}

export interface SearchResponsePayloadV2 {
  version: typeof PROTOCOL_V2_VERSION;
  kind: 'search-response';
  searchId: string;
  results: SearchResultV2[];
  createdAt: number;
}

export interface CreateSearchRequestInputV2 {
  groupId: string;
  fingerprintEpoch: string;
  fingerprint: Uint8Array;
  itemType: ItemType;
  k: number;
  threshold: number;
  createdAt?: number;
  expiresAt?: number;
}

export function generateSearchKeyMaterialV2(): SearchKeyMaterialV2 {
  const signingKeyPair = generateSigningKeyPair();
  return {
    searchId: opaqueIdFromBytes('srch', signingKeyPair.publicKey),
    signingKeyPair,
  };
}

export function createSearchRequestV2(
  input: CreateSearchRequestInputV2,
  keys: SearchKeyMaterialV2 = generateSearchKeyMaterialV2(),
): SearchRequestV2 {
  const createdAt = input.createdAt ?? Date.now();
  const body: SearchRequestBodyV2 = {
    version: PROTOCOL_V2_VERSION,
    kind: 'search-request',
    searchId: keys.searchId,
    searchKey: encodeBase64(keys.signingKeyPair.publicKey),
    groupId: input.groupId,
    fingerprint: {
      algorithm: 'random-hyperplane-lsh',
      bits: input.fingerprint.length * 8,
      epoch: input.fingerprintEpoch,
      value: encodeBase64(input.fingerprint),
    },
    itemType: input.itemType,
    k: input.k,
    threshold: input.threshold,
    createdAt,
    expiresAt: input.expiresAt ?? createdAt + 30_000,
  };
  if (!isSearchRequestBody(body)
    || keys.searchId !== opaqueIdFromBytes('srch', keys.signingKeyPair.publicKey)
    || keys.signingKeyPair.secretKey.length !== 64) {
    throw new Error('Invalid protocol v2 search input');
  }
  return {
    ...body,
    signature: encodeBase64(sign(signableSearchRequest(body), keys.signingKeyPair.secretKey)),
  };
}

export function verifySearchRequestV2(value: unknown): value is SearchRequestV2 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'createdAt', 'expiresAt', 'fingerprint', 'groupId', 'itemType', 'k', 'kind',
    'searchId', 'searchKey', 'signature', 'threshold', 'version',
  ])) return false;
  const { signature, ...body } = value;
  if (typeof signature !== 'string' || !isSearchRequestBody(body)) return false;
  try {
    const decodedSignature = decodeBase64(signature);
    return decodedSignature.length === 64 && verify(
      signableSearchRequest(body),
      decodedSignature,
      decodeBase64(body.searchKey),
    );
  } catch {
    return false;
  }
}

export function createSearchRequestFrameV2(
  request: SearchRequestV2,
  admission?: AdmissionCapabilityV2,
): SearchRequestFrameV2 {
  if (!verifySearchRequestV2(request)) throw new Error('Cannot frame an invalid protocol v2 search request');
  if (admission !== undefined && !verifyAdmissionCapabilityV2(admission)) {
    throw new Error('Cannot frame an invalid admission capability');
  }
  return admission === undefined
    ? { type: SEARCH_REQUEST_FRAME_TYPE, request }
    : { type: SEARCH_REQUEST_FRAME_TYPE, request, admission };
}

export function parseSearchRequestFrameV2(raw: string): SearchRequestFrameV2 {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)
    || !hasOnlyKeys(parsed, 'admission' in parsed
      ? ['admission', 'request', 'type']
      : ['request', 'type'])
    || parsed.type !== SEARCH_REQUEST_FRAME_TYPE
    || !verifySearchRequestV2(parsed.request)
    || ('admission' in parsed && !verifyAdmissionCapabilityV2(parsed.admission))) {
    throw new Error('Invalid protocol v2 search request frame');
  }
  return parsed as unknown as SearchRequestFrameV2;
}

export function serializeSearchRequestFrameV2(frame: SearchRequestFrameV2): string {
  if (frame.type !== SEARCH_REQUEST_FRAME_TYPE
    || !verifySearchRequestV2(frame.request)
    || (frame.admission !== undefined && !verifyAdmissionCapabilityV2(frame.admission))) {
    throw new Error('Invalid protocol v2 search request frame');
  }
  return JSON.stringify(frame);
}

export function createSearchResponsePayloadV2(
  searchId: string,
  results: SearchResultV2[],
  createdAt = Date.now(),
): SearchResponsePayloadV2 {
  const response: SearchResponsePayloadV2 = {
    version: PROTOCOL_V2_VERSION,
    kind: 'search-response',
    searchId,
    results,
    createdAt,
  };
  if (!verifySearchResponsePayloadV2(response)) throw new Error('Invalid protocol v2 search response');
  return response;
}

export function verifySearchResponsePayloadV2(value: unknown): value is SearchResponsePayloadV2 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'createdAt', 'kind', 'results', 'searchId', 'version',
  ])) return false;
  if (value.version !== PROTOCOL_V2_VERSION
    || value.kind !== 'search-response'
    || !isOpaqueId(value.searchId, 'srch')
    || !isTimestamp(value.createdAt)
    || !Array.isArray(value.results)
    || value.results.length > 50) return false;
  const publicationIds = new Set<string>();
  for (const result of value.results) {
    if (!isSearchResult(result) || publicationIds.has(result.publicationId)) return false;
    publicationIds.add(result.publicationId);
  }
  return true;
}

export function isSearchRequestActiveV2(request: SearchRequestV2, now: number): boolean {
  return verifySearchRequestV2(request) && now >= request.createdAt && now < request.expiresAt;
}

function isSearchRequestBody(value: unknown): value is SearchRequestBodyV2 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'createdAt', 'expiresAt', 'fingerprint', 'groupId', 'itemType', 'k', 'kind',
    'searchId', 'searchKey', 'threshold', 'version',
  ])) return false;
  if (value.version !== PROTOCOL_V2_VERSION || value.kind !== 'search-request') return false;
  if (!isOpaqueId(value.searchId, 'srch') || !isBase64OfLength(value.searchKey, 32)) return false;
  if (value.searchId !== opaqueIdFromBytes('srch', decodeBase64(value.searchKey))) return false;
  if (!isBoundedName(value.groupId) || !isFingerprint(value.fingerprint)) return false;
  if (value.itemType !== 'need' && value.itemType !== 'offer') return false;
  if (!Number.isSafeInteger(value.k) || (value.k as number) < 1 || (value.k as number) > 50) return false;
  if (typeof value.threshold !== 'number' || !Number.isFinite(value.threshold)
    || value.threshold < 0 || value.threshold > 1) return false;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt)) return false;
  return value.expiresAt > value.createdAt && value.expiresAt - value.createdAt <= 60_000;
}

function isFingerprint(value: unknown): value is PublicationFingerprint {
  if (!isObject(value) || !hasOnlyKeys(value, ['algorithm', 'bits', 'epoch', 'value'])) return false;
  if (value.algorithm !== 'random-hyperplane-lsh') return false;
  if (!Number.isSafeInteger(value.bits) || (value.bits as number) < 64
    || (value.bits as number) % 8 !== 0) return false;
  return isBoundedName(value.epoch) && isBase64OfLength(value.value, (value.bits as number) / 8);
}

function isSearchResult(value: unknown): value is SearchResultV2 {
  return isObject(value)
    && hasOnlyKeys(value, ['itemType', 'publicationId', 'similarity'])
    && isOpaqueId(value.publicationId, 'pub')
    && (value.itemType === 'need' || value.itemType === 'offer')
    && typeof value.similarity === 'number'
    && Number.isFinite(value.similarity)
    && value.similarity >= 0
    && value.similarity <= 1;
}

function signableSearchRequest(body: SearchRequestBodyV2): Uint8Array {
  return decodeUTF8(`${SEARCH_SIGNATURE_DOMAIN}\n${canonicalize(body)}`);
}

function opaqueIdFromBytes(prefix: 'srch', bytes: Uint8Array): string {
  return `${prefix}_${encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function isOpaqueId(value: unknown, prefix: 'srch' | 'pub'): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(value);
}

function isBase64OfLength(value: unknown, length: number): value is string {
  if (typeof value !== 'string' || value.length > 100_000) return false;
  try { return decodeBase64(value).length === length; } catch { return false; }
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
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
