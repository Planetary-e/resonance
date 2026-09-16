/**
 * Self-authenticating relay discovery primitives.
 *
 * Contact hints only identify somewhere to connect. A hint becomes a relay
 * candidate after the relay proves control of the key in a signed descriptor.
 * Peer exchange is bounded and signed by the responding relay, while every
 * returned descriptor remains independently verifiable.
 */

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
  type SigningKeyPair,
} from './crypto.js';

export const RELAY_DISCOVERY_VERSION = 1 as const;
export const RELAY_PEER_REQUEST_FRAME_TYPE = 'relay_peer_request' as const;
export const RELAY_PEER_RESPONSE_FRAME_TYPE = 'relay_peer_response' as const;
export const MAX_RELAY_DESCRIPTOR_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const MAX_RELAY_PEERS_PER_RESPONSE = 32;

const MAX_RELAY_ENDPOINTS = 8;
const MAX_RELAY_GROUPS = 64;
const MAX_REQUEST_GROUPS = 32;
const MAX_PEER_REQUEST_LIFETIME_MS = 60_000;
const MAX_PEER_RESPONSE_LIFETIME_MS = 60_000;
const DESCRIPTOR_SIGNATURE_DOMAIN = 'resonance:relay-discovery:v1:descriptor';
const PEER_REQUEST_SIGNATURE_DOMAIN = 'resonance:relay-discovery:v1:peer-request';
const PEER_RESPONSE_SIGNATURE_DOMAIN = 'resonance:relay-discovery:v1:peer-response';

const CAPABILITY_KEYS = [
  'answersQueries',
  'forwardsQueries',
  'replicaExchange',
  'storesMailboxes',
  'storesPublications',
] as const;
const STORAGE_KEYS = ['availableBytes', 'capacityBytes'] as const;
const DESCRIPTOR_BODY_KEYS = [
  'capabilities',
  'endpoints',
  'expiresAt',
  'issuedAt',
  'kind',
  'reachability',
  'relayId',
  'relayKey',
  'sequence',
  'storage',
  'supportedGroups',
  'version',
] as const;
const DESCRIPTOR_KEYS = [...DESCRIPTOR_BODY_KEYS, 'signature'] as const;
const PEER_REQUEST_BODY_KEYS = [
  'createdAt',
  'expiresAt',
  'kind',
  'maxPeers',
  'requestId',
  'requestKey',
  'supportedGroups',
  'version',
] as const;
const PEER_REQUEST_KEYS = [...PEER_REQUEST_BODY_KEYS, 'signature'] as const;
const PEER_RESPONSE_BODY_KEYS = [
  'createdAt',
  'descriptors',
  'expiresAt',
  'kind',
  'requestId',
  'responderId',
  'responderKey',
  'version',
] as const;
const PEER_RESPONSE_KEYS = [...PEER_RESPONSE_BODY_KEYS, 'signature'] as const;

export type RelayReachability = 'direct' | 'outbound-only';
export type RelayContactHintSource = 'configured' | 'invitation' | 'local' | 'peer-exchange';

export interface RelayCapabilitiesV1 {
  storesPublications: boolean;
  storesMailboxes: boolean;
  answersQueries: boolean;
  forwardsQueries: boolean;
  replicaExchange: boolean;
}

export interface RelayStorageCapacityV1 {
  capacityBytes: number;
  availableBytes: number;
}

export interface RelayDescriptorBodyV1 {
  version: typeof RELAY_DISCOVERY_VERSION;
  kind: 'relay-descriptor';
  relayId: string;
  /** Base64-encoded Ed25519 relay infrastructure public key. */
  relayKey: string;
  sequence: number;
  endpoints: string[];
  reachability: RelayReachability;
  capabilities: RelayCapabilitiesV1;
  supportedGroups: string[];
  storage: RelayStorageCapacityV1;
  issuedAt: number;
  expiresAt: number;
}

export interface RelayDescriptorV1 extends RelayDescriptorBodyV1 {
  signature: string;
}

