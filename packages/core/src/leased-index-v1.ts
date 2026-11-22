import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ItemType } from './types.js';
import {
  decodeBase64,
  decodeUTF8,
  encodeBase64,
  sha512,
  sign,
  verify,
} from './crypto.js';
import {
  generatePublicationKeyMaterial,
  type PublicationKeyMaterial,
  type PublicationMailbox,
} from './protocol-v2.js';

export const LEASED_INDEX_V1_VERSION = 1 as const;
export const LEASED_INDEX_KIND = 'leased-discovery-index' as const;
export const MAX_LEASED_INDEX_BYTES = 4096;
export const MAX_LEASE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ORIGINAL_BYTES = 8192;

const LEASED_INDEX_SIGNATURE_DOMAIN = 'resonance:leased-discovery-index:v1';
const ORIGINAL_COMMITMENT_DOMAIN = 'resonance:leased-content:v1\0';
const BODY_KEYS = [
  'clientLeaseId',
  'createdAt',
  'derivationId',
  'expiresAt',
  'fingerprint',
  'groupId',
  'itemType',
  'kind',
  'leaseSequence',
  'mailbox',
  'original',
  'publicationId',
  'publicationKey',
  'semanticRevision',
  'version',
];
const RECORD_KEYS = [...BODY_KEYS, 'signature'];

export interface LeasedIndexKeyMaterialV1 extends PublicationKeyMaterial {
  clientLeaseId: string;
}

export interface LeasedIndexFingerprintV1 {
  algorithm: 'random-hyperplane-lsh';
  bits: 512;
  epoch: string;
  value: string;
}

export interface LeasedIndexOriginalV1 {
  commitmentAlgorithm: 'hmac-sha256';
  commitment: string;
}

export interface LeasedIndexBodyV1 {
  version: typeof LEASED_INDEX_V1_VERSION;
  kind: typeof LEASED_INDEX_KIND;
  publicationId: string;
  clientLeaseId: string;
  leaseSequence: number;
  semanticRevision: number;
  publicationKey: string;
  groupId: string;
  itemType: ItemType;
  derivationId: string;
  fingerprint: LeasedIndexFingerprintV1;
  original: LeasedIndexOriginalV1;
  mailbox: PublicationMailbox;
  createdAt: number;
  expiresAt: number;
}

export interface LeasedIndexV1 extends LeasedIndexBodyV1 {
  signature: string;
}

export interface CreateLeasedIndexInputV1 {
  leaseSequence?: number;
  semanticRevision?: number;
  groupId: string;
  itemType: ItemType;
  derivationId: string;
  fingerprintEpoch: string;
  fingerprint: Uint8Array;
  originalCommitment: string;
  createdAt: number;
  expiresAt: number;
}

export type LeasedIndexReplayStatusV1 =
  | 'accepted'
  | 'duplicate'
  | 'stale'
  | 'conflict'
  | 'not_yet_valid'
  | 'expired';

export interface LeasedIndexReplayResultV1 {
  status: LeasedIndexReplayStatusV1;
  generationId: string;
  retainedBytes: number;
  conflictBytes?: Uint8Array;
}

interface RetainedLeasedIndex {
  bytes: Uint8Array;
  generationId: string;
  conflictBytes?: Uint8Array;
  conflictGenerationId?: string;
}

export function generateLeasedIndexKeyMaterialV1(): LeasedIndexKeyMaterialV1 {
  const keys = generatePublicationKeyMaterial();
  return {
    ...keys,
    clientLeaseId: opaqueIdFromBytes('lease', keys.signingKeyPair.publicKey),
  };
}

export function generateOriginalCommitmentKeyV1(): Uint8Array {
  return Uint8Array.from(randomBytes(32));
}

export function createOriginalCommitmentV1(
  originalBytes: Uint8Array,
  commitmentKey: Uint8Array,
): string {
  validateOriginalInputs(originalBytes, commitmentKey);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(originalBytes.byteLength));
  const commitment = createHmac('sha256', Buffer.from(commitmentKey))
    .update(Buffer.from(ORIGINAL_COMMITMENT_DOMAIN, 'utf8'))
    .update(length)
    .update(Buffer.from(originalBytes))
    .digest();
  return encodeBase64(commitment);
}

