/** Bounded HPKE layers for one private request through two volunteer relays. */

import { randomBytes } from 'node:crypto';
import { Aes128Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import {
  decodeBase64, decodeUTF8, didToPublicKey, encodeBase64, encodeUTF8, publicKeyToDid,
  sha512, sign, verify, type Identity,
} from './crypto.js';

export const PRIVATE_ENVELOPE_VERSION = 1 as const;
export const MAX_PRIVATE_REQUEST_BYTES = 256 * 1024;
export const MAX_PRIVATE_FRAME_BYTES = 512 * 1024;
export const MAX_PRIVATE_KEY_LIFETIME_MS = 15 * 60 * 1000;
export const MAX_PRIVATE_REQUEST_LIFETIME_MS = 30 * 1000;

const KEY_DOMAIN = 'resonance:private-transport:v1:key';
const ENTRY_INFO = decodeUTF8('resonance:private-transport:v1:entry');
const DESTINATION_INFO = decodeUTF8('resonance:private-transport:v1:destination');
const RESPONSE_INFO = decodeUTF8('resonance:private-transport:v1:response');
const KEY_BODY_KEYS = ['expiresAt', 'issuedAt', 'keyId', 'kind', 'publicKey', 'relayId', 'version'];
const LAYER_KEYS = ['ciphertext', 'enc', 'expiresAt', 'keyId', 'relayId', 'requestId', 'stage', 'version'];
const FORWARD_KEYS = ['destination', 'expiresAt', 'kind', 'requestId', 'version'];
const PAYLOAD_KEYS = ['data', 'expiresAt', 'kind', 'requestId', 'responseKey', 'version'];
const RESPONSE_KEYS = ['ciphertext', 'destinationRelayId', 'enc', 'requestId', 'type', 'version'];
const DEFAULT_REPLAY_CAPACITY = 4096;

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});

export interface RelayTransportKeyV1 {
  version: typeof PRIVATE_ENVELOPE_VERSION;
  kind: 'relay-transport-key';
  relayId: string;
  keyId: string;
  /** Base64 of the uncompressed P-256 HPKE public key. */
  publicKey: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export interface RelayTransportKeyMaterialV1 {
  attestation: RelayTransportKeyV1;
  privateKey: CryptoKey;
}

export interface PrivateRequestLayerV1 {
  version: typeof PRIVATE_ENVELOPE_VERSION;
  stage: 'entry' | 'destination';
  relayId: string;
  keyId: string;
  requestId: string;
  expiresAt: number;
  /** Base64 of HPKE's encapsulated P-256 key. */
  enc: string;
  ciphertext: string;
}

export interface PrivateRequestExchangeV1 {
  request: PrivateRequestLayerV1;
  /** One-use recipient key; remains with the client. */
  responsePrivateKey: CryptoKey;
}

export interface PrivateDestinationPayloadV1 {
  data: Uint8Array;
  responseKey: string;
}

export interface PrivateResponseV1 {
  version: typeof PRIVATE_ENVELOPE_VERSION;
  type: 'private_response';
  requestId: string;
  destinationRelayId: string;
  enc: string;
  ciphertext: string;
}

export interface PrivateReplayRecordV1 {
  id: string;
  expiresAt: number;
}

/** Short-lived, bounded replay rejection for a relay process. */
export class PrivateRequestReplayCacheV1 {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly capacity = DEFAULT_REPLAY_CAPACITY,
    restored: readonly PrivateReplayRecordV1[] = [],
    private readonly persist?: (record: PrivateReplayRecordV1) => void,
    now = Date.now(),
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 65_536) {
      throw new Error('Invalid private request replay capacity');
    }
    if (!validTimestamp(now) || !Array.isArray(restored) || restored.length > capacity) {
      throw new Error('Invalid restored private replay entries');
    }
    for (const record of restored) {
      if (!record || typeof record.id !== 'string' || record.id.length > 256
        || !/^[A-Za-z0-9:_-]+$/.test(record.id)
        || !validTimestamp(record.expiresAt)) {
        throw new Error('Invalid restored private replay entry');
      }
      if (record.expiresAt <= now) continue;
      if (this.seen.has(record.id)) throw new Error('Duplicate restored private replay entry');
      this.seen.set(record.id, record.expiresAt);
    }
  }

  consume(layer: PrivateRequestLayerV1, now: number): void {
    if (!validLayer(layer) || !validTimestamp(now) || now >= layer.expiresAt) {
      throw new Error('Invalid or expired private replay entry');
    }
    for (const [id, expiresAt] of this.seen) {
      if (now >= expiresAt) this.seen.delete(id);
    }
    const id = `${layer.stage}:${layer.relayId}:${layer.keyId}:${layer.requestId}`;
    if (this.seen.has(id)) throw new Error('Replayed private request');
    if (this.seen.size >= this.capacity) throw new Error('Private replay cache is full');
    // A durable adapter must fsync before this request can be forwarded or applied.
    this.persist?.({ id, expiresAt: layer.expiresAt });
    this.seen.set(id, layer.expiresAt);
  }
}

