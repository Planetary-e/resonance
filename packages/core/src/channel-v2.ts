/** Pairwise encrypted messaging over relationship-scoped mailboxes. */

import {
  boxDecrypt,
  boxEncrypt,
  decodeBase64,
  decodeUTF8,
  encodeBase64,
  encodeUTF8,
  generateEphemeralKeyPair,
  secretboxDecrypt,
  secretboxEncrypt,
  sha512,
  sign,
  verify,
} from './crypto.js';
import {
  PROTOCOL_V2_VERSION,
} from './protocol-v2.js';
import {
  verifyAdmissionCapabilityV2,
  type AdmissionCapabilityV2,
} from './admission-v2.js';
import {
  createMailboxEnvelopeId,
  verifyMailboxEnvelope,
  type EncryptedMailboxEnvelope,
} from './mailbox-v2.js';
import type { RelationshipKeyMaterial, RelationshipMailboxV2 } from './relationship-v2.js';

export const RELATIONSHIP_MAILBOX_REQUEST_FRAME_TYPE = 'relationship_mailbox_request' as const;
export const RELATIONSHIP_MAILBOX_DEPOSIT_FRAME_TYPE = 'relationship_mailbox_deposit' as const;

const CHANNEL_OPERATION_SIGNATURE_DOMAIN = 'resonance:discovery:v2:channel-operation';
const RELATIONSHIP_MAILBOX_REQUEST_SIGNATURE_DOMAIN = 'resonance:discovery:v2:relationship-mailbox-request';
const RELATIONSHIP_MAILBOX_DEPOSIT_SIGNATURE_DOMAIN = 'resonance:discovery:v2:relationship-mailbox-deposit';

export interface ChannelContentV2 {
  kind: 'disclosure';
  text: string;
  level: 'general' | 'specific' | 'identifying';
  createdAt: number;
}

interface ChannelOperationCommonV2 {
  version: typeof PROTOCOL_V2_VERSION;
  messageId: string;
  channelId: string;
  senderRelationshipId: string;
  senderRelationshipKey: string;
  recipientRelationshipId: string;
  sequence: number;
  createdAt: number;
  expiresAt: number;
}

export interface ChannelMessageOperationV2 extends ChannelOperationCommonV2 {
  kind: 'channel-message';
  nonce: string;
  ciphertext: string;
  signature: string;
}

export interface ChannelCloseOperationV2 extends ChannelOperationCommonV2 {
  kind: 'channel-close';
  signature: string;
}

export type ChannelOperationV2 = ChannelMessageOperationV2 | ChannelCloseOperationV2;

export interface RelationshipMailboxRequestBodyV2 {
  version: typeof PROTOCOL_V2_VERSION;
  kind: 'relationship-mailbox-request';
  requestId: string;
  action: 'fetch' | 'ack';
  relationshipId: string;
  relationshipKey: string;
  mailboxId: string;
  envelopeIds: string[];
  timestamp: number;
}

export interface RelationshipMailboxRequestV2 extends RelationshipMailboxRequestBodyV2 {
  signature: string;
}

export interface RelationshipMailboxRequestFrameV2 {
  type: typeof RELATIONSHIP_MAILBOX_REQUEST_FRAME_TYPE;
  request: RelationshipMailboxRequestV2;
  admission?: AdmissionCapabilityV2;
}

export interface RelationshipMailboxDepositBodyV2 {
  version: typeof PROTOCOL_V2_VERSION;
  kind: 'relationship-mailbox-deposit';
  requestId: string;
  senderRelationshipId: string;
  senderRelationshipKey: string;
  recipientRelationshipId: string;
  recipientMailboxId: string;
  envelope: EncryptedMailboxEnvelope;
  timestamp: number;
}

export interface RelationshipMailboxDepositV2 extends RelationshipMailboxDepositBodyV2 {
  signature: string;
}

export interface RelationshipMailboxDepositFrameV2 {
  type: typeof RELATIONSHIP_MAILBOX_DEPOSIT_FRAME_TYPE;
  request: RelationshipMailboxDepositV2;
  admission?: AdmissionCapabilityV2;
}

