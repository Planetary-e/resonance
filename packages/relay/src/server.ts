/**
 * Relay server: WebSocket + HTTP admin API.
 * Accepts self-authenticating protocol v2 operations over short connections.
 */

import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  MessageTypes,
  MAILBOX_DEPOSIT_FRAME_TYPE,
  MAILBOX_REQUEST_FRAME_TYPE,
  MAILBOX_RESPONSE_MESSAGE_TYPE,
  PUBLICATION_OPERATION_FRAME_TYPE,
  RELATIONSHIP_MAILBOX_DEPOSIT_FRAME_TYPE,
  RELATIONSHIP_MAILBOX_REQUEST_FRAME_TYPE,
  SEARCH_REQUEST_FRAME_TYPE,
  SEARCH_RESPONSE_MESSAGE_TYPE,
  createAdmissionRequestBindingV2,
  createMatchOperationV2,
  createMatchNoticeMessage,
  createSearchResponsePayloadV2,
  decodeBase64,
  encryptMatchNotice,
  hammingSimilarity,
  isPublicationActive,
  isSearchRequestActiveV2,
  parseMailboxDepositFrame,
  parseMailboxRequestFrame,
  parsePublicationOperationFrame,
  parseRelationshipMailboxDepositFrameV2,
  parseRelationshipMailboxRequestFrameV2,
  parseSearchRequestFrameV2,
  parseMessage,
  verifyMessage,
  createMessage,
  serializeMessage,
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
} from '@resonance/core';
import { MatchingEngine, type MatchNotification } from './matching-engine.js';
import { RateLimiter } from './rate-limiter.js';
import { log } from './logger.js';
import { PublicationOperationStore } from './publication-store.js';
import { MailboxStore } from './mailbox-store.js';
import { MatchOperationStore } from './match-operation-store.js';
import { RelayOperationLog, type RelayOperationLogEntry } from './operation-log.js';
import { loadOrCreateRelayIdentity } from './relay-identity-store.js';
import type { AdmissionCapabilityVerifierV2 } from './admission.js';

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
  uptime: number;
}

export interface RelayServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStats(): RelayStats;
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
};

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

export function createRelayServer(config?: Partial<RelayConfig>): RelayServer {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const engine = new MatchingEngine({ matchExpiryMs: cfg.matchExpiryMs, matchThreshold: cfg.matchThreshold });
  engine.initialize();
  const publicationStore = new PublicationOperationStore();
  const mailboxStore = new MailboxStore();
  const matchStore = new MatchOperationStore();
  const operationLog = new RelayOperationLog(cfg.persistDir);

  const rateLimiter = new RateLimiter({
    maxPublishesPerMin: cfg.maxPublishesPerMin,
    maxSearchesPerMin: cfg.maxSearchesPerMin,
  });

  const relayIdentity = loadOrCreateRelayIdentity(cfg.persistDir);

  const seenSearches = new Map<string, number>();

  let httpServer: Server;
  let wss: WebSocketServer;
  let publicationExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;
  const startTime = Date.now();

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
        uptime: Math.floor((Date.now() - startTime) / 1000),
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  }

  function handleConnection(ws: WebSocket, req: any): void {
    const ip = req?.socket?.remoteAddress ?? 'unknown';

    const authTimeout = setTimeout(() => {
      ws.close(4001, 'request_timeout');
    }, 10_000);

    ws.on('message', (data: Buffer) => {
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

        const result = publicationStore.evaluate(operation);
        const accepted = result.status === 'accepted' || result.status === 'duplicate';
        if (accepted) {
          try {
            if (result.status === 'accepted') {
              operationLog.append({ kind: 'publication', operation });
              const applied = publicationStore.apply(operation);
              if (applied.status !== 'accepted') throw new Error(`Cannot apply committed publication: ${applied.status}`);
            }
            // Duplicate retries also repair a match whose atomic commit may
            // have failed after the publication itself reached disk.
            applyToMatchingIndex(operation);
            enforcePublicationExpiries();
            scheduleNextPublicationExpiry();
          } catch (err) {
            log('error', 'operation_commit_failed', { error: String(err) });
            sendOperationAck(ws, operation.publicationId, 'error', 'persistence_failed');
            return;
          }
        }
        sendOperationAck(
          ws,
          operation.publicationId,
          accepted ? 'ok' : 'error',
          result.status,
        );
        log('info', 'publication_operation', {
          publicationId: operation.publicationId,
          kind: operation.kind,
          result: result.status,
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
      wss = new WebSocketServer({ server: httpServer });
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
        enforcePublicationExpiries();
      }, 5 * 60_000);
    },

    async stop(): Promise<void> {
      if (publicationExpiryTimer) clearTimeout(publicationExpiryTimer);
      if (cleanupTimer) clearInterval(cleanupTimer);

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
        uptime: Math.floor((Date.now() - startTime) / 1000),
      };
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