export function verifyOriginalCommitmentV1(
  originalBytes: Uint8Array,
  commitmentKey: Uint8Array,
  expectedCommitment: unknown,
): boolean {
  try {
    validateOriginalInputs(originalBytes, commitmentKey);
    if (!isBase64OfLength(expectedCommitment, 32)) return false;
    const actual = Buffer.from(decodeBase64(createOriginalCommitmentV1(originalBytes, commitmentKey)));
    const expected = Buffer.from(decodeBase64(expectedCommitment));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function createLeasedIndexV1(
  input: CreateLeasedIndexInputV1,
  keys: LeasedIndexKeyMaterialV1,
): LeasedIndexV1 {
  if (!(input.fingerprint instanceof Uint8Array)) throw new Error('Invalid leased index input');
  const body: LeasedIndexBodyV1 = {
    version: LEASED_INDEX_V1_VERSION,
    kind: LEASED_INDEX_KIND,
    publicationId: keys.publicationId,
    clientLeaseId: keys.clientLeaseId,
    leaseSequence: input.leaseSequence ?? 0,
    semanticRevision: input.semanticRevision ?? 0,
    publicationKey: encodeBase64(keys.signingKeyPair.publicKey),
    groupId: input.groupId,
    itemType: input.itemType,
    derivationId: input.derivationId,
    fingerprint: {
      algorithm: 'random-hyperplane-lsh',
      bits: 512,
      epoch: input.fingerprintEpoch,
      value: encodeBase64(input.fingerprint),
    },
    original: {
      commitmentAlgorithm: 'hmac-sha256',
      commitment: input.originalCommitment,
    },
    mailbox: {
      id: keys.mailboxId,
      encryptionKey: encodeBase64(keys.mailboxKeyPair.publicKey),
    },
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  if (!isLeasedIndexBody(body)) throw new Error('Invalid leased index input');
  const record = {
    ...body,
    signature: encodeBase64(sign(signableBody(body), keys.signingKeyPair.secretKey)),
  };
  if (serializedSize(record) > MAX_LEASED_INDEX_BYTES) throw new Error('Leased index exceeds size limit');
  return record;
}

export function verifyLeasedIndexV1(value: unknown): value is LeasedIndexV1 {
  if (!isObject(value) || !hasOnlyKeys(value, RECORD_KEYS)) return false;
  const { signature, ...body } = value;
  if (typeof signature !== 'string' || !isBase64OfLength(signature, 64) || !isLeasedIndexBody(body)) {
    return false;
  }
  try {
    return verify(
      signableBody(body),
      decodeBase64(signature),
      decodeBase64(body.publicationKey),
    ) && serializedSize(value) <= MAX_LEASED_INDEX_BYTES;
  } catch {
    return false;
  }
}

export function serializeLeasedIndexV1(record: LeasedIndexV1): string {
  if (!verifyLeasedIndexV1(record)) throw new Error('Cannot serialize an invalid leased index');
  return canonicalize(record);
}

export function parseLeasedIndexV1(raw: string): LeasedIndexV1 {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_LEASED_INDEX_BYTES) {
    throw new Error('Invalid leased index');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Invalid leased index'); }
  if (!verifyLeasedIndexV1(parsed)) throw new Error('Invalid leased index');
  return parsed;
}

export function createLeasedIndexGenerationIdV1(record: LeasedIndexV1): string {
  if (!verifyLeasedIndexV1(record)) throw new Error('Cannot identify an invalid leased index');
  return derivedId('gen', `resonance:leased-index-generation:v1\n${canonicalize(record)}`);
}

export function isLeasedIndexActiveV1(record: LeasedIndexV1, now: number): boolean {
  return isTimestamp(now)
    && verifyLeasedIndexV1(record)
    && now >= record.createdAt
    && now < record.expiresAt;
}

export class LeasedIndexReplayV1 {
  private readonly records = new Map<string, Map<number, RetainedLeasedIndex>>();
  private retainedBytes = 0;

  submit(raw: string | Uint8Array, now: number): LeasedIndexReplayResultV1 {
    const bytes = exactBytes(raw);
    const record = parseLeasedIndexV1(encodeUTF8Fatal(bytes));
    const generationId = createLeasedIndexGenerationIdV1(record);
    const bySequence = this.records.get(record.publicationId);
    const prior = bySequence?.get(record.leaseSequence);
    if (prior && bytesEqual(prior.bytes, bytes)) {
      return { status: 'duplicate', generationId: prior.generationId, retainedBytes: this.retainedBytes };
    }
    if (prior?.conflictBytes && bytesEqual(prior.conflictBytes, bytes)) {
      return {
        status: 'conflict',
        generationId: prior.conflictGenerationId!,
        retainedBytes: this.retainedBytes,
        conflictBytes: Uint8Array.from(prior.conflictBytes),
      };
    }
    const currentSequence = bySequence ? Math.max(...bySequence.keys()) : -1;
    if (record.leaseSequence < currentSequence) {
      return { status: 'stale', generationId, retainedBytes: this.retainedBytes };
    }
    if (prior) {
      if (!isTimestamp(now) || now < record.createdAt || now >= record.expiresAt) {
        return {
          status: now < record.createdAt ? 'not_yet_valid' : 'expired',
          generationId,
          retainedBytes: this.retainedBytes,
        };
      }
      if (!prior.conflictBytes) {
        prior.conflictBytes = Uint8Array.from(bytes);
        prior.conflictGenerationId = generationId;
        this.retainedBytes += bytes.byteLength;
      }
      return {
        status: 'conflict',
        generationId,
        retainedBytes: this.retainedBytes,
        conflictBytes: Uint8Array.from(prior.conflictBytes),
      };
    }

    if (!isTimestamp(now) || now < record.createdAt || now >= record.expiresAt) {
      return {
        status: isTimestamp(now) && now < record.createdAt ? 'not_yet_valid' : 'expired',
        generationId,
        retainedBytes: this.retainedBytes,
      };
    }
    const generations = bySequence ?? new Map<number, RetainedLeasedIndex>();
    generations.set(record.leaseSequence, { bytes: Uint8Array.from(bytes), generationId });
    if (!bySequence) this.records.set(record.publicationId, generations);
    this.retainedBytes += bytes.byteLength;
    return { status: 'accepted', generationId, retainedBytes: this.retainedBytes };
  }

  get sizeBytes(): number {
    return this.retainedBytes;
  }
}

function isLeasedIndexBody(value: unknown): value is LeasedIndexBodyV1 {
  if (!isObject(value) || !hasOnlyKeys(value, BODY_KEYS)) return false;
  if (value.version !== LEASED_INDEX_V1_VERSION || value.kind !== LEASED_INDEX_KIND) return false;
  if (!isOpaqueId(value.publicationId, 'pub') || !isOpaqueId(value.clientLeaseId, 'lease')) return false;
  if (!isSafeCounter(value.leaseSequence) || !isSafeCounter(value.semanticRevision)) return false;
  if (!isBase64OfLength(value.publicationKey, 32)
    || !idMatchesKey(value.publicationId, 'pub', value.publicationKey)) return false;
  if (!isBoundedName(value.groupId) || !isBoundedName(value.derivationId)) return false;
  if (value.itemType !== 'need' && value.itemType !== 'offer') return false;
  if (!isFingerprint(value.fingerprint) || !isOriginal(value.original) || !isMailbox(value.mailbox)) return false;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt)) return false;
  return value.expiresAt > value.createdAt
    && value.expiresAt - value.createdAt <= MAX_LEASE_DURATION_MS;
}

function isFingerprint(value: unknown): value is LeasedIndexFingerprintV1 {
  return isObject(value)
    && hasOnlyKeys(value, ['algorithm', 'bits', 'epoch', 'value'])
    && value.algorithm === 'random-hyperplane-lsh'
    && value.bits === 512
    && isBoundedName(value.epoch)
    && isBase64OfLength(value.value, 64);
}

function isOriginal(value: unknown): value is LeasedIndexOriginalV1 {
  return isObject(value)
    && hasOnlyKeys(value, ['commitment', 'commitmentAlgorithm'])
    && value.commitmentAlgorithm === 'hmac-sha256'
    && isBase64OfLength(value.commitment, 32);
}

function isMailbox(value: unknown): value is PublicationMailbox {
  return isObject(value)
    && hasOnlyKeys(value, ['encryptionKey', 'id'])
    && isOpaqueId(value.id, 'mbx')
    && isBase64OfLength(value.encryptionKey, 32)
    && idMatchesKey(value.id, 'mbx', value.encryptionKey);
}

function signableBody(body: LeasedIndexBodyV1): Uint8Array {
  return decodeUTF8(`${LEASED_INDEX_SIGNATURE_DOMAIN}\n${canonicalize(body)}`);
}

function validateOriginalInputs(originalBytes: Uint8Array, commitmentKey: Uint8Array): void {
  if (!(originalBytes instanceof Uint8Array) || originalBytes.byteLength > MAX_ORIGINAL_BYTES
    || !(commitmentKey instanceof Uint8Array) || commitmentKey.byteLength !== 32) {
    throw new Error('Invalid original commitment input');
  }
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

function derivedId(prefix: 'gen', input: string): string {
  return opaqueIdFromBytes(prefix, sha512(decodeUTF8(input)).slice(0, 32));
}

function opaqueIdFromBytes(prefix: 'pub' | 'mbx' | 'lease' | 'gen', bytes: Uint8Array): string {
  return `${prefix}_${encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function idMatchesKey(id: string, prefix: 'pub' | 'mbx', encodedKey: string): boolean {
  try { return id === opaqueIdFromBytes(prefix, decodeBase64(encodedKey)); } catch { return false; }
}

function isOpaqueId(value: unknown, prefix: 'pub' | 'mbx' | 'lease' | 'gen'): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(value);
}

function isBase64OfLength(value: unknown, length: number): value is string {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  try { return decodeBase64(value).length === length && encodeBase64(decodeBase64(value)) === value; } catch { return false; }
}

function isSafeCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && Buffer.byteLength(value) <= 256
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
  if (!(raw instanceof Uint8Array) || raw.byteLength > MAX_LEASED_INDEX_BYTES) throw new Error('Invalid leased index');
  return Uint8Array.from(raw);
}

function encodeUTF8Fatal(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Invalid leased index'); }
}

function bytesEqual(first: Uint8Array, second: Uint8Array): boolean {
  return first.byteLength === second.byteLength && timingSafeEqual(Buffer.from(first), Buffer.from(second));
}