export interface CreateRelayDescriptorInputV1 {
  sequence: number;
  endpoints: string[];
  reachability: RelayReachability;
  capabilities: RelayCapabilitiesV1;
  supportedGroups: string[];
  storage: RelayStorageCapacityV1;
  issuedAt?: number;
  expiresAt?: number;
}

/** A location to try, never proof that a relay is trusted or even present. */
export interface RelayContactHintV1 {
  source: RelayContactHintSource;
  endpoint: string;
  /** Optional relay identity that the connection must prove. */
  expectedRelayId?: string;
}

export interface RelayPeerRequestKeyMaterialV1 {
  requestId: string;
  signingKeyPair: SigningKeyPair;
}

export interface RelayPeerRequestBodyV1 {
  version: typeof RELAY_DISCOVERY_VERSION;
  kind: 'relay-peer-request';
  requestId: string;
  /** One-use Ed25519 public key; does not expose a stable personal identity. */
  requestKey: string;
  supportedGroups: string[];
  maxPeers: number;
  createdAt: number;
  expiresAt: number;
}

export interface RelayPeerRequestV1 extends RelayPeerRequestBodyV1 {
  signature: string;
}

export interface RelayPeerResponseBodyV1 {
  version: typeof RELAY_DISCOVERY_VERSION;
  kind: 'relay-peer-response';
  requestId: string;
  responderId: string;
  /** Base64-encoded Ed25519 relay infrastructure public key. */
  responderKey: string;
  descriptors: RelayDescriptorV1[];
  createdAt: number;
  expiresAt: number;
}

export interface RelayPeerResponseV1 extends RelayPeerResponseBodyV1 {
  signature: string;
}

export interface RelayPeerRequestFrameV1 {
  type: typeof RELAY_PEER_REQUEST_FRAME_TYPE;
  request: RelayPeerRequestV1;
}

export interface RelayPeerResponseFrameV1 {
  type: typeof RELAY_PEER_RESPONSE_FRAME_TYPE;
  response: RelayPeerResponseV1;
}

export function createRelayDescriptorV1(
  input: CreateRelayDescriptorInputV1,
  identity: Identity,
): RelayDescriptorV1 {
  const issuedAt = input.issuedAt ?? Date.now();
  const endpoints = normalizeEndpoints(input.endpoints);
  const supportedGroups = normalizeNames(input.supportedGroups, MAX_RELAY_GROUPS, 'relay group');
  const body: RelayDescriptorBodyV1 = {
    version: RELAY_DISCOVERY_VERSION,
    kind: 'relay-descriptor',
    relayId: identity.did,
    relayKey: encodeBase64(identity.publicKey),
    sequence: input.sequence,
    endpoints,
    reachability: input.reachability,
    capabilities: { ...input.capabilities },
    supportedGroups,
    storage: { ...input.storage },
    issuedAt,
    expiresAt: input.expiresAt ?? issuedAt + 60 * 60 * 1000,
  };
  if (!isRelayDescriptorBody(body)
    || identity.secretKey.length !== 64
    || !equalBytes(identity.secretKey.subarray(32), identity.publicKey)) {
    throw new Error('Invalid relay descriptor input');
  }
  return {
    ...body,
    signature: encodeBase64(sign(signable(DESCRIPTOR_SIGNATURE_DOMAIN, body), identity.secretKey)),
  };
}

/** Verify structure, identity binding, canonical form, and signature. */
export function verifyRelayDescriptorV1(value: unknown): value is RelayDescriptorV1 {
  if (!isObject(value) || !hasOnlyKeys(value, DESCRIPTOR_KEYS)) return false;
  const { signature, ...body } = value;
  if (!isCanonicalBase64(signature, 64) || !isRelayDescriptorBody(body)) return false;
  try {
    return verify(
      signable(DESCRIPTOR_SIGNATURE_DOMAIN, body),
      decodeBase64(signature),
      decodeBase64(body.relayKey),
    );
  } catch {
    return false;
  }
}

