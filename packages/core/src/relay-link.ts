/** Signed handshake for long-lived relay-to-relay WebSocket links. */

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
  MAX_RELAY_DISCOVERY_FRAME_BYTES,
  isRelayDescriptorActiveV1,
  createRelayContactHintV1,
  verifyRelayDescriptorV1,
  type RelayDescriptorV1,
} from './relay-discovery.js';

export const RELAY_LINK_VERSION = 1 as const;
export const RELAY_LINK_OPEN_FRAME_TYPE = 'relay_link_open' as const;
export const RELAY_LINK_ACCEPT_FRAME_TYPE = 'relay_link_accept' as const;
export const MAX_RELAY_LINK_HANDSHAKE_LIFETIME_MS = 60_000;

const LINK_OPEN_DOMAIN = 'resonance:relay-link:v1:open';
const LINK_ACCEPT_DOMAIN = 'resonance:relay-link:v1:accept';
const OPEN_BODY_KEYS = ['createdAt', 'descriptor', 'expiresAt', 'kind', 'linkId', 'version'] as const;
const OPEN_BODY_WITH_ENDPOINT_KEYS = [...OPEN_BODY_KEYS, 'dialedEndpoint'] as const;
const OPEN_KEYS = [...OPEN_BODY_KEYS, 'signature'] as const;
const OPEN_WITH_ENDPOINT_KEYS = [...OPEN_BODY_WITH_ENDPOINT_KEYS, 'signature'] as const;
const ACCEPT_BODY_KEYS = [
  'createdAt',
  'expiresAt',
  'initiatorRelayId',
  'kind',
  'linkId',
  'responderDescriptor',
  'version',
] as const;
const ACCEPT_KEYS = [...ACCEPT_BODY_KEYS, 'signature'] as const;

export interface RelayLinkOpenBodyV1 {
  version: typeof RELAY_LINK_VERSION;
  kind: 'relay-link-open';
  linkId: string;
  descriptor: RelayDescriptorV1;
  /** Signed statement of the exact target URL used for this connection. */
  dialedEndpoint?: string;
  createdAt: number;
  expiresAt: number;
}

export interface RelayLinkOpenV1 extends RelayLinkOpenBodyV1 {
  signature: string;
}

export interface RelayLinkAcceptBodyV1 {
  version: typeof RELAY_LINK_VERSION;
  kind: 'relay-link-accept';
  linkId: string;
  initiatorRelayId: string;
  responderDescriptor: RelayDescriptorV1;
  createdAt: number;
  expiresAt: number;
}

export interface RelayLinkAcceptV1 extends RelayLinkAcceptBodyV1 {
  signature: string;
}

export interface RelayLinkOpenFrameV1 {
  type: typeof RELAY_LINK_OPEN_FRAME_TYPE;
  request: RelayLinkOpenV1;
}

export interface RelayLinkAcceptFrameV1 {
  type: typeof RELAY_LINK_ACCEPT_FRAME_TYPE;
  response: RelayLinkAcceptV1;
}

export function createRelayLinkOpenV1(
  descriptor: RelayDescriptorV1,
  identity: Identity,
  createdAt = Date.now(),
  expiresAt = createdAt + 30_000,
  dialedEndpoint?: string,
): RelayLinkOpenV1 {
  const linkId = opaqueLinkId(generateSigningKeyPair().publicKey);
  const body: RelayLinkOpenBodyV1 = {
    version: RELAY_LINK_VERSION,
    kind: 'relay-link-open',
    linkId,
    descriptor,
    ...(dialedEndpoint === undefined ? {} : { dialedEndpoint }),
    createdAt,
    expiresAt,
  };
  if (!isRelayLinkOpenBody(body)
    || descriptor.relayId !== identity.did
    || descriptor.relayKey !== encodeBase64(identity.publicKey)
    || identity.secretKey.length !== 64
    || !equalBytes(identity.secretKey.subarray(32), identity.publicKey)) {
    throw new Error('Invalid relay link open input');
  }
  return {
    ...body,
    signature: encodeBase64(sign(signable(LINK_OPEN_DOMAIN, body), identity.secretKey)),
  };
}

