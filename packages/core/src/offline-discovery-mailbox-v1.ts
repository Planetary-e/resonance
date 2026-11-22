import {
  boxDecrypt,
  boxEncrypt,
  decodeBase64,
  decodeUTF8,
  didToPublicKey,
  encodeBase64,
  generateEphemeralKeyPair,
  publicKeyToDid,
  sha512,
  sign,
  verify,
  type Identity,
  type KeyPair,
  type SigningKeyPair,
} from './crypto.js';
import { createAdmissionRequestBindingV2, type AdmissionCapabilityV2 } from './admission-v2.js';
import type {
  LeasedIndexKeyMaterialV1,
  LeasedIndexV1,
  LeasedIndexWithdrawalV1,
} from './leased-index-v1.js';
import {
  createLeasedIndexGenerationIdV1,
  verifyLeasedIndexV1,
} from './leased-index-v1.js';
import {
  createOfflineDiscoveryAckIdV1,
  createOfflineDiscoveryEnvelopeIdV1,
  parseOfflineDiscoveryRequestV1,
  serializeOfflineDiscoveryRequestV1,
  verifyOfflineDiscoveryRequestV1,
  type OfflineDiscoveryReplicaKeyV1,
  type OfflineDiscoveryRequestV1,
} from './offline-discovery-request-v1.js';

export const OFFLINE_DISCOVERY_ENVELOPE_KIND = 'offline-discovery-envelope' as const;
export const OFFLINE_DISCOVERY_DEPOSIT_KIND = 'offline-discovery-deposit' as const;
export const OFFLINE_DISCOVERY_ACK_KIND = 'offline-discovery-ack' as const;
export const OFFLINE_DISCOVERY_RECEIPT_KIND = 'offline-discovery-replica-receipt' as const;
export const OFFLINE_DISCOVERY_PADDED_PLAINTEXT_BYTES = 8192;
export const MAX_OFFLINE_DISCOVERY_ENVELOPE_BYTES = 16 * 1024;

const DEPOSIT_DOMAIN = 'resonance:offline-discovery-deposit:v1';
const ACK_DOMAIN = 'resonance:offline-discovery-ack:v1';
const RECEIPT_DOMAIN = 'resonance:offline-discovery-replica-receipt:v1';

export interface OfflineDiscoveryEnvelopeV1 {
  version: 1;
  kind: typeof OFFLINE_DISCOVERY_ENVELOPE_KIND;
  requestId: string;
  clientLeaseId: string;
  publicationId: string;
  leaseSequence: number;
  semanticRevision: number;
  generationId: string;
  mailboxId: string;
  mailboxEncryptionKey: string;
  envelopeId: string;
  ephemeralKey: string;
  nonce: string;
  ciphertext: string;
  createdAt: number;
  expiresAt: number;
}

export interface OfflineDiscoveryDepositBodyV1 {
  version: 1;
  kind: typeof OFFLINE_DISCOVERY_DEPOSIT_KIND;
  requestId: string;
  clientLeaseId: string;
  publicationId: string;
  generationId: string;
  envelopeId: string;
  mailboxId: string;
  senderRequestKey: string;
  envelope: OfflineDiscoveryEnvelopeV1;
  previousGenerationId?: string;
  previousEnvelopeId?: string;
  createdAt: number;
  expiresAt: number;
}

export interface OfflineDiscoveryDepositV1 extends OfflineDiscoveryDepositBodyV1 {
  signature: string;
}

export interface OfflineDiscoveryAckBodyV1 {
  version: 1;
  kind: typeof OFFLINE_DISCOVERY_ACK_KIND;
  ackId: string;
  requestId: string;
  clientLeaseId: string;
  publicationId: string;
  generationId: string;
  envelopeId: string;
  mailboxId: string;
  requestExpiresAt: number;
  createdAt: number;
  publicationKey: string;
}

export interface OfflineDiscoveryAckV1 extends OfflineDiscoveryAckBodyV1 {
  signature: string;
}

