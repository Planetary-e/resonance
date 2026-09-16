/**
 * Replication-safe discovery operations for protocol v2.
 *
 * These records deliberately contain no account DID. A fresh signing key and
 * mailbox are generated for each publication, limiting relay-visible linkage
 * to that publication and its replicas.
 */

import type { ItemType } from './types.js';
import {
  verifyAdmissionCapabilityV2,
  type AdmissionCapabilityV2,
} from './admission-v2.js';
import {
  decodeBase64,
  decodeUTF8,
  encodeBase64,
  generateEphemeralKeyPair,
  generateSigningKeyPair,
  sign,
  verify,
  type KeyPair,
  type SigningKeyPair,
} from './crypto.js';

export const PROTOCOL_V2_VERSION = 2 as const;
export const PUBLICATION_OPERATION_FRAME_TYPE = 'publication_operation' as const;

const PUBLICATION_SIGNATURE_DOMAIN = 'resonance:discovery:v2:publication';
const TOMBSTONE_SIGNATURE_DOMAIN = 'resonance:discovery:v2:tombstone';
const PUBLICATION_BODY_KEYS = [
  'createdAt',
  'expiresAt',
  'fingerprint',
  'groupId',
  'itemType',
  'kind',
  'mailbox',
  'publicationId',
  'publicationKey',
  'sequence',
  'version',
];
const PUBLICATION_RECORD_KEYS = [...PUBLICATION_BODY_KEYS, 'signature'];
const TOMBSTONE_BODY_KEYS = [
  'createdAt',
  'kind',
  'publicationId',
  'publicationKey',
  'reason',
  'sequence',
  'version',
];
const TOMBSTONE_RECORD_KEYS = [...TOMBSTONE_BODY_KEYS, 'signature'];

export interface PublicationKeyMaterial {
  publicationId: string;
  signingKeyPair: SigningKeyPair;
  mailboxId: string;
  mailboxKeyPair: KeyPair;
}

export interface PublicationMailbox {
  id: string;
  /** Base64-encoded X25519 public key. */
  encryptionKey: string;
}

export interface PublicationFingerprint {
  algorithm: 'random-hyperplane-lsh';
  bits: number;
  epoch: string;
  /** Base64-encoded binary fingerprint. */
  value: string;
}

export interface PublicationRecordBody {
  version: typeof PROTOCOL_V2_VERSION;
  kind: 'publication';
  publicationId: string;
  /** Monotonically increasing owner-controlled revision. */
  sequence: number;
  /** Base64-encoded Ed25519 public key scoped to this publication. */
  publicationKey: string;
  mailbox: PublicationMailbox;
  groupId: string;
  fingerprint: PublicationFingerprint;
  itemType: ItemType;
  createdAt: number;
  expiresAt: number;
}

export interface PublicationRecord extends PublicationRecordBody {
  /** Base64-encoded Ed25519 signature over the canonical record body. */
  signature: string;
}

export type PublicationTombstoneReason = 'withdrawn' | 'expired' | 'superseded';

export interface PublicationTombstoneBody {
  version: typeof PROTOCOL_V2_VERSION;
  kind: 'publication-tombstone';
  publicationId: string;
  sequence: number;
  publicationKey: string;
  reason: PublicationTombstoneReason;
  createdAt: number;
}

export interface PublicationTombstone extends PublicationTombstoneBody {
  /** Base64-encoded Ed25519 signature over the canonical tombstone body. */
  signature: string;
}

export type PublicationOperation = PublicationRecord | PublicationTombstone;

export interface PublicationOperationFrame {
  type: typeof PUBLICATION_OPERATION_FRAME_TYPE;
  operation: PublicationOperation;
  admission?: AdmissionCapabilityV2;
}

export interface CreatePublicationRecordInput {
  groupId: string;
  fingerprintEpoch: string;
  fingerprint: Uint8Array;
  itemType: ItemType;
  createdAt: number;
  expiresAt: number;
  sequence?: number;
}

/** Generate unlinkable signing and mailbox material for one publication. */
export function generatePublicationKeyMaterial(): PublicationKeyMaterial {
  const signingKeyPair = generateSigningKeyPair();
  const mailboxKeyPair = generateEphemeralKeyPair();
  return {
    publicationId: opaqueIdFromBytes('pub', signingKeyPair.publicKey),
    signingKeyPair,
    mailboxId: opaqueIdFromBytes('mbx', mailboxKeyPair.publicKey),
    mailboxKeyPair,
  };
}