export function verifyRelayLinkOpenV1(value: unknown): value is RelayLinkOpenV1 {
  if (!isObject(value) || !hasOnlyKeys(value,
    'dialedEndpoint' in value ? OPEN_WITH_ENDPOINT_KEYS : OPEN_KEYS)) return false;
  const { signature, ...body } = value;
  if (!isCanonicalBase64(signature, 64) || !isRelayLinkOpenBody(body)) return false;
  try {
    return verify(
      signable(LINK_OPEN_DOMAIN, body),
      decodeBase64(signature),
      decodeBase64(body.descriptor.relayKey),
    );
  } catch {
    return false;
  }
}

export function isRelayLinkOpenActiveV1(value: unknown, now: number): value is RelayLinkOpenV1 {
  return isTimestamp(now)
    && verifyRelayLinkOpenV1(value)
    && now >= value.createdAt
    && now < value.expiresAt
    && isRelayDescriptorActiveV1(value.descriptor, now);
}

export function createRelayLinkAcceptV1(
  request: RelayLinkOpenV1,
  responderDescriptor: RelayDescriptorV1,
  identity: Identity,
  createdAt = Date.now(),
): RelayLinkAcceptV1 {
  const body: RelayLinkAcceptBodyV1 = {
    version: RELAY_LINK_VERSION,
    kind: 'relay-link-accept',
    linkId: request.linkId,
    initiatorRelayId: request.descriptor.relayId,
    responderDescriptor,
    createdAt,
    expiresAt: Math.min(request.expiresAt, createdAt + 30_000),
  };
  if (!isRelayLinkOpenActiveV1(request, createdAt)
    || !isRelayLinkAcceptBody(body)
    || responderDescriptor.relayId !== identity.did
    || responderDescriptor.relayKey !== encodeBase64(identity.publicKey)
    || identity.secretKey.length !== 64
    || !equalBytes(identity.secretKey.subarray(32), identity.publicKey)) {
    throw new Error('Invalid relay link acceptance input');
  }
  return {
    ...body,
    signature: encodeBase64(sign(signable(LINK_ACCEPT_DOMAIN, body), identity.secretKey)),
  };
}

export function verifyRelayLinkAcceptV1(
  value: unknown,
  request?: RelayLinkOpenV1,
): value is RelayLinkAcceptV1 {
  if (!isObject(value) || !hasOnlyKeys(value, ACCEPT_KEYS)) return false;
  const { signature, ...body } = value;
  if (!isCanonicalBase64(signature, 64) || !isRelayLinkAcceptBody(body)) return false;
  if (request !== undefined && (!verifyRelayLinkOpenV1(request)
    || body.linkId !== request.linkId
    || body.initiatorRelayId !== request.descriptor.relayId
    || body.createdAt < request.createdAt
    || body.expiresAt > request.expiresAt)) return false;
  try {
    return verify(
      signable(LINK_ACCEPT_DOMAIN, body),
      decodeBase64(signature),
      decodeBase64(body.responderDescriptor.relayKey),
    );
  } catch {
    return false;
  }
}

export function isRelayLinkAcceptActiveV1(
  value: unknown,
  request: RelayLinkOpenV1,
  now: number,
): value is RelayLinkAcceptV1 {
  return isTimestamp(now)
    && verifyRelayLinkAcceptV1(value, request)
    && now >= value.createdAt
    && now < value.expiresAt
    && isRelayDescriptorActiveV1(value.responderDescriptor, now);
}

export function createRelayLinkOpenFrameV1(request: RelayLinkOpenV1): RelayLinkOpenFrameV1 {
  if (!verifyRelayLinkOpenV1(request)) throw new Error('Cannot frame an invalid relay link open');
  return { type: RELAY_LINK_OPEN_FRAME_TYPE, request };
}

export function createRelayLinkAcceptFrameV1(response: RelayLinkAcceptV1): RelayLinkAcceptFrameV1 {
  if (!verifyRelayLinkAcceptV1(response)) throw new Error('Cannot frame an invalid relay link acceptance');
  return { type: RELAY_LINK_ACCEPT_FRAME_TYPE, response };
}

export function serializeRelayLinkOpenFrameV1(frame: RelayLinkOpenFrameV1): string {
  if (frame.type !== RELAY_LINK_OPEN_FRAME_TYPE || !verifyRelayLinkOpenV1(frame.request)) {
    throw new Error('Invalid relay link open frame');
  }
  return serializeBounded(frame);
}

