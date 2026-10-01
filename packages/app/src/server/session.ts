/**
 * Session management: holds identity, store, relay client, channel manager.
 * Single shared session for the app lifetime.
 */

import {
  assertSecureRelayTransportEndpoint,
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
  type PublicationKeyMaterial,
} from '@resonance/core';
import {
  createIdentityManager,
  openStoreAsync,
  deriveStoreKey,
  derivePublicationOutboxKey,
  openPublicationOutbox,
  openPrivateRequestOutbox,
  derivePrivateRequestOutboxKey,
  deriveAdmissionWalletKey,
  openManagedAdmissionWallet,
  type ManagedAdmissionWallet,
  type AdmissionWalletRetirementPlan,
  guardRelayClient,
  type PrivateRequestOutbox,
  type PrivateRequestIntent,
  type PrivateRequestResult,
  type HeldRequest,
  type PublicationOutbox,
  type PrivatePublicationRoute,
  type HeldPublicationSummary,
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
  publicationOutbox: PublicationOutbox;
  requestOutbox: PrivateRequestOutbox;
  admissionWallet: ManagedAdmissionWallet;
  mailboxSync?: { controller: AbortController; client: RelayClient; pending: Promise<number> };
  privatePublicationRoute?: PrivatePublicationRoute;
}

function configuredPrivateRoute(): PrivatePublicationRoute | undefined {
  const configured = process.env.RESONANCE_EXPERIMENTAL_PRIVATE_ROUTE_URLS;
  if (configured === undefined) return undefined;
  const urls = [...new Set(configured.split(',').map(url => url.trim()).filter(Boolean))];
  if (urls.length < 2) {
    throw new Error('Experimental private transport needs an entry URL followed by at least one destination URL');
  }
  return { relayUrl: urls[1], fallbackUrls: urls.slice(2), privateEntryUrls: [urls[0]] };
}

function createSessionRelayClient(urls: string[], identity: Identity,
  route = session?.privatePublicationRoute ?? configuredPrivateRoute(), wallet = session?.admissionWallet): RelayClient {
  return createRelayClient({
    ...(route ?? { relayUrl: urls[0] ?? '', fallbackUrls: urls.slice(1) }),
    identity, autoReconnect: true,
    admissionCapabilityProvider: wallet ? context => {
      if (!route && wallet.configured()) throw new Error('Access tokens require a private route; direct delivery is disabled');
      return wallet.capabilityFor(context);
    } : undefined,
  });
}

export class WalletLoadError extends Error {
  constructor() { super('The access-token wallet could not be opened. Its saved tokens and reservations have been retained.'); }
}

export class ModelLoadError extends Error {
  constructor() {
    super('The matching model could not load. Connect to the internet on first use, then retry.');
    this.name = 'ModelLoadError';
  }
}

async function loadEmbeddingEngine(): Promise<EmbeddingEngine> {
  const engine = new EmbeddingEngine();
  try {
    await engine.initialize();
  } catch (error) {
    console.error('Matching model load failed:', error);
    throw new ModelLoadError();
  }
  return engine;
}

let session: Session | null = null;
let sessionEvents: SessionEvents = {};
export type RelayActivity = 'not-checked' | 'succeeded' | 'failed';
let relayActivity: RelayActivity = 'not-checked';

export function getRelayActivity(): RelayActivity {
  return relayActivity;
}
// --- Relay config persistence ---

interface RelayConfig {
  enabled: boolean;
  port: number;
  adminKey?: string;
  contacts?: string[];
  controls?: RelayOwnerControls;
  storageCommitmentFloorBytes?: number;
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
  const totalBandwidthMiBPerHour = integer(input.totalBandwidthMiBPerHour, 'Total bandwidth', 1_048_576);
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
    ...(totalBandwidthMiBPerHour === undefined ? {} : { totalBandwidthMiBPerHour }),
    ...(cpuMillisecondsPerMinute === undefined ? {} : { cpuMillisecondsPerMinute }),
    ...(activeHours ? { activeHours } : {}),
    ...(input.onlyWhenCharging ? { onlyWhenCharging: true } : {}),
  };
}

