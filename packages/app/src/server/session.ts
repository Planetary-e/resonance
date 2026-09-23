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
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  installRelayService, relayServiceRuntime, relayServiceStats, uninstallRelayService,
  type RelayOwnerControls,
} from './relay-supervisor.js';

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
  remoteRelayUrls: string[];
}

let session: Session | null = null;
let sessionEvents: SessionEvents = {};
// --- Relay config persistence ---

interface RelayConfig {
  enabled: boolean;
  port: number;
  adminKey?: string;
  contacts?: string[];
  controls?: RelayOwnerControls;
  runtime?: { nodePath: string; entryPath: string };
}

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
  const path = getRelayConfigPath();
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function validateOwnerControls(input: RelayOwnerControls): RelayOwnerControls {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Owner controls must be an object');
  }
  const integer = (value: unknown, name: string, max: number): number | undefined => {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
      throw new Error(`${name} must be a non-negative integer within its limit`);
    }
    return value as number;
  };
  const publicationStorageMiB = integer(input.publicationStorageMiB, 'Publication storage', 1_048_576);
  const newWorkIngressMiBPerHour = integer(input.newWorkIngressMiBPerHour, 'New-work bandwidth', 1_048_576);
  const cpuMillisecondsPerMinute = integer(input.cpuMillisecondsPerMinute, 'CPU budget', 60_000);
  if (publicationStorageMiB !== undefined && publicationStorageMiB < 1) {
    throw new Error('Publication storage must be at least 1 MiB');
  }
  if (input.activeHours !== undefined && typeof input.activeHours !== 'string') {
    throw new Error('Active hours must be text');
  }
  const activeHours = input.activeHours?.trim();
  if (activeHours && (!/^(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d$/.test(activeHours))) {
    throw new Error('Active hours must use HH:MM-HH:MM');
  }
  if (input.onlyWhenCharging !== undefined && typeof input.onlyWhenCharging !== 'boolean') {
    throw new Error('Only-when-charging must be true or false');
  }
  return {
    ...(publicationStorageMiB === undefined ? {} : { publicationStorageMiB }),
    ...(newWorkIngressMiBPerHour === undefined ? {} : { newWorkIngressMiBPerHour }),
    ...(cpuMillisecondsPerMinute === undefined ? {} : { cpuMillisecondsPerMinute }),
    ...(activeHours ? { activeHours } : {}),
    ...(input.onlyWhenCharging ? { onlyWhenCharging: true } : {}),
  };
}

// --- Relay mode ---

export async function startRelayMode(
  port?: number, requestedContacts?: string[], requestedControls?: RelayOwnerControls,
): Promise<{ port: number }> {
  const previous = loadRelayConfig();
  const p = port ?? previous.port ?? DEFAULT_RELAY_PORT;
  const adminKey = previous.adminKey ?? randomBytes(32).toString('base64url');
  const contacts = requestedContacts ?? previous.contacts ??
    (process.env.RESONANCE_RELAY_CONTACTS ?? process.env.RELAY_CONTACTS ?? '')
      .split(',').map(value => value.trim()).filter(Boolean);
  if (contacts.length > 16 || new Set(contacts).size !== contacts.length
    || contacts.some(value => {
      try {
        const url = new URL(value);
        return !['ws:', 'wss:'].includes(url.protocol) || Boolean(url.username || url.password)
          || Boolean(url.search || url.hash);
      } catch { return true; }
    })) throw new Error('Relay contacts must be up to 16 distinct ws:// or wss:// endpoints');
  const controls = validateOwnerControls(requestedControls ?? previous.controls ?? {});
  const runtime = relayServiceRuntime();
  if (previous.enabled && previous.port === p
    && previous.runtime?.nodePath === runtime.nodePath
    && previous.runtime?.entryPath === runtime.entryPath
    && JSON.stringify(previous.contacts) === JSON.stringify(contacts)
    && JSON.stringify(previous.controls ?? {}) === JSON.stringify(controls)
    && await relayServiceStats(p, adminKey)) return { port: p };
  installRelayService({
    port: p, dataDir: getDataDir(), adminKey, contacts, controls, ...runtime,
  });
  let running = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await relayServiceStats(p, adminKey)) { running = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!running) throw new Error('The supervised relay did not become ready');
  saveRelayConfig({
    enabled: true, port: p, adminKey, contacts, controls,
    runtime: { nodePath: runtime.nodePath, entryPath: runtime.entryPath },
  });

  // If session is active, reconnect client to local relay
  if (session) {
    session.relayClient.disconnect();
    session.remoteRelayUrls = [...new Set([...contacts, ...session.remoteRelayUrls])];
    const localClient = createRelayClient({
      relayUrl: `ws://localhost:${p}`,
      identity: session.identity,
      fallbackUrls: session.remoteRelayUrls,
      autoReconnect: true,
    });
    session.relayClient = localClient;
    session.pairwiseChannelMgr = createPairwiseChannelManagerV2(session.store, localClient);
    wireEvents(session);
  }

  return { port: p };
}

