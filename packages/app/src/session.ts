/**
 * Session management: holds identity, store, relay client, channel manager.
 * Single shared session for the app lifetime.
 */

import {
  EmbeddingEngine,
  perturbWithLevel,
  hashEmbedding,
  getSharedProjectionMatrix,
  encodeBase64,
  type Identity,
  type MatchPayload,
  type ConsentForwardPayload,
  type ChannelForwardPayload,
  type PrivacyLevel,
  type ItemType,
} from '@resonance/core';
import {
  createIdentityManager,
  openStoreAsync,
  deriveStoreKey,
  getDbPath,
  ensureDataDir,
  createRelayClient,
  createChannelManager,
  type LocalStore,
  type RelayClient,
  type ChannelManager,
  type IdentityManager,
} from '@resonance/node';
import { randomUUID } from 'node:crypto';

export interface SessionEvents {
  onMatch?: (matchId: string, partnerDID: string, similarity: number, yourItemId: string) => void;
  onChannelReady?: (channelId: string, matchId: string) => void;
  onConfirmResult?: (channelId: string, similarity: number, confirmed: boolean) => void;
  onDisclosure?: (channelId: string, text: string, level: string) => void;
  onAccept?: (channelId: string, message?: string) => void;
  onReject?: (channelId: string, reason?: string) => void;
  onClose?: (channelId: string) => void;
}

export interface Session {
  identity: Identity;
  store: LocalStore;
  engine: EmbeddingEngine;
  relayClient: RelayClient;
  channelMgr: ChannelManager;
  identityMgr: IdentityManager;
}

let session: Session | null = null;
let sessionEvents: SessionEvents = {};

export function getSession(): Session | null {
  return session;
}

export function isUnlocked(): boolean {
  return session !== null;
}

export function isInitialized(): boolean {
  return createIdentityManager().exists();
}

export function setSessionEvents(events: SessionEvents): void {
  sessionEvents = events;
  // Re-wire if session already exists
  if (session) wireEvents(session);
}

function wireEvents(s: Session): void {
  s.relayClient.on({
    onMatch(payload: MatchPayload) {
      s.store.insertMatch({
        id: payload.matchId,
        itemId: payload.yourItemId,
        partnerDID: payload.partnerDID,
        similarity: payload.similarity,
      });
      sessionEvents.onMatch?.(payload.matchId, payload.partnerDID, payload.similarity, payload.yourItemId);
    },
    onConsentForward(payload: ConsentForwardPayload) {
      s.channelMgr.handleConsentForward(payload);
    },
    onChannelForward(payload: ChannelForwardPayload) {
      s.channelMgr.handleChannelForward(payload);
    },
  });

  s.channelMgr.on({
    onChannelReady(channelId, matchId) {
      // Auto-send confirm embedding
      const match = s.store.getMatch(matchId);
      if (match) {
        const item = s.store.getItem(match.itemId);
        if (item) {
          s.channelMgr.sendConfirmEmbedding(channelId, item.embedding);
        }
      }
      sessionEvents.onChannelReady?.(channelId, matchId);
    },
    onConfirmResult(channelId, similarity, confirmed) {
      sessionEvents.onConfirmResult?.(channelId, similarity, confirmed);
    },
    onDisclosure(channelId, text, level) {
      sessionEvents.onDisclosure?.(channelId, text, level);
    },
    onAccept(channelId, message) {
      sessionEvents.onAccept?.(channelId, message);
    },
    onReject(channelId, reason) {
      sessionEvents.onReject?.(channelId, reason);
    },
    onClose(channelId) {
      sessionEvents.onClose?.(channelId);
    },
  });
}

export async function initSession(password: string): Promise<{ did: string }> {
  ensureDataDir();
  const mgr = createIdentityManager();
  const identity = await mgr.create(password);

  // Initialize engine + create DB
  const engine = new EmbeddingEngine();
  await engine.initialize();
  const store = await openStoreAsync(getDbPath(), deriveStoreKey(identity));
  store.close();

  return { did: identity.did };
}

export async function unlockSession(password: string, relayUrl: string): Promise<{ did: string }> {
  if (session) return { did: session.identity.did };

  const mgr = createIdentityManager();
  const identity = await mgr.load(password);
  const store = await openStoreAsync(getDbPath(), deriveStoreKey(identity));

  const engine = new EmbeddingEngine();
  await engine.initialize();

  const relayClient = createRelayClient({ relayUrl, identity });
  const channelMgr = createChannelManager({ identity, store, relayClient });

  // Connect to relay
  try {
    await relayClient.connect();
  } catch {
    // Relay may not be available — continue in local-only mode
  }

  session = { identity, store, engine, relayClient, channelMgr, identityMgr: mgr };
  wireEvents(session);
  resetInactivityTimer();

  return { did: identity.did };
}

// VULN-08: Session timeout
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

export function resetInactivityTimer(): void {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  if (session) {
    inactivityTimer = setTimeout(() => lockSession(), SESSION_TIMEOUT_MS);
  }
}

export function lockSession(): void {
  if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
  if (!session) return;
  // VULN-16: Zero key material
  session.identity.secretKey.fill(0);
  session.relayClient.disconnect();
  session.store.close();
  session = null;
}

export async function publishItem(text: string, type: ItemType, privacy: PrivacyLevel): Promise<{
  id: string; status: string; dims: number;
}> {
  const s = session!;
  const embedding = await s.engine.embedForMatching(text, type);
  // LSH: hash the embedding instead of perturbing it
  const hash = hashEmbedding(embedding, getSharedProjectionMatrix());
  const id = randomUUID();

  // Still store perturbed locally for backward compat, but relay gets hash
  const { perturbed, epsilon } = perturbWithLevel(embedding, privacy);
  s.store.insertItem({ id, type, rawText: text, embedding, privacyLevel: privacy, perturbed, epsilon });

  let status = 'local';
  if (s.relayClient.isConnected()) {
    try {
      await s.relayClient.publish({ itemId: id, hash: encodeBase64(hash), itemType: type, ttl: 604800 });
      s.store.updateItemStatus(id, 'published');
      status = 'published';
    } catch { /* relay unavailable */ }
  }

  return { id, status, dims: embedding.length };
}

export async function searchRelay(text: string, type: ItemType): Promise<Array<{
  did: string; similarity: number; itemType: string;
}>> {
  const s = session!;
  const embedding = await s.engine.embedForMatching(text, type);
  // LSH: hash the query — relay sees only the binary hash, not the embedding
  const hash = hashEmbedding(embedding, getSharedProjectionMatrix());
  if (!s.relayClient.isConnected()) return [];
  const results = await s.relayClient.search({ hash: encodeBase64(hash), k: 10, threshold: 0.65 });
  return results.results;
}

export async function initiateChannel(matchId: string): Promise<{ channelId: string }> {
  const s = session!;
  const match = s.store.getMatch(matchId);
  if (!match) throw new Error('Match not found');
  const channelId = await s.channelMgr.initiateChannel(matchId, match.partnerDID);
  return { channelId };
}