export interface OfflineDiscoveryReplicaReceiptBodyV1 {
  version: 1;
  kind: typeof OFFLINE_DISCOVERY_RECEIPT_KIND;
  relayId: string;
  requestId: string;
  clientLeaseId: string;
  mailboxId: string;
  generationId: string;
  envelopeId: string;
  ciphertextDigest: string;
  requestExpiresAt: number;
  status: 'stored' | 'already-stored';
  createdAt: number;
}

export interface OfflineDiscoveryReplicaReceiptV1 extends OfflineDiscoveryReplicaReceiptBodyV1 {
  signature: string;
}

export type OfflineDiscoverySyncEventV1 =
  | {
    kind: 'deposit';
    deposit: OfflineDiscoveryDepositV1;
    admission: AdmissionCapabilityV2;
  }
  | {
    kind: 'ack';
    ack: OfflineDiscoveryAckV1;
    deposit: OfflineDiscoveryDepositV1;
    admission: AdmissionCapabilityV2;
  }
  | {
    kind: 'withdrawal';
    withdrawal: LeasedIndexWithdrawalV1;
  };

export function encryptOfflineDiscoveryRequestV1(
  request: OfflineDiscoveryRequestV1,
): OfflineDiscoveryEnvelopeV1 {
  if (!verifyOfflineDiscoveryRequestV1(request)) throw new Error('Invalid offline discovery request');
  const meaningful = Buffer.from(serializeOfflineDiscoveryRequestV1(request));
  if (meaningful.length > 4096 || meaningful.length + 4 > OFFLINE_DISCOVERY_PADDED_PLAINTEXT_BYTES) {
    throw new Error('Offline request exceeds padded plaintext capacity');
  }
  const padded = Buffer.alloc(OFFLINE_DISCOVERY_PADDED_PLAINTEXT_BYTES);
  padded.writeUInt32BE(meaningful.length, 0);
  meaningful.copy(padded, 4);
  const ephemeral = generateEphemeralKeyPair();
  const encrypted = boxEncrypt(
    padded,
    decodeBase64(request.mailboxEncryptionKey),
    ephemeral.secretKey,
  );
  const envelope: OfflineDiscoveryEnvelopeV1 = {
    version: 1,
    kind: OFFLINE_DISCOVERY_ENVELOPE_KIND,
    requestId: request.requestId,
    clientLeaseId: request.clientLeaseId,
    publicationId: request.publicationId,
    leaseSequence: request.leaseSequence,
    semanticRevision: request.semanticRevision,
    generationId: request.generationId,
    mailboxId: request.mailboxId,
    mailboxEncryptionKey: request.mailboxEncryptionKey,
    envelopeId: createOfflineDiscoveryEnvelopeIdV1(request),
    ephemeralKey: encodeBase64(ephemeral.publicKey),
    nonce: encodeBase64(encrypted.nonce),
    ciphertext: encodeBase64(encrypted.ciphertext),
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
  if (!verifyOfflineDiscoveryEnvelopeV1(envelope)) throw new Error('Invalid encrypted offline envelope');
  return envelope;
}

export function decryptOfflineDiscoveryEnvelopeV1(
  envelope: OfflineDiscoveryEnvelopeV1,
  mailbox: Pick<KeyPair, 'secretKey'>,
): OfflineDiscoveryRequestV1 {
  if (!verifyOfflineDiscoveryEnvelopeV1(envelope)) throw new Error('Invalid offline discovery envelope');
  const padded = boxDecrypt(
    decodeBase64(envelope.ciphertext),
    decodeBase64(envelope.nonce),
    decodeBase64(envelope.ephemeralKey),
    mailbox.secretKey,
  );
  if (!padded || padded.length !== OFFLINE_DISCOVERY_PADDED_PLAINTEXT_BYTES) {
    throw new Error('Offline envelope decryption failed');
  }
  const length = Buffer.from(padded.subarray(0, 4)).readUInt32BE();
  if (length > 4096 || length + 4 > padded.length
    || padded.subarray(length + 4).some(byte => byte !== 0)) {
    throw new Error('Invalid offline envelope padding');
  }
  const request = parseOfflineDiscoveryRequestV1(
    new TextDecoder('utf-8', { fatal: true }).decode(padded.subarray(4, length + 4)),
  );
  if (!sameEnvelopeBindings(envelope, request)
    || createOfflineDiscoveryEnvelopeIdV1(request) !== envelope.envelopeId) {
    throw new Error('Offline envelope inner and outer bindings differ');
  }
  return request;
}

export function verifyOfflineDiscoveryEnvelopeV1(value: unknown): value is OfflineDiscoveryEnvelopeV1 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'ciphertext', 'clientLeaseId', 'createdAt', 'envelopeId', 'ephemeralKey', 'expiresAt',
    'generationId', 'kind', 'leaseSequence', 'mailboxEncryptionKey', 'mailboxId', 'nonce',
    'publicationId', 'requestId', 'semanticRevision', 'version',
  ])) return false;
  return value.version === 1
    && value.kind === OFFLINE_DISCOVERY_ENVELOPE_KIND
    && isOpaque(value.requestId, 'oreq')
    && isOpaque(value.clientLeaseId, 'lease')
    && isOpaque(value.publicationId, 'pub')
    && isCounter(value.leaseSequence)
    && isCounter(value.semanticRevision)
    && isOpaque(value.generationId, 'gen')
    && isOpaque(value.mailboxId, 'mbx')
    && isBase64(value.mailboxEncryptionKey, 32)
    && mailboxMatchesKey(value.mailboxId, value.mailboxEncryptionKey)
    && isOpaque(value.envelopeId, 'env', 86)
    && isBase64(value.ephemeralKey, 32)
    && isBase64(value.nonce, 24)
    && isBase64(value.ciphertext, OFFLINE_DISCOVERY_PADDED_PLAINTEXT_BYTES + 16)
    && isTimestamp(value.createdAt)
    && isTimestamp(value.expiresAt)
    && value.expiresAt > value.createdAt
    && serializedSize(value) <= MAX_OFFLINE_DISCOVERY_ENVELOPE_BYTES;
}

