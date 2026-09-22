/** Bounded, signed mailbox anti-entropy between a publication controller and its selected replica. */

import {
  decodeBase64, decodeUTF8, didToPublicKey, encodeBase64,
  generateSigningKeyPair, publicKeyToDid, sign, verify, type Identity,
} from './crypto.js';
import { verifyMailboxEnvelope, type EncryptedMailboxEnvelope } from './mailbox-v2.js';
import { MAX_RELAY_DISCOVERY_FRAME_BYTES } from './relay-discovery.js';
import { isDurabilityReceiptV1, type RelayReplicaReceiptV1 } from './relay-replication.js';

export const RELAY_MAILBOX_SYNC_REQUEST_FRAME_TYPE = 'relay_mailbox_sync_request' as const;
export const RELAY_MAILBOX_SYNC_RESPONSE_FRAME_TYPE = 'relay_mailbox_sync_response' as const;
export const MAX_RELAY_MAILBOX_SYNC_EVENTS = 8;
const LIFETIME_MS = 15_000;
const REQUEST_DOMAIN = 'resonance:relay-mailbox-sync:v1:request';
const RESPONSE_DOMAIN = 'resonance:relay-mailbox-sync:v1:response';

export type RelayMailboxEventV1 =
  | { kind: 'envelope'; envelope: EncryptedMailboxEnvelope }
  | { kind: 'ack'; mailboxId: string; envelopeId: string; expiresAt: number };

export interface RelayMailboxSyncRequestV1 {
  version: 1;
  kind: 'relay-mailbox-sync-request';
  requestId: string;
  senderRelayId: string;
  targetRelayId: string;
  receipt: RelayReplicaReceiptV1;
  cursor: number;
  events: RelayMailboxEventV1[];
  createdAt: number;
  expiresAt: number;
  signature: string;
}

export interface RelayMailboxSyncResponseV1 {
  version: 1;
  kind: 'relay-mailbox-sync-response';
  requestId: string;
  requestSignature: string;
  senderRelayId: string;
  targetRelayId: string;
  status: 'ok' | 'rejected';
  events: RelayMailboxEventV1[];
  nextCursor: number;
  createdAt: number;
  signature: string;
}

export function verifyRelayMailboxEventV1(value: unknown): value is RelayMailboxEventV1 {
  if (!isObject(value)) return false;
  if (value.kind === 'envelope') {
    return hasKeys(value, ['envelope', 'kind']) && verifyMailboxEnvelope(value.envelope);
  }
  return value.kind === 'ack' && hasKeys(value, ['envelopeId', 'expiresAt', 'kind', 'mailboxId'])
    && typeof value.mailboxId === 'string' && /^mbx_[A-Za-z0-9_-]{43}$/.test(value.mailboxId)
    && typeof value.envelopeId === 'string' && /^env_[A-Za-z0-9_-]{43}$/.test(value.envelopeId)
    && isTimestamp(value.expiresAt);
}

export function createRelayMailboxSyncRequestV1(
  receipt: RelayReplicaReceiptV1,
  cursor: number,
  events: RelayMailboxEventV1[],
  identity: Identity,
  now = Date.now(),
): RelayMailboxSyncRequestV1 {
  const body = {
    version: 1 as const, kind: 'relay-mailbox-sync-request' as const,
    requestId: requestId(), senderRelayId: identity.did,
    targetRelayId: receipt.responderRelayId, receipt, cursor, events,
    createdAt: now, expiresAt: now + LIFETIME_MS,
  };
  if (!isRequestBody(body) || identity.did !== receipt.senderRelayId
    || publicKeyToDid(identity.publicKey) !== identity.did) throw new Error('Invalid mailbox sync request');
  return { ...body, signature: encodeBase64(sign(signable(REQUEST_DOMAIN, body), identity.secretKey)) };
}