/** Create a short-lived encryption key authenticated by a relay signing key. */
export async function generateRelayTransportKeyV1(
  identity: Identity,
  issuedAt = Date.now(),
): Promise<RelayTransportKeyMaterialV1> {
  if (!validTimestamp(issuedAt) || identity.publicKey.length !== 32
    || publicKeyToDid(identity.publicKey) !== identity.did
    || identity.secretKey.length !== 64
    || encodeBase64(identity.secretKey.subarray(32)) !== encodeBase64(identity.publicKey)) {
    throw new Error('Invalid relay transport key identity');
  }
  const keys = await suite.kem.generateKeyPair();
  const publicBytes = new Uint8Array(await suite.kem.serializePublicKey(keys.publicKey));
  const body = {
    version: PRIVATE_ENVELOPE_VERSION,
    kind: 'relay-transport-key' as const,
    relayId: identity.did,
    keyId: base64url(sha512(publicBytes).subarray(0, 16)),
    publicKey: encodeBase64(publicBytes),
    issuedAt,
    expiresAt: issuedAt + MAX_PRIVATE_KEY_LIFETIME_MS,
  };
  return {
    attestation: {
      ...body,
      signature: encodeBase64(sign(signableKey(body), identity.secretKey)),
    },
    privateKey: keys.privateKey,
  };
}

export function verifyRelayTransportKeyV1(value: unknown): value is RelayTransportKeyV1 {
  if (!object(value) || !exactKeys(value, [...KEY_BODY_KEYS, 'signature'])) return false;
  const { signature, ...body } = value;
  if (body.version !== PRIVATE_ENVELOPE_VERSION || body.kind !== 'relay-transport-key'
    || typeof body.relayId !== 'string' || typeof body.keyId !== 'string'
    || !/^[-_A-Za-z0-9]{22}$/.test(body.keyId)
    || !canonicalBase64(body.publicKey, 65)
    || !canonicalBase64(signature, 64)
    || !validTimestamp(body.issuedAt) || !validTimestamp(body.expiresAt)
    || body.expiresAt <= body.issuedAt
    || body.expiresAt - body.issuedAt > MAX_PRIVATE_KEY_LIFETIME_MS) return false;
  const publicBytes = decodeBase64(body.publicKey);
  if (publicBytes[0] !== 4
    || body.keyId !== base64url(sha512(publicBytes).subarray(0, 16))) return false;
  try {
    const relayKey = didToPublicKey(body.relayId);
    return relayKey.length === 32
      && verify(signableKey(body), decodeBase64(signature), relayKey);
  } catch { return false; }
}

export function isRelayTransportKeyActiveV1(
  value: unknown, now: number,
): value is RelayTransportKeyV1 {
  return validTimestamp(now) && verifyRelayTransportKeyV1(value)
    && now >= value.issuedAt && now < value.expiresAt;
}

