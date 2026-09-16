/**
 * Session management: holds identity, store, relay client, channel manager.
 * Single shared session for the app lifetime.
 */

import {
  EmbeddingEngine,
  perturbWithLevel,
  hashEmbedding,
  getSharedProjectionMatrix,
  createPublicationRecord,
  createPublicationTombstone,
  generatePublicationKeyMaterial,
  DEFAULT_RELAY_PORT,
  BOOTSTRAP_RELAYS,
  type Identity,
  type PrivacyLevel,
  type ItemType,
} from '@resonance/core';
import {
  createIdentityManager,
  openStoreAsync,
  deriveStoreKey,
  getDataDir,
  getDbPath,
  ensureDataDir,
  createRelayClient,
  createPairwiseChannelManagerV2,
  type LocalStore,
  type RelayClient,
  type PairwiseChannelManagerV2,
  type IdentityManager,
} from '@resonance/node';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRelayServer, type RelayServer } from '@resonance/relay';

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
  pairwiseChannelMgr: PairwiseChannelManagerV2;
  identityMgr: IdentityManager;
}

let session: Session | null = null;
let sessionEvents: SessionEvents = {};
let relayServer: RelayServer | null = null;

// --- Relay config persistence ---

interface RelayConfig { enabled: boolean; port: number; }

function getRelayConfigPath(): string {
  return join(getDataDir(), 'relay-config.json');
}

export function loadRelayConfig(): RelayConfig {
  const path = getRelayConfigPath();
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { /* corrupt */ }
  }
  return { enabled: false, port: DEFAULT_RELAY_PORT };
}

function saveRelayConfig(config: RelayConfig): void {
  ensureDataDir();
  writeFileSync(getRelayConfigPath(), JSON.stringify(config));
}

// --- Relay mode ---

export async function startRelayMode(port?: number): Promise<{ port: number }> {
  const p = port ?? DEFAULT_RELAY_PORT;
  if (relayServer) return { port: p };

  const persistDir = join(getDataDir(), 'relay-data');
  relayServer = createRelayServer({
    port: p,
    host: '0.0.0.0', // Accept connections from other machines
    persistDir,
    maxAuthAttemptsPerMin: 20,
  });
  await relayServer.start();
  saveRelayConfig({ enabled: true, port: p });

  // If session is active, reconnect client to local relay
  if (session) {
    session.relayClient.disconnect();
    const localClient = createRelayClient({
      relayUrl: `ws://localhost:${p}`,
      identity: session.identity,
      fallbackUrls: BOOTSTRAP_RELAYS,
      autoReconnect: true,
    });
    session.relayClient = localClient;
    session.pairwiseChannelMgr = createPairwiseChannelManagerV2(session.store, localClient);
    wireEvents(session);
  }

  return { port: p };
}

export async function stopRelayMode(): Promise<void> {
  if (!relayServer) return;
  await relayServer.stop();
  relayServer = null;
  saveRelayConfig({ enabled: false, port: DEFAULT_RELAY_PORT });
}

export function isRelayMode(): boolean {
  return relayServer !== null;
}

