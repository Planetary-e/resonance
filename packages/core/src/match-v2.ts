/** Relay-signed, replication-safe match decisions for protocol v2. */

import {
  decodeBase64,
  decodeUTF8,
  encodeBase64,
  publicKeyToDid,
  sha512,
  sign,
  verify,
  type Identity,
} from './crypto.js';
import { hammingSimilarity } from './lsh.js';
import {
  PROTOCOL_V2_VERSION,
  verifyPublicationRecord,
  type PublicationFingerprint,
  type PublicationRecord,
} from './protocol-v2.js';

const MATCH_OPERATION_SIGNATURE_DOMAIN = 'resonance:discovery:v2:match-operation';
const MATCH_OPERATION_BODY_KEYS = [
  'createdAt',
  'expiresAt',
  'fingerprint',
  'groupId',
  'kind',
  'matchId',
  'operationId',
  'publications',
  'relayId',
  'relayKey',
  'similarity',
  'version',
];
const MATCH_OPERATION_KEYS = [...MATCH_OPERATION_BODY_KEYS, 'signature'];

export interface MatchPublicationReferenceV2 {
  publicationId: string;
  sequence: number;
  /** Signature of the exact publication revision used for matching. */
  publicationSignature: string;
}

export interface MatchOperationFingerprintV2 {
  algorithm: PublicationFingerprint['algorithm'];
  bits: number;
  epoch: string;
}

export interface MatchOperationBodyV2 {
  version: typeof PROTOCOL_V2_VERSION;
  kind: 'match-operation';
  operationId: string;
  /** Stable across relays for the same pair of publication identities. */
  matchId: string;
  /** Sorted by publication ID and bound to exact signed revisions. */
  publications: [MatchPublicationReferenceV2, MatchPublicationReferenceV2];
  groupId: string;
  fingerprint: MatchOperationFingerprintV2;
  similarity: number;
  createdAt: number;
  expiresAt: number;
  relayId: string;
  /** Base64-encoded Ed25519 infrastructure public key. */
  relayKey: string;
}

export interface MatchOperationV2 extends MatchOperationBodyV2 {
  signature: string;
}

export interface CreateMatchOperationOptionsV2 {
  createdAt?: number;
  expiresAt?: number;
}