export function createOfflineDiscoveryDepositV1(
  envelope: OfflineDiscoveryEnvelopeV1,
  request: OfflineDiscoveryRequestV1,
  sender: SigningKeyPair,
): OfflineDiscoveryDepositV1 {
  if (!verifyOfflineDiscoveryEnvelopeV1(envelope)
    || !verifyOfflineDiscoveryRequestV1(request)
    || !sameEnvelopeBindings(envelope, request)
    || encodeBase64(sender.publicKey) !== request.senderRequestKey) {
    throw new Error('Invalid offline discovery deposit input');
  }
  const body: OfflineDiscoveryDepositBodyV1 = {
    version: 1,
    kind: OFFLINE_DISCOVERY_DEPOSIT_KIND,
    requestId: request.requestId,
    clientLeaseId: request.clientLeaseId,
    publicationId: request.publicationId,
    generationId: request.generationId,
    envelopeId: requestEnvelopeId(request),
    mailboxId: request.mailboxId,
    senderRequestKey: request.senderRequestKey,
    envelope,
    ...(request.previousGenerationId !== undefined ? {
      previousGenerationId: request.previousGenerationId,
      previousEnvelopeId: request.previousEnvelopeId,
    } : {}),
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
  const deposit = {
    ...body,
    signature: encodeBase64(sign(signable(DEPOSIT_DOMAIN, body), sender.secretKey)),
  };
  if (!verifyOfflineDiscoveryDepositV1(deposit)) throw new Error('Invalid offline discovery deposit');
  return deposit;
}

export function verifyOfflineDiscoveryDepositV1(value: unknown): value is OfflineDiscoveryDepositV1 {
  if (!isObject(value)) return false;
  const linked = 'previousGenerationId' in value || 'previousEnvelopeId' in value;
  const expected = [
    'clientLeaseId', 'createdAt', 'envelope', 'envelopeId', 'expiresAt', 'generationId', 'kind',
    'mailboxId', 'publicationId', 'requestId', 'senderRequestKey', 'signature', 'version',
    ...(linked ? ['previousEnvelopeId', 'previousGenerationId'] : []),
  ];
  if (!hasOnlyKeys(value, expected)) return false;
  const { signature, ...body } = value;
  if (typeof signature !== 'string' || !isBase64(signature, 64)
    || body.version !== 1 || body.kind !== OFFLINE_DISCOVERY_DEPOSIT_KIND
    || !isOpaque(body.requestId, 'oreq') || !isOpaque(body.clientLeaseId, 'lease')
    || !isOpaque(body.publicationId, 'pub') || !isOpaque(body.generationId, 'gen')
    || !isOpaque(body.envelopeId, 'env', 86) || !isOpaque(body.mailboxId, 'mbx')
    || !isBase64(body.senderRequestKey, 32) || !verifyOfflineDiscoveryEnvelopeV1(body.envelope)
    || !isTimestamp(body.createdAt) || !isTimestamp(body.expiresAt)
    || body.expiresAt <= body.createdAt
    || body.requestId !== body.envelope.requestId
    || body.clientLeaseId !== body.envelope.clientLeaseId
    || body.publicationId !== body.envelope.publicationId
    || body.generationId !== body.envelope.generationId
    || body.envelopeId !== body.envelope.envelopeId
    || body.mailboxId !== body.envelope.mailboxId
    || body.createdAt !== body.envelope.createdAt
    || body.expiresAt !== body.envelope.expiresAt) return false;
  if (linked && (!isOpaque(body.previousGenerationId, 'gen')
    || !isOpaque(body.previousEnvelopeId, 'env', 86)
    || body.previousGenerationId === body.generationId)) return false;
  try {
    return verify(signable(DEPOSIT_DOMAIN, body), decodeBase64(signature), decodeBase64(body.senderRequestKey));
  } catch {
    return false;
  }
}

export function serializeOfflineDiscoveryDepositV1(deposit: OfflineDiscoveryDepositV1): string {
  if (!verifyOfflineDiscoveryDepositV1(deposit)) throw new Error('Invalid offline discovery deposit');
  return canonicalize(deposit);
}

export function parseOfflineDiscoveryDepositV1(raw: string): OfflineDiscoveryDepositV1 {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_OFFLINE_DISCOVERY_ENVELOPE_BYTES + 8192) {
    throw new Error('Invalid offline discovery deposit');
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Invalid offline discovery deposit'); }
  if (!verifyOfflineDiscoveryDepositV1(value)) throw new Error('Invalid offline discovery deposit');
  return value;
}

export function offlineDiscoveryAdmissionBindingV1(deposit: OfflineDiscoveryDepositV1): string {
  if (!verifyOfflineDiscoveryDepositV1(deposit)) throw new Error('Invalid offline discovery deposit');
  return createAdmissionRequestBindingV2('mailbox-deposit', deposit);
}

export function createOfflineDiscoveryAckV1(
  request: OfflineDiscoveryRequestV1,
  index: LeasedIndexV1,
  keys: LeasedIndexKeyMaterialV1,
  createdAt: number,
): OfflineDiscoveryAckV1 {
  if (!verifyOfflineDiscoveryRequestV1(request) || !verifyLeasedIndexV1(index)
    || request.generationId !== createLeasedIndexGenerationIdV1(index)
    || request.publicationId !== index.publicationId
    || request.clientLeaseId !== index.clientLeaseId
    || request.mailboxId !== index.mailbox.id
    || keys.publicationId !== index.publicationId
    || keys.clientLeaseId !== index.clientLeaseId
    || encodeBase64(keys.signingKeyPair.publicKey) !== index.publicationKey
    || !isTimestamp(createdAt) || createdAt >= request.expiresAt) {
    throw new Error('Invalid offline discovery ACK input');
  }
  const body: OfflineDiscoveryAckBodyV1 = {
    version: 1,
    kind: OFFLINE_DISCOVERY_ACK_KIND,
    ackId: createOfflineDiscoveryAckIdV1(request),
    requestId: request.requestId,
    clientLeaseId: request.clientLeaseId,
    publicationId: request.publicationId,
    generationId: request.generationId,
    envelopeId: requestEnvelopeId(request),
    mailboxId: request.mailboxId,
    requestExpiresAt: request.expiresAt,
    createdAt,
    publicationKey: index.publicationKey,
  };
  return {
    ...body,
    signature: encodeBase64(sign(signable(ACK_DOMAIN, body), keys.signingKeyPair.secretKey)),
  };
}

export function verifyOfflineDiscoveryAckV1(value: unknown): value is OfflineDiscoveryAckV1 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'ackId', 'clientLeaseId', 'createdAt', 'envelopeId', 'generationId', 'kind', 'mailboxId',
    'publicationId', 'publicationKey', 'requestExpiresAt', 'requestId', 'signature', 'version',
  ])) return false;
  const { signature, ...body } = value;
  if (typeof signature !== 'string' || !isBase64(signature, 64)
    || body.version !== 1 || body.kind !== OFFLINE_DISCOVERY_ACK_KIND
    || !isOpaque(body.ackId, 'oack') || !isOpaque(body.requestId, 'oreq')
    || !isOpaque(body.clientLeaseId, 'lease') || !isOpaque(body.publicationId, 'pub')
    || !isOpaque(body.generationId, 'gen') || !isOpaque(body.envelopeId, 'env', 86)
    || !isOpaque(body.mailboxId, 'mbx') || !isBase64(body.publicationKey, 32)
    || !isTimestamp(body.requestExpiresAt) || !isTimestamp(body.createdAt)
    || body.createdAt > body.requestExpiresAt
    || body.publicationId !== publicationIdFromKey(body.publicationKey)) return false;
  try {
    return verify(signable(ACK_DOMAIN, body), decodeBase64(signature), decodeBase64(body.publicationKey));
  } catch {
    return false;
  }
}

