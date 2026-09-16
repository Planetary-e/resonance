/** Encrypted, independently acknowledged match mailboxes for protocol v2. */

import {
  boxDecrypt,
  boxEncrypt,
  decodeBase64,
  decodeUTF8,
  encodeBase64,
  encodeUTF8,
  generateEphemeralKeyPair,
  sha512,
  sign,
  verify,
  type Identity,
} from './crypto.js';
import { createMessage, parseMessage, verifyMessage, type Message } from './protocol.js';
import {
  PROTOCOL_V2_VERSION,
  verifyPublicationRecord,
  type PublicationKeyMaterial,
  type PublicationMailbox,
  type PublicationRecord,
} from './protocol-v2.js';
import {
  createDeterministicMatchId,
  verifyMatchOperationAgainstPublicationsV2,
  verifyMatchOperationV2,
  type MatchOperationV2,
} from './match-v2.js';
import {
  verifyRelationshipMessageV2,
  type RelationshipMessageV2,
} from './relationship-v2.js';
import type { ItemType } from './types.js';
import {
  verifyAdmissionCapabilityV2,
  type AdmissionCapabilityV2,
} from './admission-v2.js';

export const MATCH_NOTICE_MESSAGE_TYPE = 'match_notice_v2' as const;
export const MAILBOX_REQUEST_FRAME_TYPE = 'mailbox_request' as const;
export const MAILBOX_DEPOSIT_FRAME_TYPE = 'mailbox_deposit' as const;
export const MAILBOX_RESPONSE_MESSAGE_TYPE = 'mailbox_response' as const;

const MAILBOX_REQUEST_SIGNATURE_DOMAIN = 'resonance:discovery:v2:mailbox-request';
const MAILBOX_DEPOSIT_SIGNATURE_DOMAIN = 'resonance:discovery:v2:mailbox-deposit';

export type MailboxPayloadType = 'match-notice' | 'relationship-message' | 'channel-operation';

export interface PublicationMailboxRecipient {
  publicationId: string;
  mailbox: PublicationMailbox;
}

export interface MatchNoticePayload {
  version: typeof PROTOCOL_V2_VERSION;
  kind: 'match-notice';
  matchOperation: MatchOperationV2;
  matchId: string;
  recipientPublicationId: string;
  recipientMailboxId: string;
  partnerPublicationId: string;
  partnerPublicationKey: string;
  partnerMailbox: PublicationMailbox;
  partnerItemType: ItemType;
  similarity: number;
  createdAt: number;
  expiresAt: number;
}

export interface EncryptedMailboxEnvelope {
  version: typeof PROTOCOL_V2_VERSION;
  kind: 'mailbox-envelope';
  payloadType: MailboxPayloadType;
  envelopeId: string;
  mailboxId: string;
  ephemeralKey: string;
  nonce: string;
  ciphertext: string;
  createdAt: number;
  expiresAt: number;
}

export interface MailboxRequestBody {
  version: typeof PROTOCOL_V2_VERSION;
  kind: 'mailbox-request';
  requestId: string;
  action: 'fetch' | 'ack';
  publicationId: string;
  publicationKey: string;
  mailboxId: string;
  envelopeIds: string[];
  timestamp: number;
}

export interface MailboxRequest extends MailboxRequestBody {
  signature: string;
}

export interface MailboxRequestFrame {
  type: typeof MAILBOX_REQUEST_FRAME_TYPE;
  request: MailboxRequest;
  admission?: AdmissionCapabilityV2;
}

export interface MailboxDepositBody {
  version: typeof PROTOCOL_V2_VERSION;
  kind: 'mailbox-deposit';
  requestId: string;
  matchId: string;
  senderPublicationId: string;
  senderPublicationKey: string;
  recipientPublicationId: string;
  recipientMailboxId: string;
  envelope: EncryptedMailboxEnvelope;
  timestamp: number;
}

export interface MailboxDepositRequest extends MailboxDepositBody {
  signature: string;
}

export interface MailboxDepositFrame {
  type: typeof MAILBOX_DEPOSIT_FRAME_TYPE;
  request: MailboxDepositRequest;
  admission?: AdmissionCapabilityV2;
}

export interface MailboxResponsePayload {
  requestId: string;
  mailboxId: string;
  envelopes: EncryptedMailboxEnvelope[];
}

export { createDeterministicMatchId } from './match-v2.js';