export function createChannelMessageOperationV2(
  channelId: string,
  recipientRelationshipId: string,
  sequence: number,
  content: ChannelContentV2,
  sharedKey: Uint8Array,
  keys: RelationshipKeyMaterial,
  createdAt = Date.now(),
  expiresAt = createdAt + 7 * 24 * 60 * 60 * 1000,
): ChannelMessageOperationV2 {
  if (!isChannelContent(content) || sharedKey.length !== 32) throw new Error('Invalid channel message input');
  assertRelationshipKeys(keys);
  const encrypted = secretboxEncrypt(decodeUTF8(JSON.stringify(content)), sharedKey);
  const bodyWithoutId = {
    version: PROTOCOL_V2_VERSION,
    kind: 'channel-message' as const,
    channelId,
    senderRelationshipId: keys.relationshipId,
    senderRelationshipKey: encodeBase64(keys.signingKeyPair.publicKey),
    recipientRelationshipId,
    sequence,
    nonce: encodeBase64(encrypted.nonce),
    ciphertext: encodeBase64(encrypted.ciphertext),
    createdAt,
    expiresAt,
  };
  const body = withMessageId(bodyWithoutId);
  if (!isChannelMessageBody(body)) throw new Error('Invalid channel message input');
  return signChannelOperation(body, keys);
}

export function createChannelCloseOperationV2(
  channelId: string,
  recipientRelationshipId: string,
  sequence: number,
  keys: RelationshipKeyMaterial,
  createdAt = Date.now(),
  expiresAt = createdAt + 7 * 24 * 60 * 60 * 1000,
): ChannelCloseOperationV2 {
  assertRelationshipKeys(keys);
  const bodyWithoutId = {
    version: PROTOCOL_V2_VERSION,
    kind: 'channel-close' as const,
    channelId,
    senderRelationshipId: keys.relationshipId,
    senderRelationshipKey: encodeBase64(keys.signingKeyPair.publicKey),
    recipientRelationshipId,
    sequence,
    createdAt,
    expiresAt,
  };
  const body = withMessageId(bodyWithoutId);
  if (!isChannelCloseBody(body)) throw new Error('Invalid channel close input');
  return signChannelOperation(body, keys);
}

export function verifyChannelOperationV2(value: unknown): value is ChannelOperationV2 {
  if (!isObject(value) || typeof value.signature !== 'string') return false;
  const { signature, ...body } = value;
  if (!isChannelMessageBody(body) && !isChannelCloseBody(body)) return false;
  try {
    return verify(
      signable(CHANNEL_OPERATION_SIGNATURE_DOMAIN, body),
      decodeBase64(signature),
      decodeBase64(body.senderRelationshipKey),
    );
  } catch {
    return false;
  }
}

export function decryptChannelContentV2(
  operation: ChannelMessageOperationV2,
  sharedKey: Uint8Array,
): ChannelContentV2 {
  if (!verifyChannelOperationV2(operation) || sharedKey.length !== 32) {
    throw new Error('Invalid channel message operation');
  }
  const plaintext = secretboxDecrypt(
    decodeBase64(operation.ciphertext),
    decodeBase64(operation.nonce),
    sharedKey,
  );
  if (!plaintext) throw new Error('Channel message decryption failed');
  let content: unknown;
  try { content = JSON.parse(encodeUTF8(plaintext)); } catch {
    throw new Error('Channel message plaintext is invalid');
  }
  if (!isChannelContent(content)) throw new Error('Channel message content is invalid');
  return content;
}

export function encryptChannelOperationV2(
  operation: ChannelOperationV2,
  recipientMailbox: RelationshipMailboxV2,
): EncryptedMailboxEnvelope {
  if (!verifyChannelOperationV2(operation) || !isRelationshipMailbox(recipientMailbox)) {
    throw new Error('Invalid channel operation envelope input');
  }
  if (!mailboxMatchesRelationship(recipientMailbox.id, operation.recipientRelationshipId)) {
    throw new Error('Channel operation recipient does not own the relationship mailbox');
  }
  const ephemeral = generateEphemeralKeyPair();
  const encrypted = boxEncrypt(
    decodeUTF8(JSON.stringify(operation)),
    decodeBase64(recipientMailbox.encryptionKey),
    ephemeral.secretKey,
  );
  return {
    version: PROTOCOL_V2_VERSION,
    kind: 'mailbox-envelope',
    payloadType: 'channel-operation',
    envelopeId: createMailboxEnvelopeId(operation.messageId, recipientMailbox.id),
    mailboxId: recipientMailbox.id,
    ephemeralKey: encodeBase64(ephemeral.publicKey),
    nonce: encodeBase64(encrypted.nonce),
    ciphertext: encodeBase64(encrypted.ciphertext),
    createdAt: operation.createdAt,
    expiresAt: operation.expiresAt,
  };
}

