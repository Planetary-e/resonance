/**
 * Relay server: WebSocket + HTTP admin API.
 * Accepts self-authenticating protocol v2 operations over short connections.
 */

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
  createRelayReplicaReceiptFrameV1,
  createRelayReplicaReceiptV1,
  createRelayDescriptorV1,
  createRelayPeerResponseFrameV1,
  createRelayPeerResponseV1,
  createSearchResponsePayloadV2,
  decodeBase64,
  encryptMatchNotice,
  hammingSimilarity,
  isPublicationActive,
  isRelayLinkOpenActiveV1,
  isRelayReplicaPutActiveV1,
  isRelayPeerRequestActiveV1,
  isSearchRequestActiveV2,
  parseMailboxDepositFrame,
  parseMailboxRequestFrame,
  parsePublicationOperationFrame,
  parseRelationshipMailboxDepositFrameV2,
  parseRelationshipMailboxRequestFrameV2,
  parseRelayLinkOpenFrameV1,
  parseRelayReplicaPutFrameV1,
  parseRelayPeerRequestFrameV1,
  parseSearchRequestFrameV2,
  parseMessage,
  verifyMessage,
  createMessage,
  serializeMessage,
  serializeRelayLinkAcceptFrameV1,
  serializeRelayReplicaReceiptFrameV1,
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
  type RelayReplicaPutV1,
  type RelayReplicaReceiptV1,
  type RelayReplicaRejectionReasonV1,
} from '@resonance/core';
import { MatchingEngine, type MatchNotification } from './matching-engine.js';
import { RateLimiter } from './rate-limiter.js';
import { log } from './logger.js';
import { PublicationOperationStore, type PublicationApplyStatus } from './publication-store.js';
import { MailboxStore } from './mailbox-store.js';
import { MatchOperationStore } from './match-operation-store.js';
import { RelayOperationLog, type RelayOperationLogEntry } from './operation-log.js';
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
  adminApiKey: string | null;
  maxAuthAttemptsPerMin: number;
  maxPeerRequestsPerMin: number;
  maxReplicaRequestsPerMin: number;
  maxInboundRelayLinks: number;
  relayLinkHeartbeatIntervalMs: number;
  relayLinkHeartbeatTimeoutMs: number;
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
  mailbox_envelopes: number;
  stored_matches: number;
  journal_entries: number;
  connected_nodes: number;
  matches_today: number;
  known_relays: number;
  connected_relays: number;
  durability_receipts: number;
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
  stop(): Promise<void>;
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
};

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