export function createMailboxEnvelopeId(matchId: string, mailboxId: string): string {
  return derivedId('env', `resonance:discovery:v2:mailbox-envelope\n${matchId}\n${mailboxId}`);
}

export function createMatchNoticeMessage(
  recipient: PublicationRecord,
  partner: PublicationRecord,
  matchOperation: MatchOperationV2,
  relayIdentity: Identity,
): Message<MatchNoticePayload> {
  if (!verifyPublicationRecord(recipient)
    || !verifyPublicationRecord(partner)
    || !verifyMatchOperationAgainstPublicationsV2(matchOperation, recipient, partner, 0)
    || matchOperation.relayId !== relayIdentity.did
    || matchOperation.relayKey !== encodeBase64(relayIdentity.publicKey)) {
    throw new Error('Cannot create a match notice for an invalid publication');
  }
  const payload: MatchNoticePayload = {
    version: PROTOCOL_V2_VERSION,
    kind: 'match-notice',
    matchOperation,
    matchId: matchOperation.matchId,
    recipientPublicationId: recipient.publicationId,
    recipientMailboxId: recipient.mailbox.id,
    partnerPublicationId: partner.publicationId,
    partnerPublicationKey: partner.publicationKey,
    partnerMailbox: partner.mailbox,
    partnerItemType: partner.itemType,
    similarity: matchOperation.similarity,
    createdAt: matchOperation.createdAt,
    expiresAt: matchOperation.expiresAt,
  };
  if (!verifyMatchNoticePayload(payload)) throw new Error('Invalid match notice input');
  return createMessage(MATCH_NOTICE_MESSAGE_TYPE, payload, relayIdentity);
}

export function verifyMatchNoticeMessage(value: unknown): value is Message<MatchNoticePayload> {
  if (!isObject(value)) return false;
  try {
    const message = value as unknown as Message;
    return message.type === MATCH_NOTICE_MESSAGE_TYPE
      && verifyMessage(message)
      && verifyMatchNoticePayload(message.payload)
      && message.from === message.payload.matchOperation.relayId;
  } catch {
    return false;
  }
}

export function encryptMatchNotice(
  message: Message<MatchNoticePayload>,
  recipient: PublicationRecord,
): EncryptedMailboxEnvelope {
  if (!verifyMatchNoticeMessage(message)
    || !verifyPublicationRecord(recipient)
    || message.payload.recipientPublicationId !== recipient.publicationId
    || message.payload.recipientMailboxId !== recipient.mailbox.id) {
    throw new Error('Match notice recipient does not match publication mailbox');
  }
  const ephemeral = generateEphemeralKeyPair();
  const encrypted = boxEncrypt(
    decodeUTF8(JSON.stringify(message)),
    decodeBase64(recipient.mailbox.encryptionKey),
    ephemeral.secretKey,
  );
  return {
    version: PROTOCOL_V2_VERSION,
    kind: 'mailbox-envelope',
    payloadType: 'match-notice',
    envelopeId: createMailboxEnvelopeId(message.payload.matchOperation.operationId, recipient.mailbox.id),
    mailboxId: recipient.mailbox.id,
    ephemeralKey: encodeBase64(ephemeral.publicKey),
    nonce: encodeBase64(encrypted.nonce),
    ciphertext: encodeBase64(encrypted.ciphertext),
    createdAt: message.payload.createdAt,
    expiresAt: message.payload.expiresAt,
  };
}

export function verifyMailboxEnvelope(value: unknown): value is EncryptedMailboxEnvelope {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'ciphertext', 'createdAt', 'envelopeId', 'ephemeralKey', 'expiresAt',
    'kind', 'mailboxId', 'nonce', 'payloadType', 'version',
  ])) return false;
  return value.version === PROTOCOL_V2_VERSION
    && value.kind === 'mailbox-envelope'
    && (value.payloadType === 'match-notice'
      || value.payloadType === 'relationship-message'
      || value.payloadType === 'channel-operation')
    && isOpaqueId(value.envelopeId, 'env')
    && isAnyMailboxId(value.mailboxId)
    && isBase64OfLength(value.ephemeralKey, 32)
    && isBase64OfLength(value.nonce, 24)
    && isBoundedCiphertext(value.ciphertext)
    && isTimestamp(value.createdAt)
    && isTimestamp(value.expiresAt)
    && (value.expiresAt as number) > (value.createdAt as number);
}