/** Encrypt the operation for the destination, then the forward instruction for the entry. */
export async function createPrivateRequestV1(
  data: Uint8Array,
  entry: RelayTransportKeyV1,
  destination: RelayTransportKeyV1,
  now = Date.now(),
): Promise<PrivateRequestExchangeV1> {
  if (!(data instanceof Uint8Array) || data.length < 1
    || data.length > MAX_PRIVATE_REQUEST_BYTES
    || !isRelayTransportKeyActiveV1(entry, now)
    || !isRelayTransportKeyActiveV1(destination, now)
    || entry.relayId === destination.relayId) {
    throw new Error('Invalid private request input');
  }
  const expiresAt = Math.min(
    now + MAX_PRIVATE_REQUEST_LIFETIME_MS,
    entry.expiresAt,
    destination.expiresAt,
  );
  if (expiresAt <= now) throw new Error('Private request keys expire too soon');
  const requestId = base64url(randomBytes(16));
  const responseKeys = await suite.kem.generateKeyPair();
  const responseKey = encodeBase64(new Uint8Array(
    await suite.kem.serializePublicKey(responseKeys.publicKey),
  ));
  const inner = await sealLayer('destination', destination, requestId, expiresAt,
    decodeUTF8(JSON.stringify({
      version: PRIVATE_ENVELOPE_VERSION,
      kind: 'private-payload',
      requestId,
      expiresAt,
      data: encodeBase64(data),
      responseKey,
    })));
  const request = await sealLayer('entry', entry, requestId, expiresAt,
    decodeUTF8(JSON.stringify({
      version: PRIVATE_ENVELOPE_VERSION,
      kind: 'private-forward',
      requestId,
      expiresAt,
      destination: inner,
    })));
  return { request, responsePrivateKey: responseKeys.privateKey };
}

/** The entry learns the destination and opaque inner layer, never the operation. */
export async function openPrivateEntryRequestV1(
  layer: PrivateRequestLayerV1,
  key: RelayTransportKeyMaterialV1,
  replay: PrivateRequestReplayCacheV1,
  now = Date.now(),
): Promise<PrivateRequestLayerV1> {
  const plaintext = await openLayer(layer, key, 'entry', now);
  const instruction = parseBounded(encodeUTF8(plaintext));
  if (!object(instruction) || !exactKeys(instruction, FORWARD_KEYS)
    || instruction.version !== PRIVATE_ENVELOPE_VERSION
    || instruction.kind !== 'private-forward'
    || instruction.requestId !== layer.requestId
    || instruction.expiresAt !== layer.expiresAt
    || !validLayer(instruction.destination, 'destination')
    || instruction.destination.requestId !== layer.requestId
    || instruction.destination.expiresAt !== layer.expiresAt
    || instruction.destination.relayId === layer.relayId) {
    throw new Error('Invalid private forward instruction');
  }
  replay.consume(layer, now);
  return instruction.destination;
}

/** The destination learns the operation, but receives no client address or identity here. */
export async function openPrivateDestinationRequestV1(
  layer: PrivateRequestLayerV1,
  key: RelayTransportKeyMaterialV1,
  replay: PrivateRequestReplayCacheV1,
  now = Date.now(),
): Promise<PrivateDestinationPayloadV1> {
  const plaintext = await openLayer(layer, key, 'destination', now);
  const payload = parseBounded(encodeUTF8(plaintext));
  if (!object(payload) || !exactKeys(payload, PAYLOAD_KEYS)
    || payload.version !== PRIVATE_ENVELOPE_VERSION
    || payload.kind !== 'private-payload'
    || payload.requestId !== layer.requestId
    || payload.expiresAt !== layer.expiresAt
    || !canonicalBase64(payload.data)
    || !canonicalBase64(payload.responseKey, 65)) {
    throw new Error('Invalid private destination payload');
  }
  const data = decodeBase64(payload.data);
  if (data.length < 1 || data.length > MAX_PRIVATE_REQUEST_BYTES) {
    throw new Error('Invalid private destination payload size');
  }
  replay.consume(layer, now);
  return { data, responseKey: payload.responseKey };
}

