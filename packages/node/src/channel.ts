/**
 * Direct channel manager: consent handshake, key exchange,
 * encrypted messaging, and match confirmation.
 *
 * Uses the relay as a message bridge — all channel messages are
 * E2E encrypted with a DH-derived shared secret.
 */

import { randomUUID } from 'node:crypto';
import {
  generateEphemeralKeyPair,
  deriveSharedSecret,
  secretboxEncrypt,
  secretboxDecrypt,
  sign,
  verify,
  didToPublicKey,
  encodeBase64,
  decodeBase64,
  decodeUTF8,
  encodeUTF8,
  cosineSimilarity,
  MessageTypes,
  PROTOCOL_DEFAULTS,
  type Identity,
  type KeyPair,
  type ConsentForwardPayload,
  type ChannelForwardPayload,
  type ChannelMessagePayload,
  type ConfirmEmbeddingPayload,
  type ConfirmResultPayload,
  type DisclosurePayload,
  type AcceptPayload,
  type RejectPayload,
} from '@resonance/core';
import type { LocalStore } from './store.js';
import type { RelayClient } from './relay-client.js';

// --- Public types ---

export type ChannelState = 'pending' | 'handshaking' | 'confirming' | 'active' | 'closed';

export interface ChannelInfo {
  id: string;
  matchId: string;
  partnerDID: string;
  state: ChannelState;
  similarity: number | null;
  confirmed: boolean | null;
}

export interface ChannelManagerEvents {
  onChannelReady?: (channelId: string, matchId: string) => void;
  onConfirmResult?: (channelId: string, similarity: number, confirmed: boolean) => void;
  onDisclosure?: (channelId: string, text: string, level: string) => void;
  onAccept?: (channelId: string, message?: string) => void;
  onReject?: (channelId: string, reason?: string) => void;
  onClose?: (channelId: string) => void;
}

export interface ChannelManagerConfig {
  identity: Identity;
  store: LocalStore;
  relayClient: RelayClient;
  confirmThreshold?: number;
}

export interface ChannelManager {
  initiateChannel(matchId: string, partnerDID: string): Promise<string>;
  handleConsentForward(payload: ConsentForwardPayload): Promise<void>;
  handleChannelForward(payload: ChannelForwardPayload): Promise<void>;
  sendConfirmEmbedding(channelId: string, embedding: Float32Array): Promise<void>;
  sendDisclosure(channelId: string, text: string, level: 'category' | 'detail' | 'contact'): Promise<void>;
  sendAccept(channelId: string, message?: string): Promise<void>;
  sendReject(channelId: string, reason?: string): Promise<void>;
  sendClose(channelId: string): Promise<void>;
  getChannel(channelId: string): ChannelInfo | null;
  listChannels(): ChannelInfo[];
  on(events: Partial<ChannelManagerEvents>): void;
}

// --- Internal state ---

interface InternalChannel {
  id: string;
  matchId: string;
  partnerDID: string;
  state: ChannelState;
  myKeyPair: KeyPair | null;
  sharedSecret: Uint8Array | null;
  similarity: number | null;
  confirmed: boolean | null;
  myEmbedding: Float32Array | null;
  partnerEmbedding: Float32Array | null;
}

// --- Authenticated key exchange helpers ---

/** Sign the consent payload to prevent MITM by the relay. */
function signConsentData(
  ephemeralPublicKey: Uint8Array,
  matchId: string,
  partnerDID: string,
  identity: Identity,
): string {
  const payload = JSON.stringify({
    ephemeralPublicKey: encodeBase64(ephemeralPublicKey),
    matchId,
    partnerDID,
  });
  const sig = sign(decodeUTF8(payload), identity.secretKey);
  return JSON.stringify({
    payload,
    signature: encodeBase64(sig),
    senderDID: identity.did,
  });
}

/** Verify and extract the ephemeral public key from a signed consent. */
function verifyConsentData(
  data: string,
  expectedMatchId: string,
): { ephemeralPublicKey: Uint8Array; senderDID: string } {
  const outer = JSON.parse(data);
  const { payload, signature, senderDID } = outer;

  // Verify signature with the sender's public key (derived from DID)
  const pubKey = didToPublicKey(senderDID);
  const isValid = verify(decodeUTF8(payload), decodeBase64(signature), pubKey);
  if (!isValid) throw new Error('Invalid consent signature — possible MITM');

  const inner = JSON.parse(payload);
  if (inner.matchId !== expectedMatchId) throw new Error('Consent matchId mismatch');

  return {
    ephemeralPublicKey: decodeBase64(inner.ephemeralPublicKey),
    senderDID,
  };
}

// --- Implementation ---