export function decryptChannelOperationV2(
  envelope: EncryptedMailboxEnvelope,
  keys: RelationshipKeyMaterial,
): ChannelOperationV2 {
  assertRelationshipKeys(keys);
  if (!verifyMailboxEnvelope(envelope)
    || envelope.payloadType !== 'channel-operation'
    || envelope.mailboxId !== keys.mailboxId) {
    throw new Error('Envelope does not belong to this relationship mailbox');
  }
  const plaintext = boxDecrypt(
    decodeBase64(envelope.ciphertext),
    decodeBase64(envelope.nonce),
    decodeBase64(envelope.ephemeralKey),
    keys.mailboxKeyPair.secretKey,
  );
  if (!plaintext) throw new Error('Relationship mailbox envelope decryption failed');
  let operation: unknown;
  try { operation = JSON.parse(encodeUTF8(plaintext)); } catch {
    throw new Error('Relationship mailbox plaintext is invalid');
  }
  if (!verifyChannelOperationV2(operation)
    || operation.recipientRelationshipId !== keys.relationshipId
    || operation.messageId === undefined
    || createMailboxEnvelopeId(operation.messageId, keys.mailboxId) !== envelope.envelopeId
    || operation.createdAt !== envelope.createdAt
    || operation.expiresAt !== envelope.expiresAt) {
    throw new Error('Relationship mailbox operation binding is invalid');
  }
  return operation;
}

export function createRelationshipMailboxRequestV2(
  action: 'fetch' | 'ack',
  keys: RelationshipKeyMaterial,
  envelopeIds: string[] = [],
  timestamp = Date.now(),
): RelationshipMailboxRequestV2 {
  assertRelationshipKeys(keys);
  const body: RelationshipMailboxRequestBodyV2 = {
    version: PROTOCOL_V2_VERSION,
    kind: 'relationship-mailbox-request',
    requestId: randomRequestId(),
    action,
    relationshipId: keys.relationshipId,
    relationshipKey: encodeBase64(keys.signingKeyPair.publicKey),
    mailboxId: keys.mailboxId,
    envelopeIds,
    timestamp,
  };
  if (!isRelationshipMailboxRequestBody(body)) throw new Error('Invalid relationship mailbox request');
  return {
    ...body,
    signature: encodeBase64(sign(
      signable(RELATIONSHIP_MAILBOX_REQUEST_SIGNATURE_DOMAIN, body),
      keys.signingKeyPair.secretKey,
    )),
  };
}

export function verifyRelationshipMailboxRequestV2(value: unknown): value is RelationshipMailboxRequestV2 {
  return verifySignedRequest(value, isRelationshipMailboxRequestBody, RELATIONSHIP_MAILBOX_REQUEST_SIGNATURE_DOMAIN);
}

export function createRelationshipMailboxDepositV2(
  recipientRelationshipId: string,
  keys: RelationshipKeyMaterial,
  envelope: EncryptedMailboxEnvelope,
  timestamp = Date.now(),
): RelationshipMailboxDepositV2 {
  assertRelationshipKeys(keys);
  const body: RelationshipMailboxDepositBodyV2 = {
    version: PROTOCOL_V2_VERSION,
    kind: 'relationship-mailbox-deposit',
    requestId: randomRequestId(),
    senderRelationshipId: keys.relationshipId,
    senderRelationshipKey: encodeBase64(keys.signingKeyPair.publicKey),
    recipientRelationshipId,
    recipientMailboxId: envelope.mailboxId,
    envelope,
    timestamp,
  };
  if (!isRelationshipMailboxDepositBody(body)) throw new Error('Invalid relationship mailbox deposit');
  return {
    ...body,
    signature: encodeBase64(sign(
      signable(RELATIONSHIP_MAILBOX_DEPOSIT_SIGNATURE_DOMAIN, body),
      keys.signingKeyPair.secretKey,
    )),
  };
}