export function verifyOfflineDiscoveryAckForDepositV1(
  ack: OfflineDiscoveryAckV1,
  deposit: OfflineDiscoveryDepositV1,
  index: LeasedIndexV1,
): boolean {
  return verifyOfflineDiscoveryAckV1(ack)
    && verifyOfflineDiscoveryDepositV1(deposit)
    && verifyLeasedIndexV1(index)
    && deposit.generationId === createLeasedIndexGenerationIdV1(index)
    && ack.publicationKey === index.publicationKey
    && ack.publicationId === index.publicationId
    && ack.clientLeaseId === index.clientLeaseId
    && ack.requestId === deposit.requestId
    && ack.clientLeaseId === deposit.clientLeaseId
    && ack.publicationId === deposit.publicationId
    && ack.generationId === deposit.generationId
    && ack.envelopeId === deposit.envelopeId
    && ack.mailboxId === deposit.mailboxId
    && ack.requestExpiresAt === deposit.expiresAt;
}

export function serializeOfflineDiscoveryAckV1(ack: OfflineDiscoveryAckV1): string {
  if (!verifyOfflineDiscoveryAckV1(ack)) throw new Error('Invalid offline discovery ACK');
  return canonicalize(ack);
}

export function parseOfflineDiscoveryAckV1(raw: string): OfflineDiscoveryAckV1 {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw new Error('Invalid offline discovery ACK');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Invalid offline discovery ACK'); }
  if (!verifyOfflineDiscoveryAckV1(value)) throw new Error('Invalid offline discovery ACK');
  return value;
}