/** Freshness policy is kept separate from cryptographic validity. */
export function isRelayDescriptorActiveV1(value: unknown, now: number): value is RelayDescriptorV1 {
  return isTimestamp(now)
    && verifyRelayDescriptorV1(value)
    && now >= value.issuedAt
    && now < value.expiresAt;
}

export function createRelayContactHintV1(
  source: RelayContactHintSource,
  endpoint: string,
  expectedRelayId?: string,
): RelayContactHintV1 {
  const hint: RelayContactHintV1 = expectedRelayId === undefined
    ? { source, endpoint: canonicalEndpoint(endpoint) }
    : { source, endpoint: canonicalEndpoint(endpoint), expectedRelayId };
  if (!verifyRelayContactHintV1(hint)) throw new Error('Invalid relay contact hint');
  return hint;
}

export function verifyRelayContactHintV1(value: unknown): value is RelayContactHintV1 {
  if (!isObject(value) || !hasOnlyKeys(value, 'expectedRelayId' in value
    ? ['endpoint', 'expectedRelayId', 'source']
    : ['endpoint', 'source'])) return false;
  if (value.source !== 'configured' && value.source !== 'invitation'
    && value.source !== 'local' && value.source !== 'peer-exchange') return false;
  if (typeof value.endpoint !== 'string' || !isCanonicalEndpoint(value.endpoint)) return false;
  return !('expectedRelayId' in value) || isRelayId(value.expectedRelayId);
}

export function generateRelayPeerRequestKeyMaterialV1(): RelayPeerRequestKeyMaterialV1 {
  const signingKeyPair = generateSigningKeyPair();
  return {
    requestId: opaqueIdFromBytes('rpr', signingKeyPair.publicKey),
    signingKeyPair,
  };
}

export function createRelayPeerRequestV1(
  input: {
    supportedGroups: string[];
    maxPeers?: number;
    createdAt?: number;
    expiresAt?: number;
  },
  keys: RelayPeerRequestKeyMaterialV1 = generateRelayPeerRequestKeyMaterialV1(),
): RelayPeerRequestV1 {
  const createdAt = input.createdAt ?? Date.now();
  const body: RelayPeerRequestBodyV1 = {
    version: RELAY_DISCOVERY_VERSION,
    kind: 'relay-peer-request',
    requestId: keys.requestId,
    requestKey: encodeBase64(keys.signingKeyPair.publicKey),
    supportedGroups: normalizeNames(input.supportedGroups, MAX_REQUEST_GROUPS, 'requested group'),
    maxPeers: input.maxPeers ?? MAX_RELAY_PEERS_PER_RESPONSE,
    createdAt,
    expiresAt: input.expiresAt ?? createdAt + 30_000,
  };
  if (!isRelayPeerRequestBody(body)
    || keys.requestId !== opaqueIdFromBytes('rpr', keys.signingKeyPair.publicKey)
    || keys.signingKeyPair.secretKey.length !== 64
    || !equalBytes(keys.signingKeyPair.secretKey.subarray(32), keys.signingKeyPair.publicKey)) {
    throw new Error('Invalid relay peer request input');
  }
  return {
    ...body,
    signature: encodeBase64(sign(signable(PEER_REQUEST_SIGNATURE_DOMAIN, body), keys.signingKeyPair.secretKey)),
  };
}

export function verifyRelayPeerRequestV1(value: unknown): value is RelayPeerRequestV1 {
  if (!isObject(value) || !hasOnlyKeys(value, PEER_REQUEST_KEYS)) return false;
  const { signature, ...body } = value;
  if (!isCanonicalBase64(signature, 64) || !isRelayPeerRequestBody(body)) return false;
  try {
    return verify(
      signable(PEER_REQUEST_SIGNATURE_DOMAIN, body),
      decodeBase64(signature),
      decodeBase64(body.requestKey),
    );
  } catch {
    return false;
  }
}

export function isRelayPeerRequestActiveV1(value: unknown, now: number): value is RelayPeerRequestV1 {
  return isTimestamp(now)
    && verifyRelayPeerRequestV1(value)
    && now >= value.createdAt
    && now < value.expiresAt;
}