function storageCommitmentFloor(stats: Record<string, unknown> | null, fallback = 0): number {
  if (!stats) return fallback;
  return Math.max(0,
    Number(stats.publication_commitment_floor_bytes) || 0,
    Number(stats.journal_commitment_floor_bytes) || 0);
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
      try { assertSecureRelayTransportEndpoint(value); return false; }
      catch { return true; }
    })) throw new Error('Relay contacts must be up to 16 distinct endpoints; public contacts require wss://');
  const controls = validateOwnerControls(requestedControls ?? previous.controls ?? {});
  const runtime = relayServiceRuntime();
  const previousStats = previous.enabled ? await relayServiceStats(previous.port, adminKey) : null;
  const minimumStorageBytes = storageCommitmentFloor(
    previousStats, previous.storageCommitmentFloorBytes ?? 0,
  );
  if (controls.publicationStorageMiB !== undefined
    && controls.publicationStorageMiB * 1_048_576 < minimumStorageBytes) {
    throw new Error(`Storage limit must be at least ${Math.ceil(minimumStorageBytes / 1_048_576)} MiB to preserve accepted relay data`);
  }
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
    const localClient = createSessionRelayClient(
      [`ws://localhost:${p}`, ...session.remoteRelayUrls], session.identity,
    );
    session.relayClient = localClient;
    session.pairwiseChannelMgr = createPairwiseChannelManagerV2(session.store, localClient);
    wireEvents(session);
  }

  return { port: p };
}