export function createChannelManager(config: ChannelManagerConfig): ChannelManager {
  const { identity, store, relayClient } = config;
  const confirmThreshold = config.confirmThreshold ?? PROTOCOL_DEFAULTS.confirmThreshold;
  const channels = new Map<string, InternalChannel>();
  const matchToChannel = new Map<string, string>();
  const events: Partial<ChannelManagerEvents> = {};

  /** VULN-16: Zero key material and remove channel from memory. */
  function cleanupChannel(ch: InternalChannel): void {
    ch.sharedSecret?.fill(0);
    ch.myKeyPair?.secretKey.fill(0);
    ch.myEmbedding = null;
    ch.partnerEmbedding = null;
    channels.delete(ch.id);
  }

  function sendEncrypted(ch: InternalChannel, type: string, payload: unknown): void {
    if (!ch.sharedSecret) throw new Error('No shared secret');
    const json = JSON.stringify({ type, payload });
    const { nonce, ciphertext } = secretboxEncrypt(decodeUTF8(json), ch.sharedSecret);

    relayClient.sendChannelMessage({
      matchId: ch.matchId,
      encrypted: encodeBase64(ciphertext),
      nonce: encodeBase64(nonce),
    });
  }

  function processConfirmation(ch: InternalChannel): void {
    if (!ch.myEmbedding || !ch.partnerEmbedding) return;

    const sim = cosineSimilarity(ch.myEmbedding, ch.partnerEmbedding);
    const confirmed = sim >= confirmThreshold;
    ch.similarity = sim;
    ch.confirmed = confirmed;

    // Send result
    sendEncrypted(ch, MessageTypes.CONFIRM_RESULT, { similarity: sim, confirmed } satisfies ConfirmResultPayload);

    if (confirmed) {
      ch.state = 'active';
      store.updateChannelStatus(ch.id, 'active');
      events.onConfirmResult?.(ch.id, sim, true);
    } else {
      ch.state = 'closed';
      store.updateChannelStatus(ch.id, 'closed');
      events.onConfirmResult?.(ch.id, sim, false);
    }
  }

  return {
    async initiateChannel(matchId: string, partnerDID: string): Promise<string> {
      const id = randomUUID();
      const myKP = generateEphemeralKeyPair();

      const ch: InternalChannel = {
        id,
        matchId,
        partnerDID,
        state: 'handshaking',
        myKeyPair: myKP,
        sharedSecret: null,
        similarity: null,
        confirmed: null,
        myEmbedding: null,
        partnerEmbedding: null,
      };
      channels.set(id, ch);
      matchToChannel.set(matchId, id);

      // Store channel in DB
      store.insertChannel({ id, matchId, partnerDID });

      // Send consent with signed ephemeral public key (prevents relay MITM)
      await relayClient.sendConsent({
        matchId,
        accept: true,
        encryptedForPartner: signConsentData(myKP.publicKey, matchId, partnerDID, identity),
      });

      store.updateMatchStatus(matchId, 'consented');
      return id;
    },

    async handleConsentForward(payload: ConsentForwardPayload): Promise<void> {
      // Verify signature to prevent relay MITM
      const { ephemeralPublicKey: partnerPubKey, senderDID } = verifyConsentData(
        payload.encrypted,
        payload.matchId,
      );
      const channelId = matchToChannel.get(payload.matchId);

      if (channelId) {
        // We initiated — partner responded. Complete key exchange.
        const ch = channels.get(channelId)!;
        ch.sharedSecret = deriveSharedSecret(ch.myKeyPair!.secretKey, partnerPubKey);
        ch.state = 'confirming';
        store.updateChannelSharedKey(ch.id, ch.sharedSecret);
        events.onChannelReady?.(ch.id, ch.matchId);
      } else {
        // Partner initiated — we need to respond.
        const id = randomUUID();
        const myKP = generateEphemeralKeyPair();
        const sharedSecret = deriveSharedSecret(myKP.secretKey, partnerPubKey);

        const ch: InternalChannel = {
          id,
          matchId: payload.matchId,
          partnerDID: payload.fromDID,
          state: 'confirming',
          myKeyPair: myKP,
          sharedSecret,
          similarity: null,
          confirmed: null,
          myEmbedding: null,
          partnerEmbedding: null,
        };
        channels.set(id, ch);
        matchToChannel.set(payload.matchId, id);

        store.insertChannel({ id, matchId: payload.matchId, partnerDID: payload.fromDID, sharedKey: sharedSecret });

        // Send our consent back (signed to prevent relay MITM)
        await relayClient.sendConsent({
          matchId: payload.matchId,
          accept: true,
          encryptedForPartner: signConsentData(myKP.publicKey, payload.matchId, payload.fromDID, identity),
        });

        store.updateMatchStatus(payload.matchId, 'consented');
        events.onChannelReady?.(id, payload.matchId);
      }
    },

    async handleChannelForward(payload: ChannelForwardPayload): Promise<void> {
      const channelId = matchToChannel.get(payload.matchId);
      if (!channelId) return;
      const ch = channels.get(channelId);
      if (!ch?.sharedSecret) return;

      // Decrypt
      const decrypted = secretboxDecrypt(
        decodeBase64(payload.encrypted),
        decodeBase64(payload.nonce),
        ch.sharedSecret,
      );
      if (!decrypted) return;

      const inner = JSON.parse(encodeUTF8(decrypted));

      switch (inner.type) {
        case MessageTypes.CONFIRM_EMBEDDING: {
          const p = inner.payload as ConfirmEmbeddingPayload;
          ch.partnerEmbedding = new Float32Array(p.vector);
          processConfirmation(ch);
          break;
        }
        case MessageTypes.CONFIRM_RESULT: {
          const p = inner.payload as ConfirmResultPayload;
          // Partner computed similarity too — update our state
          if (ch.confirmed === null) {
            ch.similarity = p.similarity;
            ch.confirmed = p.confirmed;
            if (p.confirmed) {
              ch.state = 'active';
              store.updateChannelStatus(ch.id, 'active');
            } else {
              ch.state = 'closed';
              store.updateChannelStatus(ch.id, 'closed');
            }
            events.onConfirmResult?.(ch.id, p.similarity, p.confirmed);
          }
          break;
        }
        case MessageTypes.DISCLOSURE: {
          const p = inner.payload as DisclosurePayload;
          events.onDisclosure?.(ch.id, p.text, p.level);
          break;
        }
        case MessageTypes.ACCEPT: {
          const p = inner.payload as AcceptPayload;
          events.onAccept?.(ch.id, p.message);
          break;
        }
        case MessageTypes.REJECT: {
          const p = inner.payload as RejectPayload;
          ch.state = 'closed';
          store.updateChannelStatus(ch.id, 'closed');
          events.onReject?.(ch.id, p.reason);
          cleanupChannel(ch);
          break;
        }
        case MessageTypes.CLOSE: {
          ch.state = 'closed';
          store.updateChannelStatus(ch.id, 'closed');
          events.onClose?.(ch.id);
          cleanupChannel(ch);
          break;
        }
      }
    },

    async sendConfirmEmbedding(channelId: string, embedding: Float32Array): Promise<void> {
      const ch = channels.get(channelId);
      if (!ch) throw new Error('Channel not found');
      ch.myEmbedding = embedding;
      sendEncrypted(ch, MessageTypes.CONFIRM_EMBEDDING, { vector: Array.from(embedding) } satisfies ConfirmEmbeddingPayload);
    },

    async sendDisclosure(channelId: string, text: string, level: 'category' | 'detail' | 'contact'): Promise<void> {
      const ch = channels.get(channelId);
      if (!ch || ch.state !== 'active') throw new Error('Channel not active');
      sendEncrypted(ch, MessageTypes.DISCLOSURE, { text, level } satisfies DisclosurePayload);
    },

    async sendAccept(channelId: string, message?: string): Promise<void> {
      const ch = channels.get(channelId);
      if (!ch || ch.state !== 'active') throw new Error('Channel not active');
      sendEncrypted(ch, MessageTypes.ACCEPT, { message } satisfies AcceptPayload);
    },

    async sendReject(channelId: string, reason?: string): Promise<void> {
      const ch = channels.get(channelId);
      if (!ch) throw new Error('Channel not found');
      sendEncrypted(ch, MessageTypes.REJECT, { reason } satisfies RejectPayload);
      ch.state = 'closed';
      store.updateChannelStatus(ch.id, 'closed');
      cleanupChannel(ch);
    },

    async sendClose(channelId: string): Promise<void> {
      const ch = channels.get(channelId);
      if (!ch) throw new Error('Channel not found');
      sendEncrypted(ch, MessageTypes.CLOSE, {});
      ch.state = 'closed';
      store.updateChannelStatus(ch.id, 'closed');
      cleanupChannel(ch);
    },

    getChannel(channelId: string): ChannelInfo | null {
      const ch = channels.get(channelId);
      if (!ch) return null;
      return {
        id: ch.id,
        matchId: ch.matchId,
        partnerDID: ch.partnerDID,
        state: ch.state,
        similarity: ch.similarity,
        confirmed: ch.confirmed,
      };
    },

    listChannels(): ChannelInfo[] {
      return Array.from(channels.values()).map(ch => ({
        id: ch.id,
        matchId: ch.matchId,
        partnerDID: ch.partnerDID,
        state: ch.state,
        similarity: ch.similarity,
        confirmed: ch.confirmed,
      }));
    },

    on(newEvents: Partial<ChannelManagerEvents>): void {
      Object.assign(events, newEvents);
    },
  };
}
