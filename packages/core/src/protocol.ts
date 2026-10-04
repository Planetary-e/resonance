/**
 * Wire protocol: message types, envelope creation, signing, and validation.
 * All messages are JSON over WebSocket with a signed envelope.
 */

import type { ItemType } from './types.js';
import type { Identity } from './crypto.js';
import { sign, verify, didToPublicKey, encodeBase64, decodeBase64, decodeUTF8 } from './crypto.js';

export const MAX_SIGNED_MESSAGE_BYTES = 1024 * 1024;

// --- Message Envelope ---

export interface Message<T = unknown> {
  type: string;
  from: string;        // DID of sender
  timestamp: number;   // unix ms
  signature: string;   // base64 ed25519 signature
  payload: T;
}

// --- Node → Relay Payloads ---

export interface PublishPayload {
  itemId: string;
  hash: string;         // base64-encoded LSH binary hash
  itemType: ItemType;
  ttl: number;          // seconds until expiry (default: 604800 = 7 days)
}

export interface SearchPayload {
  hash: string;          // base64-encoded LSH binary hash
  k: number;
  threshold: number;
}

export interface ConsentPayload {
  matchId: string;
  accept: boolean;
  encryptedForPartner: string;  // base64 box-encrypted
}

export interface WithdrawPayload {
  itemId: string;
}

// --- Relay → Node Payloads ---

export interface MatchPayload {
  matchId: string;
  partnerDID: string;
  similarity: number;
  yourItemId: string;
  partnerItemType: ItemType;
  expiry: number;      // unix ms
}

export interface SearchResultsPayload {
  results: Array<{
    did: string;
    similarity: number;
    itemType: ItemType;
  }>;
}

export interface ConsentForwardPayload {
  matchId: string;
  fromDID: string;
  encrypted: string;   // base64 box-encrypted
}

export interface AckPayload {
  ref: string;
  status: 'ok' | 'error';
  message?: string;
}

// --- Direct Channel Payloads ---

export interface ConfirmEmbeddingPayload {
  vector: number[];
}

export interface ConfirmResultPayload {
  similarity: number;
  confirmed: boolean;
}

export interface DisclosurePayload {
  text: string;
  level: 'category' | 'detail' | 'contact';
}

export interface AcceptPayload {
  message?: string;
}

export interface RejectPayload {
  reason?: string;
}

export interface ClosePayload {}

// --- Authentication ---

export interface AuthPayload {}

// --- Channel bridge (via relay) ---

export interface ChannelMessagePayload {
  matchId: string;
  encrypted: string;  // secretbox(JSON, sharedSecret) → base64
  nonce: string;      // base64
}

export interface ChannelForwardPayload {
  matchId: string;
  fromDID: string;
  encrypted: string;  // base64 (relay cannot read)
  nonce: string;      // base64
}

// --- Message type constants ---

export const MessageTypes = {
  // Authentication
  AUTH: 'auth',
  // Node → Relay
  PUBLISH: 'publish',
  SEARCH: 'search',
  CONSENT: 'consent',
  WITHDRAW: 'withdraw',
  // Relay → Node
  MATCH: 'match',
  SEARCH_RESULTS: 'search_results',
  CONSENT_FORWARD: 'consent_forward',
  ACK: 'ack',
  // Direct Channel
  CONFIRM_EMBEDDING: 'confirm_embedding',
  CONFIRM_RESULT: 'confirm_result',
  DISCLOSURE: 'disclosure',
  ACCEPT: 'accept',
  REJECT: 'reject',
  CLOSE: 'close',
  // Channel bridge (via relay)
  CHANNEL_MESSAGE: 'channel_message',
  CHANNEL_FORWARD: 'channel_forward',
} as const;

// --- Signing and Verification ---

/**
 * Create the signable bytes for a message.
 * Signs over: JSON.stringify({ type, from, timestamp, payload })
 */
function getSignableBytes(type: string, from: string, timestamp: number, payload: unknown): Uint8Array {
  const canonical = JSON.stringify({ type, from, timestamp, payload });
  return decodeUTF8(canonical);
}

/**
 * Create a signed message envelope.
 */
export function createMessage<T>(type: string, payload: T, identity: Identity): Message<T> {
  const timestamp = Date.now();
  const signable = getSignableBytes(type, identity.did, timestamp, payload);
  const signature = sign(signable, identity.secretKey);

  return {
    type,
    from: identity.did,
    timestamp,
    signature: encodeBase64(signature),
    payload,
  };
}

/**
 * Verify a message's signature.
 * If publicKey is not provided, extracts it from the message's `from` DID.
 */
export function verifyMessage(message: Message, publicKey?: Uint8Array): boolean {
  try {
    if (!message || typeof message !== 'object'
      || Object.keys(message).sort().join(',') !== 'from,payload,signature,timestamp,type'
      || typeof message.from !== 'string' || message.from.length > 256
      || typeof message.type !== 'string' || message.type.length > 128
      || !Number.isSafeInteger(message.timestamp)
      || typeof message.signature !== 'string' || message.signature.length !== 88) return false;
    const signature = decodeBase64(message.signature);
    if (signature.length !== 64 || encodeBase64(signature) !== message.signature) return false;
    const pk = publicKey ?? didToPublicKey(message.from);
    const signable = getSignableBytes(message.type, message.from, message.timestamp, message.payload);
    return signable.length <= MAX_SIGNED_MESSAGE_BYTES && verify(signable, signature, pk);
  } catch { return false; }
}

/**
 * Parse a raw JSON string into a Message.
 * Validates that required fields are present.
 */
export function parseMessage(raw: string): Message {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_SIGNED_MESSAGE_BYTES) {
    throw new Error('Signed message exceeds the maximum size');
  }
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid signed message envelope');
  }

  if (typeof parsed.type !== 'string') throw new Error('Missing or invalid "type" field');
  if (typeof parsed.from !== 'string') throw new Error('Missing or invalid "from" field');
  if (typeof parsed.timestamp !== 'number') throw new Error('Missing or invalid "timestamp" field');
  if (typeof parsed.signature !== 'string') throw new Error('Missing or invalid "signature" field');
  if (parsed.payload === undefined) throw new Error('Missing "payload" field');
  if (Object.keys(parsed).sort().join(',') !== 'from,payload,signature,timestamp,type'
    || parsed.type.length > 128 || parsed.from.length > 256
    || !Number.isSafeInteger(parsed.timestamp) || parsed.timestamp < 0
    || parsed.signature.length !== 88) {
    throw new Error('Invalid signed message envelope');
  }

  return parsed as Message;
}

/**
 * Serialize a message to JSON string for transmission.
 */
export function serializeMessage(message: Message): string {
  const raw = JSON.stringify(message);
  if (Buffer.byteLength(raw, 'utf8') > MAX_SIGNED_MESSAGE_BYTES) {
    throw new Error('Signed message exceeds the maximum size');
  }
  return raw;
}