export async function stopRelayMode(): Promise<void> {
  const previous = loadRelayConfig();
  const stats = previous.enabled && previous.adminKey
    ? await relayServiceStats(previous.port, previous.adminKey) : null;
  uninstallRelayService();
  saveRelayConfig({ ...previous, enabled: false,
    storageCommitmentFloorBytes: storageCommitmentFloor(
      stats, previous.storageCommitmentFloorBytes ?? 0,
    ),
  });
  if (session) {
    session.relayClient.disconnect();
    const urls = session.remoteRelayUrls;
    const remoteClient = createSessionRelayClient(
      urls.length > 0 ? urls : ['ws://localhost:9090'], session.identity,
    );
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
  storageCommitmentFloorBytes: number;
  stats: {
    relay_id: string;
    connected_relays: number;
    inbound_authenticated_relays: number;
    outbound_authenticated_relays: number;
    connected_query_peers: number;
    peer_confirmed_direct_endpoints: number;
    active_publications: number;
    placement_intents: number;
    minimum_confirmed_placements: number;
    publication_storage_reserved_bytes: number;
    publication_storage_quota_bytes: number;
    transport_ingress_bytes: number;
    transport_egress_bytes: number;
    lan_ingress_bytes: number;
    lan_egress_bytes: number;
    process_cpu_milliseconds: number;
    data_file_bytes: number;
    mailbox_storage_reserved_bytes: number;
    journal_bytes: number;
    publication_commitment_floor_bytes: number;
    mailbox_commitment_floor_bytes: number;
    journal_commitment_floor_bytes: number;
  } | null;
} | null> {
  const config = loadRelayConfig();
  if (!config.enabled || !config.adminKey) return {
    enabled: false, running: false, port: config.port,
    contacts: config.contacts ?? [], controls: config.controls ?? {},
    storageCommitmentFloorBytes: config.storageCommitmentFloorBytes ?? 0, stats: null,
  };
  const stats = await relayServiceStats(config.port, config.adminKey);
  return {
    enabled: true, running: stats !== null, port: config.port,
    contacts: config.contacts ?? [], controls: config.controls ?? {},
    storageCommitmentFloorBytes: storageCommitmentFloor(
      stats, config.storageCommitmentFloorBytes ?? 0,
    ),
    stats: stats ? {
      relay_id: String(stats.relay_id ?? ''),
      connected_relays: Number(stats.connected_relays) || 0,
      inbound_authenticated_relays: Number(stats.inbound_authenticated_relays) || 0,
      outbound_authenticated_relays: Number(stats.outbound_authenticated_relays) || 0,
      connected_query_peers: Number(stats.connected_query_peers) || 0,
      peer_confirmed_direct_endpoints: Number(stats.peer_confirmed_direct_endpoints) || 0,
      active_publications: Number(stats.active_publications) || 0,
      placement_intents: Number(stats.placement_intents) || 0,
      minimum_confirmed_placements: Number(stats.minimum_confirmed_placements) || 0,
      publication_storage_reserved_bytes: Number(stats.publication_storage_reserved_bytes) || 0,
      publication_storage_quota_bytes: Number(stats.publication_storage_quota_bytes) || 0,
      transport_ingress_bytes: Number(stats.transport_ingress_bytes) || 0,
      transport_egress_bytes: Number(stats.transport_egress_bytes) || 0,
      lan_ingress_bytes: Number(stats.lan_ingress_bytes) || 0,
      lan_egress_bytes: Number(stats.lan_egress_bytes) || 0,
      process_cpu_milliseconds: Number(stats.process_cpu_milliseconds) || 0,
      data_file_bytes: Number(stats.data_file_bytes) || 0,
      mailbox_storage_reserved_bytes: Number(stats.mailbox_storage_reserved_bytes) || 0,
      journal_bytes: Number(stats.journal_bytes) || 0,
      publication_commitment_floor_bytes:
        Number(stats.publication_commitment_floor_bytes) || 0,
      mailbox_commitment_floor_bytes: Number(stats.mailbox_commitment_floor_bytes) || 0,
      journal_commitment_floor_bytes: Number(stats.journal_commitment_floor_bytes) || 0,
    } : null,
  };
}

export function getSession(): Session | null {
  return session;
}

export function listExternalMailboxMatches(): ReturnType<LocalStore['listMailboxMatches']> {
  if (!session) return [];
  const ownPublications = new Set(session.store.listPublications().map(value => value.publicationId));
  return session.store.listMailboxMatches()
    .filter(match => !ownPublications.has(match.partnerPublicationId));
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
  // A failed first model download must not leave a half-created identity.
  await loadEmbeddingEngine();
  const mgr = createIdentityManager();
  const identity = await mgr.create(password);

  // Create the encrypted store only after the model and identity are ready.
  const store = await openStoreAsync(getDbPath(), deriveStoreKey(identity));
  store.close();

  return { did: identity.did };
}

export async function unlockSession(password: string, relayUrl: string): Promise<{ did: string }> {
  if (session) {
    const current = session;
    // A new browser page needs a fresh token, even when the backend is still
    // unlocked. Never let the existing in-memory identity bypass authentication.
    const verified = await current.identityMgr.load(password);
    try {
      if (session !== current || verified.did !== current.identity.did) throw new Error('Session changed during unlock');
      return { did: current.identity.did };
    } finally { verified.secretKey.fill(0); }
  }

  const mgr = createIdentityManager();
  const identity = await mgr.load(password);
  const engine = await loadEmbeddingEngine();
  const store = await openStoreAsync(getDbPath(), deriveStoreKey(identity));

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

  let privatePublicationRoute: PrivatePublicationRoute | undefined;
  const outboxKey = derivePublicationOutboxKey(identity);
  let publicationOutbox: PublicationOutbox;
  let requestOutbox: PrivateRequestOutbox;
  let admissionWallet: ManagedAdmissionWallet | undefined;
  let relayClient: RelayClient;
  try {
    privatePublicationRoute = configuredPrivateRoute();
    const walletKey = deriveAdmissionWalletKey(identity);
    try { admissionWallet = await openManagedAdmissionWallet({ directory: getDataDir(), encryptionKey: walletKey }); }
    catch { throw new WalletLoadError(); }
    finally { walletKey.fill(0); }
    const capabilityProvider = (context: Parameters<ManagedAdmissionWallet['capabilityFor']>[0]) => admissionWallet!.capabilityFor(context);
    publicationOutbox = openPublicationOutbox({
      path: join(getDataDir(), 'publication-outbox.json'), encryptionKey: outboxKey,
      admissionCapabilityProvider: capabilityProvider,
    });
    try {
      const requestKey = derivePrivateRequestOutboxKey(identity);
      try {
        requestOutbox = openPrivateRequestOutbox({ path: join(getDataDir(), 'private-request-outbox.json'), encryptionKey: requestKey,
          admissionCapabilityProvider: capabilityProvider,
          execute: async (intent, client, signal) => {
            const current = session;
            if (!current || current.store !== store) throw new Error('Session changed before release');
            signal.throwIfAborted();
            if (intent.kind === 'search') {
              const response = await client.searchV2({ groupId: 'public', fingerprintEpoch: 'pilot-static-v1',
                fingerprint: Buffer.from(intent.fingerprint, 'base64'), itemType: intent.itemType, k: 10, threshold: 0.65 });
              return { kind: 'search', results: response.results };
            }
            assertMailboxTarget(current, intent);
            const manager = createPairwiseChannelManagerV2(store, client);
            const result = await manager.syncMailboxes({
              publicationIds: intent.kind === 'publication-mailbox' ? [intent.publicationId] : [],
              relationshipIds: intent.kind === 'relationship-mailbox' ? [intent.relationshipId] : [],
            });
            return { kind: 'mailbox', ...result };
          },
        });
      } finally { requestKey.fill(0); }
      try { relayClient = createSessionRelayClient(urls, identity, privatePublicationRoute, admissionWallet); }
      catch (error) { requestOutbox.close(); throw error; }
    } catch (error) { publicationOutbox.close(); throw error; }
  } catch (error) { admissionWallet?.close(); store.close(); identity.secretKey.fill(0); throw error; }
  finally { outboxKey.fill(0); }
  const pairwiseChannelMgr = createPairwiseChannelManagerV2(store, relayClient);

  // Protocol v2 operations use short, self-authenticating connections. Keeping
  // the legacy root-authenticated socket closed prevents passive DID linkage.
  session = {
    identity, store, engine, relayClient, pairwiseChannelMgr,
    identityMgr: mgr, remoteRelayUrls: uniqueRemoteUrls, publicationOutbox, requestOutbox, privatePublicationRoute, admissionWallet,
  };
  try { reconcileDeliveredPublications(session); }
  catch (error) { lockSession(); throw error; }
  relayActivity = 'not-checked';
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
  stopAutomaticMailboxSync(session);
  session.requestOutbox.close();
  session.publicationOutbox.close();
  // VULN-16: Zero key material
  session.identity.secretKey.fill(0);
  session.relayClient.disconnect();
  session.admissionWallet.close();
  session.store.close();
  session = null;
  relayActivity = 'not-checked';
}

export async function publishItem(text: string, type: ItemType, privacy: PrivacyLevel, delivery: 'send' | 'hold' = 'send'): Promise<{
  id: string; status: string; dims: number;
}> {
  const s = session!;
  if (delivery === 'hold' && !s.privatePublicationRoute) throw new Error('Local hold requires the private transport pilot');
  const embedding = await s.engine.embedForMatching(text, type);
  if (session !== s) throw new Error('Session locked before saving');
  // LSH: hash the embedding instead of perturbing it
  const hash = hashEmbedding(embedding, getSharedProjectionMatrix());
  const id = randomUUID();

  // Still store perturbed locally for backward compat, but relay gets hash
  const { perturbed, epsilon } = perturbWithLevel(embedding, privacy);
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
  if (delivery === 'hold') {
    // Keep even the fingerprint and mailbox identifiers out of the ordinary store:
    // mailbox sync must have no knowledge of an unsent publication.
    const local: HeldItem = { id, type, rawText: text, privacyLevel: privacy, epsilon,
      embedding: Array.from(embedding), perturbed: Array.from(perturbed), createdAt: new Date(now).toISOString(),
      signingSecret: Buffer.from(keys.signingKeyPair.secretKey).toString('base64'),
      mailboxSecret: Buffer.from(keys.mailboxKeyPair.secretKey).toString('base64') };
    s.publicationOutbox.hold(record, s.privatePublicationRoute!, JSON.stringify(local));
    return { id, status: 'held', dims: embedding.length };
  }
  s.store.insertItem({ id, type, rawText: text, embedding, privacyLevel: privacy, perturbed, epsilon });
  s.store.insertPublication(id, record, keys);

  let status = 'local';
  try {
    const ack = await s.relayClient.submitPublicationOperation(record);
    if (ack.status !== 'ok') throw new Error(ack.message ?? 'Relay rejected publication');
    s.store.updateItemStatus(id, 'published');
    status = 'published';
    relayActivity = 'succeeded';
  } catch {
    relayActivity = 'failed';
    /* relay unavailable; signed operation remains available for retry */
  }

  return { id, status, dims: embedding.length };
}

interface HeldItem {
  id: string; type: ItemType; rawText: string; privacyLevel: PrivacyLevel; epsilon: number;
  embedding: number[]; perturbed: number[]; createdAt: string;
  signingSecret: string; mailboxSecret: string;
}

function heldItem(s: Session, id: string): HeldItem {
  return JSON.parse(s.publicationOutbox.read(id).localData) as HeldItem;
}

function reconcileDeliveredPublications(s: Session): void {
  for (const delivery of s.publicationOutbox.list()) {
    if (delivery.state !== 'delivered') continue;
    const { record } = s.publicationOutbox.read(delivery.id);
    const local = heldItem(s, delivery.id);
    if (!s.store.getItem(local.id)) s.store.insertItem({
      id: local.id, type: local.type, rawText: local.rawText, privacyLevel: local.privacyLevel,
      epsilon: local.epsilon, embedding: new Float32Array(local.embedding), perturbed: new Float32Array(local.perturbed),
    });
    if (!s.store.getPublicationForItem(local.id)) {
      const keys: PublicationKeyMaterial = {
        publicationId: record.publicationId, mailboxId: record.mailbox.id,
        signingKeyPair: { publicKey: Buffer.from(record.publicationKey, 'base64'), secretKey: Buffer.from(local.signingSecret, 'base64') },
        mailboxKeyPair: { publicKey: Buffer.from(record.mailbox.encryptionKey, 'base64'), secretKey: Buffer.from(local.mailboxSecret, 'base64') },
      };
      s.store.insertPublication(local.id, record, keys);
    }
    // Restart recovery must never undo a later withdrawal.
    if (s.store.getItem(local.id)?.status === 'local') s.store.updateItemStatus(local.id, 'published');
  }
}

export function listSessionItems() {
  const s = session!;
  reconcileDeliveredPublications(s);
  const deliveries = new Map<string, HeldPublicationSummary>();
  const held = [];
  for (const delivery of s.publicationOutbox.list()) {
    const local = heldItem(s, delivery.id);
    deliveries.set(local.id, delivery);
    if (!s.store.getItem(local.id)) held.push({ id: local.id, type: local.type, rawText: local.rawText,
      privacyLevel: local.privacyLevel, epsilon: local.epsilon, createdAt: local.createdAt, status: 'local' });
  }
  return [...held, ...s.store.listItems()].map(item => ({
    id: item.id, type: item.type, rawText: item.rawText, privacyLevel: item.privacyLevel,
    epsilon: item.epsilon, createdAt: item.createdAt, status: item.status, delivery: deliveries.get(item.id),
  }));
}

export async function releaseHeldPublication(id: string): Promise<void> {
  const s = session!;
  try { await s.publicationOutbox.release(id); }
  catch (error) { if (session === s) relayActivity = 'failed'; throw error; }
  if (session !== s) throw new Error('Session locked; reopen to inspect delivery');
  reconcileDeliveredPublications(s);
  relayActivity = 'succeeded';
}

export function cancelHeldPublication(id: string): void { session!.publicationOutbox.cancel(id); }
export function removeHeldPublication(id: string): void {
  reconcileDeliveredPublications(session!);
  session!.publicationOutbox.remove(id);
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
  try {
    const ack = await s.relayClient.submitPublicationOperation(tombstone);
    if (ack.status !== 'ok') throw new Error(ack.message ?? 'Relay rejected tombstone');
    relayActivity = 'succeeded';
  } catch (error) {
    relayActivity = 'failed';
    throw error;
  }
}

function stopAutomaticMailboxSync(s: Session): void {
  s.mailboxSync?.controller.abort(new Error('Automatic mailbox checks paused'));
  s.mailboxSync?.client.disconnect();
}

export async function syncMatchMailboxes(): Promise<number> {
  const s = session!;
  if (!s.requestOutbox.automaticMailboxes()) return 0;
  if (s.mailboxSync) return s.mailboxSync.pending;
  const controller = new AbortController();
  // Isolate background checks so pausing them cannot cancel a publication/search.
  const config = loadRelayConfig();
  const urls = config.enabled ? [`ws://localhost:${config.port}`, ...s.remoteRelayUrls] : s.remoteRelayUrls;
  const client = createSessionRelayClient(urls.length ? urls : ['ws://localhost:9090'], s.identity);
  const manager = createPairwiseChannelManagerV2(s.store, guardRelayClient(client, controller.signal));
  const pending = Promise.resolve().then(async () => {
    try {
      controller.signal.throwIfAborted();
      const activeBefore = new Set(manager.list().filter(channel => channel.status === 'active').map(channel => channel.matchId));
      const result = await manager.syncMailboxes();
      for (const channel of manager.list()) {
        if (channel.status === 'active' && !activeBefore.has(channel.matchId) && channel.channelId) {
          sessionEvents.onChannelReady?.(channel.channelId, channel.matchId);
        }
      }
      return result.matchesAdded;
    } catch { return 0; }
    finally { client.disconnect(); if (s.mailboxSync?.controller === controller) s.mailboxSync = undefined; }
  });
  s.mailboxSync = { controller, client, pending };
  return pending;
}

function assertMailboxTarget(s: Session, intent: Exclude<PrivateRequestIntent, { kind: 'search' }>): void {
  if (intent.kind === 'publication-mailbox') {
    const publication = s.store.getPublication(intent.publicationId);
    if (!publication || publication.tombstone || publication.record.expiresAt <= Date.now()) throw new Error('Publication is no longer active; remove this saved check');
  } else {
    const channel = s.store.listPairwiseChannels().find(channel => channel.localKeys.relationshipId === intent.relationshipId);
    if (!channel || !channel.channelId || channel.status === 'closed') throw new Error('Channel is no longer active; remove this saved check');
  }
}

export interface HeldRequestView extends Omit<HeldRequest, 'intent'> { kind: PrivateRequestIntent['kind']; label: string }
export function listHeldRequests(): { automaticMailboxes: boolean; requests: HeldRequestView[];
  mailboxes: Array<{ kind: 'publication-mailbox' | 'relationship-mailbox'; id: string; label: string }> } {
  const s = session!;
  return { automaticMailboxes: s.requestOutbox.automaticMailboxes(), requests: s.requestOutbox.list().map(entry => ({
    id: entry.id, kind: entry.intent.kind, label: entry.intent.kind === 'search' ? entry.intent.text
      : entry.intent.kind === 'publication-mailbox' ? s.store.getItem(s.store.getPublication(entry.intent.publicationId)?.itemId ?? '')?.rawText ?? 'Publication mailbox'
      : 'Channel mailbox', state: entry.state, heldAt: entry.heldAt, expiresAt: entry.expiresAt,
    attempts: entry.attempts, mayHaveBeenSent: entry.mayHaveBeenSent, result: entry.result,
  })), mailboxes: [
    ...s.store.listPublications().filter(publication => !publication.tombstone && publication.record.expiresAt > Date.now())
      .map(publication => ({ kind: 'publication-mailbox' as const, id: publication.publicationId, label: s.store.getItem(publication.itemId)?.rawText ?? 'Publication mailbox' })),
    ...s.store.listPairwiseChannels().filter(channel => channel.channelId && channel.status !== 'closed')
      .map(channel => ({ kind: 'relationship-mailbox' as const, id: channel.localKeys.relationshipId, label: `Channel ${channel.channelId?.slice(0, 16)}` })),
  ] };
}

export function setAutomaticMailboxChecks(enabled: boolean): void {
  const s = session!;
  s.requestOutbox.setAutomaticMailboxes(enabled);
  if (!enabled) stopAutomaticMailboxSync(s);
}

export async function holdSearch(text: string, type: ItemType) {
  const s = session!;
  if (!s.privatePublicationRoute) throw new Error('Search hold requires the private transport pilot');
  if (!text.trim() || Buffer.byteLength(text) > 8192) throw new Error('Saved search must contain 1–8192 bytes of text');
  const embedding = await s.engine.embedForMatching(text, type);
  if (session !== s) throw new Error('Session locked before saving');
  const fingerprint = Buffer.from(hashEmbedding(embedding, getSharedProjectionMatrix())).toString('base64');
  return s.requestOutbox.hold({ kind: 'search', text, itemType: type, fingerprint }, s.privatePublicationRoute);
}

export function holdMailboxCheck(kind: 'publication-mailbox' | 'relationship-mailbox', id: string) {
  const s = session!;
  if (!s.privatePublicationRoute) throw new Error('Mailbox hold requires the private transport pilot');
  const intent: Exclude<PrivateRequestIntent, { kind: 'search' }> = kind === 'publication-mailbox' ? { kind, publicationId: id } : { kind, relationshipId: id };
  assertMailboxTarget(s, intent);
  const held = s.requestOutbox.hold(intent, s.privatePublicationRoute);
  stopAutomaticMailboxSync(s);
  return held;
}

export async function releaseHeldRequest(id: string): Promise<PrivateRequestResult> {
  const s = session!;
  // A previous automatic check may be unwinding. Stop its client before an explicit mailbox run.
  const held = s.requestOutbox.list().find(entry => entry.id === id);
  if (held?.intent.kind !== 'search') { stopAutomaticMailboxSync(s); await s.mailboxSync?.pending; }
  if (session !== s) throw new Error('Session locked before release');
  try {
    const result = await s.requestOutbox.release(id);
    if (session === s) relayActivity = 'succeeded';
    return result;
  } catch (error) { if (session === s) relayActivity = 'failed'; throw error; }
}

export function cancelHeldRequest(id: string): void { session!.requestOutbox.cancel(id); }
export function removeHeldRequest(id: string): void { session!.requestOutbox.remove(id); }

export function planAdmissionWalletRetirement(issuerKey: string): AdmissionWalletRetirementPlan { return session!.admissionWallet.planRetirement(issuerKey); }
export function retireAdmissionWallet(issuerKey: string, approvalDigest: string): AdmissionWalletRetirementPlan { return session!.admissionWallet.retire(issuerKey, approvalDigest); }

export function getAdmissionWalletStatus() { return session!.admissionWallet.status(); }

export async function configureAdmissionWallet(profile: unknown): Promise<void> {
  const s = session!;
  if (!s.privatePublicationRoute) throw new Error('Wallet setup requires the private transport pilot');
  // Persist the pause before accepting any token configuration; failed setup cannot start automatic spending.
  s.requestOutbox.setAutomaticMailboxes(false);
  stopAutomaticMailboxSync(s);
  await s.admissionWallet.configure(profile);
  if (session !== s) throw new Error('Session locked during wallet setup');
}

export async function installAdmissionPolicy(policy: unknown, authority: string): Promise<void> {
  const s = session!;
  if (!s.privatePublicationRoute && !s.admissionWallet.configured()) throw new Error('Wallet setup requires the private transport pilot');
  s.requestOutbox.setAutomaticMailboxes(false); stopAutomaticMailboxSync(s);
  await s.admissionWallet.installPolicy(policy, authority);
  if (session !== s) throw new Error('Session locked during policy update');
}

export async function importAdmissionTokens(tokens: readonly string[]): Promise<number> {
  const s = session!;
  const count = await s.admissionWallet.importTokens(tokens);
  if (session !== s) throw new Error('Session locked during token import');
  return count;
}

export async function requestAdmissionTokens(count: number) {
  const s = session!;
  const request = await s.admissionWallet.requestTokens(count);
  if (session !== s) throw new Error('Session locked during token request');
  return request;
}
export async function completeAdmissionIssuance(response: unknown) {
  const s = session!;
  const imported = await s.admissionWallet.completeIssuance(response);
  if (session !== s) throw new Error('Session locked during token issuance');
  return imported;
}
export function cancelAdmissionIssuance() { session!.admissionWallet.cancelIssuance(); }

export async function searchRelay(text: string, type: ItemType): Promise<Array<{
  publicationId: string; similarity: number; itemType: string;
}>> {
  const s = session!;
  const embedding = await s.engine.embedForMatching(text, type);
  // LSH: hash the query — relay sees only the binary hash, not the embedding
  const hash = hashEmbedding(embedding, getSharedProjectionMatrix());
  try {
    const results = await s.relayClient.searchV2({
      groupId: 'public',
      fingerprintEpoch: 'pilot-static-v1',
      fingerprint: hash,
      itemType: type,
      k: 10,
      threshold: 0.65,
    });
    relayActivity = 'succeeded';
    return results.results;
  } catch (error) {
    relayActivity = 'failed';
    throw error;
  }
}

export async function initiateChannel(matchId: string): Promise<{ channelId: string }> {
  const s = session!;
  const mailboxMatch = listExternalMailboxMatches().find((candidate) => candidate.matchId === matchId);
  if (mailboxMatch) {
    const channel = await s.pairwiseChannelMgr.initiate(matchId);
    return { channelId: channel.channelId ?? channel.localKeys.relationshipId };
  }
  throw new Error('Protocol v2 mailbox match not found');
}