export async function stopRelayMode(): Promise<void> {
  uninstallRelayService();
  saveRelayConfig({ ...loadRelayConfig(), enabled: false });
  if (session) {
    session.relayClient.disconnect();
    const urls = session.remoteRelayUrls;
    const remoteClient = createRelayClient({
      relayUrl: urls[0] ?? 'ws://localhost:9090',
      identity: session.identity,
      fallbackUrls: urls.slice(1),
      autoReconnect: true,
    });
    session.relayClient = remoteClient;
    session.pairwiseChannelMgr = createPairwiseChannelManagerV2(session.store, remoteClient);
    wireEvents(session);
  }
}

export function isRelayMode(): boolean {
  return loadRelayConfig().enabled;
}

export async function getRelayStats(): Promise<{
  enabled: boolean; running: boolean; port: number; contacts: string[];
  controls: RelayOwnerControls;
  stats: {
    relay_id: string;
    connected_relays: number;
    active_publications: number;
    placement_intents: number;
    minimum_confirmed_placements: number;
    publication_storage_reserved_bytes: number;
    publication_storage_quota_bytes: number;
  } | null;
} | null> {
  const config = loadRelayConfig();
  if (!config.enabled || !config.adminKey) return {
    enabled: false, running: false, port: config.port,
    contacts: config.contacts ?? [], controls: config.controls ?? {}, stats: null,
  };
  const stats = await relayServiceStats(config.port, config.adminKey);
  return {
    enabled: true, running: stats !== null, port: config.port,
    contacts: config.contacts ?? [], controls: config.controls ?? {},
    stats: stats ? {
      relay_id: String(stats.relay_id ?? ''),
      connected_relays: Number(stats.connected_relays) || 0,
      active_publications: Number(stats.active_publications) || 0,
      placement_intents: Number(stats.placement_intents) || 0,
      minimum_confirmed_placements: Number(stats.minimum_confirmed_placements) || 0,
      publication_storage_reserved_bytes: Number(stats.publication_storage_reserved_bytes) || 0,
      publication_storage_quota_bytes: Number(stats.publication_storage_quota_bytes) || 0,
    } : null,
  };
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
  if (relayConfig.enabled) {
    try { await startRelayMode(relayConfig.port); } catch { /* port busy? */ }
  }

  // Build relay URL list: local relay first (if running), then configured, then bootstrap
  const remoteUrls: string[] = [];
  remoteUrls.push(...(relayConfig.contacts ?? []));
  if (relayUrl && relayUrl !== 'ws://localhost:9090') remoteUrls.push(relayUrl);
  remoteUrls.push(...BOOTSTRAP_RELAYS);
  const uniqueRemoteUrls = [...new Set(remoteUrls)];
  const urls: string[] = [];
  if (relayConfig.enabled && relayConfig.adminKey
    && await relayServiceStats(relayConfig.port, relayConfig.adminKey)) {
    urls.push(`ws://localhost:${relayConfig.port}`);
  }
  urls.push(...uniqueRemoteUrls.filter(u => !urls.includes(u)));
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
  session = {
    identity, store, engine, relayClient, pairwiseChannelMgr,
    identityMgr: mgr, remoteRelayUrls: uniqueRemoteUrls,
  };
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
