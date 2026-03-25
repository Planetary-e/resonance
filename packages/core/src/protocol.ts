/**
 * Wire protocol: message types, envelope creation, signing, and validation.
 * All messages are JSON over WebSocket with a signed envelope.
 */

import type { ItemType } from './types.js';
import type { Identity } from './crypto.js';
import { sign, verify, didToPublicKey, encodeBase64, decodeBase64, decodeUTF8 } from './crypto.js';

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
  vector: number[];
  itemType: ItemType;
  ttl: number;         // seconds until expiry (default: 604800 = 7 days)
}

export interface SearchPayload {
  vector: number[];
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
  const pk = publicKey ?? didToPublicKey(message.from);
  const signable = getSignableBytes(message.type, message.from, message.timestamp, message.payload);
  const signature = decodeBase64(message.signature);
  return verify(signable, signature, pk);
}

/**
 * Parse a raw JSON string into a Message.
 * Validates that required fields are present.
 */
export function parseMessage(raw: string): Message {
  const parsed = JSON.parse(raw);

  if (typeof parsed.type !== 'string') throw new Error('Missing or invalid "type" field');
  if (typeof parsed.from !== 'string') throw new Error('Missing or invalid "from" field');
  if (typeof parsed.timestamp !== 'number') throw new Error('Missing or invalid "timestamp" field');
  if (typeof parsed.signature !== 'string') throw new Error('Missing or invalid "signature" field');
  if (parsed.payload === undefined) throw new Error('Missing "payload" field');

  return parsed as Message;
}

/**
 * Serialize a message to JSON string for transmission.
 */
export function serializeMessage(message: Message): string {
  return JSON.stringify(message);
}