export function decryptMatchNotice(
  envelope: EncryptedMailboxEnvelope,
  keys: PublicationKeyMaterial,
): Message<MatchNoticePayload> {
  if (!verifyMailboxEnvelope(envelope)
    || envelope.payloadType !== 'match-notice'
    || envelope.mailboxId !== keys.mailboxId) {
    throw new Error('Mailbox envelope does not belong to this publication');
  }
  const plaintext = boxDecrypt(
    decodeBase64(envelope.ciphertext),
    decodeBase64(envelope.nonce),
    decodeBase64(envelope.ephemeralKey),
    keys.mailboxKeyPair.secretKey,
  );
  if (!plaintext) throw new Error('Mailbox envelope decryption failed');

  let message: unknown;
  try { message = parseMessage(encodeUTF8(plaintext)); } catch {
    throw new Error('Mailbox envelope plaintext is invalid');
  }
  if (!verifyMatchNoticeMessage(message)) throw new Error('Mailbox match notice signature is invalid');
  if (message.payload.recipientPublicationId !== keys.publicationId
    || message.payload.recipientMailboxId !== keys.mailboxId
    || createMailboxEnvelopeId(message.payload.matchOperation.operationId, keys.mailboxId) !== envelope.envelopeId
    || message.payload.createdAt !== envelope.createdAt
    || message.payload.expiresAt !== envelope.expiresAt) {
    throw new Error('Mailbox envelope metadata does not match its encrypted notice');
  }
  return message;
}

export function encryptRelationshipMessage(
  message: RelationshipMessageV2,
  recipient: PublicationMailboxRecipient,
): EncryptedMailboxEnvelope {
  if (!verifyRelationshipMessageV2(message)
    || !isOpaqueId(recipient.publicationId, 'pub')
    || !isMailbox(recipient.mailbox)
    || message.recipientPublicationId !== recipient.publicationId) {
    throw new Error('Relationship message recipient does not match publication mailbox');
  }
  const ephemeral = generateEphemeralKeyPair();
  const encrypted = boxEncrypt(
    decodeUTF8(JSON.stringify(message)),
    decodeBase64(recipient.mailbox.encryptionKey),
    ephemeral.secretKey,
  );
  return {
    version: PROTOCOL_V2_VERSION,
    kind: 'mailbox-envelope',
    payloadType: 'relationship-message',
    envelopeId: createMailboxEnvelopeId(message.messageId, recipient.mailbox.id),
    mailboxId: recipient.mailbox.id,
    ephemeralKey: encodeBase64(ephemeral.publicKey),
    nonce: encodeBase64(encrypted.nonce),
    ciphertext: encodeBase64(encrypted.ciphertext),
    createdAt: message.createdAt,
    expiresAt: message.expiresAt,
  };
}

export function decryptRelationshipMessage(
  envelope: EncryptedMailboxEnvelope,
  keys: PublicationKeyMaterial,
): RelationshipMessageV2 {
  if (!verifyMailboxEnvelope(envelope)
    || envelope.payloadType !== 'relationship-message'
    || envelope.mailboxId !== keys.mailboxId) {
    throw new Error('Mailbox envelope does not contain a relationship message for this publication');
  }
  const plaintext = boxDecrypt(
    decodeBase64(envelope.ciphertext),
    decodeBase64(envelope.nonce),
    decodeBase64(envelope.ephemeralKey),
    keys.mailboxKeyPair.secretKey,
  );
  if (!plaintext) throw new Error('Mailbox envelope decryption failed');
  let message: unknown;
  try { message = JSON.parse(encodeUTF8(plaintext)); } catch {
    throw new Error('Mailbox relationship message plaintext is invalid');
  }
  if (!verifyRelationshipMessageV2(message)) {
    throw new Error('Mailbox relationship message signature is invalid');
  }
  if (message.recipientPublicationId !== keys.publicationId
    || createMailboxEnvelopeId(message.messageId, keys.mailboxId) !== envelope.envelopeId
    || message.createdAt !== envelope.createdAt
    || message.expiresAt !== envelope.expiresAt) {
    throw new Error('Mailbox envelope metadata does not match its relationship message');
  }
  return message;
}

