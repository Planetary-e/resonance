/** Authenticated relay-to-relay carrier for one destination HPKE layer. */

import {
  decodeBase64, decodeUTF8, encodeBase64, sign, verify, type Identity,
} from './crypto.js';
import { isRelayDescriptorActiveV1, type RelayDescriptorV1 } from './relay-discovery.js';
import {
  MAX_PRIVATE_FRAME_BYTES, MAX_PRIVATE_REQUEST_LIFETIME_MS,
  parsePrivateRequestLayerV1, serializePrivateRequestLayerV1,
  type PrivateRequestLayerV1,
} from './private-envelope.js';

export const RELAY_PRIVATE_FORWARD_FRAME_TYPE = 'relay_private_forward' as const;
const DOMAIN = 'resonance:private-transport:v1:relay-forward';
const BODY_KEYS = ['createdAt', 'destination', 'entryDescriptor', 'expiresAt', 'type', 'version'];
const FRAME_KEYS = [...BODY_KEYS, 'signature'];

export interface RelayPrivateForwardV1 {
  version: 1;
  type: typeof RELAY_PRIVATE_FORWARD_FRAME_TYPE;
  entryDescriptor: RelayDescriptorV1;
  destination: PrivateRequestLayerV1;
  createdAt: number;
  expiresAt: number;
  signature: string;
}

export function createRelayPrivateForwardV1(
  destination: PrivateRequestLayerV1,
  entryDescriptor: RelayDescriptorV1,
  identity: Identity,
  createdAt = Date.now(),
): RelayPrivateForwardV1 {
  const body = {
    version: 1 as const,
    type: RELAY_PRIVATE_FORWARD_FRAME_TYPE,
    entryDescriptor,
    destination,
    createdAt,
    expiresAt: Math.min(destination.expiresAt, createdAt + MAX_PRIVATE_REQUEST_LIFETIME_MS),
  };
  if (!validBody(body) || !isRelayDescriptorActiveV1(entryDescriptor, createdAt)
    || entryDescriptor.relayId !== identity.did
    || encodeBase64(identity.publicKey) !== entryDescriptor.relayKey
    || identity.secretKey.length !== 64
    || encodeBase64(identity.secretKey.subarray(32)) !== entryDescriptor.relayKey) {
    throw new Error('Invalid private relay forward input');
  }
  return { ...body, signature: encodeBase64(sign(signable(body), identity.secretKey)) };
}

export function verifyRelayPrivateForwardV1(value: unknown): value is RelayPrivateForwardV1 {
  if (!object(value) || !exactKeys(value, FRAME_KEYS)) return false;
  const { signature, ...body } = value;
  if (!validBody(body) || !canonicalSignature(signature)) return false;
  try {
    return verify(signable(body), decodeBase64(signature), decodeBase64(body.entryDescriptor.relayKey));
  } catch { return false; }
}

export function isRelayPrivateForwardActiveV1(
  value: unknown, now: number,
): value is RelayPrivateForwardV1 {
  return Number.isSafeInteger(now) && now >= 0 && verifyRelayPrivateForwardV1(value)
    && now >= value.createdAt && now < value.expiresAt
    && isRelayDescriptorActiveV1(value.entryDescriptor, now);
}

export function serializeRelayPrivateForwardV1(value: RelayPrivateForwardV1): string {
  if (!verifyRelayPrivateForwardV1(value)) throw new Error('Invalid private relay forward');
  const raw = JSON.stringify(value);
  if (decodeUTF8(raw).length > MAX_PRIVATE_FRAME_BYTES) {
    throw new Error('Private relay forward exceeds the maximum size');
  }
  return raw;
}

export function parseRelayPrivateForwardV1(raw: string): RelayPrivateForwardV1 {
  if (typeof raw !== 'string' || decodeUTF8(raw).length > MAX_PRIVATE_FRAME_BYTES) {
    throw new Error('Private relay forward exceeds the maximum size');
  }
  const value = JSON.parse(raw) as unknown;
  if (!verifyRelayPrivateForwardV1(value)) throw new Error('Invalid private relay forward');
  return value;
}

function validBody(value: unknown): value is Omit<RelayPrivateForwardV1, 'signature'> {
  if (!object(value) || !exactKeys(value, BODY_KEYS)
    || value.version !== 1 || value.type !== RELAY_PRIVATE_FORWARD_FRAME_TYPE
    || !isRelayDescriptorActiveV1(value.entryDescriptor, value.createdAt as number)
    || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
    || !Number.isSafeInteger(value.expiresAt)
    || (value.expiresAt as number) <= (value.createdAt as number)
    || (value.expiresAt as number) - (value.createdAt as number) > MAX_PRIVATE_REQUEST_LIFETIME_MS) {
    return false;
  }
  try {
    const destination = parsePrivateRequestLayerV1(serializePrivateRequestLayerV1(
      value.destination as PrivateRequestLayerV1,
    ));
    return destination.stage === 'destination'
      && destination.relayId !== value.entryDescriptor.relayId
      && (value.expiresAt as number) <= destination.expiresAt;
  } catch { return false; }
}

function signable(body: object): Uint8Array {
  return decodeUTF8(`${DOMAIN}\n${canonicalize(body)}`);
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(
    key => `${JSON.stringify(key)}:${canonicalize(value[key])}`,
  ).join(',')}}`;
  throw new Error('Cannot canonicalize private relay forward');
}

function canonicalSignature(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const bytes = decodeBase64(value);
    return bytes.length === 64 && encodeBase64(bytes) === value;
  } catch { return false; }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}
