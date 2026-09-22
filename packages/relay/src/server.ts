/**
 * Relay server: WebSocket + HTTP admin API.
 * Accepts self-authenticating protocol v2 operations over short connections.
 */

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  MessageTypes,
  MAILBOX_DEPOSIT_FRAME_TYPE,
  MAILBOX_REQUEST_FRAME_TYPE,
  MAILBOX_RESPONSE_MESSAGE_TYPE,
  MAX_RELAY_DISCOVERY_FRAME_BYTES,
  PUBLICATION_OPERATION_FRAME_TYPE,
  RELAY_LINK_OPEN_FRAME_TYPE,
  RELAY_REPLICA_INVENTORY_BATCH_REQUEST_FRAME_TYPE,
  RELAY_REPLICA_HANDOFF_RESPONSE_FRAME_TYPE,
  RELAY_REPLICA_INVENTORY_REQUEST_FRAME_TYPE,
  RELAY_REPLICA_RECONCILIATION_REQUEST_FRAME_TYPE,
  RELAY_REPLICA_PUT_FRAME_TYPE,
  RELATIONSHIP_MAILBOX_DEPOSIT_FRAME_TYPE,
  RELATIONSHIP_MAILBOX_REQUEST_FRAME_TYPE,
  RELAY_PEER_REQUEST_FRAME_TYPE,
  SEARCH_REQUEST_FRAME_TYPE,
  SEARCH_RESPONSE_MESSAGE_TYPE,
  createAdmissionRequestBindingV2,
  createMatchOperationV2,
  createMatchNoticeMessage,
  createRelayLinkAcceptFrameV1,
  createRelayLinkAcceptV1,
  createRelayReplicaInventoryBatchResponseFrameV1,
  createRelayReplicaInventoryBatchResponseV1,
  createRelayReplicaInventoryResponseFrameV1,
  createRelayReplicaInventoryResponseV1,
  createRelayReplicaReconciliationResponseFrameV1,
  createRelayReplicaReconciliationResponseV1,
  createRelayReplicaReceiptFrameV1,
  createRelayReplicaReceiptV1,
  createRelayReplicaHandoffRequestFrameV1,
  createRelayReplicaHandoffRequestV1,
  decodeRelayReplicaHandoffResultV1,
  createRelayDescriptorV1,
  createRelayPeerResponseFrameV1,
  createRelayPeerResponseV1,
  createSearchResponsePayloadV2,
  decodeBase64,
  encryptMatchNotice,
  hammingSimilarity,
  isPublicationActive,
  isRelayLinkOpenActiveV1,
  isRelayReplicaInventoryBatchRequestActiveV1,
  isRelayReplicaInventoryRequestActiveV1,
  isRelayReplicaReconciliationReceiptV1,
  isRelayReplicaReconciliationRequestActiveV1,
  isRelayReplicaPutActiveV1,
  isRelayPeerRequestActiveV1,
  isSearchRequestActiveV2,
  parseMailboxDepositFrame,
  parseMailboxRequestFrame,
  parsePublicationOperationFrame,
  parseRelationshipMailboxDepositFrameV2,
  parseRelationshipMailboxRequestFrameV2,
  parseRelayLinkOpenFrameV1,
  parseRelayReplicaInventoryBatchRequestFrameV1,
  parseRelayReplicaInventoryRequestFrameV1,
  parseRelayReplicaReconciliationRequestFrameV1,
  parseRelayReplicaPutFrameV1,
  parseRelayReplicaHandoffResponseFrameV1,
  parseRelayPeerRequestFrameV1,
  parseSearchRequestFrameV2,
  parseMessage,
  verifyMessage,
  verifyRelayReplicaHandoffResponseV1,
  createMessage,
  serializeMessage,
  serializeRelayLinkAcceptFrameV1,
  serializeRelayReplicaInventoryBatchResponseFrameV1,
  serializeRelayReplicaInventoryResponseFrameV1,
  serializeRelayReplicaReconciliationResponseFrameV1,
  serializeRelayReplicaReceiptFrameV1,
  serializeRelayReplicaHandoffRequestFrameV1,
  serializeRelayPeerResponseFrameV1,
  verifyMatchOperationAgainstPublicationsV2,
  type AckPayload,
  type AdmissionCapabilityV2,
  type MailboxResponsePayload,
  type MailboxDepositRequest,
  type MailboxRequest,
  type PublicationOperation,
  type RelayAdmissionActionV2,
  type RelationshipMailboxDepositV2,
  type RelationshipMailboxRequestV2,
  type RelayDescriptorV1,
  type RelayContactHintV1,
  type RelayReachability,
  type RelayStorageCapacityV1,
  type RelayReplicaInventoryBatchRequestV1,
  type RelayReplicaInventoryRequestV1,
  type RelayReplicaInventoryRejectionReasonV1,
  type RelayReplicaReconciliationRequestV1,
  type RelayReplicaReconciliationResponseV1,
  type RelayReplicaReconciliationRejectionReasonV1,
  type RelayReplicaPutV1,
  type RelayReplicaReceiptV1,
  type RelayReplicaHandoffRequestV1,
  type RelayReplicaHandoffResponseV1,
  type RelayReplicaRejectionReasonV1,
} from '@resonance/core';
import { MatchingEngine, type MatchNotification } from './matching-engine.js';
import { RateLimiter } from './rate-limiter.js';
import { log } from './logger.js';
import { PublicationOperationStore, type PublicationApplyStatus } from './publication-store.js';
import { MailboxStore } from './mailbox-store.js';
import { MatchOperationStore } from './match-operation-store.js';
import { compactPublicationHistory } from './journal-compaction.js';
import { compactMailboxHistory } from './mailbox-journal-compaction.js';
import {
  RelayOperationLog,
  RelayJournalCapacityError,
  type RelayOperationLogEntry,
  type RelayReconciliationAdoptionLogEntry,
  type RelayPublicationOperationLogEntry,
  type RelayPublicationStorageAllocationLog,
} from './operation-log.js';
import { loadOrCreateRelayIdentity } from './relay-identity-store.js';
import {
  RelayDirectory,
  type RelayDescriptorObservation,
} from './relay-directory.js';
import {
  discoverRelayContactV1,
  type RelayContactDiscoveryOptions,
  type RelayContactDiscoveryResult,
} from './relay-discovery-client.js';
import {
  RelayLinkManager,
  type RelayLinkManagerOptions,
  type RelayLinkManagerStatus,
} from './relay-link-client.js';
import {
  DEFAULT_DESIRED_REPLICA_COUNT,
  DEFAULT_MINIMUM_HEALTHY_REPLICA_COUNT,
  ReplicaInventoryScheduler,
  ReplicaPlacementTracker,
  ReplicaReconciliationScheduler,
  isPermanentReplicaRejection,
  placementMatchesOperation,
  type ReplicaPlacementIntentV1,
  type ReplicaReconciliationRequirementV1,
  type ReplicaPlacementStatus,
} from './replica-placement.js';
import { prioritizeReplicaDiversity } from './replica-diversity.js';
import {
  FIRST_SEEN_TOMBSTONE_RESERVE_BYTES,
  ReplicaStorageLedger,
  publicationStorageAllocatableBytes,
  publicationStorageReservationBytes,
  type PublicationStorageAllocationPrincipal,
} from './replica-storage-ledger.js';
import type { AdmissionCapabilityVerifierV2 } from './admission.js';

export interface RelayDiscoveryConfig {
  endpoints: string[];
  reachability: RelayReachability;
  supportedGroups: string[];
  storage: RelayStorageCapacityV1;
  /** Maximum independently verified remote descriptors retained in memory. */
  maxKnownRelays?: number;
  /** Descriptor lifetime; capped by the core protocol at 24 hours. */
  descriptorLifetimeMs?: number;
}

export interface RelayConfig {
  port: number;
  host: string;
  persistDir: string;
  persistIntervalMs: number;
  matchThreshold: number;
  matchK: number;
  matchExpiryMs: number;
  maxPublishesPerMin: number;
  maxSearchesPerMin: number;
  authWindowMs: number;
  /** Enables the exact operational /stats endpoint; null disables it. */
  adminApiKey: string | null;
  maxAuthAttemptsPerMin: number;
  maxPeerRequestsPerMin: number;
  maxReplicaRequestsPerMin: number;
  maxInboundRelayLinks: number;
  relayLinkHeartbeatIntervalMs: number;
  relayLinkHeartbeatTimeoutMs: number;
  /** Desired number of configured, authenticated relay copies per publication. */
  desiredReplicaCount: number;
  /** Receipt-confirmed copy count required before a placement meets its quorum. */
  minimumHealthyReplicaCount: number;
  /** How often unfinished placements are retried over live configured links. */
  replicaRepairIntervalMs: number;
  /** Maximum age of a signed inventory answer before receipt-holders are checked again. */
  replicaInventoryIntervalMs: number;
  /** Offline grace period before a selected target may be replaced by a live spare. */
  replicaOfflineReplacementDelayMs: number;
  /** Maximum retained publication-state allocation this relay will accept. */
  publicationStorageQuotaBytes?: number;
  /** Maximum retained replica allocation attributed to any one relay identity. */
  maxReplicaStorageBytesPerRelay?: number;
  /** Retained encrypted envelopes and acknowledgement IDs this relay will hold. */
  maxMailboxStorageBytes?: number;
  /** Disk budget for the journal plus its temporary compaction copy. */
  maxJournalStorageBytes?: number;
  /** Omit to disable public relay discovery on this server. */
  relayDiscovery?: RelayDiscoveryConfig;
  /** Authenticated outbound relay links; requires relayDiscovery. */
  relayLinks?: Omit<RelayLinkManagerOptions, 'onEvent'>;
  /** When set, every v2 operation must present an anonymous one-use capability. */
  admissionVerifier?: AdmissionCapabilityVerifierV2;
}

export interface RelayStats {
  indexed_embeddings: number;
  stored_publications: number;
  active_publications: number;
  retained_tombstones: number;
  publication_storage_quota_bytes: number;
  publication_storage_withdrawal_reserve_bytes: number;
  publication_storage_reserved_bytes: number;
  publication_storage_available_bytes: number;
  replica_storage_reserved_bytes: number;
  replica_storage_relays: number;
  legacy_unattributed_storage_reserved_bytes: number;
  mailbox_envelopes: number;
  mailbox_storage_quota_bytes: number;
  mailbox_storage_reserved_bytes: number;
  journal_storage_quota_bytes: number;
  journal_bytes: number;
  stored_matches: number;
  journal_entries: number;
  connected_nodes: number;
  matches_today: number;
  known_relays: number;
  connected_relays: number;
  durability_receipts: number;
  placement_intents: number;
  minimum_confirmed_placements: number;
  uptime: number;
}

export interface RelayDiscoveryIngestResult extends RelayContactDiscoveryResult {
  observations: Array<{
    relayId: string;
    status: RelayDescriptorObservation;
  }>;
}

export interface RelayServer {
  start(): Promise<void>;
  stop(options?: { graceful?: boolean }): Promise<void>;
  getStats(): RelayStats;
  getRelayDescriptor(now?: number): RelayDescriptorV1 | null;
  observeRelayDescriptor(value: unknown, now?: number): RelayDescriptorObservation;
  getKnownRelayDescriptors(now?: number): RelayDescriptorV1[];
  discoverRelay(
    hint: RelayContactHintV1,
    options?: RelayContactDiscoveryOptions,
  ): Promise<RelayDiscoveryIngestResult>;
  getRelayLinkStatus(): RelayLinkManagerStatus & { inboundRelayIds: string[] };
  getReplicaReceipts(publicationId: string): RelayReplicaReceiptV1[];
  getReplicaPlacementStatus(publicationId: string): ReplicaPlacementStatus | undefined;
}

const DEFAULT_CONFIG: RelayConfig = {
  port: 9090,
  host: '0.0.0.0',
  persistDir: './data',
  persistIntervalMs: 60_000,
  matchThreshold: 0.70,  // Hamming similarity threshold for LSH matching
  matchK: 10,
  matchExpiryMs: 7 * 24 * 60 * 60 * 1000,
  maxPublishesPerMin: 10,
  maxSearchesPerMin: 30,
  authWindowMs: 30_000,
  adminApiKey: null,
  maxAuthAttemptsPerMin: 5,
  maxPeerRequestsPerMin: 60,
  maxReplicaRequestsPerMin: 120,
  maxInboundRelayLinks: 64,
  relayLinkHeartbeatIntervalMs: 30_000,
  relayLinkHeartbeatTimeoutMs: 90_000,
  desiredReplicaCount: DEFAULT_DESIRED_REPLICA_COUNT,
  minimumHealthyReplicaCount: DEFAULT_MINIMUM_HEALTHY_REPLICA_COUNT,
  replicaRepairIntervalMs: 30_000,
  replicaInventoryIntervalMs: 5 * 60_000,
  replicaOfflineReplacementDelayMs: 5 * 60_000,
  maxMailboxStorageBytes: 128 * 1024 * 1024,
};

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;
const MAX_SEEN_REPLICA_REQUESTS = 8_192;
const MAX_SEEN_REPLICA_REQUESTS_PER_RELAY = 256;
const MAX_REPLICA_INVENTORY_CHECKS_PER_REPAIR = 32;
const MAX_REPLICA_RECONCILIATIONS_PER_REPAIR = 16;
const MAX_REPLICA_HANDOFF_OPERATIONS = 64;
const REPLICA_HANDOFF_TIMEOUT_MS = 2_000;
const DEFAULT_PUBLICATION_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024;
const STORAGE_AVAILABILITY_GRANULARITY_BYTES = 64 * 1024;
const STORAGE_AVAILABILITY_REFRESH_MS = 60_000;
const MAX_MAILBOX_ENVELOPE_LIFETIME_MS = 30 * 24 * 60 * 60_000;
const JOURNAL_TERMINAL_RESERVE_BYTES = 1024;
const JOURNAL_ACK_RESERVE_BYTES = 2048;
type PublicationCommitStatus = PublicationApplyStatus | 'capacity-exhausted';