export function createMailboxRequest(
  action: 'fetch' | 'ack',
  record: PublicationRecord,
  keys: PublicationKeyMaterial,
  envelopeIds: string[] = [],
  timestamp = Date.now(),
): MailboxRequest {
  if (!verifyPublicationRecord(record)
    || record.publicationId !== keys.publicationId
    || record.publicationKey !== encodeBase64(keys.signingKeyPair.publicKey)
    || record.mailbox.id !== keys.mailboxId) {
    throw new Error('Mailbox request key material does not own the publication');
  }
  const body: MailboxRequestBody = {
    version: PROTOCOL_V2_VERSION,
    kind: 'mailbox-request',
    requestId: derivedId('req', encodeBase64(generateEphemeralKeyPair().publicKey)),
    action,
    publicationId: record.publicationId,
    publicationKey: record.publicationKey,
    mailboxId: record.mailbox.id,
    envelopeIds,
    timestamp,
  };
  if (!isMailboxRequestBody(body)) throw new Error('Invalid mailbox request input');
  return {
    ...body,
    signature: encodeBase64(sign(signableMailboxRequest(body), keys.signingKeyPair.secretKey)),
  };
}

export function verifyMailboxRequest(value: unknown): value is MailboxRequest {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'action', 'envelopeIds', 'kind', 'mailboxId', 'publicationId',
    'publicationKey', 'requestId', 'signature', 'timestamp', 'version',
  ])) return false;
  const { signature, ...body } = value;
  if (typeof signature !== 'string' || !isMailboxRequestBody(body)) return false;
  try {
    return verify(
      signableMailboxRequest(body),
      decodeBase64(signature),
      decodeBase64(body.publicationKey),
    );
  } catch {
    return false;
  }
}

export function createMailboxRequestFrame(
  request: MailboxRequest,
  admission?: AdmissionCapabilityV2,
): MailboxRequestFrame {
  if (!verifyMailboxRequest(request)) throw new Error('Cannot frame an invalid mailbox request');
  if (admission !== undefined && !verifyAdmissionCapabilityV2(admission)) {
    throw new Error('Cannot frame an invalid admission capability');
  }
  return admission === undefined
    ? { type: MAILBOX_REQUEST_FRAME_TYPE, request }
    : { type: MAILBOX_REQUEST_FRAME_TYPE, request, admission };
}

export function parseMailboxRequestFrame(raw: string): MailboxRequestFrame {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)
    || !hasFrameKeys(parsed)
    || parsed.type !== MAILBOX_REQUEST_FRAME_TYPE
    || !verifyMailboxRequest(parsed.request)
    || ('admission' in parsed && !verifyAdmissionCapabilityV2(parsed.admission))) {
    throw new Error('Invalid mailbox request frame');
  }
  return parsed as unknown as MailboxRequestFrame;
}

export function serializeMailboxRequestFrame(frame: MailboxRequestFrame): string {
  if (frame.type !== MAILBOX_REQUEST_FRAME_TYPE
    || !verifyMailboxRequest(frame.request)
    || (frame.admission !== undefined && !verifyAdmissionCapabilityV2(frame.admission))) {
    throw new Error('Invalid mailbox request frame');
  }
  return JSON.stringify(frame);
}

export function createMailboxDepositRequest(
  matchId: string,
  sender: PublicationRecord,
  recipient: PublicationMailboxRecipient,
  keys: PublicationKeyMaterial,
  envelope: EncryptedMailboxEnvelope,
  timestamp = Date.now(),
): MailboxDepositRequest {
  if (!verifyPublicationRecord(sender)
    || sender.publicationId !== keys.publicationId
    || sender.publicationKey !== encodeBase64(keys.signingKeyPair.publicKey)) {
    throw new Error('Mailbox deposit key material does not own the sender publication');
  }
  if (!isOpaqueId(recipient.publicationId, 'pub')
    || !isMailbox(recipient.mailbox)
    || envelope.mailboxId !== recipient.mailbox.id
    || matchId !== createDeterministicMatchId(sender.publicationId, recipient.publicationId)) {
    throw new Error('Mailbox deposit recipient does not match the encrypted envelope');
  }
  const body: MailboxDepositBody = {
    version: PROTOCOL_V2_VERSION,
    kind: 'mailbox-deposit',
    requestId: derivedId('req', encodeBase64(generateEphemeralKeyPair().publicKey)),
    matchId,
    senderPublicationId: sender.publicationId,
    senderPublicationKey: sender.publicationKey,
    recipientPublicationId: recipient.publicationId,
    recipientMailboxId: recipient.mailbox.id,
    envelope,
    timestamp,
  };
  if (!isMailboxDepositBody(body)) throw new Error('Invalid mailbox deposit input');
  return {
    ...body,
    signature: encodeBase64(sign(signableMailboxDeposit(body), keys.signingKeyPair.secretKey)),
  };
}