/** Build and sign a canonical publication record. */
export function createPublicationRecord(
  input: CreatePublicationRecordInput,
  keys: PublicationKeyMaterial,
): PublicationRecord {
  const body: PublicationRecordBody = {
    version: PROTOCOL_V2_VERSION,
    kind: 'publication',
    publicationId: keys.publicationId,
    sequence: input.sequence ?? 0,
    publicationKey: encodeBase64(keys.signingKeyPair.publicKey),
    mailbox: {
      id: keys.mailboxId,
      encryptionKey: encodeBase64(keys.mailboxKeyPair.publicKey),
    },
    groupId: input.groupId,
    fingerprint: {
      algorithm: 'random-hyperplane-lsh',
      bits: input.fingerprint.length * 8,
      epoch: input.fingerprintEpoch,
      value: encodeBase64(input.fingerprint),
    },
    itemType: input.itemType,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };

  if (!isPublicationRecordBody(body)) {
    throw new Error('Invalid publication record input');
  }

  return {
    ...body,
    signature: encodeBase64(signBody(PUBLICATION_SIGNATURE_DOMAIN, body, keys.signingKeyPair.secretKey)),
  };
}

/** Verify structure and owner signature without applying local expiry policy. */
export function verifyPublicationRecord(value: unknown): value is PublicationRecord {
  if (!isObject(value) || !hasOnlyKeys(value, PUBLICATION_RECORD_KEYS)) return false;
  const { signature, ...body } = value;
  if (typeof signature !== 'string' || !isPublicationRecordBody(body)) return false;

  return verifyBody(
    PUBLICATION_SIGNATURE_DOMAIN,
    body,
    signature,
    body.publicationKey,
  );
}

/** Create an owner-authorized terminal operation for a publication. */
export function createPublicationTombstone(
  record: PublicationRecord,
  reason: PublicationTombstoneReason,
  signingKeyPair: SigningKeyPair,
  createdAt: number,
): PublicationTombstone {
  if (!verifyPublicationRecord(record)) {
    throw new Error('Cannot tombstone an invalid publication record');
  }
  if (encodeBase64(signingKeyPair.publicKey) !== record.publicationKey) {
    throw new Error('Tombstone signing key does not own the publication');
  }

  const body: PublicationTombstoneBody = {
    version: PROTOCOL_V2_VERSION,
    kind: 'publication-tombstone',
    publicationId: record.publicationId,
    sequence: record.sequence + 1,
    publicationKey: record.publicationKey,
    reason,
    createdAt,
  };

  if (!isPublicationTombstoneBody(body)) {
    throw new Error('Invalid publication tombstone input');
  }

  return {
    ...body,
    signature: encodeBase64(signBody(TOMBSTONE_SIGNATURE_DOMAIN, body, signingKeyPair.secretKey)),
  };
}

export function verifyPublicationTombstone(value: unknown): value is PublicationTombstone {
  if (!isObject(value) || !hasOnlyKeys(value, TOMBSTONE_RECORD_KEYS)) return false;
  const { signature, ...body } = value;
  if (typeof signature !== 'string' || !isPublicationTombstoneBody(body)) return false;

  return verifyBody(
    TOMBSTONE_SIGNATURE_DOMAIN,
    body,
    signature,
    body.publicationKey,
  );
}

export function verifyPublicationOperation(value: unknown): value is PublicationOperation {
  return verifyPublicationRecord(value) || verifyPublicationTombstone(value);
}

export function createPublicationOperationFrame(
  operation: PublicationOperation,
  admission?: AdmissionCapabilityV2,
): PublicationOperationFrame {
  if (!verifyPublicationOperation(operation)) {
    throw new Error('Cannot frame an invalid publication operation');
  }
  if (admission !== undefined && !verifyAdmissionCapabilityV2(admission)) {
    throw new Error('Cannot frame an invalid admission capability');
  }
  return admission === undefined
    ? { type: PUBLICATION_OPERATION_FRAME_TYPE, operation }
    : { type: PUBLICATION_OPERATION_FRAME_TYPE, operation, admission };
}

export function parsePublicationOperationFrame(raw: string): PublicationOperationFrame {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed) || !hasFrameKeys(parsed, 'operation')) {
    throw new Error('Invalid publication operation frame');
  }
  if (parsed.type !== PUBLICATION_OPERATION_FRAME_TYPE
    || !verifyPublicationOperation(parsed.operation)
    || ('admission' in parsed && !verifyAdmissionCapabilityV2(parsed.admission))) {
    throw new Error('Invalid publication operation frame');
  }
  return parsed as unknown as PublicationOperationFrame;
}

export function serializePublicationOperationFrame(frame: PublicationOperationFrame): string {
  if (frame.type !== PUBLICATION_OPERATION_FRAME_TYPE
    || !verifyPublicationOperation(frame.operation)
    || (frame.admission !== undefined && !verifyAdmissionCapabilityV2(frame.admission))) {
    throw new Error('Invalid publication operation frame');
  }
  return JSON.stringify(frame);
}

/** Parse an untrusted serialized operation and require a valid owner signature. */
export function parsePublicationOperation(raw: string): PublicationOperation {
  const parsed: unknown = JSON.parse(raw);
  if (!verifyPublicationOperation(parsed)) {
    throw new Error('Invalid publication operation');
  }
  return parsed;
}