export function createOfflineDiscoveryReceiptV1(
  deposit: OfflineDiscoveryDepositV1,
  status: 'stored' | 'already-stored',
  identity: Identity,
  createdAt: number,
): OfflineDiscoveryReplicaReceiptV1 {
  if (!verifyOfflineDiscoveryDepositV1(deposit) || publicKeyToDid(identity.publicKey) !== identity.did
    || !isTimestamp(createdAt) || createdAt > deposit.expiresAt) throw new Error('Invalid offline receipt input');
  const body: OfflineDiscoveryReplicaReceiptBodyV1 = {
    version: 1,
    kind: OFFLINE_DISCOVERY_RECEIPT_KIND,
    relayId: identity.did,
    requestId: deposit.requestId,
    clientLeaseId: deposit.clientLeaseId,
    mailboxId: deposit.mailboxId,
    generationId: deposit.generationId,
    envelopeId: deposit.envelopeId,
    ciphertextDigest: encodeBase64(sha512(decodeBase64(deposit.envelope.ciphertext)).slice(0, 32)),
    requestExpiresAt: deposit.expiresAt,
    status,
    createdAt,
  };
  return {
    ...body,
    signature: encodeBase64(sign(signable(RECEIPT_DOMAIN, body), identity.secretKey)),
  };
}