export function createRelayPeerResponseV1(
  request: RelayPeerRequestV1,
  descriptors: RelayDescriptorV1[],
  responder: Identity,
  createdAt = Date.now(),
): RelayPeerResponseV1 {
  if (!isRelayPeerRequestActiveV1(request, createdAt)) {
    throw new Error('Cannot answer an invalid or inactive relay peer request');
  }
  if (descriptors.length > request.maxPeers) {
    throw new Error('Relay peer response exceeds the requested peer limit');
  }
  const ordered = [...descriptors].sort((first, second) => (
    first.relayId < second.relayId ? -1 : first.relayId > second.relayId ? 1 : 0
  ));
  if (!areUniqueRelayDescriptors(ordered)
    || !ordered.every(descriptor => isRelayDescriptorActiveV1(descriptor, createdAt))
    || !ordered.every(descriptor => supportsRequestedGroups(descriptor, request.supportedGroups))) {
    throw new Error('Relay peer response contains an invalid, stale, or duplicate descriptor');
  }
  const body: RelayPeerResponseBodyV1 = {
    version: RELAY_DISCOVERY_VERSION,
    kind: 'relay-peer-response',
    requestId: request.requestId,
    responderId: responder.did,
    responderKey: encodeBase64(responder.publicKey),
    descriptors: ordered,
    createdAt,
    expiresAt: Math.min(request.expiresAt, createdAt + 30_000),
  };
  if (!isRelayPeerResponseBody(body)
    || responder.secretKey.length !== 64
    || !equalBytes(responder.secretKey.subarray(32), responder.publicKey)) {
    throw new Error('Invalid relay peer response input');
  }
  return {
    ...body,
    signature: encodeBase64(sign(signable(PEER_RESPONSE_SIGNATURE_DOMAIN, body), responder.secretKey)),
  };
}

export function verifyRelayPeerResponseV1(
  value: unknown,
  request?: RelayPeerRequestV1,
): value is RelayPeerResponseV1 {
  if (!isObject(value) || !hasOnlyKeys(value, PEER_RESPONSE_KEYS)) return false;
  const { signature, ...body } = value;
  if (!isCanonicalBase64(signature, 64) || !isRelayPeerResponseBody(body)) return false;
  if (request !== undefined && (!verifyRelayPeerRequestV1(request)
    || body.requestId !== request.requestId
    || body.descriptors.length > request.maxPeers
    || body.createdAt < request.createdAt
    || body.expiresAt > request.expiresAt
    || !body.descriptors.every(descriptor => supportsRequestedGroups(
      descriptor, request.supportedGroups,
    )))) return false;
  try {
    return verify(
      signable(PEER_RESPONSE_SIGNATURE_DOMAIN, body),
      decodeBase64(signature),
      decodeBase64(body.responderKey),
    );
  } catch {
    return false;
  }
}

export function isRelayPeerResponseActiveV1(
  value: unknown,
  request: RelayPeerRequestV1,
  now: number,
): value is RelayPeerResponseV1 {
  return isTimestamp(now)
    && verifyRelayPeerResponseV1(value, request)
    && now >= value.createdAt
    && now < value.expiresAt;
}

export function createRelayPeerRequestFrameV1(request: RelayPeerRequestV1): RelayPeerRequestFrameV1 {
  if (!verifyRelayPeerRequestV1(request)) throw new Error('Cannot frame an invalid relay peer request');
  return { type: RELAY_PEER_REQUEST_FRAME_TYPE, request };
}

export function createRelayPeerResponseFrameV1(response: RelayPeerResponseV1): RelayPeerResponseFrameV1 {
  if (!verifyRelayPeerResponseV1(response)) throw new Error('Cannot frame an invalid relay peer response');
  return { type: RELAY_PEER_RESPONSE_FRAME_TYPE, response };
}

export function serializeRelayPeerRequestFrameV1(frame: RelayPeerRequestFrameV1): string {
  if (frame.type !== RELAY_PEER_REQUEST_FRAME_TYPE || !verifyRelayPeerRequestV1(frame.request)) {
    throw new Error('Invalid relay peer request frame');
  }
  return JSON.stringify(frame);
}