/** Encrypt a destination-signed reply so the entry cannot inspect its contents. */
export async function createPrivateResponseV1(
  signedReply: Uint8Array,
  responseKey: string,
  requestId: string,
  destinationRelayId: string,
): Promise<PrivateResponseV1> {
  if (!(signedReply instanceof Uint8Array) || signedReply.length < 1
    || signedReply.length > MAX_PRIVATE_REQUEST_BYTES
    || !canonicalBase64(responseKey, 65)
    || !/^[-_A-Za-z0-9]{22}$/.test(requestId)
    || !validRelayId(destinationRelayId)) throw new Error('Invalid private response input');
  const recipientPublicKey = await suite.kem.deserializePublicKey(decodeBase64(responseKey));
  const sender = await suite.createSenderContext({
    recipientPublicKey,
    info: RESPONSE_INFO,
  });
  const ciphertext = await sender.seal(
    signedReply, aad('response', destinationRelayId, '', requestId, 0),
  );
  const response: PrivateResponseV1 = {
    version: PRIVATE_ENVELOPE_VERSION,
    type: 'private_response',
    requestId,
    destinationRelayId,
    enc: encodeBase64(new Uint8Array(sender.enc)),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };
  serializePrivateResponseV1(response);
  return response;
}

export async function openPrivateResponseV1(
  response: PrivateResponseV1,
  privateKey: CryptoKey,
  requestId: string,
  destinationRelayId: string,
): Promise<Uint8Array> {
  if (!validResponse(response) || response.requestId !== requestId
    || response.destinationRelayId !== destinationRelayId) {
    throw new Error('Invalid private response');
  }
  const recipient = await suite.createRecipientContext({
    recipientKey: privateKey,
    enc: decodeBase64(response.enc),
    info: RESPONSE_INFO,
  });
  return new Uint8Array(await recipient.open(
    decodeBase64(response.ciphertext),
    aad('response', destinationRelayId, '', requestId, 0),
  ));
}

export function serializePrivateResponseV1(response: PrivateResponseV1): string {
  if (!validResponse(response)) throw new Error('Invalid private response');
  const raw = JSON.stringify(response);
  if (decodeUTF8(raw).length > MAX_PRIVATE_FRAME_BYTES) {
    throw new Error('Private response exceeds the maximum size');
  }
  return raw;
}

export function parsePrivateResponseV1(raw: string): PrivateResponseV1 {
  const parsed = parseBounded(raw);
  if (!validResponse(parsed)) throw new Error('Invalid private response');
  return parsed;
}

export function serializePrivateRequestLayerV1(layer: PrivateRequestLayerV1): string {
  if (!validLayer(layer)) throw new Error('Invalid private request layer');
  const raw = JSON.stringify(layer);
  if (decodeUTF8(raw).length > MAX_PRIVATE_FRAME_BYTES) {
    throw new Error('Private request frame exceeds the maximum size');
  }
  return raw;
}

export function parsePrivateRequestLayerV1(raw: string): PrivateRequestLayerV1 {
  const parsed = parseBounded(raw);
  if (!validLayer(parsed)) throw new Error('Invalid private request layer');
  return parsed;
}

async function sealLayer(
  stage: PrivateRequestLayerV1['stage'],
  key: RelayTransportKeyV1,
  requestId: string,
  expiresAt: number,
  plaintext: Uint8Array,
): Promise<PrivateRequestLayerV1> {
  const relayId = key.relayId;
  const keyId = key.keyId;
  const recipientPublicKey = await suite.kem.deserializePublicKey(decodeBase64(key.publicKey));
  const sender = await suite.createSenderContext({
    recipientPublicKey,
    info: stage === 'entry' ? ENTRY_INFO : DESTINATION_INFO,
  });
  const ciphertext = await sender.seal(plaintext, aad(stage, relayId, keyId, requestId, expiresAt));
  const layer: PrivateRequestLayerV1 = {
    version: PRIVATE_ENVELOPE_VERSION,
    stage,
    relayId,
    keyId,
    requestId,
    expiresAt,
    enc: encodeBase64(new Uint8Array(sender.enc)),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };
  if (!validLayer(layer) || decodeUTF8(JSON.stringify(layer)).length > MAX_PRIVATE_FRAME_BYTES) {
    throw new Error('Private request frame exceeds the maximum size');
  }
  return layer;
}