export function createRelayServer(config?: Partial<RelayConfig>): RelayServer {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const publicationStorageQuotaBytes = config?.publicationStorageQuotaBytes
    ?? cfg.relayDiscovery?.storage.availableBytes
    ?? DEFAULT_PUBLICATION_STORAGE_QUOTA_BYTES;
  const maxReplicaStorageBytesPerRelay = config?.maxReplicaStorageBytesPerRelay
    ?? publicationStorageQuotaBytes;
  const maxMailboxStorageBytes = cfg.maxMailboxStorageBytes ?? 128 * 1024 * 1024;
  const maxJournalStorageBytes = config?.maxJournalStorageBytes ?? 1024 * 1024 * 1024;
  const maxJournalFileBytes = Math.floor(maxJournalStorageBytes / 2);
  if (!Number.isSafeInteger(publicationStorageQuotaBytes) || publicationStorageQuotaBytes < 0
    || !Number.isSafeInteger(maxReplicaStorageBytesPerRelay)
    || maxReplicaStorageBytesPerRelay < 0
    || maxReplicaStorageBytesPerRelay > publicationStorageQuotaBytes) {
    throw new Error('Invalid publication or per-relay replica storage quota');
  }
  if (!Number.isSafeInteger(maxMailboxStorageBytes) || maxMailboxStorageBytes < 0) {
    throw new Error('Invalid mailbox storage quota');
  }
  if (!Number.isSafeInteger(maxJournalStorageBytes) || maxJournalStorageBytes < 0) {
    throw new Error('Invalid journal storage quota');
  }
  if (cfg.relayDiscovery
    && (publicationStorageQuotaBytes > cfg.relayDiscovery.storage.capacityBytes
      || publicationStorageQuotaBytes > cfg.relayDiscovery.storage.availableBytes)) {
    throw new Error('Publication storage quota cannot exceed advertised relay availability');
  }
  const allocatablePublicationStorageBytes = publicationStorageAllocatableBytes(
    publicationStorageQuotaBytes,
  );
  if (!Number.isSafeInteger(cfg.maxInboundRelayLinks)
    || cfg.maxInboundRelayLinks < 1
    || cfg.maxInboundRelayLinks > 4_096) {
    throw new Error('Inbound relay link limit must be between 1 and 4096');
  }
  if (!Number.isSafeInteger(cfg.maxReplicaRequestsPerMin)
    || cfg.maxReplicaRequestsPerMin < 1
    || cfg.maxReplicaRequestsPerMin > 1_000_000) {
    throw new Error('Replica request rate limit must be between 1 and 1000000');
  }
  if (!Number.isSafeInteger(cfg.desiredReplicaCount)
    || cfg.desiredReplicaCount < 1
    || cfg.desiredReplicaCount > DEFAULT_DESIRED_REPLICA_COUNT) {
    throw new Error(`Desired replica count must be between 1 and ${DEFAULT_DESIRED_REPLICA_COUNT}`);
  }
  if (!Number.isSafeInteger(cfg.minimumHealthyReplicaCount)
    || cfg.minimumHealthyReplicaCount < 1
    || cfg.minimumHealthyReplicaCount > cfg.desiredReplicaCount) {
    throw new Error('Minimum receipt-confirmed replica count must not exceed the desired count');
  }
  if (!Number.isSafeInteger(cfg.replicaRepairIntervalMs)
    || cfg.replicaRepairIntervalMs < 100
    || cfg.replicaRepairIntervalMs > MAX_TIMEOUT_DELAY_MS) {
    throw new Error('Replica repair interval must be between 100 ms and the maximum timer delay');
  }
  if (!Number.isSafeInteger(cfg.replicaInventoryIntervalMs)
    || cfg.replicaInventoryIntervalMs < 100
    || cfg.replicaInventoryIntervalMs > MAX_TIMEOUT_DELAY_MS) {
    throw new Error('Replica inventory interval must be between 100 ms and the maximum timer delay');
  }
  if (!Number.isSafeInteger(cfg.replicaOfflineReplacementDelayMs)
    || cfg.replicaOfflineReplacementDelayMs < 100
    || cfg.replicaOfflineReplacementDelayMs > MAX_TIMEOUT_DELAY_MS) {
    throw new Error('Replica offline replacement delay must be between 100 ms and the maximum timer delay');
  }
  if (!Number.isSafeInteger(cfg.relayLinkHeartbeatIntervalMs)
    || cfg.relayLinkHeartbeatIntervalMs < 25
    || cfg.relayLinkHeartbeatIntervalMs > MAX_TIMEOUT_DELAY_MS
    || !Number.isSafeInteger(cfg.relayLinkHeartbeatTimeoutMs)
    || cfg.relayLinkHeartbeatTimeoutMs <= cfg.relayLinkHeartbeatIntervalMs
    || cfg.relayLinkHeartbeatTimeoutMs > MAX_TIMEOUT_DELAY_MS) {
    throw new Error('Invalid inbound relay link heartbeat timing');
  }

  const engine = new MatchingEngine({ matchExpiryMs: cfg.matchExpiryMs, matchThreshold: cfg.matchThreshold });
  engine.initialize();
  const publicationStore = new PublicationOperationStore();
  const mailboxStore = new MailboxStore();
  const matchStore = new MatchOperationStore();
  function journalReserveAfter(entry: RelayOperationLogEntry): number {
    let livePublications = publicationStore.liveRecordCount;
    let pendingEnvelopes = mailboxStore.envelopeCount;
    if (entry.kind === 'publication') {
      const previous = publicationStore.get(entry.operation.publicationId);
      if (entry.operation.kind === 'publication' && !previous) livePublications++;
      if (entry.operation.kind === 'publication-tombstone' && previous?.kind === 'publication') {
        livePublications--;
      }
    } else if (entry.kind === 'reconciliation-adoption') {
      const previous = publicationStore.get(entry.rejection.publicationId);
      if (entry.response.operation?.kind === 'publication-tombstone'
        && previous?.kind === 'publication') livePublications--;
    } else if (entry.kind === 'match') {
      pendingEnvelopes += entry.envelopes.filter(envelope => (
        !mailboxStore.hasEnvelope(envelope.mailboxId, envelope.envelopeId)
        && !mailboxStore.hasAcknowledgedEnvelope(envelope.mailboxId, envelope.envelopeId)
      )).length;
    } else if (entry.kind === 'mailbox-deposit') {
      pendingEnvelopes++;
    } else if (entry.kind === 'mailbox-ack') {
      pendingEnvelopes -= mailboxStore.presentEnvelopeIds(
        entry.request.mailboxId, entry.request.envelopeIds,
      ).length;
    }
    const firstSeenTombstone = entry.kind === 'publication'
      && entry.operation.kind === 'publication-tombstone'
      && !publicationStore.get(entry.operation.publicationId);
    const reserveFirstSeen = publicationStore.firstSeenTombstoneCount === 0 && !firstSeenTombstone;
    return JOURNAL_TERMINAL_RESERVE_BYTES * (livePublications + (reserveFirstSeen ? 1 : 0))
      + JOURNAL_ACK_RESERVE_BYTES * pendingEnvelopes;
  }
  const operationLog = new RelayOperationLog(
    cfg.persistDir, maxJournalFileBytes, journalReserveAfter,
  );
  const relayIdentity = loadOrCreateRelayIdentity(cfg.persistDir);
  const replicaStorageLedger = new ReplicaStorageLedger();

  const rateLimiter = new RateLimiter({
    maxPublishesPerMin: cfg.maxPublishesPerMin,
    maxSearchesPerMin: cfg.maxSearchesPerMin,
    maxDiscoveriesPerMin: cfg.maxPeerRequestsPerMin,
    maxReplicasPerMin: cfg.maxReplicaRequestsPerMin,
  });

  const relayDirectory = new RelayDirectory(
    cfg.relayDiscovery?.maxKnownRelays ?? 256,
    relayIdentity.did,
  );

  const seenSearches = new Map<string, number>();
  const seenPeerRequests = new Map<string, number>();
  const seenRelayLinks = new Map<string, number>();
  const seenRelayReplicaRequests = new Map<string, {
    expiresAt: number;
    senderRelayId: string;
    requestSignature: string;
    response?: string;
  }>();
  const seenRelayReplicaRequestCounts = new Map<string, number>();
  const inboundRelayLinks = new Map<string, {
    socket: WebSocket;
    descriptor: RelayDescriptorV1;
    lastPongAt: number;
  }>();
  const pendingReplicaHandoffs = new Map<string, {
    request: RelayReplicaHandoffRequestV1;
    controllerRelayId: string;
    timer: ReturnType<typeof setTimeout>;
    resolve: (response: RelayReplicaHandoffResponseV1) => void;
    reject: (error: Error) => void;
  }>();
  let relayDescriptor: RelayDescriptorV1 | null = null;
  let relayDescriptorSequence = Date.now();
  let relayDescriptorStorageUpdatedAt = 0;

  let httpServer: Server;
  let wss: WebSocketServer;
  let publicationExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;
  let lastJournalCompactionCheckLength = 0;
  let mailboxExpiredSinceCompaction = 0;
  let lastCapacityCompactionLength = -1;
  let lastCapacityCompactionExpiryCount = -1;
  let relayLinkHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let replicaRepairTimer: ReturnType<typeof setInterval> | null = null;
  let replicaRepairWakeupTimer: ReturnType<typeof setTimeout> | null = null;
  let replicaRepairQueued = false;
  let replicaRepairRunning = false;
  let stopping = false;
  const replicaRefreshes = new Set<string>();
  const startTime = Date.now();
  const placementTracker = new ReplicaPlacementTracker(relayIdentity.did);
  const inventoryScheduler = new ReplicaInventoryScheduler();
  const reconciliationScheduler = new ReplicaReconciliationScheduler();
  const replicaTargetOfflineSince = new Map<string, number>();

  function advertisedRelayStorage(): RelayStorageCapacityV1 {
    const discovery = cfg.relayDiscovery;
    if (!discovery) throw new Error('Relay discovery is disabled');
    const journalReservedBytes = JOURNAL_TERMINAL_RESERVE_BYTES
      * (publicationStore.liveRecordCount + (publicationStore.firstSeenTombstoneCount === 0 ? 1 : 0))
      + JOURNAL_ACK_RESERVE_BYTES * mailboxStore.envelopeCount;
    const exactAvailableBytes = Math.max(0, Math.min(
      allocatablePublicationStorageBytes - replicaStorageLedger.reservedBytes,
      maxJournalFileBytes - operationLog.byteLength - journalReservedBytes,
    ));
    return {
      capacityBytes: discovery.storage.capacityBytes,
      // A public descriptor is a placement hint, not an activity feed. Round
      // downward so it never overclaims ordinary capacity while avoiding
      // per-publication byte deltas visible to descriptor pollers.
      availableBytes: Math.floor(exactAvailableBytes / STORAGE_AVAILABILITY_GRANULARITY_BYTES)
        * STORAGE_AVAILABILITY_GRANULARITY_BYTES,
    };
  }

  function getOwnRelayDescriptor(now = Date.now()): RelayDescriptorV1 | null {
    const discovery = cfg.relayDiscovery;
    if (!discovery) return null;
    const lifetimeMs = discovery.descriptorLifetimeMs ?? 60 * 60_000;
    const refreshWindowMs = Math.min(60_000, Math.floor(lifetimeMs / 4));
    const previousDescriptor = relayDescriptor;
    const currentStorage = advertisedRelayStorage();
    const storageChanged = previousDescriptor === null
      || previousDescriptor.storage.capacityBytes !== currentStorage.capacityBytes
      || previousDescriptor.storage.availableBytes !== currentStorage.availableBytes;
    const canRefreshStorage = previousDescriptor === null
      || now - relayDescriptorStorageUpdatedAt >= STORAGE_AVAILABILITY_REFRESH_MS;
    const storage = storageChanged && !canRefreshStorage
      ? previousDescriptor.storage
      : currentStorage;
    if (!previousDescriptor
      || (storageChanged && canRefreshStorage)
      || previousDescriptor.expiresAt - now <= refreshWindowMs) {
      relayDescriptorSequence = Math.max(relayDescriptorSequence + 1, now);
      relayDescriptor = createRelayDescriptorV1({
        sequence: relayDescriptorSequence,
        endpoints: discovery.endpoints,
        reachability: discovery.reachability,
        capabilities: {
          storesPublications: true,
          storesMailboxes: true,
          answersQueries: true,
          forwardsQueries: false,
          replicaExchange: true,
        },
        supportedGroups: discovery.supportedGroups,
        storage,
        issuedAt: now,
        expiresAt: now + lifetimeMs,
      }, relayIdentity);
      if (!previousDescriptor || (storageChanged && canRefreshStorage)) {
        relayDescriptorStorageUpdatedAt = now;
      }
    }
    return relayDescriptor;
  }

  // Validate discovery configuration before the server can accept traffic.
  if (cfg.relayDiscovery) getOwnRelayDescriptor(startTime);
  if (cfg.relayLinks && !cfg.relayDiscovery) {
    throw new Error('Outbound relay links require relay discovery configuration');
  }
  const outboundRelayLinks = cfg.relayLinks
    ? new RelayLinkManager(relayIdentity, () => {
      const descriptor = getOwnRelayDescriptor();
      if (!descriptor) throw new Error('Relay discovery is disabled');
      return descriptor;
    }, {
      ...cfg.relayLinks,
      onReplicaHandoffRequest: acceptReplicaHandoffRequest,
      onEvent(event) {
        log(event.kind === 'failed' ? 'warn' : 'info', `relay_link_${event.kind}`, {
          endpoint: event.endpoint,
          relayId: event.relayId,
          error: event.error,
        });
        if (event.relayId) {
          if (event.kind === 'connected') replicaTargetOfflineSince.delete(event.relayId);
          else if (event.kind === 'disconnected' && !replicaTargetOfflineSince.has(event.relayId)) {
            replicaTargetOfflineSince.set(event.relayId, Date.now());
          }
        }
        if (event.kind === 'connected' || event.kind === 'disconnected') queueReplicaRepair();
      },
    })
    : null;

  function connectedRelayIds(): string[] {
    const ids = new Set(inboundRelayLinks.keys());
    for (const relayId of outboundRelayLinks?.status().connectedRelayIds ?? []) ids.add(relayId);
    return [...ids].sort();
  }

  function localAllocation(): PublicationStorageAllocationPrincipal {
    return { allocationOrigin: 'local', allocationRelayId: relayIdentity.did };
  }

  function replicaAllocation(relayId: string): PublicationStorageAllocationPrincipal {
    return { allocationOrigin: 'replica', allocationRelayId: relayId };
  }

  function allocationForJournalEntry(
    entry: RelayPublicationOperationLogEntry,
  ): PublicationStorageAllocationPrincipal {
    if (entry.allocationOrigin === 'local' || entry.allocationOrigin === 'replica') {
      return {
        allocationOrigin: entry.allocationOrigin,
        allocationRelayId: entry.allocationRelayId,
      };
    }
    // Never infer old provenance from an identity, signature, or timing. Both
    // unmarked journal shapes and explicit legacy rows share one conservative
    // virtual inbound allocation until an operator performs a future rewrite.
    return { allocationOrigin: 'legacy' };
  }

  function publicationJournalEntry(
    operation: PublicationOperation,
    allocation: PublicationStorageAllocationPrincipal,
  ): RelayPublicationOperationLogEntry {
    if (allocation.allocationOrigin === 'legacy') {
      return { kind: 'publication', operation, allocationOrigin: 'legacy' };
    }
    return { kind: 'publication', operation, ...allocation };
  }

  function allocationForReconciliationEntry(
    entry: RelayReconciliationAdoptionLogEntry,
  ): PublicationStorageAllocationPrincipal {
    if (entry.allocation.allocationOrigin === 'legacy') return { allocationOrigin: 'legacy' };
    return {
      allocationOrigin: entry.allocation.allocationOrigin,
      allocationRelayId: entry.allocation.allocationRelayId,
    };
  }

  function journalAllocation(
    allocation: PublicationStorageAllocationPrincipal,
  ): RelayPublicationStorageAllocationLog {
    if (allocation.allocationOrigin === 'legacy') return { allocationOrigin: 'legacy' };
    return {
      allocationOrigin: allocation.allocationOrigin,
      allocationRelayId: allocation.allocationRelayId,
    };
  }

  function retainedPublicationAllocation(
    publicationId: string,
  ): PublicationStorageAllocationPrincipal | undefined {
    const allocation = replicaStorageLedger.allocationFor(publicationId);
    if (!allocation) return undefined;
    if (allocation.allocationOrigin === 'legacy') return { allocationOrigin: 'legacy' };
    return {
      allocationOrigin: allocation.allocationOrigin,
      allocationRelayId: allocation.allocationRelayId,
    };
  }

  function replayOperation(entry: RelayOperationLogEntry): void {
    // Placement state is replayed after every publication operation. An intent
    // may be durably appended immediately before a new publication operation;
    // if a crash prevents that operation from reaching the journal, its intent
    // is harmlessly ignored rather than becoming an orphaned repair job.
    if (entry.kind === 'placement-intent' || entry.kind === 'placement-receipt') return;
    if (entry.kind === 'publication') {
      const result = publicationStore.apply(entry.operation);
      if (result.status !== 'accepted' && result.status !== 'duplicate') {
        throw new Error(`Cannot replay publication operation: ${result.status}`);
      }
      if (result.status === 'accepted') {
        replicaStorageLedger.record(
          entry.operation.publicationId,
          publicationStorageReservationBytes(
            entry.operation,
            publicationStore.getRecord(entry.operation.publicationId),
          ),
          allocationForJournalEntry(entry),
        );
      }
      return;
    }
    if (entry.kind === 'reconciliation-adoption') {
      const operation = entry.response.operation;
      if (!operation) throw new Error('Cannot replay empty reconciliation adoption');
      const prior = publicationStore.get(entry.rejection.publicationId);
      if (!prior || !operationMatchesReplicaReceipt(prior, entry.rejection)) {
        throw new Error('Cannot replay reconciliation adoption without its quarantined predecessor');
      }
      const result = publicationStore.apply(operation);
      if (result.status !== 'accepted') {
        throw new Error(`Cannot replay reconciliation adoption: ${result.status}`);
      }
      replicaStorageLedger.record(
        operation.publicationId,
        publicationStorageReservationBytes(
          operation,
          publicationStore.getRecord(operation.publicationId),
        ),
        allocationForReconciliationEntry(entry),
      );
      return;
    }
    if (entry.kind === 'match') {
      const [firstReference, secondReference] = entry.operation.publications;
      const first = publicationStore.getRecord(firstReference.publicationId);
      const second = publicationStore.getRecord(secondReference.publicationId);
      if (!first || !second || !verifyMatchOperationAgainstPublicationsV2(
        entry.operation, first, second, cfg.matchThreshold,
      )) throw new Error('Cannot replay unauditable match operation');
      const result = matchStore.apply(entry.operation);
      if (result.status !== 'accepted' && result.status !== 'attestation' && result.status !== 'duplicate') {
        throw new Error(`Cannot replay match operation: ${result.status}`);
      }
      for (const envelope of entry.envelopes) mailboxStore.enqueue(envelope);
      return;
    }
    if (entry.kind === 'mailbox-deposit') {
      mailboxStore.enqueue(entry.request.envelope);
      return;
    }
    if (entry.kind === 'mailbox-ack') {
      mailboxStore.acknowledge(entry.request.mailboxId, entry.request.envelopeIds);
      return;
    }
    throw new Error('Cannot replay unknown operation log entry');
  }

  function replayPlacementOperation(entry: RelayOperationLogEntry): void {
    if (entry.kind === 'placement-intent') {
      const operation = publicationStore.get(entry.intent.publicationId);
      if (operation && placementMatchesOperation(entry.intent, operation)) {
        placementTracker.applyIntent(entry.intent);
      }
      return;
    }
    if (entry.kind === 'placement-receipt' && placementTracker.canRecordReceipt(entry.receipt)) {
      placementTracker.recordReceipt(entry.receipt);
    }
  }

  function maybeCompactJournal(minimumRedundantRecords: number, aggressive = false): void {
    const before = operationLog.length;
    const enoughExpiredMail = mailboxExpiredSinceCompaction >= 128
      || (before < 128 && mailboxExpiredSinceCompaction > 0);
    if (!aggressive && before - lastJournalCompactionCheckLength < minimumRedundantRecords
      && !enoughExpiredMail) return;
    const publicationsRetained = compactPublicationHistory(
      operationLog.entries, publicationStore, replicaStorageLedger,
    );
    const retained = compactMailboxHistory(publicationsRetained, mailboxStore);
    lastJournalCompactionCheckLength = before;
    const removed = before - retained.length;
    if (removed < (enoughExpiredMail ? 1 : minimumRedundantRecords)) return;
    // Avoid rewriting a large mixed journal for a tiny publication saving.
    if (!aggressive && minimumRedundantRecords > 1 && before >= 128
      && removed < 4096 && removed * 10 < before) return;
    try {
      operationLog.compact(retained);
    } catch (error) {
      if (error instanceof RelayJournalCapacityError) {
        log('warn', 'journal_compaction_deferred_for_capacity', { before, retained: retained.length });
        return;
      }
      throw error;
    }
    lastJournalCompactionCheckLength = operationLog.length;
    mailboxExpiredSinceCompaction = 0;
    log('info', 'journal_compacted', { before, after: operationLog.length, removed });
  }

  function appendOperation(entry: RelayOperationLogEntry): void {
    try {
      operationLog.append(entry);
    } catch (error) {
      if (!(error instanceof RelayJournalCapacityError)) throw error;
      if (operationLog.length !== lastCapacityCompactionLength
        || mailboxExpiredSinceCompaction !== lastCapacityCompactionExpiryCount) {
        try {
          maybeCompactJournal(1, true);
        } finally {
          lastCapacityCompactionLength = operationLog.length;
          lastCapacityCompactionExpiryCount = mailboxExpiredSinceCompaction;
        }
      }
      operationLog.append(entry);
    }
  }

  function commitMailboxDeposit(
    request: MailboxDepositRequest | RelationshipMailboxDepositV2,
  ): 'accepted' | 'duplicate' | 'expired' | 'capacity-exhausted' {
    const envelope = request.envelope;
    if (envelope.expiresAt <= Date.now()
      || envelope.expiresAt - envelope.createdAt > MAX_MAILBOX_ENVELOPE_LIFETIME_MS) return 'expired';
    if (mailboxStore.hasEnvelope(envelope.mailboxId, envelope.envelopeId)
      || mailboxStore.hasAcknowledgedEnvelope(envelope.mailboxId, envelope.envelopeId)) return 'duplicate';
    if (!mailboxStore.canEnqueue([envelope], maxMailboxStorageBytes)) return 'capacity-exhausted';
    try {
      appendOperation({ kind: 'mailbox-deposit', request });
    } catch (error) {
      if (error instanceof RelayJournalCapacityError) return 'capacity-exhausted';
      throw error;
    }
    return mailboxStore.enqueue(envelope);
  }

  function commitMailboxAcknowledgement(
    request: MailboxRequest | RelationshipMailboxRequestV2,
  ): number {
    const present = mailboxStore.presentEnvelopeIds(request.mailboxId, request.envelopeIds);
    if (present.length === 0) return 0;
    appendOperation({ kind: 'mailbox-ack', request });
    return mailboxStore.acknowledge(request.mailboxId, request.envelopeIds);
  }

  function commitMatch(notification: MatchNotification): void {
    const publisher = publicationStore.getRecord(notification.publisherDID);
    const matched = publicationStore.getRecord(notification.matchedDID);
    if (!publisher || !matched) return;
    const createdAt = Date.now();
    const expiresAt = Math.min(
      publisher.expiresAt, matched.expiresAt,
      createdAt + cfg.matchExpiryMs, createdAt + MAX_MAILBOX_ENVELOPE_LIFETIME_MS,
    );
    if (expiresAt <= createdAt) return;
    const operation = createMatchOperationV2(publisher, matched, relayIdentity, { createdAt, expiresAt });
    if (!verifyMatchOperationAgainstPublicationsV2(operation, publisher, matched, cfg.matchThreshold)) {
      throw new Error('Matching engine produced an invalid match decision');
    }
    if (matchStore.hasGeneration(operation)) return;

    const publisherEnvelope = encryptMatchNotice(
      createMatchNoticeMessage(publisher, matched, operation, relayIdentity),
      publisher,
    );
    const matchedEnvelope = encryptMatchNotice(
      createMatchNoticeMessage(matched, publisher, operation, relayIdentity),
      matched,
    );
    const envelopes = [publisherEnvelope, matchedEnvelope] as const;
    if (!mailboxStore.canEnqueue(envelopes, maxMailboxStorageBytes)) {
      log('warn', 'mailbox_capacity_exhausted', { matchId: operation.matchId });
      return;
    }

    // The signed match and both recipient deliveries are one durable fact.
    // Materialized views change only after the complete record reaches disk.
    try {
      appendOperation({ kind: 'match', operation, envelopes: [...envelopes] });
    } catch (error) {
      if (error instanceof RelayJournalCapacityError) {
        log('warn', 'journal_capacity_exhausted_for_match', { matchId: operation.matchId });
        return;
      }
      throw error;
    }
    const result = matchStore.apply(operation);
    if (result.status !== 'accepted') throw new Error(`Cannot apply committed match: ${result.status}`);
    mailboxStore.enqueue(publisherEnvelope);
    mailboxStore.enqueue(matchedEnvelope);
    log('info', 'mailbox_match', { matchId: operation.matchId, operationId: operation.operationId });
  }

  function canReservePublicationStorage(
    operation: PublicationOperation,
    allocation: PublicationStorageAllocationPrincipal,
  ): boolean {
    return replicaStorageLedger.canReserve(
      operation.publicationId,
      publicationStorageReservationBytes(
        operation,
        publicationStore.getRecord(operation.publicationId),
      ),
      allocation,
      publicationStorageQuotaBytes,
      maxReplicaStorageBytesPerRelay,
      usesFirstSeenTombstoneReserve(operation),
    );
  }

  function usesFirstSeenTombstoneReserve(operation: PublicationOperation): boolean {
    return operation.kind === 'publication-tombstone'
      && publicationStore.get(operation.publicationId) === undefined;
  }

  function commitPublicationOperation(
    operation: PublicationOperation,
    allocation: PublicationStorageAllocationPrincipal,
  ): PublicationCommitStatus {
    const result = publicationStore.evaluate(operation);
    if (result.status !== 'accepted' && result.status !== 'duplicate') return result.status;
    if (result.status === 'accepted') {
      const reservedBytes = publicationStorageReservationBytes(
        operation,
        publicationStore.getRecord(operation.publicationId),
      );
      if (!replicaStorageLedger.canReserve(
        operation.publicationId,
        reservedBytes,
        allocation,
        publicationStorageQuotaBytes,
        maxReplicaStorageBytesPerRelay,
        usesFirstSeenTombstoneReserve(operation),
      )) return 'capacity-exhausted';
      // Keep the original allocation principal durable. A later relay may
      // carry an update or tombstone, but must not inherit the prior source's
      // per-relay allocation when this journal is compacted.
      const currentAllocation = replicaStorageLedger.allocationFor(operation.publicationId);
      const effectiveAllocation = currentAllocation
        ? {
          allocationOrigin: currentAllocation.allocationOrigin,
          ...(currentAllocation.allocationOrigin === 'legacy'
            ? {}
            : { allocationRelayId: currentAllocation.allocationRelayId }),
        } as PublicationStorageAllocationPrincipal
        : allocation;
      try {
        appendOperation(publicationJournalEntry(operation, effectiveAllocation));
      } catch (error) {
        if (error instanceof RelayJournalCapacityError) return 'capacity-exhausted';
        throw error;
      }
      const applied = publicationStore.apply(operation);
      if (applied.status !== 'accepted') {
        throw new Error(`Cannot apply committed publication: ${applied.status}`);
      }
      replicaStorageLedger.record(operation.publicationId, reservedBytes, effectiveAllocation);
    }
    // Duplicate retries also repair a match whose atomic commit may have
    // failed after the publication itself reached disk.
    applyToMatchingIndex(operation);
    enforcePublicationExpiries();
    scheduleNextPublicationExpiry();
    return result.status;
  }

  function replicaPlacementPolicy(previous?: ReplicaPlacementIntentV1): {
    desiredReplicaCount: number;
    minimumHealthyReplicaCount: number;
  } {
    // An existing target remains a target for an update or tombstone. This
    // prevents a later operation from silently abandoning a relay that may
    // still hold an older, live version of the record.
    const desiredReplicaCount = Math.max(
      cfg.desiredReplicaCount,
      previous?.targetRelayIds.length ?? 0,
    );
    return {
      desiredReplicaCount,
      minimumHealthyReplicaCount: Math.min(cfg.minimumHealthyReplicaCount, desiredReplicaCount),
    };
  }

  function placementGroupId(operation: PublicationOperation): string | undefined {
    if (operation.kind === 'publication') return operation.groupId;
    return publicationStore.getRecord(operation.publicationId)?.groupId;
  }

  function selectReplicaTargets(
    operation: PublicationOperation,
    permanentlyRejectedRelayIds: readonly string[] = [],
    allowExpansion = true,
    additionallyRemovedRelayIds: readonly string[] = [],
  ): string[] {
    const current = placementTracker.getIntent(operation.publicationId);
    const policy = replicaPlacementPolicy(current);
    const permanentlyRejected = new Set(permanentlyRejectedRelayIds);
    const additionallyRemoved = new Set(additionallyRemovedRelayIds);
    const selected = new Set((current?.targetRelayIds ?? []).filter(relayId => (
      !permanentlyRejected.has(relayId) && !additionallyRemoved.has(relayId)
    )));
    const groupId = placementGroupId(operation);
    if (!outboundRelayLinks || !groupId || !allowExpansion) return [...selected].sort();

    const eligiblePeers = outboundRelayLinks.connectedPeers()
      // RelayLinkManager only opens configured or otherwise explicit contacts.
      // Discovery observations never cause a connection or a placement target.
      .filter(peer => peer.relayId !== relayIdentity.did
        && peer.descriptor.reachability === 'direct'
        && peer.descriptor.capabilities.storesPublications
        && peer.descriptor.capabilities.replicaExchange
        && peer.descriptor.storage.availableBytes > 0
        && peer.descriptor.supportedGroups.includes(groupId)
        && !permanentlyRejected.has(peer.relayId)
        && !additionallyRemoved.has(peer.relayId));
    const candidates = prioritizeReplicaDiversity(
      eligiblePeers.sort((first, second) => {
        const firstScore = replicaTargetScore(operation.publicationId, first.relayId);
        const secondScore = replicaTargetScore(operation.publicationId, second.relayId);
        if (firstScore !== secondScore) return firstScore < secondScore ? -1 : 1;
        if (first.relayId === second.relayId) return 0;
        return first.relayId < second.relayId ? -1 : 1;
      }),
      selected,
    );

    for (const candidate of candidates) {
      if (selected.size >= policy.desiredReplicaCount) break;
      selected.add(candidate.relayId);
    }
    return [...selected].sort();
  }

  function nextReplicaPlacementIntent(
    operation: PublicationOperation,
    {
      additionallyRejectedRelayIds = [],
      additionallyReconciliationRequiredRelayIds = [],
      additionallyReconciliationRequirements = [],
      additionallyRemovedRelayIds = [],
      allowExpansion = true,
    }: {
      additionallyRejectedRelayIds?: readonly string[];
      additionallyReconciliationRequiredRelayIds?: readonly string[];
      additionallyReconciliationRequirements?: readonly ReplicaReconciliationRequirementV1[];
      additionallyRemovedRelayIds?: readonly string[];
      allowExpansion?: boolean;
    } = {},
  ): ReplicaPlacementIntentV1 | undefined {
    if (!outboundRelayLinks) return undefined;
    const current = placementTracker.getIntent(operation.publicationId);
    const currentMatchesOperation = current !== undefined && placementMatchesOperation(current, operation);
    const currentRejections = currentMatchesOperation
      ? current.permanentlyRejectedRelayIds ?? []
      : [];
    const currentReconciliationRequired = currentMatchesOperation
      ? current.reconciliationRequiredRelayIds ?? []
      : [];
    const currentReconciliationRequirements = currentMatchesOperation
      ? current.reconciliationRequirements ?? []
      : [];
    const permanentlyRejectedRelayIds = [...new Set([
      ...currentRejections,
      ...additionallyRejectedRelayIds,
    ])].sort();
    const reconciliationRequiredRelayIds = [...new Set([
      ...currentReconciliationRequired,
      ...additionallyReconciliationRequiredRelayIds,
      ...additionallyReconciliationRequirements.map(requirement => requirement.relayId),
    ])].sort();
    const requirementsByRelayId = new Map<string, ReplicaReconciliationRequirementV1>();
    for (const requirement of [
      ...currentReconciliationRequirements,
      ...additionallyReconciliationRequirements,
    ]) {
      requirementsByRelayId.set(requirement.relayId, requirement);
    }
    const reconciliationRequirements = [...requirementsByRelayId.values()]
      .sort((first, second) => first.relayId.localeCompare(second.relayId));
    const policy = replicaPlacementPolicy(current);
    // Once a target signals a divergent or incompatible state, preserve the
    // existing exact-operation set and stop all automatic expansion. A later
    // local update/tombstone starts a fresh intent and clears this fence.
    const targetRelayIds = currentMatchesOperation && reconciliationRequiredRelayIds.length > 0
      ? current.targetRelayIds
      : selectReplicaTargets(
        operation,
        permanentlyRejectedRelayIds,
        allowExpansion && reconciliationRequiredRelayIds.length === 0,
        additionallyRemovedRelayIds,
      );
    return placementTracker.nextIntent(
      operation,
      targetRelayIds,
      policy,
      Date.now(),
      permanentlyRejectedRelayIds,
      reconciliationRequiredRelayIds,
      reconciliationRequirements,
    );
  }

  function replacePermanentlyRejectedReplicaTarget(receipt: RelayReplicaReceiptV1): boolean {
    if (!isPermanentReplicaRejection(receipt)
      || !placementTracker.canRecordPermanentRejection(receipt)) return false;
    const operation = publicationStore.get(receipt.publicationId);
    if (!operation) return false;
    // Do not select a replacement until every pending existing target in this
    // batch has answered. A later stale/terminal receipt must be able to fence
    // this operation before a newly selected relay ever receives it.
    const intent = nextReplicaPlacementIntent(operation, {
      additionallyRejectedRelayIds: [receipt.responderRelayId],
      allowExpansion: false,
    });
    if (!intent) return false;
    appendOperation({ kind: 'placement-intent', intent });
    if (!placementTracker.applyIntent(intent)) {
      throw new Error('Cannot apply permanent replica refusal placement intent');
    }
    log('warn', 'replica_target_rejected', {
      publicationId: receipt.publicationId,
      relayId: receipt.responderRelayId,
      reason: receipt.reason,
    });
    return true;
  }

  function replaceStaleOfflineReplicaTarget(
    operation: PublicationOperation,
    now = Date.now(),
  ): boolean {
    const current = placementTracker.getIntent(operation.publicationId);
    if (!current || !placementMatchesOperation(current, operation)
      || (current.reconciliationRequiredRelayIds ?? []).length > 0) return false;
    const connected = new Set(outboundRelayLinks?.status().connectedRelayIds ?? []);
    for (const relayId of current.targetRelayIds) {
      if (connected.has(relayId)) continue;
      const offlineSince = replicaTargetOfflineSince.get(relayId) ?? startTime;
      if (now - offlineSince < cfg.replicaOfflineReplacementDelayMs) continue;
      const next = nextReplicaPlacementIntent(operation, {
        additionallyRemovedRelayIds: [relayId],
        allowExpansion: true,
      });
      // Do not discard durable evidence merely because a target is offline.
      // Rotate only when live eligible spares keep the placement at least as large.
      if (!next
        || next.targetRelayIds.includes(relayId)
        || next.targetRelayIds.length < current.targetRelayIds.length) continue;
      appendOperation({ kind: 'placement-intent', intent: next });
      if (!placementTracker.applyIntent(next)) {
        throw new Error('Cannot apply offline replica replacement intent');
      }
      log('warn', 'replica_offline_target_replaced', {
        publicationId: operation.publicationId,
        relayId,
        offlineMs: now - offlineSince,
      });
      queueReplicaRepair();
      return true;
    }
    return false;
  }

  async function acceptReplicaHandoffRequest(
    request: RelayReplicaHandoffRequestV1,
  ): Promise<{ accepted: boolean[]; safeElsewhere: boolean[] }> {
    if (stopping || !rateLimiter.checkMany(
      `relay:${request.retiringRelayId}`,
      'replica',
      request.operations.length,
    )) {
      return {
        accepted: request.operations.map(() => false),
        safeElsewhere: request.operations.map(() => false),
      };
    }
    const accepted: boolean[] = [];
    const safeElsewhere: boolean[] = [];
    for (const reference of request.operations) {
      const operation = publicationStore.get(reference.publicationId);
      const intent = placementTracker.getIntent(reference.publicationId);
      const receipts = placementTracker.receiptsFor(reference.publicationId);
      const retiringReceipt = receipts.find(receipt => (
        receipt.responderRelayId === request.retiringRelayId
        && receipt.operationSequence === reference.operationSequence
        && receipt.operationKind === reference.operationKind
        && receipt.operationSignature === reference.operationSignature
      ));
      const exact = operation !== undefined
        && operation.sequence === reference.operationSequence
        && operation.kind === reference.operationKind
        && operation.signature === reference.operationSignature;
      if (!exact || !intent || !placementMatchesOperation(intent, operation)
        || (intent.reconciliationRequiredRelayIds ?? []).length > 0
        || !intent.targetRelayIds.includes(request.retiringRelayId)
        || !retiringReceipt) {
        accepted.push(false);
        safeElsewhere.push(false);
        continue;
      }
      const alreadySafe = receipts.filter(receipt => (
        receipt.responderRelayId !== request.retiringRelayId
        && intent.targetRelayIds.includes(receipt.responderRelayId)
      )).length >= intent.minimumHealthyReplicaCount;
      const next = nextReplicaPlacementIntent(operation, {
        additionallyRejectedRelayIds: [request.retiringRelayId],
        allowExpansion: true,
      });
      if (!next || next.targetRelayIds.includes(request.retiringRelayId)) {
        accepted.push(false);
        safeElsewhere.push(false);
        continue;
      }
      appendOperation({ kind: 'placement-intent', intent: next });
      if (!placementTracker.applyIntent(next)) {
        throw new Error('Cannot apply graceful replica handoff placement intent');
      }
      accepted.push(true);
      safeElsewhere.push(alreadySafe);
      log('info', 'replica_handoff_accepted', {
        publicationId: reference.publicationId,
        retiringRelayId: request.retiringRelayId,
        safeElsewhere: alreadySafe,
      });
    }
    if (accepted.some(Boolean)) queueReplicaRepair();
    return { accepted, safeElsewhere };
  }

  function quarantineReplicaPlacement(receipt: RelayReplicaReceiptV1): boolean {
    if (!placementTracker.canRecordReconciliationRequirement(receipt)) return false;
    const operation = publicationStore.get(receipt.publicationId);
    if (!operation) return false;
    const intent = nextReplicaPlacementIntent(operation, {
      additionallyReconciliationRequiredRelayIds: [receipt.responderRelayId],
      additionallyReconciliationRequirements: isRelayReplicaReconciliationReceiptV1(receipt)
        ? [{ relayId: receipt.responderRelayId, rejection: receipt }]
        : [],
      allowExpansion: false,
    });
    if (!intent) return false;
    appendOperation({ kind: 'placement-intent', intent });
    if (!placementTracker.applyIntent(intent)) {
      throw new Error('Cannot apply reconciliation-required replica placement intent');
    }
    log('warn', 'replica_placement_quarantined', {
      publicationId: receipt.publicationId,
      relayId: receipt.responderRelayId,
      reason: receipt.reason,
    });
    return true;
  }

  function commitLocalPublicationOperation(operation: PublicationOperation): PublicationCommitStatus {
    const evaluation = publicationStore.evaluate(operation);
    if (evaluation.status !== 'accepted' && evaluation.status !== 'duplicate') return evaluation.status;
    if (evaluation.status === 'accepted' && !canReservePublicationStorage(operation, localAllocation())) {
      return 'capacity-exhausted';
    }

    // Intent is journaled before a new operation. If the process dies between
    // these two writes, replay ignores the unmatched intent; if both succeed,
    // repair can resume after restart without a client resubmission.
    const intent = nextReplicaPlacementIntent(operation);
    if (intent) appendOperation({ kind: 'placement-intent', intent });

    const status = commitPublicationOperation(operation, localAllocation());
    if ((status === 'accepted' || status === 'duplicate') && intent
      && !placementTracker.applyIntent(intent)) {
      throw new Error('Cannot apply committed replica placement intent');
    }
    // A duplicate client submission is an explicit idempotent retry. Refresh
    // all selected targets so a lost response can become an `already-stored`
    // receipt without turning the periodic repair loop into continuous probes.
    if (status === 'duplicate') replicaRefreshes.add(operation.publicationId);
    if (status === 'accepted' || status === 'duplicate') queueReplicaRepair();
    return status;
  }

  function queueReplicaRepair(): void {
    if (!outboundRelayLinks) return;
    replicaRepairQueued = true;
    if (replicaRepairRunning || replicaRepairWakeupTimer) return;
    replicaRepairWakeupTimer = setTimeout(() => {
      replicaRepairWakeupTimer = null;
      void repairReplicaPlacements().catch(error => {
        log('warn', 'replica_repair_failed', { error: String(error) });
      });
    }, 0);
    replicaRepairWakeupTimer.unref?.();
  }

  function operationMatchesReplicaReceipt(
    operation: PublicationOperation,
    receipt: RelayReplicaReceiptV1,
  ): boolean {
    return operation.publicationId === receipt.publicationId
      && operation.sequence === receipt.operationSequence
      && operation.kind === receipt.operationKind
      && operation.signature === receipt.operationSignature;
  }

  function reconciliationRequirementForResponse(
    response: RelayReplicaReconciliationResponseV1,
  ): ReplicaReconciliationRequirementV1 | undefined {
    if (response.senderRelayId !== relayIdentity.did) return undefined;
    const intent = placementTracker.getIntent(response.publicationId);
    const operation = publicationStore.get(response.publicationId);
    if (!intent || !operation || !placementMatchesOperation(intent, operation)) return undefined;
    return (intent.reconciliationRequirements ?? []).find(requirement => (
      requirement.relayId === response.responderRelayId
      && requirement.rejection.senderRelayId === response.senderRelayId
      && requirement.rejection.responderRelayId === response.responderRelayId
      && requirement.rejection.requestId === response.rejectionRequestId
      && requirement.rejection.signature === response.rejectionSignature
      && operationMatchesReplicaReceipt(operation, requirement.rejection)
    ));
  }

  function selectReconciledOperation(
    candidates: Array<{
      requirement: ReplicaReconciliationRequirementV1;
      response: RelayReplicaReconciliationResponseV1;
    }>,
  ): {
    requirement: ReplicaReconciliationRequirementV1;
    response: RelayReplicaReconciliationResponseV1;
  } | undefined {
    const withOperation = candidates.filter((candidate): candidate is {
      requirement: ReplicaReconciliationRequirementV1;
      response: RelayReplicaReconciliationResponseV1 & { operation: PublicationOperation };
    } => candidate.response.status === 'operation' && candidate.response.operation !== null);
    if (withOperation.length === 0) return undefined;

    // A valid owner-signed withdrawal is absorbing, so it wins over every
    // live response without selecting a winner between live equivocations.
    const tombstones = withOperation.filter(candidate => (
      candidate.response.operation.kind === 'publication-tombstone'
    ));
    if (tombstones.length > 0) {
      return tombstones.reduce((selected, candidate) => (
        candidate.response.operation.sequence > selected.response.operation.sequence
          ? candidate
          : selected
      ));
    }

    const highestSequence = Math.max(...withOperation.map(candidate => candidate.response.operation.sequence));
    const highest = withOperation.filter(candidate => (
      candidate.response.operation.sequence === highestSequence
    ));
    const signatures = new Set(highest.map(candidate => candidate.response.operation.signature));
    if (signatures.size !== 1) return undefined;
    return highest[0];
  }

  function commitReconciledPublicationOperation(
    requirement: ReplicaReconciliationRequirementV1,
    response: RelayReplicaReconciliationResponseV1,
  ): boolean {
    const operation = response.operation;
    if (!operation || response.status !== 'operation') return false;
    const current = publicationStore.get(response.publicationId);
    const currentRequirement = reconciliationRequirementForResponse(response);
    if (!current || !currentRequirement
      || currentRequirement.relayId !== requirement.relayId
      || currentRequirement.rejection.signature !== requirement.rejection.signature) return false;
    if (operation.kind === 'publication' && !isPublicationActive(operation, Date.now())) return false;

    const evaluation = publicationStore.evaluate(operation);
    if (evaluation.status !== 'accepted') return false;
    const allocation = retainedPublicationAllocation(operation.publicationId);
    if (!allocation) return false;
    const reservedBytes = publicationStorageReservationBytes(
      operation,
      publicationStore.getRecord(operation.publicationId),
    );
    if (!replicaStorageLedger.canReserve(
      operation.publicationId,
      reservedBytes,
      allocation,
      publicationStorageQuotaBytes,
      maxReplicaStorageBytesPerRelay,
      false,
    )) return false;

    const entry: RelayReconciliationAdoptionLogEntry = {
      kind: 'reconciliation-adoption',
      rejection: requirement.rejection,
      response,
      allocation: journalAllocation(allocation),
    };
    appendOperation(entry);
    const applied = publicationStore.apply(operation);
    if (applied.status !== 'accepted') {
      throw new Error(`Cannot apply reconciled publication: ${applied.status}`);
    }
    replicaStorageLedger.record(operation.publicationId, reservedBytes, allocation);
    applyToMatchingIndex(operation);
    enforcePublicationExpiries();
    scheduleNextPublicationExpiry();
    if (!placementTracker.retireIntentIfMatches(current)) {
      throw new Error('Cannot retire reconciled replica placement intent');
    }
    replicaRefreshes.delete(operation.publicationId);
    log('info', 'replica_reconciliation_adopted', {
      publicationId: operation.publicationId,
      relayId: response.responderRelayId,
      kind: operation.kind,
      sequence: operation.sequence,
    });
    return true;
  }

  function reconcileReplicaResponses(
    responses: readonly RelayReplicaReconciliationResponseV1[],
  ): void {
    const candidatesByPublication = new Map<string, Array<{
      requirement: ReplicaReconciliationRequirementV1;
      response: RelayReplicaReconciliationResponseV1;
    }>>();
    for (const response of responses) {
      const requirement = reconciliationRequirementForResponse(response);
      if (!requirement) continue;
      log(response.status === 'rejected' ? 'warn' : 'info', 'replica_reconciliation', {
        publicationId: response.publicationId,
        relayId: response.responderRelayId,
        status: response.status,
        reason: response.reason,
      });
      if (response.status !== 'operation' || response.operation === null) continue;
      const candidates = candidatesByPublication.get(response.publicationId);
      const candidate = { requirement, response };
      if (candidates) candidates.push(candidate);
      else candidatesByPublication.set(response.publicationId, [candidate]);
    }
    for (const candidates of candidatesByPublication.values()) {
      const selected = selectReconciledOperation(candidates);
      if (selected) commitReconciledPublicationOperation(selected.requirement, selected.response);
    }
  }

  async function repairReplicaPlacements(): Promise<void> {
    if (!outboundRelayLinks || replicaRepairRunning) return;
    replicaRepairRunning = true;
    try {
      while (replicaRepairQueued) {
        replicaRepairQueued = false;
        await repairReplicaPlacementsOnce();
      }
    } finally {
      replicaRepairRunning = false;
    }
  }

  async function repairReplicaPlacementsOnce(): Promise<void> {
    if (!outboundRelayLinks) return;
    const repairOperations: PublicationOperation[] = [];
    const reconciliationRequirements: ReplicaReconciliationRequirementV1[] = [];
    for (const persistedIntent of placementTracker.listIntents()) {
      const operation = publicationStore.get(persistedIntent.publicationId);
      if (!operation || !placementMatchesOperation(persistedIntent, operation)) continue;
      if (operation.kind === 'publication' && !isPublicationActive(operation, Date.now())) continue;
      replaceStaleOfflineReplicaTarget(operation);
      const currentIntent = placementTracker.getIntent(operation.publicationId);
      if (!currentIntent || !placementMatchesOperation(currentIntent, operation)) continue;
      if ((currentIntent.reconciliationRequiredRelayIds ?? []).length > 0) {
        replicaRefreshes.delete(operation.publicationId);
        reconciliationRequirements.push(
          ...placementTracker.reconciliationRequirementsFor(operation.publicationId),
        );
        continue;
      }
      repairOperations.push(operation);
    }

    const reconciliationBatch = reconciliationScheduler.take(
      reconciliationRequirements,
      MAX_REPLICA_RECONCILIATIONS_PER_REPAIR,
    );
    const reconciliationResponses = await outboundRelayLinks.reconcileReplicaReceipts(
      reconciliationBatch.map(requirement => requirement.rejection),
    );
    reconcileReplicaResponses(reconciliationResponses);

    const dueInventoryReceipts = repairOperations.flatMap(operation => (
      placementTracker.inventoryDueReceipts(operation.publicationId, cfg.replicaInventoryIntervalMs)
    ));
    const inventoryBatch = inventoryScheduler.take(
      dueInventoryReceipts,
      MAX_REPLICA_INVENTORY_CHECKS_PER_REPAIR,
    );
    const inventoryResponses = await outboundRelayLinks.checkReplicaReceiptBatches(inventoryBatch);
    for (const response of inventoryResponses) {
      const recordedCount = placementTracker.recordInventoryBatchResponse(response);
      log(response.status === 'rejected' ? 'warn' : 'info', 'replica_inventory_batch', {
        relayId: response.responderRelayId,
        status: response.status,
        reason: response.reason,
        receiptCount: response.receiptSignatures.length,
        recordedCount,
      });
    }

    for (const operation of repairOperations) {
      const status = placementTracker.statusFor(operation.publicationId);
      // Inventory checks await network I/O. A local update or tombstone may
      // have committed while they were in flight; never send the older queued
      // operation to targets chosen for that newer placement generation.
      if (!status || !placementMatchesOperation(status.intent, operation)) continue;
      if (status.reconciliationRequired) {
        replicaRefreshes.delete(operation.publicationId);
        continue;
      }
      const refresh = replicaRefreshes.delete(operation.publicationId);
      const targetRelayIds = refresh ? status.intent.targetRelayIds : status.pendingRelayIds;
      if (targetRelayIds.length === 0) continue;
      const receipts = await outboundRelayLinks.replicateTo(operation, targetRelayIds);
      for (const receipt of receipts) {
        const quarantined = quarantineReplicaPlacement(receipt);
        const replaced = quarantined ? false : replacePermanentlyRejectedReplicaTarget(receipt);
        if (placementTracker.canRecordReceipt(receipt)) {
          appendOperation({ kind: 'placement-receipt', receipt });
          if (!placementTracker.recordReceipt(receipt)) {
            throw new Error('Cannot apply committed replica durability receipt');
          }
        }
        log(receipt.status === 'rejected' ? 'warn' : 'info', 'replica_receipt', {
          publicationId: receipt.publicationId,
          relayId: receipt.responderRelayId,
          status: receipt.status,
          reason: receipt.reason,
        });
        if (quarantined || replaced) queueReplicaRepair();
      }
    }

    // Process existing targets before expansion so a signed stale/terminal
    // response in this pass can fence the operation before a fresh volunteer
    // receives it. A missing response remains an availability failure rather
    // than evidence of divergent state, so the existing target stays pending
    // while another live volunteer can still fill an underfull placement.
    for (const operation of repairOperations) {
      const status = placementTracker.statusFor(operation.publicationId);
      if (!status || !placementMatchesOperation(status.intent, operation)
        || status.reconciliationRequired) continue;
      const expandedIntent = nextReplicaPlacementIntent(operation);
      if (!expandedIntent) continue;
      appendOperation({ kind: 'placement-intent', intent: expandedIntent });
      if (!placementTracker.applyIntent(expandedIntent)) {
        throw new Error('Cannot apply expanded replica placement intent');
      }
      queueReplicaRepair();
    }
  }

  function applyToMatchingIndex(operation: PublicationOperation, trackStats = true): void {
    if (operation.kind === 'publication-tombstone') {
      engine.withdraw(operation.publicationId, operation.publicationId);
      return;
    }
    const notifications = engine.replaceAndMatch(
      decodeBase64(operation.fingerprint.value),
      {
        did: operation.publicationId,
        itemId: operation.publicationId,
        itemType: operation.itemType,
        scope: `${operation.groupId}\n${operation.fingerprint.algorithm}:${operation.fingerprint.bits}:${operation.fingerprint.epoch}`,
        expiresAt: operation.expiresAt,
      },
      cfg.matchK,
      cfg.matchThreshold,
      false,
      trackStats,
    );
    for (const notification of notifications) commitMatch(notification);
  }

  function enforcePublicationExpiries(now = Date.now()): number {
    const removed = engine.expirePublications(now);
    const removedEnvelopes = mailboxStore.purgeExpired(now);
    if (removed > 0) log('info', 'publications_expired', { count: removed });
    if (removedEnvelopes > 0) {
      mailboxExpiredSinceCompaction += removedEnvelopes;
      log('info', 'mailbox_entries_expired', { count: removedEnvelopes });
    }
    return removed;
  }

  function scheduleNextPublicationExpiry(now = Date.now()): void {
    if (publicationExpiryTimer) clearTimeout(publicationExpiryTimer);
    publicationExpiryTimer = null;
    const expiresAt = publicationStore.nextExpiryAfter(now);
    if (expiresAt === undefined) return;
    const delay = Math.max(1, Math.min(expiresAt - now, MAX_TIMEOUT_DELAY_MS));
    publicationExpiryTimer = setTimeout(() => {
      publicationExpiryTimer = null;
      enforcePublicationExpiries();
      scheduleNextPublicationExpiry();
    }, delay);
    publicationExpiryTimer.unref?.();
  }

  function replicaPlacementMetrics(): {
    intentCount: number;
    receiptCount: number;
    minimumConfirmedCount: number;
  } {
    let receiptCount = 0;
    let minimumConfirmedCount = 0;
    const intents = placementTracker.listIntents();
    for (const intent of intents) {
      const status = placementTracker.statusFor(intent.publicationId);
      if (!status) continue;
      receiptCount += status.confirmedReplicaCount;
      if (status.minimumConfirmed) minimumConfirmedCount++;
    }
    return { intentCount: intents.length, receiptCount, minimumConfirmedCount };
  }

  function handleHttpRequest(req: { url?: string; method?: string }, res: {
    writeHead: (code: number, headers?: Record<string, string>) => void;
    end: (body?: string) => void;
  }): void {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/relay-descriptor' && req.method === 'GET') {
      const descriptor = getOwnRelayDescriptor();
      if (!descriptor) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'relay_discovery_disabled' }));
        return;
      }
      res.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify(descriptor));
      return;
    }
    if (req.url?.startsWith('/stats') && req.method === 'GET') {
      // These metrics include exact publication and capacity activity. Keep
      // the programmatic getStats() API for an embedding operator, but never
      // expose this HTTP endpoint without an explicit administrator key.
      if (!cfg.adminApiKey) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'stats_disabled' }));
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      if (url.searchParams.get('key') !== cfg.adminApiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      enforcePublicationExpiries();
      const stats = engine.getStats();
      const placement = replicaPlacementMetrics();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        indexed_embeddings: stats.total,
        stored_publications: publicationStore.size,
        active_publications: publicationStore.activeRecords().length,
        retained_tombstones: publicationStore.tombstoneCount,
        publication_storage_quota_bytes: publicationStorageQuotaBytes,
        publication_storage_withdrawal_reserve_bytes: Math.min(
          FIRST_SEEN_TOMBSTONE_RESERVE_BYTES,
          publicationStorageQuotaBytes,
        ),
        publication_storage_reserved_bytes: replicaStorageLedger.reservedBytes,
        publication_storage_available_bytes: Math.max(
          0,
          allocatablePublicationStorageBytes - replicaStorageLedger.reservedBytes,
        ),
        replica_storage_reserved_bytes: replicaStorageLedger.replicaReservedBytes,
        replica_storage_relays: replicaStorageLedger.replicaRelayCount,
        legacy_unattributed_storage_reserved_bytes:
          replicaStorageLedger.legacyUnattributedReservedBytes,
        mailbox_envelopes: mailboxStore.envelopeCount,
        mailbox_storage_quota_bytes: maxMailboxStorageBytes,
        mailbox_storage_reserved_bytes: mailboxStore.retainedBytes,
        journal_storage_quota_bytes: maxJournalStorageBytes,
        journal_bytes: operationLog.byteLength,
        stored_matches: matchStore.size,
        journal_entries: operationLog.length,
        connected_nodes: 0,
        matches_today: stats.matchesToday,
        known_relays: relayDirectory.size(),
        connected_relays: connectedRelayIds().length,
        durability_receipts: placement.receiptCount,
        placement_intents: placement.intentCount,
        minimum_confirmed_placements: placement.minimumConfirmedCount,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  }

  function createReplicaReceiptResponse(
    request: RelayReplicaPutV1,
    result: {
      status: 'stored' | 'already-stored' | 'rejected';
      reason?: RelayReplicaRejectionReasonV1;
    },
  ): string | undefined {
    try {
      const receipt = createRelayReplicaReceiptV1(request, relayIdentity, result);
      return serializeRelayReplicaReceiptFrameV1(createRelayReplicaReceiptFrameV1(receipt));
    } catch (error) {
      log('warn', 'replica_receipt_failed', {
        publicationId: request.operation.publicationId,
        error: String(error),
      });
      return undefined;
    }
  }

  function sendReplicaReceiptResponse(ws: WebSocket, response: string): void {
    ws.send(response, error => {
      if (error) ws.terminate();
    });
  }

  function sendReplicaReceipt(
    ws: WebSocket,
    request: RelayReplicaPutV1,
    result: {
      status: 'stored' | 'already-stored' | 'rejected';
      reason?: RelayReplicaRejectionReasonV1;
    },
  ): string | undefined {
    const response = createReplicaReceiptResponse(request, result);
    if (response) sendReplicaReceiptResponse(ws, response);
    else ws.terminate();
    return response;
  }

  function replicaReplayKey(
    kind: 'placement' | 'inventory' | 'inventory-batch' | 'reconciliation',
    requestId: string,
  ): string {
    return `${kind}:${requestId}`;
  }

  function pruneSeenRelayReplicaRequests(now = Date.now()): void {
    for (const [requestId, request] of seenRelayReplicaRequests) {
      if (request.expiresAt > now) continue;
      seenRelayReplicaRequests.delete(requestId);
      const current = seenRelayReplicaRequestCounts.get(request.senderRelayId) ?? 0;
      if (current <= 1) seenRelayReplicaRequestCounts.delete(request.senderRelayId);
      else seenRelayReplicaRequestCounts.set(request.senderRelayId, current - 1);
    }
  }

  function reserveSeenRelayReplicaRequest(
    kind: 'placement' | 'inventory' | 'inventory-batch' | 'reconciliation',
    request:
      | RelayReplicaPutV1
      | RelayReplicaInventoryRequestV1
      | RelayReplicaInventoryBatchRequestV1
      | RelayReplicaReconciliationRequestV1,
  ): {
    expiresAt: number;
    senderRelayId: string;
    requestSignature: string;
    response?: string;
  } | undefined {
    if (seenRelayReplicaRequests.size >= MAX_SEEN_REPLICA_REQUESTS
      || (seenRelayReplicaRequestCounts.get(request.senderRelayId) ?? 0)
        >= MAX_SEEN_REPLICA_REQUESTS_PER_RELAY) return undefined;
    const entry = {
      expiresAt: request.expiresAt,
      senderRelayId: request.senderRelayId,
      requestSignature: request.signature,
    };
    seenRelayReplicaRequests.set(replicaReplayKey(kind, request.requestId), entry);
    seenRelayReplicaRequestCounts.set(
      request.senderRelayId,
      (seenRelayReplicaRequestCounts.get(request.senderRelayId) ?? 0) + 1,
    );
    return entry;
  }

  function handleReplicaPlacement(
    ws: WebSocket,
    raw: string,
    linkedRelayId: string,
  ): void {
    let frame: ReturnType<typeof parseRelayReplicaPutFrameV1>;
    try {
      frame = parseRelayReplicaPutFrameV1(raw);
    } catch {
      ws.close(4000, 'invalid_replica_placement');
      return;
    }
    const request = frame.request;
    const now = Date.now();
    if (request.senderRelayId !== linkedRelayId
      || !isRelayReplicaPutActiveV1(request, now)) {
      ws.close(4003, 'unauthenticated_replica_placement');
      return;
    }
    const link = inboundRelayLinks.get(linkedRelayId);
    if (!link || link.socket !== ws || !link.descriptor.capabilities.replicaExchange) {
      ws.close(4003, 'replica_exchange_not_advertised');
      return;
    }
    pruneSeenRelayReplicaRequests(now);
    const replay = seenRelayReplicaRequests.get(replicaReplayKey('placement', request.requestId));
    if (replay) {
      if (replay.senderRelayId !== request.senderRelayId
        || replay.requestSignature !== request.signature) {
        ws.close(4003, 'replayed_replica_placement');
        return;
      }
      if (replay.response) sendReplicaReceiptResponse(ws, replay.response);
      else ws.close(4008, 'replica_response_unavailable');
      return;
    }

    if (!rateLimiter.check(`relay:${linkedRelayId}`, 'replica')) {
      sendReplicaReceipt(ws, request, { status: 'rejected', reason: 'rate-limited' });
      return;
    }
    const replayEntry = reserveSeenRelayReplicaRequest('placement', request);
    if (!replayEntry) {
      sendReplicaReceipt(ws, request, { status: 'rejected', reason: 'rate-limited' });
      return;
    }
    const respond = (result: {
      status: 'stored' | 'already-stored' | 'rejected';
      reason?: RelayReplicaRejectionReasonV1;
    }): void => {
      const response = sendReplicaReceipt(ws, request, result);
      if (response) replayEntry.response = response;
    };
    const operation = request.operation;
    if (operation.kind === 'publication') {
      if (!isPublicationActive(operation, now)) {
        respond({ status: 'rejected', reason: 'expired' });
        return;
      }
      if (!cfg.relayDiscovery?.supportedGroups.includes(operation.groupId)) {
        respond({ status: 'rejected', reason: 'unsupported-group' });
        return;
      }
    }

    let status: PublicationCommitStatus;
    try {
      status = commitPublicationOperation(operation, replicaAllocation(linkedRelayId));
    } catch (error) {
      log('error', 'replica_commit_failed', {
        publicationId: operation.publicationId,
        senderRelayId: linkedRelayId,
        error: String(error),
      });
      respond({ status: 'rejected', reason: 'persistence-failed' });
      return;
    }

    if (status === 'accepted' || status === 'duplicate') {
      respond({
        status: status === 'accepted' ? 'stored' : 'already-stored',
      });
    } else {
      respond({
        status: 'rejected',
        reason: replicaRejectionReason(status),
      });
    }
    log('info', 'replica_operation', {
      publicationId: operation.publicationId,
      kind: operation.kind,
      senderRelayId: linkedRelayId,
      result: status,
    });
  }

  function createReplicaInventoryResponse(
    request: RelayReplicaInventoryRequestV1,
    result: {
      status: 'present' | 'missing' | 'rejected';
      reason?: RelayReplicaInventoryRejectionReasonV1;
    },
  ): string | undefined {
    try {
      const response = createRelayReplicaInventoryResponseV1(request, relayIdentity, result);
      return serializeRelayReplicaInventoryResponseFrameV1(
        createRelayReplicaInventoryResponseFrameV1(response),
      );
    } catch (error) {
      log('warn', 'replica_inventory_response_failed', {
        publicationId: request.receipt.publicationId,
        error: String(error),
      });
      return undefined;
    }
  }

  function sendReplicaInventoryResponse(ws: WebSocket, response: string): void {
    ws.send(response, error => {
      if (error) ws.terminate();
    });
  }

  function sendReplicaInventory(
    ws: WebSocket,
    request: RelayReplicaInventoryRequestV1,
    result: {
      status: 'present' | 'missing' | 'rejected';
      reason?: RelayReplicaInventoryRejectionReasonV1;
    },
  ): string | undefined {
    const response = createReplicaInventoryResponse(request, result);
    if (response) sendReplicaInventoryResponse(ws, response);
    else ws.terminate();
    return response;
  }

  function handleReplicaInventory(
    ws: WebSocket,
    raw: string,
    linkedRelayId: string,
  ): void {
    let frame: ReturnType<typeof parseRelayReplicaInventoryRequestFrameV1>;
    try {
      frame = parseRelayReplicaInventoryRequestFrameV1(raw);
    } catch {
      ws.close(4000, 'invalid_replica_inventory_request');
      return;
    }
    const request = frame.request;
    const now = Date.now();
    if (request.senderRelayId !== linkedRelayId
      || request.targetRelayId !== relayIdentity.did
      || !isRelayReplicaInventoryRequestActiveV1(request, now)) {
      ws.close(4003, 'unauthenticated_replica_inventory_request');
      return;
    }
    const link = inboundRelayLinks.get(linkedRelayId);
    if (!link || link.socket !== ws || !link.descriptor.capabilities.replicaExchange) {
      ws.close(4003, 'replica_exchange_not_advertised');
      return;
    }
    pruneSeenRelayReplicaRequests(now);
    const replay = seenRelayReplicaRequests.get(replicaReplayKey('inventory', request.requestId));
    if (replay) {
      if (replay.senderRelayId !== request.senderRelayId
        || replay.requestSignature !== request.signature) {
        ws.close(4003, 'replayed_replica_inventory_request');
        return;
      }
      if (replay.response) sendReplicaInventoryResponse(ws, replay.response);
      else ws.close(4008, 'replica_response_unavailable');
      return;
    }

    if (!rateLimiter.check(`relay:${linkedRelayId}`, 'replica')) {
      sendReplicaInventory(ws, request, { status: 'rejected', reason: 'rate-limited' });
      return;
    }
    const replayEntry = reserveSeenRelayReplicaRequest('inventory', request);
    if (!replayEntry) {
      sendReplicaInventory(ws, request, { status: 'rejected', reason: 'rate-limited' });
      return;
    }
    const respond = (result: {
      status: 'present' | 'missing' | 'rejected';
      reason?: RelayReplicaInventoryRejectionReasonV1;
    }): void => {
      const response = sendReplicaInventory(ws, request, result);
      if (response) replayEntry.response = response;
    };
    const current = publicationStore.get(request.receipt.publicationId);
    const exact = current !== undefined
      && current.sequence === request.receipt.operationSequence
      && current.kind === request.receipt.operationKind
      && current.signature === request.receipt.operationSignature
      && (current.kind === 'publication-tombstone' || isPublicationActive(current, now));
    respond({ status: exact ? 'present' : 'missing' });
    log('info', 'replica_inventory', {
      publicationId: request.receipt.publicationId,
      relayId: linkedRelayId,
      status: exact ? 'present' : 'missing',
    });
  }

  function createReplicaInventoryBatchResponse(
    request: RelayReplicaInventoryBatchRequestV1,
    result: { status: 'inventory'; present: readonly boolean[] }
      | { status: 'rejected'; reason: RelayReplicaInventoryRejectionReasonV1 },
  ): string | undefined {
    try {
      const response = createRelayReplicaInventoryBatchResponseV1(request, relayIdentity, result);
      return serializeRelayReplicaInventoryBatchResponseFrameV1(
        createRelayReplicaInventoryBatchResponseFrameV1(response),
      );
    } catch (error) {
      log('warn', 'replica_inventory_batch_response_failed', {
        receiptCount: request.receipts.length,
        error: String(error),
      });
      return undefined;
    }
  }

  function sendReplicaInventoryBatchResponse(ws: WebSocket, response: string): void {
    ws.send(response, error => {
      if (error) ws.terminate();
    });
  }

  function sendReplicaInventoryBatch(
    ws: WebSocket,
    request: RelayReplicaInventoryBatchRequestV1,
    result: { status: 'inventory'; present: readonly boolean[] }
      | { status: 'rejected'; reason: RelayReplicaInventoryRejectionReasonV1 },
  ): string | undefined {
    const response = createReplicaInventoryBatchResponse(request, result);
    if (response) sendReplicaInventoryBatchResponse(ws, response);
    else ws.terminate();
    return response;
  }

  function handleReplicaInventoryBatch(
    ws: WebSocket,
    raw: string,
    linkedRelayId: string,
  ): void {
    let frame: ReturnType<typeof parseRelayReplicaInventoryBatchRequestFrameV1>;
    try {
      frame = parseRelayReplicaInventoryBatchRequestFrameV1(raw);
    } catch {
      ws.close(4000, 'invalid_replica_inventory_batch_request');
      return;
    }
    const request = frame.request;
    const now = Date.now();
    if (request.senderRelayId !== linkedRelayId
      || request.targetRelayId !== relayIdentity.did
      || !isRelayReplicaInventoryBatchRequestActiveV1(request, now)) {
      ws.close(4003, 'unauthenticated_replica_inventory_batch_request');
      return;
    }
    const link = inboundRelayLinks.get(linkedRelayId);
    if (!link || link.socket !== ws || !link.descriptor.capabilities.replicaExchange) {
      ws.close(4003, 'replica_exchange_not_advertised');
      return;
    }
    pruneSeenRelayReplicaRequests(now);
    const replay = seenRelayReplicaRequests.get(
      replicaReplayKey('inventory-batch', request.requestId),
    );
    if (replay) {
      if (replay.senderRelayId !== request.senderRelayId
        || replay.requestSignature !== request.signature) {
        ws.close(4003, 'replayed_replica_inventory_batch_request');
        return;
      }
      if (replay.response) sendReplicaInventoryBatchResponse(ws, replay.response);
      else ws.close(4008, 'replica_response_unavailable');
      return;
    }

    if (!rateLimiter.checkMany(`relay:${linkedRelayId}`, 'replica', request.receipts.length)) {
      sendReplicaInventoryBatch(ws, request, { status: 'rejected', reason: 'rate-limited' });
      return;
    }
    const replayEntry = reserveSeenRelayReplicaRequest('inventory-batch', request);
    if (!replayEntry) {
      sendReplicaInventoryBatch(ws, request, { status: 'rejected', reason: 'rate-limited' });
      return;
    }
    const present = request.receipts.map(receipt => {
      const current = publicationStore.get(receipt.publicationId);
      return current !== undefined
        && current.sequence === receipt.operationSequence
        && current.kind === receipt.operationKind
        && current.signature === receipt.operationSignature
        && (current.kind === 'publication-tombstone' || isPublicationActive(current, now));
    });
    const response = sendReplicaInventoryBatch(ws, request, { status: 'inventory', present });
    if (response) replayEntry.response = response;
    const presentCount = present.filter(Boolean).length;
    log('info', 'replica_inventory_batch', {
      relayId: linkedRelayId,
      receiptCount: request.receipts.length,
      presentCount,
      missingCount: request.receipts.length - presentCount,
    });
  }

  function createReplicaReconciliationResponse(
    request: RelayReplicaReconciliationRequestV1,
    result: {
      status: 'operation' | 'missing' | 'rejected';
      operation?: PublicationOperation;
      reason?: RelayReplicaReconciliationRejectionReasonV1;
    },
  ): string | undefined {
    try {
      const response = createRelayReplicaReconciliationResponseV1(request, relayIdentity, result);
      return serializeRelayReplicaReconciliationResponseFrameV1(
        createRelayReplicaReconciliationResponseFrameV1(response),
      );
    } catch (error) {
      log('warn', 'replica_reconciliation_response_failed', {
        publicationId: request.receipt.publicationId,
        error: String(error),
      });
      return undefined;
    }
  }

  function sendReplicaReconciliationResponse(ws: WebSocket, response: string): void {
    ws.send(response, error => {
      if (error) ws.terminate();
    });
  }

  function sendReplicaReconciliation(
    ws: WebSocket,
    request: RelayReplicaReconciliationRequestV1,
    result: {
      status: 'operation' | 'missing' | 'rejected';
      operation?: PublicationOperation;
      reason?: RelayReplicaReconciliationRejectionReasonV1;
    },
  ): string | undefined {
    const response = createReplicaReconciliationResponse(request, result);
    if (response) sendReplicaReconciliationResponse(ws, response);
    else ws.terminate();
    return response;
  }

  function handleReplicaReconciliation(
    ws: WebSocket,
    raw: string,
    linkedRelayId: string,
  ): void {
    let frame: ReturnType<typeof parseRelayReplicaReconciliationRequestFrameV1>;
    try {
      frame = parseRelayReplicaReconciliationRequestFrameV1(raw);
    } catch {
      ws.close(4000, 'invalid_replica_reconciliation_request');
      return;
    }
    const request = frame.request;
    const now = Date.now();
    if (request.senderRelayId !== linkedRelayId
      || request.targetRelayId !== relayIdentity.did
      || !isRelayReplicaReconciliationRequestActiveV1(request, now)) {
      ws.close(4003, 'unauthenticated_replica_reconciliation_request');
      return;
    }
    const link = inboundRelayLinks.get(linkedRelayId);
    if (!link || link.socket !== ws || !link.descriptor.capabilities.replicaExchange) {
      ws.close(4003, 'replica_exchange_not_advertised');
      return;
    }
    pruneSeenRelayReplicaRequests(now);
    const replay = seenRelayReplicaRequests.get(replicaReplayKey('reconciliation', request.requestId));
    if (replay) {
      if (replay.senderRelayId !== request.senderRelayId
        || replay.requestSignature !== request.signature) {
        ws.close(4003, 'replayed_replica_reconciliation_request');
        return;
      }
      if (replay.response) sendReplicaReconciliationResponse(ws, replay.response);
      else ws.close(4008, 'replica_response_unavailable');
      return;
    }

    if (!rateLimiter.check(`relay:${linkedRelayId}`, 'replica')) {
      sendReplicaReconciliation(ws, request, { status: 'rejected', reason: 'rate-limited' });
      return;
    }
    const replayEntry = reserveSeenRelayReplicaRequest('reconciliation', request);
    if (!replayEntry) {
      sendReplicaReconciliation(ws, request, { status: 'rejected', reason: 'rate-limited' });
      return;
    }
    const respond = (result: {
      status: 'operation' | 'missing' | 'rejected';
      operation?: PublicationOperation;
      reason?: RelayReplicaReconciliationRejectionReasonV1;
    }): void => {
      const response = sendReplicaReconciliation(ws, request, result);
      if (response) replayEntry.response = response;
    };

    const current = publicationStore.get(request.receipt.publicationId);
    if (current && (current.kind === 'publication-tombstone' || isPublicationActive(current, now))) {
      respond({ status: 'operation', operation: current });
      log('info', 'replica_reconciliation', {
        publicationId: request.receipt.publicationId,
        relayId: linkedRelayId,
        status: 'operation',
      });
      return;
    }
    respond({ status: 'missing' });
    log('info', 'replica_reconciliation', {
      publicationId: request.receipt.publicationId,
      relayId: linkedRelayId,
      status: 'missing',
    });
  }

  function requestReplicaHandoff(
    controllerRelayId: string,
    operations: readonly PublicationOperation[],
    timeoutMs = REPLICA_HANDOFF_TIMEOUT_MS,
  ): Promise<RelayReplicaHandoffResponseV1> {
    const link = inboundRelayLinks.get(controllerRelayId);
    if (!link || link.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Replica controller link is unavailable'));
    }
    const createdAt = Date.now();
    const request = createRelayReplicaHandoffRequestV1(
      operations,
      controllerRelayId,
      relayIdentity,
      createdAt,
      createdAt + timeoutMs + 1_000,
    );
    const frame = serializeRelayReplicaHandoffRequestFrameV1(
      createRelayReplicaHandoffRequestFrameV1(request),
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingReplicaHandoffs.delete(request.requestId);
        reject(new Error('Replica handoff timed out'));
      }, timeoutMs);
      timer.unref?.();
      pendingReplicaHandoffs.set(request.requestId, {
        request,
        controllerRelayId,
        timer,
        resolve,
        reject,
      });
      link.socket.send(frame, error => {
        if (!error) return;
        const pending = pendingReplicaHandoffs.get(request.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingReplicaHandoffs.delete(request.requestId);
        pending.reject(error);
      });
    });
  }

  function handleReplicaHandoffResponse(
    ws: WebSocket,
    raw: string,
    linkedRelayId: string,
  ): void {
    try {
      const { response } = parseRelayReplicaHandoffResponseFrameV1(raw);
      const pending = pendingReplicaHandoffs.get(response.requestId);
      if (!pending
        || pending.controllerRelayId !== linkedRelayId
        || response.controllerRelayId !== linkedRelayId
        || response.retiringRelayId !== relayIdentity.did
        || !verifyRelayReplicaHandoffResponseV1(response, pending.request)) {
        throw new Error('Replica handoff response is not bound to this request');
      }
      clearTimeout(pending.timer);
      pendingReplicaHandoffs.delete(response.requestId);
      pending.resolve(response);
    } catch {
      ws.close(4000, 'invalid_replica_handoff_response');
    }
  }

  async function handoffHostedReplicas(): Promise<void> {
    const operationsByController = new Map<string, PublicationOperation[]>();
    for (const operation of publicationStore.list()) {
      const allocation = replicaStorageLedger.allocationFor(operation.publicationId);
      if (!allocation || allocation.allocationOrigin !== 'replica') continue;
      const operations = operationsByController.get(allocation.allocationRelayId);
      if (operations) operations.push(operation);
      else operationsByController.set(allocation.allocationRelayId, [operation]);
    }
    let hosted = 0;
    let acknowledged = 0;
    let safeElsewhere = 0;
    await Promise.all([...operationsByController].map(async ([controllerRelayId, operations]) => {
      hosted += operations.length;
      const deadline = Date.now() + REPLICA_HANDOFF_TIMEOUT_MS;
      for (let index = 0; index < operations.length; index += MAX_REPLICA_HANDOFF_OPERATIONS) {
        const chunk = operations.slice(index, index + MAX_REPLICA_HANDOFF_OPERATIONS);
        const remainingMs = deadline - Date.now();
        if (remainingMs < 100) break;
        try {
          const result = decodeRelayReplicaHandoffResultV1(
            await requestReplicaHandoff(controllerRelayId, chunk, remainingMs),
          );
          acknowledged += result.accepted.filter(Boolean).length;
          safeElsewhere += result.safeElsewhere.filter(Boolean).length;
        } catch (error) {
          log('warn', 'replica_handoff_failed', {
            controllerRelayId,
            operationCount: chunk.length,
            error: String(error),
          });
        }
      }
    }));
    if (hosted > 0) {
      log('info', 'replica_handoff_complete', {
        hosted,
        acknowledged,
        safeElsewhere,
        unacknowledged: hosted - acknowledged,
      });
    }
  }

  function handleConnection(ws: WebSocket, req: any): void {
    const ip = req?.socket?.remoteAddress ?? 'unknown';
    let linkedRelayId: string | null = null;

    const authTimeout = setTimeout(() => {
      ws.close(4001, 'request_timeout');
    }, 10_000);

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      let raw: string;
      try {
        raw = data.toString('utf-8');
      } catch {
        ws.close(4000, 'invalid_encoding');
        return;
      }
      // Protocol v2 publication operations authenticate themselves. They use
      // a short connection and never send the user's root identity.
      let frameCandidate: unknown;
      try { frameCandidate = JSON.parse(raw); } catch { /* handled by v1 parser below */ }
      if (linkedRelayId) {
        if (isBinary) {
          ws.close(4000, 'relay_message_must_be_json');
          return;
        }
        if (isObject(frameCandidate) && frameCandidate.type === RELAY_REPLICA_PUT_FRAME_TYPE) {
          handleReplicaPlacement(ws, raw, linkedRelayId);
        } else if (isObject(frameCandidate)
          && frameCandidate.type === RELAY_REPLICA_HANDOFF_RESPONSE_FRAME_TYPE) {
          handleReplicaHandoffResponse(ws, raw, linkedRelayId);
        } else if (isObject(frameCandidate)
          && frameCandidate.type === RELAY_REPLICA_INVENTORY_BATCH_REQUEST_FRAME_TYPE) {
          handleReplicaInventoryBatch(ws, raw, linkedRelayId);
        } else if (isObject(frameCandidate)
          && frameCandidate.type === RELAY_REPLICA_INVENTORY_REQUEST_FRAME_TYPE) {
          handleReplicaInventory(ws, raw, linkedRelayId);
        } else if (isObject(frameCandidate)
          && frameCandidate.type === RELAY_REPLICA_RECONCILIATION_REQUEST_FRAME_TYPE) {
          handleReplicaReconciliation(ws, raw, linkedRelayId);
        } else {
          ws.close(4000, 'unexpected_link_message');
        }
        return;
      }
      if (isObject(frameCandidate) && frameCandidate.type === RELAY_LINK_OPEN_FRAME_TYPE) {
        clearTimeout(authTimeout);
        if (!cfg.relayDiscovery) {
          ws.close(4004, 'relay_discovery_disabled');
          return;
        }
        let frame: ReturnType<typeof parseRelayLinkOpenFrameV1>;
        try {
          frame = parseRelayLinkOpenFrameV1(raw);
        } catch {
          ws.close(4000, 'invalid_relay_link');
          return;
        }
        const request = frame.request;
        const now = Date.now();
        if (!isRelayLinkOpenActiveV1(request, now)) {
          ws.close(4003, 'expired_relay_link');
          return;
        }
        if (seenRelayLinks.has(request.linkId)) {
          ws.close(4003, 'replayed_relay_link');
          return;
        }
        seenRelayLinks.set(request.linkId, request.expiresAt);
        if (!rateLimiter.check(`transport:${ip}`, 'discovery')) {
          ws.close(4008, 'rate_limited');
          return;
        }
        const remoteRelayId = request.descriptor.relayId;
        if (inboundRelayLinks.has(remoteRelayId)) {
          ws.close(4009, 'relay_link_already_connected');
          return;
        }
        if (inboundRelayLinks.size >= cfg.maxInboundRelayLinks) {
          ws.close(4010, 'relay_link_capacity_reached');
          return;
        }
        const observation = relayDirectory.observe(request.descriptor, now);
        if (observation !== 'accepted' && observation !== 'updated' && observation !== 'unchanged') {
          ws.close(4003, `relay_descriptor_${observation}`);
          return;
        }
        const ownDescriptor = getOwnRelayDescriptor(now);
        if (!ownDescriptor || ownDescriptor.reachability !== 'direct') {
          ws.close(4004, 'relay_not_directly_reachable');
          return;
        }
        const acceptance = createRelayLinkAcceptV1(
          request,
          ownDescriptor,
          relayIdentity,
          now,
        );
        const response = serializeRelayLinkAcceptFrameV1(
          createRelayLinkAcceptFrameV1(acceptance),
        );
        linkedRelayId = remoteRelayId;
        inboundRelayLinks.set(remoteRelayId, {
          socket: ws,
          descriptor: request.descriptor,
          lastPongAt: now,
        });
        ws.on('pong', () => {
          const link = inboundRelayLinks.get(remoteRelayId);
          if (link?.socket === ws) link.lastPongAt = Date.now();
        });
        ws.send(response, error => {
          if (error) ws.terminate();
        });
        log('info', 'relay_link_accepted', { relayId: remoteRelayId, reachability: request.descriptor.reachability });
        return;
      }
      if (isObject(frameCandidate) && frameCandidate.type === RELAY_PEER_REQUEST_FRAME_TYPE) {
        clearTimeout(authTimeout);
        if (!cfg.relayDiscovery) {
          ws.close(4004, 'relay_discovery_disabled');
          return;
        }
        let frame: ReturnType<typeof parseRelayPeerRequestFrameV1>;
        try {
          frame = parseRelayPeerRequestFrameV1(raw);
        } catch {
          ws.close(4000, 'invalid_peer_request');
          return;
        }
        const request = frame.request;
        const now = Date.now();
        if (!isRelayPeerRequestActiveV1(request, now)) {
          ws.close(4003, 'expired_peer_request');
          return;
        }
        if (seenPeerRequests.has(request.requestId)) {
          ws.close(4003, 'replayed_peer_request');
          return;
        }
        if (!rateLimiter.check(`transport:${ip}`, 'discovery')) {
          ws.close(4008, 'rate_limited');
          return;
        }
        seenPeerRequests.set(request.requestId, request.expiresAt);

        const descriptors: RelayDescriptorV1[] = [];
        const ownDescriptor = getOwnRelayDescriptor(now);
        if (ownDescriptor && supportsAnyGroup(ownDescriptor, request.supportedGroups)) {
          descriptors.push(ownDescriptor);
        }
        descriptors.push(...relayDirectory.select({
          supportedGroups: request.supportedGroups,
          limit: request.maxPeers - descriptors.length,
          now,
        }));
        const response = createRelayPeerResponseV1(request, descriptors, relayIdentity, now);
        const responseFrame = createRelayPeerResponseFrameV1(response);
        ws.send(serializeRelayPeerResponseFrameV1(responseFrame), () => {
          ws.close(1000, 'peer_exchange_complete');
        });
        log('info', 'relay_peer_exchange', { resultCount: descriptors.length });
        return;
      }
      if (isObject(frameCandidate) && frameCandidate.type === SEARCH_REQUEST_FRAME_TYPE) {
        clearTimeout(authTimeout);
        let frame: ReturnType<typeof parseSearchRequestFrameV2>;
        try {
          frame = parseSearchRequestFrameV2(raw);
        } catch {
          ws.close(4000, 'invalid_search_request');
          return;
        }
        const request = frame.request;
        const now = Date.now();
        if (!isSearchRequestActiveV2(request, now)
          || Math.abs(now - request.createdAt) > cfg.authWindowMs) {
          sendOperationAck(ws, request.searchId, 'error', 'expired_search');
          return;
        }
        if (seenSearches.has(request.searchId)) {
          sendOperationAck(ws, request.searchId, 'error', 'replayed_search');
          return;
        }
        if (!authorizeAdmission(ws, request.searchId, frame.admission, 'search', request, now)) return;
        if (!rateLimiter.check(`transport:${ip}`, 'search')) {
          sendOperationAck(ws, request.searchId, 'error', 'rate_limited');
          return;
        }
        seenSearches.set(request.searchId, request.expiresAt);

        const scope = `${request.groupId}\n${request.fingerprint.algorithm}:${request.fingerprint.bits}:${request.fingerprint.epoch}`;
        const matches = engine.search(
          decodeBase64(request.fingerprint.value),
          request.itemType,
          request.k,
          Math.max(request.threshold, cfg.matchThreshold),
          scope,
        );
        const results = matches.flatMap((match) => {
          const publication = publicationStore.get(match.did);
          if (!publication || publication.kind !== 'publication' || !isPublicationActive(publication, now)) {
            return [];
          }
          return [{
            publicationId: publication.publicationId,
            similarity: match.similarity,
            itemType: publication.itemType,
          }];
        });
        const response = createMessage(
          SEARCH_RESPONSE_MESSAGE_TYPE,
          createSearchResponsePayloadV2(request.searchId, results, now),
          relayIdentity,
        );
        ws.send(serializeMessage(response), () => ws.close(1000, 'search_complete'));
        log('info', 'search_v2', { resultCount: results.length });
        return;
      }

      if (isObject(frameCandidate)
        && frameCandidate.type === PUBLICATION_OPERATION_FRAME_TYPE) {
        clearTimeout(authTimeout);
        let frame: ReturnType<typeof parsePublicationOperationFrame>;
        try {
          frame = parsePublicationOperationFrame(raw);
        } catch {
          ws.close(4000, 'invalid_publication_operation');
          return;
        }
        const operation: PublicationOperation = frame.operation;

        if (operation.kind === 'publication' && !isPublicationActive(operation, Date.now())) {
          sendOperationAck(ws, operation.publicationId, 'error', 'expired');
          return;
        }
        if (!authorizeAdmission(
          ws, operation.publicationId, frame.admission, 'publication-write', operation,
        )) return;
        if (!rateLimiter.check(`transport:${ip}`, 'publish')) {
          sendOperationAck(ws, operation.publicationId, 'error', 'rate_limited');
          return;
        }

        let result: PublicationCommitStatus;
        try {
          result = commitLocalPublicationOperation(operation);
        } catch (err) {
          log('error', 'operation_commit_failed', { error: String(err) });
          sendOperationAck(ws, operation.publicationId, 'error', 'persistence_failed');
          return;
        }
        const accepted = result === 'accepted' || result === 'duplicate';
        sendOperationAck(
          ws,
          operation.publicationId,
          accepted ? 'ok' : 'error',
          result,
        );
        log('info', 'publication_operation', {
          publicationId: operation.publicationId,
          kind: operation.kind,
          result,
        });
        return;
      }

      if (isObject(frameCandidate) && frameCandidate.type === RELATIONSHIP_MAILBOX_REQUEST_FRAME_TYPE) {
        clearTimeout(authTimeout);
        let frame: ReturnType<typeof parseRelationshipMailboxRequestFrameV2>;
        try {
          frame = parseRelationshipMailboxRequestFrameV2(raw);
        } catch {
          ws.close(4000, 'invalid_relationship_mailbox_request');
          return;
        }
        const request = frame.request;
        if (Math.abs(Date.now() - request.timestamp) > cfg.authWindowMs) {
          sendOperationAck(ws, request.requestId, 'error', 'stale_timestamp');
          return;
        }
        if (!authorizeAdmission(
          ws,
          request.requestId,
          frame.admission,
          request.action === 'fetch' ? 'mailbox-fetch' : 'mailbox-acknowledge',
          request,
        )) return;
        if (!rateLimiter.check(`transport:${ip}`, 'search')) {
          sendOperationAck(ws, request.requestId, 'error', 'rate_limited');
          return;
        }
        if (request.action === 'fetch') {
          const response = createMessage<MailboxResponsePayload>(MAILBOX_RESPONSE_MESSAGE_TYPE, {
            requestId: request.requestId,
            mailboxId: request.mailboxId,
            envelopes: mailboxStore.fetch(request.mailboxId),
          }, relayIdentity);
          ws.send(serializeMessage(response), () => ws.close(1000, 'relationship_mailbox_fetch_complete'));
          return;
        }
        let acknowledged: number;
        try {
          acknowledged = commitMailboxAcknowledgement(request);
        } catch (err) {
          log('error', 'operation_commit_failed', { error: String(err) });
          sendOperationAck(ws, request.requestId, 'error', 'persistence_failed');
          return;
        }
        sendOperationAck(ws, request.requestId, 'ok', `acknowledged:${acknowledged}`);
        return;
      }

      if (isObject(frameCandidate) && frameCandidate.type === RELATIONSHIP_MAILBOX_DEPOSIT_FRAME_TYPE) {
        clearTimeout(authTimeout);
        let frame: ReturnType<typeof parseRelationshipMailboxDepositFrameV2>;
        try {
          frame = parseRelationshipMailboxDepositFrameV2(raw);
        } catch {
          ws.close(4000, 'invalid_relationship_mailbox_deposit');
          return;
        }
        const request = frame.request;
        if (Math.abs(Date.now() - request.timestamp) > cfg.authWindowMs) {
          sendOperationAck(ws, request.requestId, 'error', 'stale_timestamp');
          return;
        }
        if (!authorizeAdmission(
          ws, request.requestId, frame.admission, 'mailbox-deposit', request,
        )) return;
        if (!rateLimiter.check(`transport:${ip}`, 'publish')) {
          sendOperationAck(ws, request.requestId, 'error', 'rate_limited');
          return;
        }
        let result: 'accepted' | 'duplicate' | 'expired' | 'capacity-exhausted';
        try {
          result = commitMailboxDeposit(request);
        } catch (err) {
          log('error', 'operation_commit_failed', { error: String(err) });
          sendOperationAck(ws, request.requestId, 'error', 'persistence_failed');
          return;
        }
        sendOperationAck(
          ws, request.requestId,
          result === 'accepted' || result === 'duplicate' ? 'ok' : 'error', result,
        );
        log('info', 'relationship_mailbox_deposit', {
          senderRelationshipId: request.senderRelationshipId,
          recipientRelationshipId: request.recipientRelationshipId,
          result,
        });
        return;
      }

      if (isObject(frameCandidate) && frameCandidate.type === MAILBOX_REQUEST_FRAME_TYPE) {
        clearTimeout(authTimeout);
        let frame: ReturnType<typeof parseMailboxRequestFrame>;
        try {
          frame = parseMailboxRequestFrame(raw);
        } catch {
          ws.close(4000, 'invalid_mailbox_request');
          return;
        }
        const request = frame.request;
        if (Math.abs(Date.now() - request.timestamp) > cfg.authWindowMs) {
          sendOperationAck(ws, request.requestId, 'error', 'stale_timestamp');
          return;
        }
        if (!authorizeAdmission(
          ws,
          request.requestId,
          frame.admission,
          request.action === 'fetch' ? 'mailbox-fetch' : 'mailbox-acknowledge',
          request,
        )) return;
        if (!rateLimiter.check(`transport:${ip}`, 'search')) {
          sendOperationAck(ws, request.requestId, 'error', 'rate_limited');
          return;
        }

        const record = publicationStore.getRecord(request.publicationId);
        if (!record
          || record.publicationKey !== request.publicationKey
          || record.mailbox.id !== request.mailboxId) {
          sendOperationAck(ws, request.requestId, 'error', 'unknown_mailbox');
          return;
        }

        if (request.action === 'fetch') {
          const response = createMessage<MailboxResponsePayload>(MAILBOX_RESPONSE_MESSAGE_TYPE, {
            requestId: request.requestId,
            mailboxId: request.mailboxId,
            envelopes: mailboxStore.fetch(request.mailboxId),
          }, relayIdentity);
          ws.send(serializeMessage(response), () => ws.close(1000, 'mailbox_fetch_complete'));
          return;
        }

        let acknowledged: number;
        try {
          acknowledged = commitMailboxAcknowledgement(request);
        } catch (err) {
          log('error', 'operation_commit_failed', { error: String(err) });
          sendOperationAck(ws, request.requestId, 'error', 'persistence_failed');
          return;
        }
        sendOperationAck(ws, request.requestId, 'ok', `acknowledged:${acknowledged}`);
        return;
      }

      if (isObject(frameCandidate) && frameCandidate.type === MAILBOX_DEPOSIT_FRAME_TYPE) {
        clearTimeout(authTimeout);
        let frame: ReturnType<typeof parseMailboxDepositFrame>;
        try {
          frame = parseMailboxDepositFrame(raw);
        } catch {
          ws.close(4000, 'invalid_mailbox_deposit');
          return;
        }
        const request = frame.request;
        if (Math.abs(Date.now() - request.timestamp) > cfg.authWindowMs) {
          sendOperationAck(ws, request.requestId, 'error', 'stale_timestamp');
          return;
        }
        if (!authorizeAdmission(
          ws, request.requestId, frame.admission, 'mailbox-deposit', request,
        )) return;
        if (!rateLimiter.check(`transport:${ip}`, 'publish')) {
          sendOperationAck(ws, request.requestId, 'error', 'rate_limited');
          return;
        }

        const sender = publicationStore.get(request.senderPublicationId);
        const recipient = publicationStore.get(request.recipientPublicationId);
        if (!sender || sender.kind !== 'publication' || !isPublicationActive(sender, Date.now())
          || sender.publicationKey !== request.senderPublicationKey) {
          sendOperationAck(ws, request.requestId, 'error', 'unknown_sender_publication');
          return;
        }
        if (!recipient || recipient.kind !== 'publication' || !isPublicationActive(recipient, Date.now())
          || recipient.mailbox.id !== request.recipientMailboxId) {
          sendOperationAck(ws, request.requestId, 'error', 'unknown_recipient_mailbox');
          return;
        }
        if (sender.itemType === recipient.itemType
          || sender.groupId !== recipient.groupId
          || sender.fingerprint.epoch !== recipient.fingerprint.epoch
          || sender.fingerprint.bits !== recipient.fingerprint.bits
          || hammingSimilarity(
            decodeBase64(sender.fingerprint.value),
            decodeBase64(recipient.fingerprint.value),
          ) < cfg.matchThreshold) {
          sendOperationAck(ws, request.requestId, 'error', 'match_not_authorized');
          return;
        }
        if (request.envelope.payloadType !== 'relationship-message') {
          sendOperationAck(ws, request.requestId, 'error', 'unsupported_deposit_payload');
          return;
        }

        let result: 'accepted' | 'duplicate' | 'expired' | 'capacity-exhausted';
        try {
          result = commitMailboxDeposit(request);
        } catch (err) {
          log('error', 'operation_commit_failed', { error: String(err) });
          sendOperationAck(ws, request.requestId, 'error', 'persistence_failed');
          return;
        }
        sendOperationAck(
          ws, request.requestId,
          result === 'accepted' || result === 'duplicate' ? 'ok' : 'error', result,
        );
        log('info', 'mailbox_deposit', {
          matchId: request.matchId,
          senderPublicationId: request.senderPublicationId,
          recipientPublicationId: request.recipientPublicationId,
          result,
        });
        return;
      }

      let msg;
      try {
        msg = parseMessage(raw);
      } catch {
        ws.close(4000, 'invalid_message');
        return;
      }

      // Verify signature
      if (!verifyMessage(msg)) {
        ws.close(4002, 'invalid_signature');
        return;
      }

      // Protocol v1 used a long-lived root-DID authenticated session. There is
      // no deployed network to migrate, so accepting it would only recreate a
      // stable cross-activity identifier.
      if (msg.type === MessageTypes.AUTH) {
        clearTimeout(authTimeout);
        sendOperationAck(ws, 'auth', 'error', 'legacy_auth_disabled');
        return;
      }
      clearTimeout(authTimeout);
      sendOperationAck(ws, msg.type, 'error', 'unknown_message_type');
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (linkedRelayId) {
        const link = inboundRelayLinks.get(linkedRelayId);
        if (link?.socket === ws) inboundRelayLinks.delete(linkedRelayId);
      }
    });

    ws.on('error', (err) => {
      log('error', 'ws_error', { error: String(err) });
    });

    function authorizeAdmission(
      socket: WebSocket,
      ref: string,
      capability: AdmissionCapabilityV2 | undefined,
      action: RelayAdmissionActionV2,
      request: unknown,
      now = Date.now(),
    ): boolean {
      if (!cfg.admissionVerifier) return true;
      if (!capability) {
        sendOperationAck(socket, ref, 'error', 'admission_required');
        return false;
      }
      try {
        const decision = cfg.admissionVerifier.verifyAndSpend(capability, {
          action,
          requestBinding: createAdmissionRequestBindingV2(action, request),
          now,
        });
        if (decision.status === 'accepted' || decision.status === 'replay') return true;
        log('warn', 'admission_rejected', { action, reason: decision.reason ?? 'rejected' });
        sendOperationAck(socket, ref, 'error', 'admission_rejected');
        return false;
      } catch (error) {
        log('error', 'admission_verifier_failed', { action, error: String(error) });
        sendOperationAck(socket, ref, 'error', 'admission_unavailable');
        return false;
      }
    }

    function sendOperationAck(
      socket: WebSocket,
      ref: string,
      status: 'ok' | 'error',
      message: string,
    ): void {
      const ack = createMessage<AckPayload>(MessageTypes.ACK, { ref, status, message }, relayIdentity);
      socket.send(serializeMessage(ack), () => socket.close(1000, 'operation_complete'));
    }

  }

  return {
    async start(): Promise<void> {
      stopping = false;
      const records = operationLog.load();
      for (const record of records) replayOperation(record.entry);
      for (const record of records) replayPlacementOperation(record.entry);
      mailboxStore.purgeExpired();
      maybeCompactJournal(1);
      if (replicaStorageLedger.legacyUnattributedReservedBytes > 0) {
        log('warn', 'legacy_replica_storage_accounted', {
          reservedBytes: replicaStorageLedger.legacyUnattributedReservedBytes,
          message: 'Unmarked and legacy publication journal rows share one conservative per-relay allocation bucket',
        });
      }
      // A descriptor may have been validated before journal replay while the
      // ledger was empty. Reissue it with the rebuilt allocation before any
      // socket or descriptor endpoint can expose a capacity claim.
      relayDescriptor = null;

      // The search index is a derived cache. Rebuilding it from authoritative
      // signed operations also repairs a publication whose match commit was
      // interrupted after its own journal record reached disk.
      const now = Date.now();
      for (const operation of publicationStore.activeRecords(now)) applyToMatchingIndex(operation, false);
      enforcePublicationExpiries();
      scheduleNextPublicationExpiry(now);
      log('info', 'journal_replayed', { dir: cfg.persistDir, entries: operationLog.length });

      httpServer = createServer(handleHttpRequest);
      wss = new WebSocketServer({
        server: httpServer,
        maxPayload: MAX_RELAY_DISCOVERY_FRAME_BYTES,
      });
      wss.on('connection', handleConnection);

      await new Promise<void>((resolve) => {
        httpServer.listen(cfg.port, cfg.host, () => {
          log('info', 'started', { port: cfg.port, host: cfg.host, did: relayIdentity.did });
          resolve();
        });
      });

      // Periodic cleanup
      cleanupTimer = setInterval(() => {
        rateLimiter.cleanup();
        for (const [searchId, expiresAt] of seenSearches) {
          if (expiresAt <= Date.now()) seenSearches.delete(searchId);
        }
        for (const [requestId, expiresAt] of seenPeerRequests) {
          if (expiresAt <= Date.now()) seenPeerRequests.delete(requestId);
        }
        for (const [linkId, expiresAt] of seenRelayLinks) {
          if (expiresAt <= Date.now()) seenRelayLinks.delete(linkId);
        }
        pruneSeenRelayReplicaRequests();
        relayDirectory.prune();
        enforcePublicationExpiries();
        try {
          maybeCompactJournal(128);
        } catch (error) {
          log('error', 'journal_compaction_failed', { error: String(error) });
        }
      }, 5 * 60_000);

      relayLinkHeartbeatTimer = setInterval(() => {
        const now = Date.now();
        for (const link of inboundRelayLinks.values()) {
          if (link.descriptor.expiresAt <= now
            || now - link.lastPongAt > cfg.relayLinkHeartbeatTimeoutMs) {
            link.socket.terminate();
          } else if (link.socket.readyState === WebSocket.OPEN) {
            link.socket.ping();
          }
        }
      }, cfg.relayLinkHeartbeatIntervalMs);
      relayLinkHeartbeatTimer.unref?.();
      outboundRelayLinks?.start();
      if (outboundRelayLinks) {
        replicaRepairTimer = setInterval(queueReplicaRepair, cfg.replicaRepairIntervalMs);
        replicaRepairTimer.unref?.();
        queueReplicaRepair();
      }
    },

    async stop(options = {}): Promise<void> {
      stopping = true;
      if (publicationExpiryTimer) clearTimeout(publicationExpiryTimer);
      if (cleanupTimer) clearInterval(cleanupTimer);
      if (relayLinkHeartbeatTimer) clearInterval(relayLinkHeartbeatTimer);
      if (replicaRepairTimer) clearInterval(replicaRepairTimer);
      if (replicaRepairWakeupTimer) clearTimeout(replicaRepairWakeupTimer);
      replicaRepairTimer = null;
      replicaRepairWakeupTimer = null;
      replicaRepairQueued = false;
      if (options.graceful !== false) await handoffHostedReplicas();
      for (const pending of pendingReplicaHandoffs.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Relay stopped before replica handoff completed'));
      }
      pendingReplicaHandoffs.clear();
      outboundRelayLinks?.stop();
      for (const link of inboundRelayLinks.values()) link.socket.close(1001, 'relay_stopping');
      inboundRelayLinks.clear();

      wss?.close();
      await new Promise<void>((resolve) => {
        httpServer?.close(() => resolve());
      });

      log('info', 'stopped');
    },

    getStats(): RelayStats {
      enforcePublicationExpiries();
      const stats = engine.getStats();
      const placement = replicaPlacementMetrics();
      return {
        indexed_embeddings: stats.total,
        stored_publications: publicationStore.size,
        active_publications: publicationStore.activeRecords().length,
        retained_tombstones: publicationStore.tombstoneCount,
        publication_storage_quota_bytes: publicationStorageQuotaBytes,
        publication_storage_withdrawal_reserve_bytes: Math.min(
          FIRST_SEEN_TOMBSTONE_RESERVE_BYTES,
          publicationStorageQuotaBytes,
        ),
        publication_storage_reserved_bytes: replicaStorageLedger.reservedBytes,
        publication_storage_available_bytes: Math.max(
          0,
          allocatablePublicationStorageBytes - replicaStorageLedger.reservedBytes,
        ),
        replica_storage_reserved_bytes: replicaStorageLedger.replicaReservedBytes,
        replica_storage_relays: replicaStorageLedger.replicaRelayCount,
        legacy_unattributed_storage_reserved_bytes:
          replicaStorageLedger.legacyUnattributedReservedBytes,
        mailbox_envelopes: mailboxStore.envelopeCount,
        mailbox_storage_quota_bytes: maxMailboxStorageBytes,
        mailbox_storage_reserved_bytes: mailboxStore.retainedBytes,
        journal_storage_quota_bytes: maxJournalStorageBytes,
        journal_bytes: operationLog.byteLength,
        stored_matches: matchStore.size,
        journal_entries: operationLog.length,
        connected_nodes: 0,
        matches_today: stats.matchesToday,
        known_relays: relayDirectory.size(),
        connected_relays: connectedRelayIds().length,
        durability_receipts: placement.receiptCount,
        placement_intents: placement.intentCount,
        minimum_confirmed_placements: placement.minimumConfirmedCount,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      };
    },

    getRelayDescriptor(now = Date.now()): RelayDescriptorV1 | null {
      const descriptor = getOwnRelayDescriptor(now);
      return descriptor ? copyRelayDescriptor(descriptor) : null;
    },

    observeRelayDescriptor(value: unknown, now = Date.now()): RelayDescriptorObservation {
      return relayDirectory.observe(value, now);
    },

    getKnownRelayDescriptors(now = Date.now()): RelayDescriptorV1[] {
      return relayDirectory.select({ limit: cfg.relayDiscovery?.maxKnownRelays ?? 256, now });
    },

    async discoverRelay(
      hint: RelayContactHintV1,
      options: RelayContactDiscoveryOptions = {},
    ): Promise<RelayDiscoveryIngestResult> {
      const result = await discoverRelayContactV1(hint, {
        supportedGroups: cfg.relayDiscovery?.supportedGroups ?? [],
        ...options,
      });
      const now = Date.now();
      const observations = result.descriptors.map(descriptor => ({
        relayId: descriptor.relayId,
        status: relayDirectory.observe(descriptor, now),
      }));
      return { ...result, observations };
    },

    getRelayLinkStatus(): RelayLinkManagerStatus & { inboundRelayIds: string[] } {
      const outbound = outboundRelayLinks?.status() ?? {
        running: false,
        targetCount: 0,
        connectedRelayIds: [],
        durabilityReceiptCount: 0,
      };
      return {
        ...outbound,
        durabilityReceiptCount: replicaPlacementMetrics().receiptCount,
        inboundRelayIds: [...inboundRelayLinks.keys()].sort(),
      };
    },

    getReplicaReceipts(publicationId: string): RelayReplicaReceiptV1[] {
      return placementTracker.receiptsFor(publicationId);
    },

    getReplicaPlacementStatus(publicationId: string): ReplicaPlacementStatus | undefined {
      return placementTracker.statusFor(publicationId);
    },
  };
}

function replicaRejectionReason(status: PublicationCommitStatus): RelayReplicaRejectionReasonV1 {
  if (status === 'capacity-exhausted') return status;
  if (status === 'stale' || status === 'conflict' || status === 'terminal' || status === 'invalid') {
    return status;
  }
  return 'invalid';
}

function supportsAnyGroup(descriptor: RelayDescriptorV1, groups: string[]): boolean {
  return groups.length === 0 || groups.some(group => descriptor.supportedGroups.includes(group));
}

function replicaTargetScore(publicationId: string, relayId: string): string {
  return createHash('sha256')
    .update(publicationId)
    .update('\u0000')
    .update(relayId)
    .digest('hex');
}

function copyRelayDescriptor(value: RelayDescriptorV1): RelayDescriptorV1 {
  return {
    ...value,
    endpoints: [...value.endpoints],
    capabilities: { ...value.capabilities },
    supportedGroups: [...value.supportedGroups],
    storage: { ...value.storage },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