export function verifyOfflineDiscoveryReceiptV1(value: unknown): value is OfflineDiscoveryReplicaReceiptV1 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'ciphertextDigest', 'clientLeaseId', 'createdAt', 'envelopeId', 'generationId', 'kind',
    'mailboxId', 'relayId', 'requestExpiresAt', 'requestId', 'signature', 'status', 'version',
  ])) return false;
  const { signature, ...body } = value;
  if (typeof signature !== 'string' || !isBase64(signature, 64)
    || body.version !== 1 || body.kind !== OFFLINE_DISCOVERY_RECEIPT_KIND
    || typeof body.relayId !== 'string'
    || !isOpaque(body.requestId, 'oreq') || !isOpaque(body.clientLeaseId, 'lease')
    || !isOpaque(body.mailboxId, 'mbx') || !isOpaque(body.generationId, 'gen')
    || !isOpaque(body.envelopeId, 'env', 86) || !isBase64(body.ciphertextDigest, 32)
    || !isTimestamp(body.requestExpiresAt) || !isTimestamp(body.createdAt)
    || body.createdAt > body.requestExpiresAt
    || (body.status !== 'stored' && body.status !== 'already-stored')) return false;
  try {
    return verify(signable(RECEIPT_DOMAIN, body), decodeBase64(signature), didToPublicKey(body.relayId));
  } catch {
    return false;
  }
}

export function verifyOfflineDiscoveryReceiptForDepositV1(
  receipt: OfflineDiscoveryReplicaReceiptV1,
  deposit: OfflineDiscoveryDepositV1,
): boolean {
  return verifyOfflineDiscoveryReceiptV1(receipt)
    && verifyOfflineDiscoveryDepositV1(deposit)
    && receipt.requestId === deposit.requestId
    && receipt.clientLeaseId === deposit.clientLeaseId
    && receipt.mailboxId === deposit.mailboxId
    && receipt.generationId === deposit.generationId
    && receipt.envelopeId === deposit.envelopeId
    && receipt.requestExpiresAt === deposit.expiresAt
    && receipt.ciphertextDigest === encodeBase64(sha512(decodeBase64(deposit.envelope.ciphertext)).slice(0, 32));
}

function sameEnvelopeBindings(
  envelope: OfflineDiscoveryEnvelopeV1,
  request: OfflineDiscoveryRequestV1,
): boolean {
  return envelope.requestId === request.requestId
    && envelope.clientLeaseId === request.clientLeaseId
    && envelope.publicationId === request.publicationId
    && envelope.leaseSequence === request.leaseSequence
    && envelope.semanticRevision === request.semanticRevision
    && envelope.generationId === request.generationId
    && envelope.mailboxId === request.mailboxId
    && envelope.mailboxEncryptionKey === request.mailboxEncryptionKey
    && envelope.createdAt === request.createdAt
    && envelope.expiresAt === request.expiresAt;
}

function requestEnvelopeId(request: OfflineDiscoveryRequestV1): string {
  return createOfflineDiscoveryEnvelopeIdV1(request);
}

function signable(domain: string, body: object): Uint8Array {
  return decodeUTF8(`${domain}\n${canonicalize(body)}`);
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  throw new Error('Cannot canonicalize value');
}

function serializedSize(value: unknown): number {
  return Buffer.byteLength(canonicalize(value));
}

function publicationIdFromKey(key: string): string {
  return `pub_${base64Url(decodeBase64(key))}`;
}

function mailboxMatchesKey(id: string, key: string): boolean {
  return id === `mbx_${base64Url(decodeBase64(key))}`;
}

function base64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function isOpaque(value: unknown, prefix: string, length = 43): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{${length}}$`).test(value);
}

function isBase64(value: unknown, length: number): value is string {
  if (typeof value !== 'string') return false;
  try {
    const bytes = decodeBase64(value);
    return bytes.length === length && encodeBase64(bytes) === value;
  } catch {
    return false;
  }
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCounter(value: unknown): value is number {
  return isTimestamp(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