export function verifyRelayMailboxSyncRequestV1(value: unknown, now?: number): value is RelayMailboxSyncRequestV1 {
  if (!isObject(value) || !hasKeys(value, [
    'createdAt', 'cursor', 'events', 'expiresAt', 'kind', 'receipt', 'requestId',
    'senderRelayId', 'signature', 'targetRelayId', 'version',
  ])) return false;
  const { signature, ...body } = value;
  if (!isSignature(signature) || !isRequestBody(body)
    || (now !== undefined && (now < body.createdAt || now >= body.expiresAt))) return false;
  try { return verify(signable(REQUEST_DOMAIN, body), decodeBase64(signature), didToPublicKey(body.senderRelayId)); }
  catch { return false; }
}

export function createRelayMailboxSyncResponseV1(
  request: RelayMailboxSyncRequestV1,
  status: 'ok' | 'rejected',
  events: RelayMailboxEventV1[],
  nextCursor: number,
  identity: Identity,
  now = Date.now(),
): RelayMailboxSyncResponseV1 {
  const body = {
    version: 1 as const, kind: 'relay-mailbox-sync-response' as const,
    requestId: request.requestId, requestSignature: request.signature,
    senderRelayId: identity.did, targetRelayId: request.senderRelayId,
    status, events, nextCursor, createdAt: now,
  };
  if (!verifyRelayMailboxSyncRequestV1(request) || !isResponseBody(body)
    || !responseMatchesRequest(body, request)
    || publicKeyToDid(identity.publicKey) !== identity.did) throw new Error('Invalid mailbox sync response');
  return { ...body, signature: encodeBase64(sign(signable(RESPONSE_DOMAIN, body), identity.secretKey)) };
}

export function verifyRelayMailboxSyncResponseV1(
  value: unknown, request?: RelayMailboxSyncRequestV1,
): value is RelayMailboxSyncResponseV1 {
  if (!isObject(value) || !hasKeys(value, [
    'createdAt', 'events', 'kind', 'nextCursor', 'requestId', 'requestSignature',
    'senderRelayId', 'signature', 'status', 'targetRelayId', 'version',
  ])) return false;
  const { signature, ...body } = value;
  if (!isSignature(signature) || !isResponseBody(body)
    || (request && (!verifyRelayMailboxSyncRequestV1(request) || !responseMatchesRequest(body, request)))) return false;
  try { return verify(signable(RESPONSE_DOMAIN, body), decodeBase64(signature), didToPublicKey(body.senderRelayId)); }
  catch { return false; }
}

export function serializeRelayMailboxSyncRequestFrameV1(request: RelayMailboxSyncRequestV1): string {
  if (!verifyRelayMailboxSyncRequestV1(request)) throw new Error('Invalid mailbox sync request');
  return boundedStringify({ type: RELAY_MAILBOX_SYNC_REQUEST_FRAME_TYPE, request });
}

export function serializeRelayMailboxSyncResponseFrameV1(response: RelayMailboxSyncResponseV1): string {
  if (!verifyRelayMailboxSyncResponseV1(response)) throw new Error('Invalid mailbox sync response');
  return boundedStringify({ type: RELAY_MAILBOX_SYNC_RESPONSE_FRAME_TYPE, response });
}

export function parseRelayMailboxSyncRequestFrameV1(raw: string): RelayMailboxSyncRequestV1 {
  const frame = boundedParse(raw);
  if (!isObject(frame) || !hasKeys(frame, ['request', 'type'])
    || frame.type !== RELAY_MAILBOX_SYNC_REQUEST_FRAME_TYPE
    || !verifyRelayMailboxSyncRequestV1(frame.request)) throw new Error('Invalid mailbox sync request frame');
  return frame.request;
}

export function parseRelayMailboxSyncResponseFrameV1(raw: string): RelayMailboxSyncResponseV1 {
  const frame = boundedParse(raw);
  if (!isObject(frame) || !hasKeys(frame, ['response', 'type'])
    || frame.type !== RELAY_MAILBOX_SYNC_RESPONSE_FRAME_TYPE
    || !verifyRelayMailboxSyncResponseV1(frame.response)) throw new Error('Invalid mailbox sync response frame');
  return frame.response;
}