export function verifyMailboxDepositRequest(value: unknown): value is MailboxDepositRequest {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'envelope', 'kind', 'matchId', 'recipientMailboxId', 'recipientPublicationId',
    'requestId', 'senderPublicationId', 'senderPublicationKey', 'signature',
    'timestamp', 'version',
  ])) return false;
  const { signature, ...body } = value;
  if (typeof signature !== 'string' || !isMailboxDepositBody(body)) return false;
  try {
    return verify(
      signableMailboxDeposit(body),
      decodeBase64(signature),
      decodeBase64(body.senderPublicationKey),
    );
  } catch {
    return false;
  }
}

export function createMailboxDepositFrame(
  request: MailboxDepositRequest,
  admission?: AdmissionCapabilityV2,
): MailboxDepositFrame {
  if (!verifyMailboxDepositRequest(request)) throw new Error('Cannot frame an invalid mailbox deposit');
  if (admission !== undefined && !verifyAdmissionCapabilityV2(admission)) {
    throw new Error('Cannot frame an invalid admission capability');
  }
  return admission === undefined
    ? { type: MAILBOX_DEPOSIT_FRAME_TYPE, request }
    : { type: MAILBOX_DEPOSIT_FRAME_TYPE, request, admission };
}

export function parseMailboxDepositFrame(raw: string): MailboxDepositFrame {
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed)
    || !hasFrameKeys(parsed)
    || parsed.type !== MAILBOX_DEPOSIT_FRAME_TYPE
    || !verifyMailboxDepositRequest(parsed.request)
    || ('admission' in parsed && !verifyAdmissionCapabilityV2(parsed.admission))) {
    throw new Error('Invalid mailbox deposit frame');
  }
  return parsed as unknown as MailboxDepositFrame;
}

export function serializeMailboxDepositFrame(frame: MailboxDepositFrame): string {
  if (frame.type !== MAILBOX_DEPOSIT_FRAME_TYPE
    || !verifyMailboxDepositRequest(frame.request)
    || (frame.admission !== undefined && !verifyAdmissionCapabilityV2(frame.admission))) {
    throw new Error('Invalid mailbox deposit frame');
  }
  return JSON.stringify(frame);
}

function verifyMatchNoticePayload(value: unknown): value is MatchNoticePayload {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'createdAt', 'expiresAt', 'kind', 'matchId', 'partnerItemType',
    'matchOperation', 'partnerMailbox', 'partnerPublicationId', 'partnerPublicationKey',
    'recipientMailboxId', 'recipientPublicationId', 'similarity', 'version',
  ])) return false;
  if (value.version !== PROTOCOL_V2_VERSION || value.kind !== 'match-notice') return false;
  if (!verifyMatchOperationV2(value.matchOperation)) return false;
  if (!isOpaqueId(value.matchId, 'match')) return false;
  if (!isOpaqueId(value.recipientPublicationId, 'pub') || !isOpaqueId(value.recipientMailboxId, 'mbx')) return false;
  if (!isOpaqueId(value.partnerPublicationId, 'pub') || !isBase64OfLength(value.partnerPublicationKey, 32)) return false;
  if (!idMatchesKey(value.partnerPublicationId, 'pub', value.partnerPublicationKey)) return false;
  if (!isMailbox(value.partnerMailbox)) return false;
  if (value.partnerItemType !== 'need' && value.partnerItemType !== 'offer') return false;
  if (typeof value.similarity !== 'number' || !Number.isFinite(value.similarity)
    || value.similarity < 0 || value.similarity > 1) return false;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt) || value.expiresAt <= value.createdAt) return false;
  return value.matchId === value.matchOperation.matchId
    && value.similarity === value.matchOperation.similarity
    && value.createdAt === value.matchOperation.createdAt
    && value.expiresAt === value.matchOperation.expiresAt
    && value.matchId === createDeterministicMatchId(
    value.recipientPublicationId,
    value.partnerPublicationId,
    )
    && value.matchOperation.publications.some(reference => (
      reference.publicationId === value.recipientPublicationId
    ))
    && value.matchOperation.publications.some(reference => (
      reference.publicationId === value.partnerPublicationId
      && reference.publicationSignature.length > 0
    ));
}