export function serializeRelayPeerResponseFrameV1(frame: RelayPeerResponseFrameV1): string {
  if (frame.type !== RELAY_PEER_RESPONSE_FRAME_TYPE || !verifyRelayPeerResponseV1(frame.response)) {
    throw new Error('Invalid relay peer response frame');
  }
  return JSON.stringify(frame);
}

export function parseRelayPeerRequestFrameV1(raw: string): RelayPeerRequestFrameV1 {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)
    || !hasOnlyKeys(parsed, ['request', 'type'])
    || parsed.type !== RELAY_PEER_REQUEST_FRAME_TYPE
    || !verifyRelayPeerRequestV1(parsed.request)) {
    throw new Error('Invalid relay peer request frame');
  }
  return parsed as unknown as RelayPeerRequestFrameV1;
}

export function parseRelayPeerResponseFrameV1(raw: string): RelayPeerResponseFrameV1 {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)
    || !hasOnlyKeys(parsed, ['response', 'type'])
    || parsed.type !== RELAY_PEER_RESPONSE_FRAME_TYPE
    || !verifyRelayPeerResponseV1(parsed.response)) {
    throw new Error('Invalid relay peer response frame');
  }
  return parsed as unknown as RelayPeerResponseFrameV1;
}

function isRelayDescriptorBody(value: unknown): value is RelayDescriptorBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value, DESCRIPTOR_BODY_KEYS)) return false;
  if (value.version !== RELAY_DISCOVERY_VERSION || value.kind !== 'relay-descriptor') return false;
  if (!isRelayIdBoundToKey(value.relayId, value.relayKey)) return false;
  if (!isSequence(value.sequence)) return false;
  if (!isCanonicalEndpointList(value.endpoints)) return false;
  if (value.reachability !== 'direct' && value.reachability !== 'outbound-only') return false;
  if (value.reachability === 'direct' && value.endpoints.length === 0) return false;
  if (value.reachability === 'outbound-only' && value.endpoints.length !== 0) return false;
  if (!isRelayCapabilities(value.capabilities)) return false;
  if (!isCanonicalNameList(value.supportedGroups, MAX_RELAY_GROUPS)) return false;
  if (!isRelayStorage(value.storage)) return false;
  if ((value.capabilities.storesPublications || value.capabilities.storesMailboxes
    || value.capabilities.replicaExchange) && value.storage.capacityBytes === 0) return false;
  if (value.capabilities.forwardsQueries && !value.capabilities.answersQueries) return false;
  if (!isTimestamp(value.issuedAt) || !isTimestamp(value.expiresAt)) return false;
  return value.expiresAt > value.issuedAt
    && value.expiresAt - value.issuedAt <= MAX_RELAY_DESCRIPTOR_LIFETIME_MS;
}

function isRelayPeerRequestBody(value: unknown): value is RelayPeerRequestBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value, PEER_REQUEST_BODY_KEYS)) return false;
  if (value.version !== RELAY_DISCOVERY_VERSION || value.kind !== 'relay-peer-request') return false;
  if (!isOpaqueId(value.requestId, 'rpr') || !isCanonicalBase64(value.requestKey, 32)) return false;
  if (value.requestId !== opaqueIdFromBytes('rpr', decodeBase64(value.requestKey))) return false;
  if (!isCanonicalNameList(value.supportedGroups, MAX_REQUEST_GROUPS)) return false;
  if (!Number.isSafeInteger(value.maxPeers)
    || (value.maxPeers as number) < 1
    || (value.maxPeers as number) > MAX_RELAY_PEERS_PER_RESPONSE) return false;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt)) return false;
  return value.expiresAt > value.createdAt
    && value.expiresAt - value.createdAt <= MAX_PEER_REQUEST_LIFETIME_MS;
}