export function getRelayStats(): { enabled: boolean; port: number; stats: any } | null {
  if (!relayServer) return null;
  const config = loadRelayConfig();
  return { enabled: true, port: config.port, stats: relayServer.getStats() };
}

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
  // Protocol v2 uses pull-based encrypted mailboxes. UI events are emitted
  // after a sync commits the corresponding local state.
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

  // Auto-start relay if config says enabled
  const relayConfig = loadRelayConfig();
  if (relayConfig.enabled && !relayServer) {
    try { await startRelayMode(relayConfig.port); } catch { /* port busy? */ }
  }

  // Build relay URL list: local relay first (if running), then configured, then bootstrap
  const urls: string[] = [];
  if (relayServer) urls.push(`ws://localhost:${relayConfig.port}`);
  if (relayUrl && relayUrl !== 'ws://localhost:9090') urls.push(relayUrl);
  urls.push(...BOOTSTRAP_RELAYS.filter(u => !urls.includes(u)));
  if (urls.length === 0) urls.push(relayUrl); // fallback to whatever was passed

  const relayClient = createRelayClient({
    relayUrl: urls[0],
    identity,
    fallbackUrls: urls.slice(1),
    autoReconnect: true,
  });
  const pairwiseChannelMgr = createPairwiseChannelManagerV2(store, relayClient);

  // Protocol v2 operations use short, self-authenticating connections. Keeping
  // the legacy root-authenticated socket closed prevents passive DID linkage.
  session = { identity, store, engine, relayClient, pairwiseChannelMgr, identityMgr: mgr };
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
  const keys = generatePublicationKeyMaterial();
  const now = Date.now();
  const record = createPublicationRecord({
    groupId: 'public',
    fingerprintEpoch: 'pilot-static-v1',
    fingerprint: hash,
    itemType: type,
    createdAt: now,
    expiresAt: now + 7 * 24 * 60 * 60 * 1000,
  }, keys);
  s.store.insertPublication(id, record, keys);

  let status = 'local';
  try {
    const ack = await s.relayClient.submitPublicationOperation(record);
    if (ack.status !== 'ok') throw new Error(ack.message ?? 'Relay rejected publication');
    s.store.updateItemStatus(id, 'published');
    status = 'published';
  } catch { /* relay unavailable; signed operation remains available for retry */ }

  return { id, status, dims: embedding.length };
}

export async function withdrawItem(itemId: string): Promise<void> {
  const s = session!;
  const publication = s.store.getPublicationForItem(itemId);
  if (!publication) throw new Error(`No protocol v2 publication found for item ${itemId}`);
  const tombstone = publication.tombstone ?? createPublicationTombstone(
    publication.record,
    'withdrawn',
    publication.keys.signingKeyPair,
    Date.now(),
  );
  if (!publication.tombstone) s.store.setPublicationTombstone(itemId, tombstone);
  s.store.updateItemStatus(itemId, 'withdrawn');
  const ack = await s.relayClient.submitPublicationOperation(tombstone);
  if (ack.status !== 'ok') throw new Error(ack.message ?? 'Relay rejected tombstone');
}

export async function syncMatchMailboxes(): Promise<number> {
  const s = session!;
  const activeBefore = new Set(
    s.pairwiseChannelMgr.list().filter((channel) => channel.status === 'active').map((channel) => channel.matchId),
  );
  try {
    const result = await s.pairwiseChannelMgr.syncMailboxes();
    for (const channel of s.pairwiseChannelMgr.list()) {
      if (channel.status === 'active' && !activeBefore.has(channel.matchId) && channel.channelId) {
        sessionEvents.onChannelReady?.(channel.channelId, channel.matchId);
      }
    }
    return result.matchesAdded;
  } catch {
    // Durable envelopes remain available and will be retried on the next sync.
    return 0;
  }
}

export async function searchRelay(text: string, type: ItemType): Promise<Array<{
  publicationId: string; similarity: number; itemType: string;
}>> {
  const s = session!;
  const embedding = await s.engine.embedForMatching(text, type);
  // LSH: hash the query — relay sees only the binary hash, not the embedding
  const hash = hashEmbedding(embedding, getSharedProjectionMatrix());
  const results = await s.relayClient.searchV2({
    groupId: 'public',
    fingerprintEpoch: 'pilot-static-v1',
    fingerprint: hash,
    itemType: type,
    k: 10,
    threshold: 0.65,
  });
  return results.results;
}

export async function initiateChannel(matchId: string): Promise<{ channelId: string }> {
  const s = session!;
  const mailboxMatch = s.store.listMailboxMatches().find((candidate) => candidate.matchId === matchId);
  if (mailboxMatch) {
    const channel = await s.pairwiseChannelMgr.initiate(matchId);
    return { channelId: channel.channelId ?? channel.localKeys.relationshipId };
  }
  throw new Error('Protocol v2 mailbox match not found');
}