/** Expiry is a local policy check and is deliberately separate from signature validity. */
export function isPublicationActive(record: PublicationRecord, now: number): boolean {
  return verifyPublicationRecord(record) && now >= record.createdAt && now < record.expiresAt;
}

function isPublicationRecordBody(value: unknown): value is PublicationRecordBody {
  if (!isObject(value) || !hasOnlyKeys(value, PUBLICATION_BODY_KEYS)) return false;
  if (value.version !== PROTOCOL_V2_VERSION || value.kind !== 'publication') return false;
  if (!isOpaqueId(value.publicationId, 'pub')) return false;
  if (!isSafeSequence(value.sequence)) return false;
  if (!isBase64OfLength(value.publicationKey, 32)) return false;
  if (!idMatchesKey(value.publicationId, 'pub', value.publicationKey)) return false;
  if (!isValidMailbox(value.mailbox)) return false;
  if (!isBoundedName(value.groupId)) return false;
  if (!isValidFingerprint(value.fingerprint)) return false;
  if (value.itemType !== 'need' && value.itemType !== 'offer') return false;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt)) return false;
  return value.expiresAt > value.createdAt;
}

function isPublicationTombstoneBody(value: unknown): value is PublicationTombstoneBody {
  if (!isObject(value) || !hasOnlyKeys(value, TOMBSTONE_BODY_KEYS)) return false;
  if (value.version !== PROTOCOL_V2_VERSION || value.kind !== 'publication-tombstone') return false;
  if (!isOpaqueId(value.publicationId, 'pub')) return false;
  if (!isSafeSequence(value.sequence) || value.sequence < 1) return false;
  if (!isBase64OfLength(value.publicationKey, 32)) return false;
  if (!idMatchesKey(value.publicationId, 'pub', value.publicationKey)) return false;
  if (value.reason !== 'withdrawn' && value.reason !== 'expired' && value.reason !== 'superseded') return false;
  return isTimestamp(value.createdAt);
}

function isValidMailbox(value: unknown): value is PublicationMailbox {
  return isObject(value)
    && hasOnlyKeys(value, ['encryptionKey', 'id'])
    && isOpaqueId(value.id, 'mbx')
    && isBase64OfLength(value.encryptionKey, 32)
    && idMatchesKey(value.id, 'mbx', value.encryptionKey);
}

function isValidFingerprint(value: unknown): value is PublicationFingerprint {
  if (!isObject(value) || !hasOnlyKeys(value, ['algorithm', 'bits', 'epoch', 'value'])) return false;
  if (value.algorithm !== 'random-hyperplane-lsh') return false;
  if (!Number.isSafeInteger(value.bits) || (value.bits as number) < 64 || (value.bits as number) % 8 !== 0) return false;
  if (!isBoundedName(value.epoch)) return false;
  return isBase64OfLength(value.value, (value.bits as number) / 8);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function hasFrameKeys(value: Record<string, unknown>, contentKey: string): boolean {
  return hasOnlyKeys(value, 'admission' in value
    ? ['admission', contentKey, 'type']
    : [contentKey, 'type']);
}

function isSafeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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

function isOpaqueId(value: unknown, prefix: 'pub' | 'mbx'): value is string {
  return typeof value === 'string'
    && new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(value);
}

function isBase64OfLength(value: unknown, length: number): value is string {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  try {
    return decodeBase64(value).length === length;
  } catch {
    return false;
  }
}

function opaqueIdFromBytes(prefix: 'pub' | 'mbx', bytes: Uint8Array): string {
  const base64url = encodeBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${prefix}_${base64url}`;
}

function idMatchesKey(id: string, prefix: 'pub' | 'mbx', encodedKey: string): boolean {
  try {
    return id === opaqueIdFromBytes(prefix, decodeBase64(encodedKey));
  } catch {
    return false;
  }
}

function signBody(domain: string, body: object, secretKey: Uint8Array): Uint8Array {
  return sign(signableBytes(domain, body), secretKey);
}

function verifyBody(domain: string, body: object, signature: string, publicKey: string): boolean {
  try {
    const decodedSignature = decodeBase64(signature);
    const decodedPublicKey = decodeBase64(publicKey);
    if (decodedSignature.length !== 64 || decodedPublicKey.length !== 32) return false;
    return verify(signableBytes(domain, body), decodedSignature, decodedPublicKey);
  } catch {
    return false;
  }
}

function signableBytes(domain: string, body: object): Uint8Array {
  return decodeUTF8(`${domain}\n${canonicalize(body)}`);
}

/** Deterministic JSON encoding with lexicographically sorted object keys. */
function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalize a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (isObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`Cannot canonicalize ${typeof value}`);
}