function isRelayPeerResponseBody(value: unknown): value is RelayPeerResponseBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value, PEER_RESPONSE_BODY_KEYS)) return false;
  if (value.version !== RELAY_DISCOVERY_VERSION || value.kind !== 'relay-peer-response') return false;
  if (!isOpaqueId(value.requestId, 'rpr')) return false;
  if (!isRelayIdBoundToKey(value.responderId, value.responderKey)) return false;
  if (!Array.isArray(value.descriptors)
    || value.descriptors.length > MAX_RELAY_PEERS_PER_RESPONSE
    || !areUniqueRelayDescriptors(value.descriptors)) return false;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt)) return false;
  if (value.expiresAt <= value.createdAt
    || value.expiresAt - value.createdAt > MAX_PEER_RESPONSE_LIFETIME_MS) return false;
  const createdAt = value.createdAt;
  return value.descriptors.every(descriptor => isRelayDescriptorActiveV1(descriptor, createdAt));
}

function isRelayCapabilities(value: unknown): value is RelayCapabilitiesV1 {
  return isObject(value)
    && hasOnlyKeys(value, CAPABILITY_KEYS)
    && CAPABILITY_KEYS.every(key => typeof value[key] === 'boolean');
}

function isRelayStorage(value: unknown): value is RelayStorageCapacityV1 {
  return isObject(value)
    && hasOnlyKeys(value, STORAGE_KEYS)
    && isNonNegativeSafeInteger(value.capacityBytes)
    && isNonNegativeSafeInteger(value.availableBytes)
    && value.availableBytes <= value.capacityBytes;
}

function normalizeEndpoints(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_RELAY_ENDPOINTS) {
    throw new Error('Invalid relay endpoint list');
  }
  const endpoints = values.map(canonicalEndpoint);
  if (new Set(endpoints).size !== endpoints.length) throw new Error('Duplicate relay endpoint');
  return endpoints.sort();
}

function normalizeNames(values: string[], limit: number, label: string): string[] {
  if (!Array.isArray(values) || values.length > limit || !values.every(isBoundedName)) {
    throw new Error(`Invalid ${label} list`);
  }
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
  return [...values].sort();
}

function isCanonicalEndpointList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_RELAY_ENDPOINTS
    && value.every(endpoint => typeof endpoint === 'string' && isCanonicalEndpoint(endpoint))
    && isStrictlySorted(value);
}

function isCanonicalNameList(value: unknown, limit: number): value is string[] {
  return Array.isArray(value)
    && value.length <= limit
    && value.every(isBoundedName)
    && isStrictlySorted(value);
}

function areUniqueRelayDescriptors(value: unknown[]): value is RelayDescriptorV1[] {
  if (!value.every(verifyRelayDescriptorV1)) return false;
  if (!isStrictlySorted(value.map(descriptor => descriptor.relayId))) return false;
  return new Set(value.map(descriptor => descriptor.relayId)).size === value.length;
}

function supportsRequestedGroups(descriptor: RelayDescriptorV1, requestedGroups: string[]): boolean {
  return requestedGroups.length === 0
    || requestedGroups.some(group => descriptor.supportedGroups.includes(group));
}

function canonicalEndpoint(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048) {
    throw new Error('Invalid relay endpoint');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid relay endpoint');
  }
  if ((parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')
    || parsed.hostname.length === 0
    || parsed.username.length !== 0
    || parsed.password.length !== 0
    || parsed.search.length !== 0
    || parsed.hash.length !== 0) {
    throw new Error('Invalid relay endpoint');
  }
  return parsed.toString();
}

function isCanonicalEndpoint(value: string): boolean {
  try { return canonicalEndpoint(value) === value; } catch { return false; }
}

function isRelayIdBoundToKey(relayId: unknown, relayKey: unknown): relayId is string {
  if (!isRelayId(relayId) || !isCanonicalBase64(relayKey, 32)) return false;
  try { return publicKeyToDid(decodeBase64(relayKey)) === relayId; } catch { return false; }
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

function opaqueIdFromBytes(prefix: 'rpr', bytes: Uint8Array): string {
  return `${prefix}_${encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function isOpaqueId(value: unknown, prefix: 'rpr'): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(value);
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

function isBoundedName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isStrictlySorted(values: string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
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