export function verifyRelationshipMailboxDepositV2(value: unknown): value is RelationshipMailboxDepositV2 {
  return verifySignedRequest(value, isRelationshipMailboxDepositBody, RELATIONSHIP_MAILBOX_DEPOSIT_SIGNATURE_DOMAIN);
}

export function createRelationshipMailboxRequestFrameV2(
  request: RelationshipMailboxRequestV2,
  admission?: AdmissionCapabilityV2,
): RelationshipMailboxRequestFrameV2 {
  if (!verifyRelationshipMailboxRequestV2(request)) throw new Error('Invalid relationship mailbox request');
  if (admission !== undefined && !verifyAdmissionCapabilityV2(admission)) {
    throw new Error('Invalid admission capability');
  }
  return admission === undefined
    ? { type: RELATIONSHIP_MAILBOX_REQUEST_FRAME_TYPE, request }
    : { type: RELATIONSHIP_MAILBOX_REQUEST_FRAME_TYPE, request, admission };
}

export function createRelationshipMailboxDepositFrameV2(
  request: RelationshipMailboxDepositV2,
  admission?: AdmissionCapabilityV2,
): RelationshipMailboxDepositFrameV2 {
  if (!verifyRelationshipMailboxDepositV2(request)) throw new Error('Invalid relationship mailbox deposit');
  if (admission !== undefined && !verifyAdmissionCapabilityV2(admission)) {
    throw new Error('Invalid admission capability');
  }
  return admission === undefined
    ? { type: RELATIONSHIP_MAILBOX_DEPOSIT_FRAME_TYPE, request }
    : { type: RELATIONSHIP_MAILBOX_DEPOSIT_FRAME_TYPE, request, admission };
}

export function serializeRelationshipMailboxRequestFrameV2(
  frame: RelationshipMailboxRequestFrameV2,
): string {
  if (frame.type !== RELATIONSHIP_MAILBOX_REQUEST_FRAME_TYPE
    || !verifyRelationshipMailboxRequestV2(frame.request)
    || (frame.admission !== undefined && !verifyAdmissionCapabilityV2(frame.admission))) {
    throw new Error('Invalid relationship mailbox request frame');
  }
  return JSON.stringify(frame);
}

export function serializeRelationshipMailboxDepositFrameV2(
  frame: RelationshipMailboxDepositFrameV2,
): string {
  if (frame.type !== RELATIONSHIP_MAILBOX_DEPOSIT_FRAME_TYPE
    || !verifyRelationshipMailboxDepositV2(frame.request)
    || (frame.admission !== undefined && !verifyAdmissionCapabilityV2(frame.admission))) {
    throw new Error('Invalid relationship mailbox deposit frame');
  }
  return JSON.stringify(frame);
}

export function parseRelationshipMailboxRequestFrameV2(raw: string): RelationshipMailboxRequestFrameV2 {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed) || !hasFrameKeys(parsed)
    || parsed.type !== RELATIONSHIP_MAILBOX_REQUEST_FRAME_TYPE
    || !verifyRelationshipMailboxRequestV2(parsed.request)
    || ('admission' in parsed && !verifyAdmissionCapabilityV2(parsed.admission))) {
    throw new Error('Invalid relationship mailbox request frame');
  }
  return parsed as unknown as RelationshipMailboxRequestFrameV2;
}

export function parseRelationshipMailboxDepositFrameV2(raw: string): RelationshipMailboxDepositFrameV2 {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed) || !hasFrameKeys(parsed)
    || parsed.type !== RELATIONSHIP_MAILBOX_DEPOSIT_FRAME_TYPE
    || !verifyRelationshipMailboxDepositV2(parsed.request)
    || ('admission' in parsed && !verifyAdmissionCapabilityV2(parsed.admission))) {
    throw new Error('Invalid relationship mailbox deposit frame');
  }
  return parsed as unknown as RelationshipMailboxDepositFrameV2;
}

function withMessageId<T extends object>(body: T): T & { messageId: string } {
  return {
    ...body,
    messageId: derivedId('msg', `resonance:discovery:v2:channel-message-id\n${canonicalize(body)}`),
  };
}

function signChannelOperation<T extends Omit<ChannelOperationV2, 'signature'>>(
  body: T,
  keys: RelationshipKeyMaterial,
): T & { signature: string } {
  return {
    ...body,
    signature: encodeBase64(sign(
      signable(CHANNEL_OPERATION_SIGNATURE_DOMAIN, body),
      keys.signingKeyPair.secretKey,
    )),
  };
}