function isMailboxRequestBody(value: unknown): value is MailboxRequestBody {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'action', 'envelopeIds', 'kind', 'mailboxId', 'publicationId',
    'publicationKey', 'requestId', 'timestamp', 'version',
  ])) return false;
  if (value.version !== PROTOCOL_V2_VERSION || value.kind !== 'mailbox-request') return false;
  if (value.action !== 'fetch' && value.action !== 'ack') return false;
  if (!isOpaqueId(value.requestId, 'req') || !isOpaqueId(value.publicationId, 'pub')) return false;
  if (!isBase64OfLength(value.publicationKey, 32)
    || !idMatchesKey(value.publicationId, 'pub', value.publicationKey)) return false;
  if (!isOpaqueId(value.mailboxId, 'mbx') || !isTimestamp(value.timestamp)) return false;
  if (!Array.isArray(value.envelopeIds) || value.envelopeIds.length > 100
    || !value.envelopeIds.every((id) => isOpaqueId(id, 'env'))
    || new Set(value.envelopeIds).size !== value.envelopeIds.length) return false;
  return value.action === 'fetch' ? value.envelopeIds.length === 0 : value.envelopeIds.length > 0;
}

function isMailboxDepositBody(value: unknown): value is MailboxDepositBody {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'envelope', 'kind', 'matchId', 'recipientMailboxId', 'recipientPublicationId',
    'requestId', 'senderPublicationId', 'senderPublicationKey', 'timestamp', 'version',
  ])) return false;
  if (value.version !== PROTOCOL_V2_VERSION || value.kind !== 'mailbox-deposit') return false;
  if (!isOpaqueId(value.requestId, 'req') || !isOpaqueId(value.matchId, 'match')) return false;
  if (!isOpaqueId(value.senderPublicationId, 'pub')
    || !isBase64OfLength(value.senderPublicationKey, 32)
    || !idMatchesKey(value.senderPublicationId, 'pub', value.senderPublicationKey)) return false;
  if (!isOpaqueId(value.recipientPublicationId, 'pub')
    || !isOpaqueId(value.recipientMailboxId, 'mbx')
    || !verifyMailboxEnvelope(value.envelope)
    || value.envelope.mailboxId !== value.recipientMailboxId
    || !isTimestamp(value.timestamp)) return false;
  return value.matchId === createDeterministicMatchId(
    value.senderPublicationId,
    value.recipientPublicationId,
  );
}

function signableMailboxRequest(body: MailboxRequestBody): Uint8Array {
  return decodeUTF8(`${MAILBOX_REQUEST_SIGNATURE_DOMAIN}\n${canonicalize(body)}`);
}

function signableMailboxDeposit(body: MailboxDepositBody): Uint8Array {
  return decodeUTF8(`${MAILBOX_DEPOSIT_SIGNATURE_DOMAIN}\n${canonicalize(body)}`);
}

function derivedId(prefix: 'match' | 'env' | 'req', input: string): string {
  const bytes = sha512(decodeUTF8(input)).slice(0, 32);
  return `${prefix}_${encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function isMailbox(value: unknown): value is PublicationMailbox {
  return isObject(value)
    && hasOnlyKeys(value, ['encryptionKey', 'id'])
    && isOpaqueId(value.id, 'mbx')
    && isBase64OfLength(value.encryptionKey, 32)
    && idMatchesKey(value.id, 'mbx', value.encryptionKey);
}

function isAnyMailboxId(value: unknown): value is string {
  return typeof value === 'string'
    && /^(?:mbx|rmbx)_[A-Za-z0-9_-]{43}$/.test(value);
}

function idMatchesKey(id: string, prefix: 'pub' | 'mbx', encodedKey: string): boolean {
  try {
    const base64url = encodeBase64(decodeBase64(encodedKey))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return id === `${prefix}_${base64url}`;
  } catch {
    return false;
  }
}

function isBase64OfLength(value: unknown, length: number): value is string {
  if (typeof value !== 'string' || value.length > 100_000) return false;
  try { return decodeBase64(value).length === length; } catch { return false; }
}

function isBoundedCiphertext(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 24 || value.length > 87_384) return false;
  try { return decodeBase64(value).length <= 65_536; } catch { return false; }
}

function isOpaqueId(value: unknown, prefix: 'pub' | 'mbx' | 'match' | 'env' | 'req'): value is string {
  return typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{43}$`).test(value);
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
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new Error(`Cannot canonicalize ${typeof value}`);
}