export function createDeterministicMatchId(firstPublicationId: string, secondPublicationId: string): string {
  const pair = [firstPublicationId, secondPublicationId].sort();
  const digest = sha512(decodeUTF8(`resonance:discovery:v2:match\n${pair[0]}\n${pair[1]}`)).slice(0, 32);
  return `match_${encodeBase64(digest).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

/**
 * Create a relay attestation for one exact pair of signed publication
 * revisions. The logical match ID converges across relays; the operation ID
 * also binds the relay identity and decision time.
 */
export function createMatchOperationV2(
  first: PublicationRecord,
  second: PublicationRecord,
  relayIdentity: Identity,
  options: CreateMatchOperationOptionsV2 = {},
): MatchOperationV2 {
  if (!verifyPublicationRecord(first) || !verifyPublicationRecord(second)) {
    throw new Error('Cannot match an invalid publication');
  }
  if (!isCompatiblePair(first, second)) {
    throw new Error('Publications are not compatible for matching');
  }
  if (publicKeyToDid(relayIdentity.publicKey) !== relayIdentity.did) {
    throw new Error('Relay identity does not match its public key');
  }

  const createdAt = options.createdAt ?? Date.now();
  const expiresAt = options.expiresAt ?? Math.min(first.expiresAt, second.expiresAt);
  const references = [publicationReference(first), publicationReference(second)]
    .sort((a, b) => compareOpaqueIds(a.publicationId, b.publicationId)) as [
      MatchPublicationReferenceV2,
      MatchPublicationReferenceV2,
    ];
  const base = {
    version: PROTOCOL_V2_VERSION,
    kind: 'match-operation' as const,
    matchId: createDeterministicMatchId(first.publicationId, second.publicationId),
    publications: references,
    groupId: first.groupId,
    fingerprint: {
      algorithm: first.fingerprint.algorithm,
      bits: first.fingerprint.bits,
      epoch: first.fingerprint.epoch,
    },
    similarity: hammingSimilarity(
      decodeBase64(first.fingerprint.value),
      decodeBase64(second.fingerprint.value),
    ),
    createdAt,
    expiresAt,
    relayId: relayIdentity.did,
    relayKey: encodeBase64(relayIdentity.publicKey),
  };
  const body: MatchOperationBodyV2 = {
    ...base,
    operationId: derivedOperationId(base),
  };
  if (!isMatchOperationBody(body)) throw new Error('Invalid match operation input');
  if (!verifyMatchOperationAgainstPublicationsBody(body, first, second, 0)) {
    throw new Error('Match operation does not bind its publications');
  }
  return {
    ...body,
    signature: encodeBase64(sign(signableBytes(body), relayIdentity.secretKey)),
  };
}

/** Verify the strict schema, derived identifiers, infrastructure identity, and relay signature. */
export function verifyMatchOperationV2(value: unknown): value is MatchOperationV2 {
  if (!isObject(value) || !hasOnlyKeys(value, MATCH_OPERATION_KEYS)) return false;
  const { signature, ...body } = value;
  if (typeof signature !== 'string' || !isMatchOperationBody(body)) return false;
  try {
    const decodedSignature = decodeBase64(signature);
    const relayKey = decodeBase64(body.relayKey);
    return decodedSignature.length === 64
      && relayKey.length === 32
      && verify(signableBytes(body), decodedSignature, relayKey);
  } catch {
    return false;
  }
}

/**
 * Audit a signed decision against the exact signed publications it names and
 * a relay's matching threshold. This is usable during historical replay and
 * therefore does not apply the current wall clock.
 */
export function verifyMatchOperationAgainstPublicationsV2(
  operation: MatchOperationV2,
  first: PublicationRecord,
  second: PublicationRecord,
  threshold: number,
): boolean {
  return verifyMatchOperationV2(operation)
    && verifyMatchOperationAgainstPublicationsBody(operation, first, second, threshold);
}

function verifyMatchOperationAgainstPublicationsBody(
  operation: MatchOperationBodyV2,
  first: PublicationRecord,
  second: PublicationRecord,
  threshold: number,
): boolean {
  if (!verifyPublicationRecord(first) || !verifyPublicationRecord(second)) return false;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) return false;
  if (!isCompatiblePair(first, second)) return false;

  const records = [first, second].sort((a, b) => compareOpaqueIds(a.publicationId, b.publicationId));
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const reference = operation.publications[index];
    if (reference.publicationId !== record.publicationId
      || reference.sequence !== record.sequence
      || reference.publicationSignature !== record.signature) return false;
  }

  const similarity = hammingSimilarity(
    decodeBase64(first.fingerprint.value),
    decodeBase64(second.fingerprint.value),
  );
  return operation.matchId === createDeterministicMatchId(first.publicationId, second.publicationId)
    && operation.groupId === first.groupId
    && operation.fingerprint.algorithm === first.fingerprint.algorithm
    && operation.fingerprint.bits === first.fingerprint.bits
    && operation.fingerprint.epoch === first.fingerprint.epoch
    && operation.similarity === similarity
    && similarity >= threshold
    && operation.createdAt >= Math.max(first.createdAt, second.createdAt)
    && operation.expiresAt <= Math.min(first.expiresAt, second.expiresAt)
    && operation.expiresAt > operation.createdAt;
}

function isCompatiblePair(first: PublicationRecord, second: PublicationRecord): boolean {
  return first.publicationId !== second.publicationId
    && first.itemType !== second.itemType
    && first.groupId === second.groupId
    && first.fingerprint.algorithm === second.fingerprint.algorithm
    && first.fingerprint.bits === second.fingerprint.bits
    && first.fingerprint.epoch === second.fingerprint.epoch;
}

function publicationReference(record: PublicationRecord): MatchPublicationReferenceV2 {
  return {
    publicationId: record.publicationId,
    sequence: record.sequence,
    publicationSignature: record.signature,
  };
}

function compareOpaqueIds(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function isMatchOperationBody(value: unknown): value is MatchOperationBodyV2 {
  if (!isObject(value) || !hasOnlyKeys(value, MATCH_OPERATION_BODY_KEYS)) return false;
  if (value.version !== PROTOCOL_V2_VERSION || value.kind !== 'match-operation') return false;
  if (!isOpaqueId(value.operationId, 'mop') || !isOpaqueId(value.matchId, 'match')) return false;
  if (!Array.isArray(value.publications) || value.publications.length !== 2
    || !value.publications.every(isPublicationReference)) return false;
  if (value.publications[0].publicationId >= value.publications[1].publicationId) return false;
  if (value.matchId !== createDeterministicMatchId(
    value.publications[0].publicationId,
    value.publications[1].publicationId,
  )) return false;
  if (!isBoundedName(value.groupId) || !isFingerprint(value.fingerprint)) return false;
  if (typeof value.similarity !== 'number' || !Number.isFinite(value.similarity)
    || value.similarity < 0 || value.similarity > 1) return false;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt)
    || value.expiresAt <= value.createdAt) return false;
  if (typeof value.relayId !== 'string' || !value.relayId.startsWith('did:key:z')) return false;
  if (!isBase64OfLength(value.relayKey, 32)) return false;
  try {
    if (publicKeyToDid(decodeBase64(value.relayKey)) !== value.relayId) return false;
  } catch {
    return false;
  }
  const { operationId: _operationId, ...base } = value;
  return value.operationId === derivedOperationId(base);
}

function isPublicationReference(value: unknown): value is MatchPublicationReferenceV2 {
  return isObject(value)
    && hasOnlyKeys(value, ['publicationId', 'publicationSignature', 'sequence'])
    && isOpaqueId(value.publicationId, 'pub')
    && Number.isSafeInteger(value.sequence)
    && (value.sequence as number) >= 0
    && isBase64OfLength(value.publicationSignature, 64);
}

function isFingerprint(value: unknown): value is MatchOperationFingerprintV2 {
  return isObject(value)
    && hasOnlyKeys(value, ['algorithm', 'bits', 'epoch'])
    && value.algorithm === 'random-hyperplane-lsh'
    && Number.isSafeInteger(value.bits)
    && (value.bits as number) >= 64
    && (value.bits as number) % 8 === 0
    && isBoundedName(value.epoch);
}

function derivedOperationId(value: object): string {
  const digest = sha512(decodeUTF8(`${MATCH_OPERATION_SIGNATURE_DOMAIN}:id\n${canonicalize(value)}`)).slice(0, 32);
  return `mop_${encodeBase64(digest).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function signableBytes(body: MatchOperationBodyV2): Uint8Array {
  return decodeUTF8(`${MATCH_OPERATION_SIGNATURE_DOMAIN}\n${canonicalize(body)}`);
}

function isOpaqueId(value: unknown, prefix: 'mop' | 'match' | 'pub'): value is string {
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