function isChannelMessageBody(value: unknown): value is Omit<ChannelMessageOperationV2, 'signature'> {
  return isObject(value)
    && hasOnlyKeys(value, [
      'channelId', 'ciphertext', 'createdAt', 'expiresAt', 'kind', 'messageId', 'nonce',
      'recipientRelationshipId', 'senderRelationshipId', 'senderRelationshipKey', 'sequence', 'version',
    ])
    && value.kind === 'channel-message'
    && isCommonChannelBody(value)
    && isBase64OfLength(value.nonce, 24)
    && isBoundedCiphertext(value.ciphertext)
    && hasCorrectMessageId(value);
}

function isChannelCloseBody(value: unknown): value is Omit<ChannelCloseOperationV2, 'signature'> {
  return isObject(value)
    && hasOnlyKeys(value, [
      'channelId', 'createdAt', 'expiresAt', 'kind', 'messageId', 'recipientRelationshipId',
      'senderRelationshipId', 'senderRelationshipKey', 'sequence', 'version',
    ])
    && value.kind === 'channel-close'
    && isCommonChannelBody(value)
    && hasCorrectMessageId(value);
}

function isCommonChannelBody(value: Record<string, unknown>): boolean {
  return value.version === PROTOCOL_V2_VERSION
    && isOpaqueId(value.messageId, 'msg')
    && isOpaqueId(value.channelId, 'chn')
    && isOpaqueId(value.senderRelationshipId, 'rel')
    && isBase64OfLength(value.senderRelationshipKey, 32)
    && relationshipMatchesKey(value.senderRelationshipId as string, value.senderRelationshipKey as string)
    && isOpaqueId(value.recipientRelationshipId, 'rel')
    && Number.isSafeInteger(value.sequence)
    && (value.sequence as number) >= 0
    && isTimestamp(value.createdAt)
    && isTimestamp(value.expiresAt)
    && (value.expiresAt as number) > (value.createdAt as number);
}

function hasCorrectMessageId(value: Record<string, unknown>): boolean {
  const { messageId, ...body } = value;
  return messageId === derivedId('msg', `resonance:discovery:v2:channel-message-id\n${canonicalize(body)}`);
}

function isChannelContent(value: unknown): value is ChannelContentV2 {
  return isObject(value)
    && hasOnlyKeys(value, ['createdAt', 'kind', 'level', 'text'])
    && value.kind === 'disclosure'
    && typeof value.text === 'string'
    && value.text.length >= 1
    && value.text.length <= 16_384
    && (value.level === 'general' || value.level === 'specific' || value.level === 'identifying')
    && isTimestamp(value.createdAt);
}

function isRelationshipMailboxRequestBody(value: unknown): value is RelationshipMailboxRequestBodyV2 {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'action', 'envelopeIds', 'kind', 'mailboxId', 'relationshipId', 'relationshipKey',
    'requestId', 'timestamp', 'version',
  ])) return false;
  if (value.version !== PROTOCOL_V2_VERSION || value.kind !== 'relationship-mailbox-request') return false;
  if (value.action !== 'fetch' && value.action !== 'ack') return false;
  if (!isOpaqueId(value.requestId, 'req')
    || !isOpaqueId(value.relationshipId, 'rel')
    || !isBase64OfLength(value.relationshipKey, 32)
    || !relationshipMatchesKey(value.relationshipId, value.relationshipKey)
    || !isRelationshipMailboxId(value.mailboxId)
    || !mailboxMatchesRelationship(value.mailboxId, value.relationshipId)
    || !isTimestamp(value.timestamp)) return false;
  if (!Array.isArray(value.envelopeIds) || value.envelopeIds.length > 100
    || !value.envelopeIds.every((id) => isOpaqueId(id, 'env'))
    || new Set(value.envelopeIds).size !== value.envelopeIds.length) return false;
  return value.action === 'fetch' ? value.envelopeIds.length === 0 : value.envelopeIds.length > 0;
}