function isRequestBody(value: unknown): value is Omit<RelayMailboxSyncRequestV1, 'signature'> {
  if (!isObject(value) || !hasKeys(value, [
    'createdAt', 'cursor', 'events', 'expiresAt', 'kind', 'receipt', 'requestId',
    'senderRelayId', 'targetRelayId', 'version',
  ])) return false;
  return value.version === 1 && value.kind === 'relay-mailbox-sync-request'
    && isRequestId(value.requestId) && isRelayId(value.senderRelayId)
    && isRelayId(value.targetRelayId) && value.senderRelayId !== value.targetRelayId
    && isDurabilityReceiptV1(value.receipt)
    && value.receipt.senderRelayId === value.senderRelayId
    && value.receipt.responderRelayId === value.targetRelayId
    && isCursor(value.cursor) && isEvents(value.events)
    && isTimestamp(value.createdAt) && isTimestamp(value.expiresAt)
    && value.expiresAt > value.createdAt
    && value.expiresAt - value.createdAt <= LIFETIME_MS;
}

function isResponseBody(value: unknown): value is Omit<RelayMailboxSyncResponseV1, 'signature'> {
  if (!isObject(value) || !hasKeys(value, [
    'createdAt', 'events', 'kind', 'nextCursor', 'requestId', 'requestSignature',
    'senderRelayId', 'status', 'targetRelayId', 'version',
  ])) return false;
  return value.version === 1 && value.kind === 'relay-mailbox-sync-response'
    && isRequestId(value.requestId) && isSignature(value.requestSignature)
    && isRelayId(value.senderRelayId) && isRelayId(value.targetRelayId)
    && (value.status === 'ok' || value.status === 'rejected')
    && isEvents(value.events) && isCursor(value.nextCursor)
    && (value.status === 'ok' || value.events.length === 0)
    && isTimestamp(value.createdAt);
}

function responseMatchesRequest(
  response: Omit<RelayMailboxSyncResponseV1, 'signature'>,
  request: RelayMailboxSyncRequestV1,
): boolean {
  return response.requestId === request.requestId
    && response.requestSignature === request.signature
    && response.senderRelayId === request.targetRelayId
    && response.targetRelayId === request.senderRelayId
    && response.createdAt >= request.createdAt
    && response.createdAt <= request.expiresAt;
}

function isEvents(value: unknown): value is RelayMailboxEventV1[] {
  return Array.isArray(value) && value.length <= MAX_RELAY_MAILBOX_SYNC_EVENTS
    && value.every(verifyRelayMailboxEventV1);
}
function isCursor(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function isTimestamp(value: unknown): value is number { return isCursor(value); }
function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^mbsync_[A-Za-z0-9_-]{43}$/.test(value);
}
function requestId(): string {
  return `mbsync_${encodeBase64(generateSigningKeyPair().publicKey).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}
function isRelayId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256) return false;
  try { return publicKeyToDid(didToPublicKey(value)) === value; } catch { return false; }
}
function isSignature(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128) return false;
  try { return decodeBase64(value).length === 64 && encodeBase64(decodeBase64(value)) === value; }
  catch { return false; }
}
function signable(domain: string, body: unknown): Uint8Array {
  return decodeUTF8(`${domain}\n${canonicalize(body)}`);
}
function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  throw new Error('Invalid canonical mailbox sync value');
}
function boundedStringify(value: unknown): string {
  const raw = JSON.stringify(value);
  if (decodeUTF8(raw).length > MAX_RELAY_DISCOVERY_FRAME_BYTES) throw new Error('Mailbox sync frame too large');
  return raw;
}
function boundedParse(raw: string): unknown {
  if (typeof raw !== 'string' || decodeUTF8(raw).length > MAX_RELAY_DISCOVERY_FRAME_BYTES) throw new Error('Mailbox sync frame too large');
  return JSON.parse(raw) as unknown;
}
function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
