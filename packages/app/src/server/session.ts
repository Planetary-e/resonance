/**
 * Session management: holds identity, store, relay client, channel manager.
 * Single shared session for the app lifetime.
 */

import { exactWitnessFields } from '@resonance/core/admission-witness';
import { parseRelayHistoryCollectionInput, parseRelayHistoryCollectionBinding, withRelayHistoryCollectionActivation } from './history-collection-activation.js';
import { parseRelayPolicyObserverInput, parseRelayPolicyObserverBinding, policyObserverActivationServiceFiles, withRelayPolicyObserverActivation } from './policy-observer-activation.js';
import { inventoryRelayHistoryStorage, retainRelayStorageDirectories, retainRelayHistoryOperationLocations } from './history-storage.js';
import { parseStorageDirectories } from '@resonance/relay';
import {
  assertSecureRelayTransportEndpoint,
  EmbeddingEngine,
  assertEmbeddingText,
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
import { chmodSync, readFileSync, writeFileSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { beginRelayMaintenance, readRelayMaintenance, assertRelayNotInMaintenance, acquireStoppedRelayMaintenance, finishRelayMaintenance, RELAY_MAINTENANCE_FILENAME,
  readOperatorJson, writeOperatorJsonAtomic, parseRelayHistoryHealth, type RelayHistoryHealth } from '@resonance/relay';
import {
  installRelayService, prepareRelayServiceInstallation, validateRelayServicePaths, relayServiceRuntime, relayServiceStats, uninstallRelayService, relayPortClosed,
  type RelayOwnerControls,
} from './relay-supervisor.js';
import { withRelayControl } from './relay-control.js';
import { openDesktopStorageBootstrapReview, desktopStorageBootstrapPending, readDesktopStorageBootstrapIntent } from './relay-storage-bootstrap.js';
import { openDesktopStorageAdoptionReview } from './relay-storage-adoption.js';
import { openDesktopStorageActivationReview } from './relay-storage-activation.js';
import { openDesktopStorageLimitReview } from './relay-storage-limit.js';
import { openDesktopStorageScopeReview } from './relay-storage-scope.js';
import { openReservedStorageControl } from '@resonance/core/storage-reservations';
import { readDesktopRelayStorage, currentDesktopRelayStorage, withDesktopRelayStorage, desktopRelayStorageControls } from './relay-storage.js';
import { withRelayHistoryActivation, parseRelayHistoryActivationInput, historyActivationServiceFiles, type RelayHistoryActivationInput } from './history-activation.js';
import { runDesktopHistoryRecovery, parseRelayHistoryRecoveryInput, type RelayHistoryRecoveryInput, type RelayHistoryRecoveryAction } from './history-recovery.js';
import { runDesktopHistorySetup, parseRelayHistorySetupInput, type RelayHistorySetupInput } from './history-setup.js';
import { runDesktopPolicyObserverSetup, parseRelayPolicyObserverSetupInput } from './policy-observer-setup.js';
import { runDesktopPolicyObserverRecovery, parseRelayPolicyObserverRecoveryInput, type RelayPolicyObserverRecoveryAction } from './policy-observer-recovery.js';
import { revokeSessionToken } from './local-session-auth.js';
import { withRelayVolunteerActivation, volunteerActivationServiceFiles, parseRelayVolunteerActivationInput, parseRelayVolunteerBinding,
  type RelayVolunteerActivationInput, type RelayVolunteerBinding } from './history-volunteer-activation.js';

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
  policyUpdate?: AbortController;
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
  const provider = wallet?.provider();
  return createRelayClient({
    ...(route ?? { relayUrl: urls[0] ?? '', fallbackUrls: urls.slice(1) }),
    identity, autoReconnect: true,
    admissionCapabilityProvider: provider ? Object.assign((context: Parameters<typeof provider>[0]) => {
      if (!route && wallet!.configured()) throw new Error('Access tokens require a private route; direct delivery is disabled');
      return provider(context);
    }, provider) : undefined,
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

let modelDisposal = Promise.resolve();
function releaseEmbeddingEngine(engine: EmbeddingEngine): Promise<void> {
  modelDisposal = Promise.all([modelDisposal, engine.dispose()]).then(() => undefined);
  // Lock is synchronous; keep errors observed and refuse another model load if
  // native cleanup failed rather than accumulating abandoned model sessions.
  void modelDisposal.catch(() => console.error('Matching model cleanup failed; restart the application before unlocking.'));
  return modelDisposal;
}
async function loadEmbeddingEngine(): Promise<EmbeddingEngine> {
  const engine = new EmbeddingEngine();
  try {
    await modelDisposal;
    await engine.initialize();
  } catch (error) {
    await releaseEmbeddingEngine(engine).catch(() => {});
    console.error('Matching model load failed:', error);
    throw new ModelLoadError();
  }
  return engine;
}

let session: Session | null = null;
let identityOperationInProgress = false;
let lockEpoch = {};
let sessionEvents: SessionEvents = {};
export type RelayActivity = 'not-checked' | 'succeeded' | 'failed';
let relayActivity: RelayActivity = 'not-checked';
let relayHistoryOperationAbort: AbortController | undefined;

export function getRelayActivity(): RelayActivity {
  return relayActivity;
}
// --- Relay config persistence ---

export interface RelayConfig {
  policyObserverRecoveryInput?: import('./policy-observer-recovery.js').RelayPolicyObserverRecoveryInput;
  policyObserverSetupInput?: import('./policy-observer-setup.js').RelayPolicyObserverSetupInput;
  policyObserverInput?: import('./policy-observer-activation.js').RelayPolicyObserverInput;
  policyObserverBinding?: import('./policy-observer-activation.js').RelayPolicyObserverBinding;
  historyCollectionInput?: import('./history-collection-activation.js').RelayHistoryCollectionInput;
  historyCollectionBinding?: import('./history-collection-activation.js').RelayHistoryCollectionBinding;
  enabled: boolean;
  port: number;
  adminKey?: string;
  contacts?: string[];
  controls?: RelayOwnerControls;
  storageCommitmentFloorBytes?: number;
  runtime?: ReturnType<typeof relayServiceRuntime>;
  historyStorageDirectories?: string[];
  historyActivationInput?: RelayHistoryActivationInput;
  historyRecoveryInput?: RelayHistoryRecoveryInput;
  historySetupInput?: RelayHistorySetupInput;
  historyVolunteerActivationInput?: RelayVolunteerActivationInput;
  historyVolunteerBinding?: RelayVolunteerBinding;
}

function getRelayConfigPath(): string {
  return join(getDataDir(), 'relay-config.json');
}

export function loadRelayConfig(): RelayConfig {
  const path = getRelayConfigPath();
  try { lstatSync(path); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved relay settings are unavailable; retain them before changing the service');
    // A missing settings file must not guess the port of an existing relay. A
    // newly paused, never-configured directory contains only the pause marker.
    let entries: string[];
    try { entries = readdirSync(join(getDataDir(), 'relay-data')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; entries = []; }
    if (entries.some(name => name !== RELAY_MAINTENANCE_FILENAME)) {
      throw new Error('Saved relay settings are missing for existing relay data; restore the settings before changing the service');
    }
    return { enabled: false, port: DEFAULT_RELAY_PORT };
  }
  try {
    const value = readOperatorJson(path, 65536) as Partial<RelayConfig> | null;
    if (!value || Array.isArray(value) || typeof value !== 'object' || typeof value.enabled !== 'boolean'
      || !Number.isSafeInteger(value.port) || value.port! < 1024 || value.port! > 65535
      || (value.adminKey !== undefined && typeof value.adminKey !== 'string')
      || (value.contacts !== undefined && (!Array.isArray(value.contacts) || value.contacts.some(c => typeof c !== 'string')))) throw new Error('Invalid settings');
    if (value.runtime !== undefined && (!value.runtime || typeof value.runtime !== 'object' || Array.isArray(value.runtime))) throw new Error('Invalid saved relay runtime');
    const storageSelection = value.runtime?.storageSelectionFile;
    if (storageSelection !== undefined && (typeof storageSelection !== 'string' || !isAbsolute(storageSelection) || storageSelection.length > 4096
      || /[\x00-\x1f\x7f]/.test(storageSelection))) throw new Error('Invalid saved relay storage selection');
    if (value.historyStorageDirectories !== undefined) parseStorageDirectories(value.historyStorageDirectories);
    if (value.historyActivationInput !== undefined) parseRelayHistoryActivationInput(value.historyActivationInput);
    if (value.historyRecoveryInput !== undefined) parseRelayHistoryRecoveryInput(value.historyRecoveryInput);
    if (value.historySetupInput !== undefined) parseRelayHistorySetupInput(value.historySetupInput);
    if (value.policyObserverSetupInput !== undefined) parseRelayPolicyObserverSetupInput(value.policyObserverSetupInput);
    if (value.policyObserverRecoveryInput !== undefined) parseRelayPolicyObserverRecoveryInput(value.policyObserverRecoveryInput);
    if ((value.historyVolunteerActivationInput === undefined) !== (value.historyVolunteerBinding === undefined)) throw new Error('Missing volunteer selection or binding');
    if (value.historyVolunteerActivationInput !== undefined) parseRelayVolunteerActivationInput(value.historyVolunteerActivationInput);
    if (value.historyVolunteerBinding !== undefined) parseRelayVolunteerBinding(value.historyVolunteerBinding);
    if ((value.historyCollectionInput === undefined) !== (value.historyCollectionBinding === undefined)) throw new Error('Missing collection selection or binding');
    if (value.historyCollectionInput !== undefined) parseRelayHistoryCollectionInput(value.historyCollectionInput);
    if (value.historyCollectionBinding !== undefined) parseRelayHistoryCollectionBinding(value.historyCollectionBinding);
    if ((value.policyObserverInput === undefined) !== (value.policyObserverBinding === undefined)) throw new Error('Missing observer selection or binding');
    if (value.policyObserverInput !== undefined) parseRelayPolicyObserverInput(value.policyObserverInput);
    if (value.policyObserverBinding !== undefined) parseRelayPolicyObserverBinding(value.policyObserverBinding);
    return value as RelayConfig;
  } catch { throw new Error('Saved relay settings are invalid; retain them for recovery before changing the service'); }
}

function saveRelayConfig(config: RelayConfig): void {
  const selected = currentDesktopRelayStorage();
  if (selected) {
    selected.assertCurrent();
    config = { ...config, runtime: { ...(config.runtime ?? relayServiceRuntime()), storageSelectionFile: selected.file } };
  }
  ensureDataDir();
  const path = getRelayConfigPath();
  config = retainRelayStorageDirectories(config, existsSync(path) ? loadRelayConfig() : undefined, join(getDataDir(), 'relay-data'));
  writeOperatorJsonAtomic(path, config, 65536);
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

/** Recheck selection after locking so a concurrent settings change cannot select
 * an unmanaged operation after its control lock was acquired. */
function assertBootstrapSelection(selected: ReturnType<typeof readDesktopRelayStorage>) {
  if (!desktopStorageBootstrapPending(getDataDir())) return;
  if (!selected) throw new Error('Storage setup is unfinished; recover and review its retained budget before resuming relay operations');
  const pins = readDesktopStorageBootstrapIntent(getDataDir(), selected.configuration.runtimePort);
  if (pins.authorityDirectory !== selected.configuration.authorityDirectory || pins.intent.authorityId !== selected.configuration.authorityId) {
    throw new Error('Selected storage differs from its retained bootstrap identity; use a separately reviewed migration');
  }
}
function withConfiguredRelayControl<T>(operation: () => T | Promise<T>): Promise<T> {
  const selected = readDesktopRelayStorage(loadRelayConfig());
  assertBootstrapSelection(selected);
  return withRelayControl(() => {
    const current = readDesktopRelayStorage(loadRelayConfig());
    assertBootstrapSelection(current);
    if (JSON.stringify(current?.source) !== JSON.stringify(selected?.source)) throw new Error('Relay storage selection changed before control acquisition');
    return withDesktopRelayStorage(selected, operation);
  }, selected);
}
function withPrepaidRelayControls<T>(operation: () => T & (T extends PromiseLike<unknown> ? never : unknown)): T {
  const selected = currentDesktopRelayStorage(); return selected ? selected.controls(operation) : operation();
}

// --- Relay mode ---

export async function startRelayMode(port?: number, contacts?: string[], controls?: RelayOwnerControls): Promise<{ port: number }> {
  return withConfiguredRelayControl(() => {
    assertRelayNotInMaintenance(join(getDataDir(), 'relay-data'));
    return startRelayModeUnlocked(port, contacts, controls);
  });
}
async function startRelayModeUnlocked(
  port?: number, requestedContacts?: string[], requestedControls?: RelayOwnerControls,
): Promise<{ port: number }> {
  const previous = loadRelayConfig();
  const p = port ?? previous.port ?? DEFAULT_RELAY_PORT;
  if (!Number.isSafeInteger(p) || p < 1024 || p > 65535) throw new Error('Relay port must be an integer between 1024 and 65535');
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
  const runtime = relayServiceRuntime(previous.runtime, { ...(previous.historyActivationInput ? historyActivationServiceFiles(previous.historyActivationInput) : {}),
    ...volunteerActivationServiceFiles(previous), ...policyObserverActivationServiceFiles(previous) });
  const selectedStorage = currentDesktopRelayStorage();
  if (selectedStorage && (p !== selectedStorage.configuration.runtimePort || runtime.storageSelectionFile !== selectedStorage.file)) {
    throw new Error('Changing the selected relay endpoint requires a separately reviewed storage selection');
  }
  const previousStats = previous.enabled ? await relayServiceStats(previous.port, adminKey) : null;
  const minimumStorageBytes = storageCommitmentFloor(
    previousStats, previous.storageCommitmentFloorBytes ?? 0,
  );
  if (controls.publicationStorageMiB !== undefined
    && controls.publicationStorageMiB * 1_048_576 < minimumStorageBytes) {
    throw new Error(`Storage limit must be at least ${Math.ceil(minimumStorageBytes / 1_048_576)} MiB to preserve accepted relay data`);
  }
  if (previous.enabled && previous.port === p
    && JSON.stringify(previous.runtime) === JSON.stringify(runtime)
    && JSON.stringify(previous.contacts) === JSON.stringify(contacts)
    && JSON.stringify(previous.controls ?? {}) === JSON.stringify(controls)
    && await relayServiceStats(p, adminKey)) return { port: p };
  const service = { port: p, dataDir: getDataDir(), adminKey, contacts, controls, ...runtime };
  const next: RelayConfig = { enabled: true, port: p, adminKey, contacts, controls, runtime,
    ...(previous.policyObserverInput ? { policyObserverInput: previous.policyObserverInput, policyObserverBinding: previous.policyObserverBinding } : {}),
    ...(previous.historyCollectionInput ? { historyCollectionInput: previous.historyCollectionInput, historyCollectionBinding: previous.historyCollectionBinding } : {}),
    ...(previous.historyActivationInput ? { historyActivationInput: previous.historyActivationInput } : {}),
    ...(previous.historyRecoveryInput ? { historyRecoveryInput: previous.historyRecoveryInput } : {}),
    ...(previous.historySetupInput ? { historySetupInput: previous.historySetupInput } : {}),
    ...(previous.policyObserverSetupInput ? { policyObserverSetupInput: previous.policyObserverSetupInput } : {}),
    ...(previous.policyObserverRecoveryInput ? { policyObserverRecoveryInput: previous.policyObserverRecoveryInput } : {}),
    ...(previous.historyVolunteerActivationInput ? { historyVolunteerActivationInput: previous.historyVolunteerActivationInput,
      historyVolunteerBinding: previous.historyVolunteerBinding } : {}),
    storageCommitmentFloorBytes: minimumStorageBytes };
  if (selectedStorage) {
    validateRelayServicePaths(service);
    withPrepaidRelayControls(() => beginRelayMaintenance(join(getDataDir(), 'relay-data')));
    uninstallRelayService();
    const stopped = await claimStoppedRelay();
    let prepared: ReturnType<typeof prepareRelayServiceInstallation>;
    try { prepared = stopped.run(() => { const value = prepareRelayServiceInstallation(service); saveRelayConfig(next); return value; }); }
    finally { stopped.close(); }
    selectedStorage.assertCurrent();
    withPrepaidRelayControls(() => finishRelayMaintenance(join(getDataDir(), 'relay-data')));
    try { prepared.start(); }
    catch (error) {
      // A partial native start may already have effects. Persist the pause again
      // before reporting failure; it prevents subsequent supervised restarts.
      withPrepaidRelayControls(() => beginRelayMaintenance(join(getDataDir(), 'relay-data')));
      throw error;
    }
  } else {
    installRelayService(service);
    saveRelayConfig(next);
  }
  let running = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await relayServiceStats(p, adminKey)) { running = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!running) throw new Error('The supervised relay is installed but has not responded; check its status and service log');

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

export async function stopRelayMode(): Promise<void> { return withConfiguredRelayControl(stopRelayModeUnlocked); }
async function stopRelayModeUnlocked(keepMaintenance = false): Promise<void> {
  keepMaintenance ||= !!readRelayMaintenance(join(getDataDir(), 'relay-data'));
  const previous = loadRelayConfig();
  const stats = previous.enabled && previous.adminKey
    ? await relayServiceStats(previous.port, previous.adminKey) : null;
  if (currentDesktopRelayStorage()) withPrepaidRelayControls(() => beginRelayMaintenance(join(getDataDir(), 'relay-data')));
  uninstallRelayService();
  withPrepaidRelayControls(() => saveRelayConfig({ ...previous, enabled: false,
    storageCommitmentFloorBytes: storageCommitmentFloor(
      stats, previous.storageCommitmentFloorBytes ?? 0,
    ),
  }));
  if (currentDesktopRelayStorage() && !keepMaintenance) {
    const stopped = await claimStoppedRelay(); stopped.close();
    withPrepaidRelayControls(() => finishRelayMaintenance(join(getDataDir(), 'relay-data')));
  }
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

/** Private operator state; this neither opens admission state nor starts transport. */
export function getRelayMaintenanceStatus() {
  const state = readRelayMaintenance(join(getDataDir(), 'relay-data'));
  return { active: state !== null, createdAt: state?.createdAt ?? null };
}
async function claimStoppedRelay(signal?: AbortSignal): Promise<{ run<T>(operation: () => T): T; close(): void }> {
  const directory = join(getDataDir(), 'relay-data'), port = loadRelayConfig().port;
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    if (signal?.aborted) throw new Error('Relay maintenance cancelled; its saved marker remains active');
    let release: (() => void) | undefined;
    try {
      const selected = currentDesktopRelayStorage();
      if (selected) return await selected.stopped(signal);
      release = acquireStoppedRelayMaintenance(directory);
      // Older unmanaged processes may not hold the runtime claim. A busy port
      // cannot count as a stopped service merely because stats are unavailable.
      if (await relayPortClosed(port)) {
        if (signal?.aborted) throw new Error('Relay maintenance cancelled; its saved marker remains active');
        const held = release; release = undefined; return { run: operation => operation(), close: held };
      }
    } catch (error) {
      if (signal?.aborted || !String(error).includes('already open') && !String(error).includes('listener is not closed')) throw error;
    } finally { release?.(); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The relay has not stopped. Maintenance remains active; stop the running process before retrying');
}
export async function beginRelayHistoryMaintenance(signal?: AbortSignal) {
  return withConfiguredRelayControl(async () => {
    if (signal?.aborted) throw new Error('Relay maintenance cancelled');
    withPrepaidRelayControls(() => beginRelayMaintenance(join(getDataDir(), 'relay-data')));
    await stopRelayModeUnlocked(true);
    const stopped = await claimStoppedRelay(signal); stopped.close();
    return getRelayMaintenanceStatus();
  });
}
/** The next desktop workflow runs each bounded step inside this exclusion. */
export async function runRelayHistoryOperation<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withConfiguredRelayControl(async () => {
    const controller = new AbortController(); relayHistoryOperationAbort = controller;
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let stopped: Awaited<ReturnType<typeof claimStoppedRelay>> | undefined;
    try { stopped = await claimStoppedRelay(combined); return await stopped.run(() => operation(combined)); }
    finally { stopped?.close(); if (relayHistoryOperationAbort === controller) relayHistoryOperationAbort = undefined; }
  });
}
export function cancelRelayHistoryOperation() {
  const active = !!relayHistoryOperationAbort; relayHistoryOperationAbort?.abort(); return { active };
}
export async function measureRelayHistoryStorage(signal?: AbortSignal) {
  return runRelayHistoryOperation(operationSignal => inventoryRelayHistoryStorage(loadRelayConfig(), join(getDataDir(), 'relay-data'), operationSignal), signal);
}
type StorageReviewPurpose = 'bootstrap' | 'adoption' | 'activation' | 'limit' | 'scope';
interface StorageReviewHandle { review(): unknown; apply(approvalDigest: string): unknown; close(): void }
let pendingStorageReview: { purpose: StorageReviewPurpose; owner: Session; controller: AbortController; handle?: StorageReviewHandle; settings: string } | undefined;
/** Keep approval tied to the unlocked session and held desktop/runtime claims.
 * The HTTP response may finish while the bounded review remains alive. */
async function planSessionStorageReview(purpose: StorageReviewPurpose,
  open: (config: RelayConfig, signal: AbortSignal) => Promise<StorageReviewHandle>, signal?: AbortSignal) {
  if (!session) throw new Error('Unlock the desktop before reviewing storage setup');
  if (pendingStorageReview) throw new Error('A storage review is already active; finish or cancel it');
  const config = loadRelayConfig();
  const selected = readDesktopRelayStorage(config);
  if (purpose === 'limit' || purpose === 'scope') { if (!selected) throw new Error('Select storage before changing its limit or locations'); assertBootstrapSelection(selected); }
  else if (selected) throw new Error('Storage is already selected; use its reviewed maintenance controls');
  const operation = { purpose, owner: session, controller: new AbortController(), settings: JSON.stringify(config), handle: undefined as StorageReviewHandle | undefined };
  pendingStorageReview = operation;
  const combined = AbortSignal.any([operation.controller.signal, AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
  const abandon = () => { if (pendingStorageReview === operation) pendingStorageReview = undefined; };
  combined.addEventListener('abort', abandon, { once: true });
  try {
    operation.handle = await open(config, combined);
    combined.throwIfAborted();
    if (session !== operation.owner || pendingStorageReview !== operation || JSON.stringify(loadRelayConfig()) !== operation.settings) throw new Error('Desktop session or settings changed during storage review');
    return operation.handle.review();
  } catch (error) {
    if (pendingStorageReview === operation) pendingStorageReview = undefined;
    operation.controller.abort(); operation.handle?.close(); throw error;
  }
}
function cancelSessionStorageReview(purpose?: StorageReviewPurpose) {
  const operation = pendingStorageReview;
  if (purpose && operation?.purpose !== purpose) return { active: false };
  pendingStorageReview = undefined;
  if (operation) { operation.controller.abort(); operation.handle?.close(); }
  return { active: !!operation };
}
function applySessionStorageReview(purpose: StorageReviewPurpose, approvalDigest: string) {
  const operation = pendingStorageReview;
  if (!operation?.handle || operation.purpose !== purpose || !session || operation.owner !== session) throw new Error('Review this storage operation in the current unlocked session before applying');
  pendingStorageReview = undefined;
  try {
    if (JSON.stringify(loadRelayConfig()) !== operation.settings || !['limit', 'scope'].includes(purpose) && readDesktopRelayStorage(loadRelayConfig())) throw new Error('Desktop settings changed; review storage setup again');
    if (purpose === 'limit' || purpose === 'scope') assertBootstrapSelection(readDesktopRelayStorage(loadRelayConfig()));
    return operation.handle.apply(approvalDigest);
  } finally { operation.controller.abort(); operation.handle.close(); }
}
export function planRelayStorageBootstrap(input: unknown, signal?: AbortSignal) {
  if (!exactWitnessFields(input, ['mode', ...(input && typeof input === 'object' && 'mode' in input && input.mode === 'new' ? ['limitBytes'] : [])])
    || !['new', 'recover'].includes(input.mode as string)) throw new Error('Select new storage with its byte limit, or recovery without a new limit');
  const mode = input.mode as 'new' | 'recover', limitBytes = input.limitBytes as number | undefined;
  return planSessionStorageReview('bootstrap', (config, combined) => openDesktopStorageBootstrapReview({ dataDirectory: getDataDir(), runtimePort: config.port,
    mode, ...(mode === 'new' ? { limitBytes } : {}), signal: combined }), signal);
}
export function applyRelayStorageBootstrap(approvalDigest: string) { return applySessionStorageReview('bootstrap', approvalDigest); }
export function cancelRelayStorageBootstrap() { return cancelSessionStorageReview('bootstrap'); }
export function planRelayStorageAdoption(input: unknown, signal?: AbortSignal) {
  if (!exactWitnessFields(input, input && typeof input === 'object' && 'limitBytes' in input ? ['limitBytes'] : [])) throw new Error('Adoption uses saved locations and an optional reviewed byte limit');
  const limitBytes = input.limitBytes as number | undefined;
  return planSessionStorageReview('adoption', (config, combined) => openDesktopStorageAdoptionReview({ dataDirectory: getDataDir(), config, limitBytes, signal: combined }), signal);
}
export function applyRelayStorageAdoption(approvalDigest: string) { return applySessionStorageReview('adoption', approvalDigest); }
export function cancelRelayStorageAdoption() { return cancelSessionStorageReview('adoption'); }
export function planRelayStorageActivation(input: unknown, signal?: AbortSignal) {
  if (!exactWitnessFields(input, [])) throw new Error('Storage activation uses the reviewed saved locations');
  return planSessionStorageReview('activation', (config, combined) => {
    const runtime = relayServiceRuntime(config.runtime, { ...(config.historyActivationInput ? historyActivationServiceFiles(config.historyActivationInput) : {}),
      ...volunteerActivationServiceFiles(config), ...policyObserverActivationServiceFiles(config) });
    const contacts = config.contacts ?? [];
    if (contacts.length > 16 || new Set(contacts).size !== contacts.length) throw new Error('Relay contacts must be distinct and bounded');
    for (const contact of contacts) assertSecureRelayTransportEndpoint(contact);
    return openDesktopStorageActivationReview({ dataDirectory: getDataDir(), config, signal: combined, saveConfig: saveRelayConfig,
      service: { ...runtime, dataDir: getDataDir(), port: config.port, contacts, controls: validateOwnerControls(config.controls ?? {}),
        adminKey: config.adminKey ?? randomBytes(32).toString('base64url') } });
  }, signal);
}
export function applyRelayStorageActivation(approvalDigest: string) { return applySessionStorageReview('activation', approvalDigest); }
export function cancelRelayStorageActivation() { return cancelSessionStorageReview('activation'); }
export function planRelayStorageLimit(input: unknown, signal?: AbortSignal) {
  if (!exactWitnessFields(input, ['limitBytes']) || !Number.isSafeInteger(input.limitBytes) || (input.limitBytes as number) < 1) throw new Error('Supply a positive integer byte limit');
  return planSessionStorageReview('limit', (config, combined) => openDesktopStorageLimitReview({ dataDirectory: getDataDir(), config,
    limitBytes: input.limitBytes as number, signal: combined }), signal);
}
export function applyRelayStorageLimit(approvalDigest: string) { return applySessionStorageReview('limit', approvalDigest); }
export function cancelRelayStorageLimit() { return cancelSessionStorageReview('limit'); }
export function planRelayStorageScope(input: unknown, signal?: AbortSignal) {
  return planSessionStorageReview('scope', (config, combined) => openDesktopStorageScopeReview({ dataDirectory: getDataDir(), config, input, signal: combined }), signal);
}
export function applyRelayStorageScope(approvalDigest: string) { return applySessionStorageReview('scope', approvalDigest); }
export function cancelRelayStorageScope() { return cancelSessionStorageReview('scope'); }
export function getRelayStorageStatus() {
  const config = loadRelayConfig(), directory = getDataDir(), maintenanceActive = !!readRelayMaintenance(join(directory, 'relay-data'));
  const pending = desktopStorageBootstrapPending(directory);
  try {
    const selected = readDesktopRelayStorage(config);
    if (!selected && !pending) return { phase: 'unconfigured' as const, maintenanceActive, budget: null };
    if (selected) assertBootstrapSelection(selected);
    const pins = selected?.configuration ?? (() => { const value = readDesktopStorageBootstrapIntent(directory, config.port);
      return { authorityDirectory: value.authorityDirectory, authorityId: value.intent.authorityId }; })();
    const view = openReservedStorageControl({ directory: pins.authorityDirectory, authorityId: pins.authorityId, controls: desktopRelayStorageControls(directory) });
    try {
      const budget = view.status(); selected?.assertCurrent();
      return { phase: selected ? 'selected' as const : 'preparing' as const, maintenanceActive, budget };
    } finally { view.close(); }
  } catch {
    // A partial/missing primary is not an empty budget. No details or guessed
    // totals are exposed; reviewed recovery uses the independently retained pins.
    return { phase: 'recovery-required' as const, maintenanceActive, budget: null };
  }
}

export function getRelayHistoryActivationInput() { return loadRelayConfig().historyActivationInput ?? null; }
export function getRelayHistoryRecoveryInput() { return loadRelayConfig().historyRecoveryInput ?? null; }
export function getRelayHistorySetupInput() { return loadRelayConfig().historySetupInput ?? null; }
export function getRelayVolunteerActivationInput() { return loadRelayConfig().historyVolunteerActivationInput ?? null; }
export function getRelayHistoryCollectionInput() { return loadRelayConfig().historyCollectionInput ?? null; }
export function getRelayPolicyObserverInput() { return loadRelayConfig().policyObserverInput ?? null; }
export function getRelayPolicyObserverSetupInput() { return loadRelayConfig().policyObserverSetupInput ?? null; }
export function getRelayPolicyObserverRecoveryInput() { return loadRelayConfig().policyObserverRecoveryInput ?? null; }
export async function performRelayPolicyObserverRecovery(action: RelayPolicyObserverRecoveryAction, input: unknown, approval?: unknown, signal?: AbortSignal) {
  return runRelayHistoryOperation(async operationSignal => {
    const previous = loadRelayConfig(), runtimeDirectory = join(getDataDir(), 'relay-data');
    const outcome = await runDesktopPolicyObserverRecovery(action, input, approval, operationSignal, runtimeDirectory,
      locations => retainRelayHistoryOperationLocations(previous, runtimeDirectory, undefined, locations));
    if (['start', 'step', 'restore', 'resume', 'export'].includes(action)) saveRelayConfig({ ...previous, policyObserverRecoveryInput: outcome.input });
    return outcome;
  }, signal);
}
export async function performRelayPolicyObserverSetup(action: 'review' | 'apply', input: unknown, approval?: unknown, signal?: AbortSignal) {
  return runRelayHistoryOperation(async operationSignal => {
    const previous = loadRelayConfig(), runtimeDirectory = join(getDataDir(), 'relay-data');
    const outcome = await runDesktopPolicyObserverSetup(action, input, approval, operationSignal, runtimeDirectory,
      locations => retainRelayHistoryOperationLocations(previous, runtimeDirectory, undefined, locations));
    if (action === 'apply') saveRelayConfig({ ...previous, policyObserverSetupInput: outcome.input });
    return outcome;
  }, signal);
}
export async function planRelayPolicyObserverActivation(input: unknown, signal?: AbortSignal) {
  return runRelayHistoryOperation(operationSignal => {
    const previous = loadRelayConfig();
    return withRelayPolicyObserverActivation(input, previous, join(getDataDir(), 'relay-data'), operationSignal,
      { ...(previous.historyActivationInput ? historyActivationServiceFiles(previous.historyActivationInput) : {}), ...volunteerActivationServiceFiles(previous) },
      async prepared => prepared.review);
  }, signal);
}
export async function applyRelayPolicyObserverActivation(input: unknown, digest: string, signal?: AbortSignal) {
  return runRelayHistoryOperation(operationSignal => {
    const previous = loadRelayConfig();
    return withRelayPolicyObserverActivation(input, previous, join(getDataDir(), 'relay-data'), operationSignal,
      { ...(previous.historyActivationInput ? historyActivationServiceFiles(previous.historyActivationInput) : {}), ...volunteerActivationServiceFiles(previous) }, async prepared => {
        const next = { ...previous, enabled: false, runtime: prepared.runtime, policyObserverInput: prepared.input, policyObserverBinding: prepared.binding };
        const result = prepared.apply(digest, () => retainRelayHistoryOperationLocations(next, join(getDataDir(), 'relay-data'), previous));
        saveRelayConfig(next); return { ...result, maintenanceActive: true };
      });
  }, signal);
}
export async function planRelayHistoryCollectionActivation(input: unknown, signal?: AbortSignal) {
  return runRelayHistoryOperation(operationSignal => withRelayHistoryCollectionActivation(input, loadRelayConfig(), join(getDataDir(), 'relay-data'), operationSignal,
    async prepared => prepared.review), signal);
}
export async function applyRelayHistoryCollectionActivation(input: unknown, digest: string, signal?: AbortSignal) {
  return runRelayHistoryOperation(async operationSignal => {
    const previous = loadRelayConfig();
    return withRelayHistoryCollectionActivation(input, previous, join(getDataDir(), 'relay-data'), operationSignal, async prepared => {
      const next = { ...previous, enabled: false, runtime: prepared.runtime, historyCollectionInput: prepared.input, historyCollectionBinding: prepared.binding };
      const result = prepared.apply(digest, () => retainRelayHistoryOperationLocations(next, join(getDataDir(), 'relay-data'), previous));
      saveRelayConfig(next); return { ...result, maintenanceActive: true };
    });
  }, signal);
}
export async function planRelayVolunteerActivation(input: unknown, signal?: AbortSignal) {
  return runRelayHistoryOperation(async operationSignal => withRelayVolunteerActivation(input, loadRelayConfig(), join(getDataDir(), 'relay-data'), operationSignal,
    async prepared => prepared.review), signal);
}
export async function applyRelayVolunteerActivation(input: unknown, digest: string, signal?: AbortSignal) {
  return runRelayHistoryOperation(async operationSignal => {
    const previous = loadRelayConfig();
    return withRelayVolunteerActivation(input, previous, join(getDataDir(), 'relay-data'), operationSignal, async prepared => {
      const result = prepared.apply(digest, () => retainRelayHistoryOperationLocations(
        { ...previous, historyVolunteerActivationInput: prepared.input }, join(getDataDir(), 'relay-data'), previous));
      saveRelayConfig({ ...previous, enabled: false, runtime: prepared.runtime, historyVolunteerActivationInput: prepared.input, historyVolunteerBinding: prepared.binding });
      return { ...result, maintenanceActive: true };
    });
  }, signal);
}
export async function performRelayHistorySetup(action: 'review' | 'apply', input: unknown, approval?: unknown, signal?: AbortSignal) {
  return runRelayHistoryOperation(async operationSignal => {
    const previous = loadRelayConfig(), outcome = await runDesktopHistorySetup(action, input, approval, operationSignal, join(getDataDir(), 'relay-data'),
      selection => { retainRelayHistoryOperationLocations({ ...previous, historySetupInput: selection }, join(getDataDir(), 'relay-data'), previous); });
    if (action === 'apply') saveRelayConfig({ ...previous, historySetupInput: outcome.input });
    return outcome;
  }, signal);
}
export async function performRelayHistoryRecovery(action: RelayHistoryRecoveryAction, input: unknown, approval?: unknown, signal?: AbortSignal) {
  return runRelayHistoryOperation(async operationSignal => {
    const previous = loadRelayConfig(), outcome = await runDesktopHistoryRecovery(action, input, approval, operationSignal, join(getDataDir(), 'relay-data'),
      selection => retainRelayHistoryOperationLocations({ ...previous, historyRecoveryInput: selection }, join(getDataDir(), 'relay-data'), previous));
    if (!['plan', 'review', 'readiness-plan'].includes(action)) saveRelayConfig({ ...previous, historyRecoveryInput: outcome.input });
    return outcome.result;
  }, signal);
}
export async function planRelayHistoryActivation(input: unknown, signal?: AbortSignal) {
  return runRelayHistoryOperation(async operationSignal => {
    const previous = loadRelayConfig();
    return withRelayHistoryActivation(input, previous, join(getDataDir(), 'relay-data'), operationSignal,
      async ({ activation }) => activation.review(), { ...volunteerActivationServiceFiles(previous), ...policyObserverActivationServiceFiles(previous) });
  }, signal);
}
export async function applyRelayHistoryActivation(input: unknown, approvalDigest: string, signal?: AbortSignal) {
  return runRelayHistoryOperation(async operationSignal => {
    const previous = loadRelayConfig();
    return withRelayHistoryActivation(input, previous, join(getDataDir(), 'relay-data'), operationSignal,
      async ({ activation, runtime, input: selection, checkInputs }) => {
        if (approvalDigest !== activation.review().approvalDigest) throw new Error('Activation approval does not match; review current history and settings again');
        retainRelayHistoryOperationLocations({ ...previous, historyActivationInput: selection }, join(getDataDir(), 'relay-data'), previous);
        const result = await activation.apply(approvalDigest); checkInputs();
        saveRelayConfig({ ...previous, enabled: false, runtime, historyActivationInput: selection });
        return { ...result, result: 'owner-service-configured' as const, maintenanceActive: true as const };
      }, { ...volunteerActivationServiceFiles(previous), ...policyObserverActivationServiceFiles(previous) });
  }, signal);
}
export async function finishRelayHistoryMaintenance() {
  return withConfiguredRelayControl(async () => {
    const stopped = await claimStoppedRelay(); stopped.close();
    withPrepaidRelayControls(() => finishRelayMaintenance(join(getDataDir(), 'relay-data')));
    return getRelayMaintenanceStatus();
  });
}

export function isRelayMode(): boolean {
  return loadRelayConfig().enabled;
}

export async function getRelayStats(): Promise<{
  enabled: boolean; running: boolean; admissionReady: boolean | null; port: number; contacts: string[];
  controls: RelayOwnerControls;
  storageCommitmentFloorBytes: number;
  stats: {
    history: RelayHistoryHealth | null;
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
    enabled: false, running: false, admissionReady: null, port: config.port,
    contacts: config.contacts ?? [], controls: config.controls ?? {},
    storageCommitmentFloorBytes: config.storageCommitmentFloorBytes ?? 0, stats: null,
  };
  const stats = await relayServiceStats(config.port, config.adminKey);
  return {
    enabled: true, running: stats !== null,
    admissionReady: typeof stats?.admission_ready === 'boolean' ? stats.admission_ready : null, port: config.port,
    contacts: config.contacts ?? [], controls: config.controls ?? {},
    storageCommitmentFloorBytes: storageCommitmentFloor(
      stats, config.storageCommitmentFloorBytes ?? 0,
    ),
    stats: stats ? {
      history: parseRelayHistoryHealth(stats.history),
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

export async function initSession(password: string, signal?: AbortSignal): Promise<{ did: string }> {
  signal?.throwIfAborted();
  if (identityOperationInProgress) throw new Error('A local identity operation is already in progress');
  identityOperationInProgress = true;
  const epoch = lockEpoch;
  try {
    ensureDataDir();
    const mgr = createIdentityManager();
    if (mgr.exists()) throw new Error('Identity already initialized');
    // A failed or cancelled model load must not leave a half-created identity.
    const probe = await loadEmbeddingEngine();
    await releaseEmbeddingEngine(probe);
    signal?.throwIfAborted();
    if (epoch !== lockEpoch) throw new Error('Session locked during initialization');
    const identity = await mgr.create(password);
    try {
      signal?.throwIfAborted();
      const store = await openStoreAsync(getDbPath(), deriveStoreKey(identity));
      store.close(); return { did: identity.did };
    } finally { identity.secretKey.fill(0); }
  } finally { identityOperationInProgress = false; }
}

export async function unlockSession(password: string, relayUrl: string, signal?: AbortSignal): Promise<{ did: string }> {
  signal?.throwIfAborted();
  if (identityOperationInProgress) throw new Error('A local identity operation is already in progress');
  identityOperationInProgress = true;
  let allocated: EmbeddingEngine | undefined;
  try { return await unlockSessionOnce(password, relayUrl, signal, engine => { allocated = engine; }); }
  finally {
    try { if (allocated && session?.engine !== allocated) await releaseEmbeddingEngine(allocated); }
    finally { identityOperationInProgress = false; }
  }
}

async function unlockSessionOnce(password: string, relayUrl: string, signal: AbortSignal | undefined, ownEngine: (engine: EmbeddingEngine) => void): Promise<{ did: string }> {
  const epoch = lockEpoch;
  const currentUnlock = () => { signal?.throwIfAborted(); if (epoch !== lockEpoch) throw new Error('Session locked during unlock'); };
  if (session) {
    const current = session;
    // A new browser page needs a fresh token, even when the backend is still
    // unlocked. Never let the existing in-memory identity bypass authentication.
    const verified = await current.identityMgr.load(password);
    try {
      currentUnlock();
      if (session !== current || verified.did !== current.identity.did) throw new Error('Session changed during unlock');
      return { did: current.identity.did };
    } finally { verified.secretKey.fill(0); }
  }

  const mgr = createIdentityManager();
  const identity = await mgr.load(password);
  let engine: EmbeddingEngine | undefined, store: LocalStore | undefined;
  try {
    currentUnlock(); engine = await loadEmbeddingEngine(); ownEngine(engine); currentUnlock();
    store = await openStoreAsync(getDbPath(), deriveStoreKey(identity)); currentUnlock();
  } catch (error) { store?.close(); identity.secretKey.fill(0); throw error; }

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
    currentUnlock();
    privatePublicationRoute = configuredPrivateRoute();
    const walletKey = deriveAdmissionWalletKey(identity);
    try { admissionWallet = await openManagedAdmissionWallet({ directory: getDataDir(), encryptionKey: walletKey }); }
    catch { throw new WalletLoadError(); }
    finally { walletKey.fill(0); }
    currentUnlock();
    const capabilityProvider = admissionWallet.provider();
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
  lockEpoch = {};
  revokeSessionToken();
  cancelSessionStorageReview();
  relayHistoryOperationAbort?.abort();
  if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
  if (!session) return;
  void releaseEmbeddingEngine(session.engine);
  stopAutomaticMailboxSync(session);
  session.policyUpdate?.abort();
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

export async function publishItem(text: string, type: ItemType, privacy: PrivacyLevel, delivery: 'send' | 'hold' = 'send', signal?: AbortSignal): Promise<{
  id: string; status: string; dims: number;
}> {
  const s = session!;
  assertEmbeddingText(text); signal?.throwIfAborted();
  if (delivery === 'hold' && !s.privatePublicationRoute) throw new Error('Local hold requires the private transport pilot');
  const embedding = await s.engine.embedForMatching(text, type, 'search_document', { signal });
  signal?.throwIfAborted();
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

export async function holdSearch(text: string, type: ItemType, signal?: AbortSignal) {
  const s = session!;
  assertEmbeddingText(text); signal?.throwIfAborted();
  if (!s.privatePublicationRoute) throw new Error('Search hold requires the private transport pilot');
  const embedding = await s.engine.embedForMatching(text, type, 'search_document', { signal });
  signal?.throwIfAborted();
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

export async function installAdmissionPolicy(policy: unknown, authority: string, observers?: unknown): Promise<void> {
  const s = session!;
  if (!s.privatePublicationRoute && !s.admissionWallet.configured()) throw new Error('Wallet setup requires the private transport pilot');
  s.requestOutbox.setAutomaticMailboxes(false); stopAutomaticMailboxSync(s);
  await s.admissionWallet.installPolicy(policy, authority, observers);
  if (session !== s) throw new Error('Session locked during policy update');
}

/** One explicit catch-up step, with no token allocation or periodic polling. */
export async function updateAdmissionPolicy(signal?: AbortSignal) {
  const s = session!;
  if (!s.privatePublicationRoute) throw new Error('A private route is required to fetch community policies');
  if (s.policyUpdate) throw new Error('A community policy update is already in progress');
  const pins = s.admissionWallet.policyUpdatePins(), controller = new AbortController();
  const client = createSessionRelayClient([], s.identity, s.privatePublicationRoute, s.admissionWallet);
  s.policyUpdate = controller;
  const lifetime = AbortSignal.any([controller.signal, AbortSignal.timeout(25000), ...(signal ? [signal] : [])]);
  const cancel = () => client.disconnect(), current = () => { lifetime.throwIfAborted(); if (session !== s) throw new Error('Session changed during policy update'); };
  lifetime.addEventListener('abort', cancel, { once: true });
  try {
    current();
    const observation = await client.queryAdmissionPolicy!(pins.context); current();
    const observed = s.admissionWallet.observePolicy(observation); current();
    if (observed.previous.revision === observed.observed.revision) return { updated: false, revision: observed.previous.revision, remaining: 0 };
    const advance = await client.fetchAdmissionPolicySuccessor!(observed.context, observed.previous); current();
    await s.admissionWallet.installPolicy(advance, observed.context.authority, undefined, lifetime); current();
    const after = s.admissionWallet.policyUpdatePins();
    return { updated: true, revision: after.previous.revision, remaining: Math.max(0, after.observed.revision - after.previous.revision) };
  } finally { lifetime.removeEventListener('abort', cancel); client.disconnect(); if (s.policyUpdate === controller) delete s.policyUpdate; }
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

export async function searchRelay(text: string, type: ItemType, signal?: AbortSignal): Promise<Array<{
  publicationId: string; similarity: number; itemType: string;
}>> {
  const s = session!;
  assertEmbeddingText(text); signal?.throwIfAborted();
  const embedding = await s.engine.embedForMatching(text, type, 'search_document', { signal });
  signal?.throwIfAborted();
  if (session !== s) throw new Error('Session locked before search');
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