function isRelationshipMailboxDepositBody(value: unknown): value is RelationshipMailboxDepositBodyV2 {
  return isObject(value)
    && hasOnlyKeys(value, [
      'envelope', 'kind', 'recipientMailboxId', 'recipientRelationshipId', 'requestId',
      'senderRelationshipId', 'senderRelationshipKey', 'timestamp', 'version',
    ])
    && value.version === PROTOCOL_V2_VERSION
    && value.kind === 'relationship-mailbox-deposit'
    && isOpaqueId(value.requestId, 'req')
    && isOpaqueId(value.senderRelationshipId, 'rel')
    && isBase64OfLength(value.senderRelationshipKey, 32)
    && relationshipMatchesKey(value.senderRelationshipId, value.senderRelationshipKey)
    && isOpaqueId(value.recipientRelationshipId, 'rel')
    && isRelationshipMailboxId(value.recipientMailboxId)
    && mailboxMatchesRelationship(value.recipientMailboxId, value.recipientRelationshipId)
    && verifyMailboxEnvelope(value.envelope)
    && value.envelope.payloadType === 'channel-operation'
    && value.envelope.mailboxId === value.recipientMailboxId
    && isTimestamp(value.timestamp);
}

function verifySignedRequest<T extends { senderRelationshipKey?: string; relationshipKey?: string }>(
  value: unknown,
  bodyGuard: (body: unknown) => body is T,
  domain: string,
): value is T & { signature: string } {
  if (!isObject(value) || typeof value.signature !== 'string') return false;
  const { signature, ...body } = value;
  if (!bodyGuard(body)) return false;
  const publicKey = body.senderRelationshipKey ?? body.relationshipKey;
  if (!publicKey) return false;
  try {
    return verify(signable(domain, body), decodeBase64(signature), decodeBase64(publicKey));
  } catch {
    return false;
  }
}

function assertRelationshipKeys(keys: RelationshipKeyMaterial): void {
  if (!keys
    || !isOpaqueId(keys.relationshipId, 'rel')
    || keys.relationshipId !== relationshipIdFromKey(keys.signingKeyPair.publicKey)
    || keys.signingKeyPair.secretKey.length !== 64
    || !isRelationshipMailboxId(keys.mailboxId)
    || !mailboxMatchesRelationship(keys.mailboxId, keys.relationshipId)
    || keys.mailboxKeyPair.publicKey.length !== 32
    || keys.mailboxKeyPair.secretKey.length !== 32) throw new Error('Invalid relationship key material');
}

function signable(domain: string, body: object): Uint8Array {
  return decodeUTF8(`${domain}\n${canonicalize(body)}`);
}

function randomRequestId(): string {
  return derivedId('req', encodeBase64(generateEphemeralKeyPair().publicKey));
}

function derivedId(prefix: 'msg' | 'req', input: string): string {
  const bytes = sha512(decodeUTF8(input)).slice(0, 32);
  return `${prefix}_${encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function relationshipIdFromKey(key: Uint8Array): string {
  return `rel_${encodeBase64(key).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function relationshipMatchesKey(id: string, encodedKey: string): boolean {
  try { return id === relationshipIdFromKey(decodeBase64(encodedKey)); } catch { return false; }
}

function mailboxMatchesRelationship(mailboxId: string, relationshipId: string): boolean {
  return mailboxId.slice('rmbx_'.length) === relationshipId.slice('rel_'.length);
}

function isRelationshipMailbox(value: unknown): value is RelationshipMailboxV2 {
  return isObject(value)
    && hasOnlyKeys(value, ['encryptionKey', 'id'])
    && isRelationshipMailboxId(value.id)
    && isBase64OfLength(value.encryptionKey, 32);
}

function isRelationshipMailboxId(value: unknown): value is string {
  return typeof value === 'string' && /^rmbx_[A-Za-z0-9_-]{43}$/.test(value);
}

function isOpaqueId(value: unknown, prefix: 'msg' | 'req' | 'env' | 'rel' | 'chn'): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(value);
}

function isBase64OfLength(value: unknown, length: number): value is string {
  if (typeof value !== 'string' || value.length > 100_000) return false;
  try { return decodeBase64(value).length === length; } catch { return false; }
}

function isBoundedCiphertext(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 24_000) return false;
  try { return decodeBase64(value).length <= 16_400; } catch { return false; }
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function hasFrameKeys(value: Record<string, unknown>): boolean {
  return hasOnlyKeys(value, 'admission' in value
    ? ['admission', 'request', 'type']
    : ['request', 'type']);
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Cannot canonicalize number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new Error(`Cannot canonicalize ${typeof value}`);
}