export function serializeRelayLinkAcceptFrameV1(frame: RelayLinkAcceptFrameV1): string {
  if (frame.type !== RELAY_LINK_ACCEPT_FRAME_TYPE || !verifyRelayLinkAcceptV1(frame.response)) {
    throw new Error('Invalid relay link acceptance frame');
  }
  return serializeBounded(frame);
}

export function parseRelayLinkOpenFrameV1(raw: string): RelayLinkOpenFrameV1 {
  const parsed = parseBounded(raw);
  if (!isObject(parsed)
    || !hasOnlyKeys(parsed, ['request', 'type'])
    || parsed.type !== RELAY_LINK_OPEN_FRAME_TYPE
    || !verifyRelayLinkOpenV1(parsed.request)) {
    throw new Error('Invalid relay link open frame');
  }
  return parsed as unknown as RelayLinkOpenFrameV1;
}

export function parseRelayLinkAcceptFrameV1(raw: string): RelayLinkAcceptFrameV1 {
  const parsed = parseBounded(raw);
  if (!isObject(parsed)
    || !hasOnlyKeys(parsed, ['response', 'type'])
    || parsed.type !== RELAY_LINK_ACCEPT_FRAME_TYPE
    || !verifyRelayLinkAcceptV1(parsed.response)) {
    throw new Error('Invalid relay link acceptance frame');
  }
  return parsed as unknown as RelayLinkAcceptFrameV1;
}

function isRelayLinkOpenBody(value: unknown): value is RelayLinkOpenBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value,
    'dialedEndpoint' in value ? OPEN_BODY_WITH_ENDPOINT_KEYS : OPEN_BODY_KEYS)) return false;
  if ('dialedEndpoint' in value) {
    if (typeof value.dialedEndpoint !== 'string') return false;
    try {
      if (createRelayContactHintV1('configured', value.dialedEndpoint).endpoint
        !== value.dialedEndpoint) return false;
    } catch { return false; }
  }
  if (value.version !== RELAY_LINK_VERSION || value.kind !== 'relay-link-open') return false;
  if (!isOpaqueLinkId(value.linkId) || !verifyRelayDescriptorV1(value.descriptor)) return false;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt)) return false;
  return value.expiresAt > value.createdAt
    && value.expiresAt - value.createdAt <= MAX_RELAY_LINK_HANDSHAKE_LIFETIME_MS
    && isRelayDescriptorActiveV1(value.descriptor, value.createdAt);
}

function isRelayLinkAcceptBody(value: unknown): value is RelayLinkAcceptBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value, ACCEPT_BODY_KEYS)) return false;
  if (value.version !== RELAY_LINK_VERSION || value.kind !== 'relay-link-accept') return false;
  if (!isOpaqueLinkId(value.linkId) || !isRelayId(value.initiatorRelayId)) return false;
  if (!verifyRelayDescriptorV1(value.responderDescriptor)) return false;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt)) return false;
  return value.expiresAt > value.createdAt
    && value.expiresAt - value.createdAt <= MAX_RELAY_LINK_HANDSHAKE_LIFETIME_MS
    && isRelayDescriptorActiveV1(value.responderDescriptor, value.createdAt);
}

function opaqueLinkId(bytes: Uint8Array): string {
  return `lnk_${encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function isOpaqueLinkId(value: unknown): value is string {
  return typeof value === 'string' && /^lnk_[A-Za-z0-9_-]{43}$/.test(value);
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

function serializeBounded(value: RelayLinkOpenFrameV1 | RelayLinkAcceptFrameV1): string {
  const raw = JSON.stringify(value);
  if (decodeUTF8(raw).length > MAX_RELAY_DISCOVERY_FRAME_BYTES) {
    throw new Error('Relay link frame exceeds the maximum size');
  }
  return raw;
}

function parseBounded(raw: string): unknown {
  if (typeof raw !== 'string' || decodeUTF8(raw).length > MAX_RELAY_DISCOVERY_FRAME_BYTES) {
    throw new Error('Relay link frame exceeds the maximum size');
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

function isRelayId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256) return false;
  try {
    const key = didToPublicKey(value);
    return key.length === 32 && publicKeyToDid(key) === value;
  } catch {
    return false;
  }
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