export function createRelayServer(config?: Partial<RelayConfig>): RelayServer {
  const cfg = { ...DEFAULT_CONFIG, ...config };
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
  const operationLog = new RelayOperationLog(cfg.persistDir);

  const rateLimiter = new RateLimiter({
    maxPublishesPerMin: cfg.maxPublishesPerMin,
    maxSearchesPerMin: cfg.maxSearchesPerMin,
    maxDiscoveriesPerMin: cfg.maxPeerRequestsPerMin,
    maxReplicasPerMin: cfg.maxReplicaRequestsPerMin,
  });

  const relayIdentity = loadOrCreateRelayIdentity(cfg.persistDir);
  const relayDirectory = new RelayDirectory(
    cfg.relayDiscovery?.maxKnownRelays ?? 256,
    relayIdentity.did,
  );

  const seenSearches = new Map<string, number>();
  const seenPeerRequests = new Map<string, number>();
  const seenRelayLinks = new Map<string, number>();
  const seenReplicaRequests = new Map<string, number>();
  const inboundRelayLinks = new Map<string, {
    socket: WebSocket;
    descriptor: RelayDescriptorV1;
    lastPongAt: number;
  }>();
  let relayDescriptor: RelayDescriptorV1 | null = null;
  let relayDescriptorSequence = Date.now();

  let httpServer: Server;
  let wss: WebSocketServer;
  let publicationExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;
  let relayLinkHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const startTime = Date.now();

  function getOwnRelayDescriptor(now = Date.now()): RelayDescriptorV1 | null {
    const discovery = cfg.relayDiscovery;
    if (!discovery) return null;
    const lifetimeMs = discovery.descriptorLifetimeMs ?? 60 * 60_000;
    const refreshWindowMs = Math.min(60_000, Math.floor(lifetimeMs / 4));
    if (!relayDescriptor || relayDescriptor.expiresAt - now <= refreshWindowMs) {
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
        storage: discovery.storage,
        issuedAt: now,
        expiresAt: now + lifetimeMs,
      }, relayIdentity);
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
      onEvent(event) {
        log(event.kind === 'failed' ? 'warn' : 'info', `relay_link_${event.kind}`, {
          endpoint: event.endpoint,
          relayId: event.relayId,
          error: event.error,
        });
      },
    })
    : null;

  function connectedRelayIds(): string[] {
    const ids = new Set(inboundRelayLinks.keys());
    for (const relayId of outboundRelayLinks?.status().connectedRelayIds ?? []) ids.add(relayId);
    return [...ids].sort();
  }

  function replayOperation(entry: RelayOperationLogEntry): void {
    if (entry.kind === 'publication') {
      const result = publicationStore.apply(entry.operation);
      if (result.status !== 'accepted' && result.status !== 'duplicate') {
        throw new Error(`Cannot replay publication operation: ${result.status}`);
      }
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
    mailboxStore.acknowledge(entry.request.mailboxId, entry.request.envelopeIds);
  }

  function commitMailboxDeposit(
    request: MailboxDepositRequest | RelationshipMailboxDepositV2,
  ): 'accepted' | 'duplicate' {
    const envelope = request.envelope;
    if (mailboxStore.hasEnvelope(envelope.mailboxId, envelope.envelopeId)) return 'duplicate';
    operationLog.append({ kind: 'mailbox-deposit', request });
    return mailboxStore.enqueue(envelope);
  }

  function commitMailboxAcknowledgement(
    request: MailboxRequest | RelationshipMailboxRequestV2,
  ): number {
    const present = mailboxStore.presentEnvelopeIds(request.mailboxId, request.envelopeIds);
    if (present.length === 0) return 0;
    operationLog.append({ kind: 'mailbox-ack', request });
    return mailboxStore.acknowledge(request.mailboxId, request.envelopeIds);
  }

  function commitMatch(notification: MatchNotification): void {
    const publisher = publicationStore.getRecord(notification.publisherDID);
    const matched = publicationStore.getRecord(notification.matchedDID);
    if (!publisher || !matched) return;
    const createdAt = Date.now();
    const expiresAt = Math.min(publisher.expiresAt, matched.expiresAt, createdAt + cfg.matchExpiryMs);
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

    // The signed match and both recipient deliveries are one durable fact.
    // Materialized views change only after the complete record reaches disk.
    operationLog.append({ kind: 'match', operation, envelopes: [...envelopes] });
    const result = matchStore.apply(operation);
    if (result.status !== 'accepted') throw new Error(`Cannot apply committed match: ${result.status}`);
    mailboxStore.enqueue(publisherEnvelope);
    mailboxStore.enqueue(matchedEnvelope);
    log('info', 'mailbox_match', { matchId: operation.matchId, operationId: operation.operationId });
  }

  function commitPublicationOperation(operation: PublicationOperation): PublicationApplyStatus {
    const result = publicationStore.evaluate(operation);
    if (result.status !== 'accepted' && result.status !== 'duplicate') return result.status;
    if (result.status === 'accepted') {
      operationLog.append({ kind: 'publication', operation });
      const applied = publicationStore.apply(operation);
      if (applied.status !== 'accepted') {
        throw new Error(`Cannot apply committed publication: ${applied.status}`);
      }
    }
    // Duplicate retries also repair a match whose atomic commit may have
    // failed after the publication itself reached disk.
    applyToMatchingIndex(operation);
    enforcePublicationExpiries();
    scheduleNextPublicationExpiry();
    return result.status;
  }

  function replicatePublicationOperation(operation: PublicationOperation): void {
    if (!outboundRelayLinks) return;
    void outboundRelayLinks.replicate(operation).then(receipts => {
      for (const receipt of receipts) {
        log(receipt.status === 'rejected' ? 'warn' : 'info', 'replica_receipt', {
          publicationId: receipt.publicationId,
          relayId: receipt.responderRelayId,
          status: receipt.status,
          reason: receipt.reason,
        });
      }
    }).catch(error => {
      log('warn', 'replica_placement_failed', {
        publicationId: operation.publicationId,
        error: String(error),
      });
    });
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
    if (removedEnvelopes > 0) log('info', 'mailbox_envelopes_expired', { count: removedEnvelopes });
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
      // VULN-07: Require API key if configured
      if (cfg.adminApiKey) {
        const url = new URL(req.url, 'http://localhost');
        if (url.searchParams.get('key') !== cfg.adminApiKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
      }
      enforcePublicationExpiries();
      const stats = engine.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        indexed_embeddings: stats.total,
        stored_publications: publicationStore.size,
        active_publications: publicationStore.activeRecords().length,
        retained_tombstones: publicationStore.tombstoneCount,
        mailbox_envelopes: mailboxStore.envelopeCount,
        stored_matches: matchStore.size,
        journal_entries: operationLog.length,
        connected_nodes: 0,
        matches_today: stats.matchesToday,
        known_relays: relayDirectory.size(),
        connected_relays: connectedRelayIds().length,
        durability_receipts: outboundRelayLinks?.status().durabilityReceiptCount ?? 0,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  }

  function sendReplicaReceipt(
    ws: WebSocket,
    request: RelayReplicaPutV1,
    result: {
      status: 'stored' | 'already-stored' | 'rejected';
      reason?: RelayReplicaRejectionReasonV1;
    },
  ): void {
    try {
      const receipt = createRelayReplicaReceiptV1(request, relayIdentity, result);
      ws.send(serializeRelayReplicaReceiptFrameV1(
        createRelayReplicaReceiptFrameV1(receipt),
      ), error => {
        if (error) ws.terminate();
      });
    } catch (error) {
      log('warn', 'replica_receipt_failed', {
        publicationId: request.operation.publicationId,
        error: String(error),
      });
      ws.terminate();
    }
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
    if (seenReplicaRequests.has(request.requestId)) {
      ws.close(4003, 'replayed_replica_placement');
      return;
    }
    seenReplicaRequests.set(request.requestId, request.expiresAt);

    const link = inboundRelayLinks.get(linkedRelayId);
    if (!link || link.socket !== ws || !link.descriptor.capabilities.replicaExchange) {
      ws.close(4003, 'replica_exchange_not_advertised');
      return;
    }
    if (!rateLimiter.check(`relay:${linkedRelayId}`, 'replica')) {
      sendReplicaReceipt(ws, request, { status: 'rejected', reason: 'rate-limited' });
      return;
    }

    const operation = request.operation;
    if (operation.kind === 'publication') {
      if (!isPublicationActive(operation, now)) {
        sendReplicaReceipt(ws, request, { status: 'rejected', reason: 'expired' });
        return;
      }
      if (!cfg.relayDiscovery?.supportedGroups.includes(operation.groupId)) {
        sendReplicaReceipt(ws, request, { status: 'rejected', reason: 'unsupported-group' });
        return;
      }
    }

    let status: PublicationApplyStatus;
    try {
      status = commitPublicationOperation(operation);
    } catch (error) {
      log('error', 'replica_commit_failed', {
        publicationId: operation.publicationId,
        senderRelayId: linkedRelayId,
        error: String(error),
      });
      sendReplicaReceipt(ws, request, { status: 'rejected', reason: 'persistence-failed' });
      return;
    }

    if (status === 'accepted' || status === 'duplicate') {
      sendReplicaReceipt(ws, request, {
        status: status === 'accepted' ? 'stored' : 'already-stored',
      });
    } else {
      sendReplicaReceipt(ws, request, {
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

        let result: PublicationApplyStatus;
        try {
          result = commitPublicationOperation(operation);
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
        if (accepted) replicatePublicationOperation(operation);
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
        let result: 'accepted' | 'duplicate';
        try {
          result = commitMailboxDeposit(request);
        } catch (err) {
          log('error', 'operation_commit_failed', { error: String(err) });
          sendOperationAck(ws, request.requestId, 'error', 'persistence_failed');
          return;
        }
        sendOperationAck(ws, request.requestId, 'ok', result);
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

        let result: 'accepted' | 'duplicate';
        try {
          result = commitMailboxDeposit(request);
        } catch (err) {
          log('error', 'operation_commit_failed', { error: String(err) });
          sendOperationAck(ws, request.requestId, 'error', 'persistence_failed');
          return;
        }
        sendOperationAck(ws, request.requestId, 'ok', result);
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
      const records = operationLog.load();
      for (const record of records) replayOperation(record.entry);
      mailboxStore.purgeExpired();

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
        for (const [requestId, expiresAt] of seenReplicaRequests) {
          if (expiresAt <= Date.now()) seenReplicaRequests.delete(requestId);
        }
        relayDirectory.prune();
        enforcePublicationExpiries();
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
    },

    async stop(): Promise<void> {
      if (publicationExpiryTimer) clearTimeout(publicationExpiryTimer);
      if (cleanupTimer) clearInterval(cleanupTimer);
      if (relayLinkHeartbeatTimer) clearInterval(relayLinkHeartbeatTimer);
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
      return {
        indexed_embeddings: stats.total,
        stored_publications: publicationStore.size,
        active_publications: publicationStore.activeRecords().length,
        retained_tombstones: publicationStore.tombstoneCount,
        mailbox_envelopes: mailboxStore.envelopeCount,
        stored_matches: matchStore.size,
        journal_entries: operationLog.length,
        connected_nodes: 0,
        matches_today: stats.matchesToday,
        known_relays: relayDirectory.size(),
        connected_relays: connectedRelayIds().length,
        durability_receipts: outboundRelayLinks?.status().durabilityReceiptCount ?? 0,
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
        inboundRelayIds: [...inboundRelayLinks.keys()].sort(),
      };
    },

    getReplicaReceipts(publicationId: string): RelayReplicaReceiptV1[] {
      return outboundRelayLinks?.receipts(publicationId) ?? [];
    },
  };
}

function replicaRejectionReason(status: PublicationApplyStatus): RelayReplicaRejectionReasonV1 {
  if (status === 'stale' || status === 'conflict' || status === 'terminal' || status === 'invalid') {
    return status;
  }
  return 'invalid';
}

function supportsAnyGroup(descriptor: RelayDescriptorV1, groups: string[]): boolean {
  return groups.length === 0 || groups.some(group => descriptor.supportedGroups.includes(group));
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