async function openLayer(
  layer: PrivateRequestLayerV1,
  key: RelayTransportKeyMaterialV1,
  stage: PrivateRequestLayerV1['stage'],
  now: number,
): Promise<Uint8Array> {
  if (!validLayer(layer, stage) || !isRelayTransportKeyActiveV1(key.attestation, now)
    || layer.relayId !== key.attestation.relayId
    || layer.keyId !== key.attestation.keyId
    || now >= layer.expiresAt || layer.expiresAt > key.attestation.expiresAt
    || layer.expiresAt - now > MAX_PRIVATE_REQUEST_LIFETIME_MS
    || decodeUTF8(JSON.stringify(layer)).length > MAX_PRIVATE_FRAME_BYTES) {
    throw new Error('Invalid or expired private request layer');
  }
  const recipient = await suite.createRecipientContext({
    recipientKey: key.privateKey,
    enc: decodeBase64(layer.enc),
    info: stage === 'entry' ? ENTRY_INFO : DESTINATION_INFO,
  });
  const plaintext = await recipient.open(
    decodeBase64(layer.ciphertext),
    aad(stage, layer.relayId, layer.keyId, layer.requestId, layer.expiresAt),
  );
  return new Uint8Array(plaintext);
}

function validLayer(value: unknown, stage?: PrivateRequestLayerV1['stage']): value is PrivateRequestLayerV1 {
  return object(value) && exactKeys(value, LAYER_KEYS)
    && value.version === PRIVATE_ENVELOPE_VERSION
    && (value.stage === 'entry' || value.stage === 'destination')
    && (stage === undefined || value.stage === stage)
    && typeof value.relayId === 'string' && validRelayId(value.relayId)
    && typeof value.keyId === 'string' && /^[-_A-Za-z0-9]{22}$/.test(value.keyId)
    && typeof value.requestId === 'string' && /^[-_A-Za-z0-9]{22}$/.test(value.requestId)
    && validTimestamp(value.expiresAt)
    && canonicalBase64(value.enc, 65)
    && canonicalBase64(value.ciphertext)
    && value.ciphertext.length <= MAX_PRIVATE_FRAME_BYTES;
}

function validResponse(value: unknown): value is PrivateResponseV1 {
  return object(value) && exactKeys(value, RESPONSE_KEYS)
    && value.version === PRIVATE_ENVELOPE_VERSION
    && value.type === 'private_response'
    && typeof value.requestId === 'string' && /^[-_A-Za-z0-9]{22}$/.test(value.requestId)
    && typeof value.destinationRelayId === 'string' && validRelayId(value.destinationRelayId)
    && canonicalBase64(value.enc, 65)
    && canonicalBase64(value.ciphertext)
    && value.ciphertext.length <= MAX_PRIVATE_FRAME_BYTES;
}

function aad(stage: string, relayId: string, keyId: string, requestId: string, expiresAt: number): Uint8Array {
  return decodeUTF8(JSON.stringify([
    `resonance:private-transport:v1:${stage}`, relayId, keyId, requestId, expiresAt,
  ]));
}

function signableKey(body: object): Uint8Array {
  const fields = body as Record<string, unknown>;
  return decodeUTF8(`${KEY_DOMAIN}\n${JSON.stringify(
    Object.fromEntries(KEY_BODY_KEYS.map(key => [key, fields[key]])),
  )}`);
}

function parseBounded(raw: string): unknown {
  if (typeof raw !== 'string' || decodeUTF8(raw).length > MAX_PRIVATE_FRAME_BYTES) {
    throw new Error('Private request frame exceeds the maximum size');
  }
  return JSON.parse(raw) as unknown;
}

function validRelayId(value: string): boolean {
  try {
    const publicKey = didToPublicKey(value);
    return publicKey.length === 32 && publicKeyToDid(publicKey) === value;
  }
  catch { return false; }
}

function canonicalBase64(value: unknown, expectedLength?: number): value is string {
  if (typeof value !== 'string' || value.length > MAX_PRIVATE_FRAME_BYTES) return false;
  try {
    const decoded = decodeBase64(value);
    return (expectedLength === undefined || decoded.length === expectedLength)
      && encodeBase64(decoded) === value;
  } catch { return false; }
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function base64url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
