/** Experimental owner-authenticated exchange, separate from the live admission path. */
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { assertSecureRelayTransportEndpoint, relayTlsClientOptions, type SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointEnvelopeId, parseHistoryCheckpointContext,
  parseHistoryCheckpointEnvelope, parseHistoryFreeze, type HistoryFreeze,
  type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeResponse, parseHistoryExchangeRequest, parseHistoryExchangeResponse,
  type HistoryExchangeRequest, type HistoryExchangeResponse } from '@resonance/core/history-exchange';
import { historyCompactionCertificateId } from '@resonance/core/history-compaction-control';
import { parseHistoryCompactionCertificate, type HistoryCompactionCertificate } from '@resonance/core/history-compaction';
import type { openHistoryCheckpointStore } from './history-checkpoint-store.js';
import { HISTORY_SUCCESSOR_MAX_BYTES, historySuccessorProposalId, historySuccessorRepairId, parseHistorySuccessorProposal,
  type HistorySuccessorProposal } from '@resonance/core/history-successor';

export const HISTORY_EXCHANGE_MAX_BYTES = HISTORY_ENVELOPE_MAX_BYTES + HISTORY_SUCCESSOR_MAX_BYTES + 4096;
/** A certified boundary is at most 36 KiB; discovery never accepts a full checkpoint. */
export const HISTORY_CONTINUATION_RESPONSE_MAX_BYTES = 40 * 1024;
export interface HistoryReplicaEndpoint { publicKey: string; endpoint: string }
export interface HistoryExchangeFrame {
  request: HistoryExchangeRequest; envelope: HistoryCheckpointEnvelope | null;
  /** Required only for a freeze; separately owner-signed for durable replica storage. */
  freeze?: HistoryFreeze;
  successor?: HistorySuccessorProposal;
  /** Required only for a live checkpoint installation. */
  compaction?: HistoryCompactionCertificate;
}
export type HistoryCheckpointTransport = (member: HistoryReplicaEndpoint, frame: HistoryExchangeFrame, signal: AbortSignal) => Promise<unknown>;

export function createHistoryCheckpointReplica(options: {
  context: HistoryCheckpointContext; store: ReturnType<typeof openHistoryCheckpointStore>;
  signingKey: SigningKeyPair; acceptNew?: () => boolean; now?: () => number;
}) {
  const context = parseHistoryCheckpointContext(options.context), key = copyAdmissionSigningKey(options.signingKey);
  const replica = Buffer.from(key.publicKey).toString('base64url'), now = options.now ?? Date.now;
  let closed = false;
  try {
    if (!context.members.includes(replica)) throw new Error('History replica key is not pinned');
    // Also check the store's context/member pins, not only the visible root.
    if (!options.store.matches(context, replica)) throw new Error('History store belongs to another replica or context');
  } catch (error) { key.secretKey.fill(0); throw error; }
  return {
    exchange(value: unknown): HistoryExchangeResponse {
      if (closed) throw new Error('History replica is closed');
      if (!exactWitnessFields(value, ['request', 'envelope'])
        && !exactWitnessFields(value, ['request', 'envelope', 'freeze'])
        && !exactWitnessFields(value, ['request', 'envelope', 'successor'])
        && !exactWitnessFields(value, ['request', 'envelope', 'compaction'])) throw new Error('Invalid history exchange frame');
      const request = parseHistoryExchangeRequest(value.request, context, now()), head = options.store.describe();
      const fields = request.action === 'freeze' ? ['request', 'envelope', 'freeze']
        : request.action === 'repair' || request.action === 'seal' ? ['request', 'envelope', 'successor']
          : request.action === 'install' ? ['request', 'envelope', 'compaction'] : ['request', 'envelope'];
      if (!exactWitnessFields(value, fields)) {
        throw new Error('Unexpected history freeze payload');
      }
      if (request.replica !== replica || request.rootId !== head.rootId || request.generation !== head.generation) {
        throw new Error('History request does not match enrolment');
      }
      let status: HistoryExchangeResponse['status'], envelope: HistoryCheckpointEnvelope | null = null;
      if (request.action === 'seal') {
        const p = parseHistorySuccessorProposal(value.successor, context);
        if (value.envelope !== null || request.envelopeId !== historySuccessorProposalId(p)
          || request.sequence !== p.sequence) throw new Error('Successor request payload mismatch');
        options.store.seal(p); status = 'sealed';
      } else if (request.action === 'append' || request.action === 'repair' || request.action === 'install') {
        const incoming = parseHistoryCheckpointEnvelope(value.envelope, context);
        const successor = request.action === 'repair' ? parseHistorySuccessorProposal(value.successor, context) : null;
        if (incoming.generation !== request.generation || incoming.sequence !== request.sequence
          || (successor ? historySuccessorRepairId(successor, incoming) : historyCheckpointEnvelopeId(incoming)) !== request.envelopeId) {
          throw new Error('History request payload mismatch');
        }
        const compaction = request.action === 'install'
          ? parseHistoryCompactionCertificate(value.compaction, context, options.store.genesisId!, incoming) : null;
        if (compaction && historyCompactionCertificateId(compaction, context, options.store.genesisId!) !== request.certificateId) {
          throw new Error('Checkpoint installation proof does not match owner authorization');
        }
        const existing = options.store.envelopeIdAt(incoming.sequence);
        if (existing !== historyCheckpointEnvelopeId(incoming) && options.acceptNew?.() === false) throw new Error('History owner paused new storage');
        // Owner callbacks may close/freeze the role. Recheck before any write or signature escapes.
        if (closed) throw new Error('History replica is closed');
        parseHistoryExchangeRequest(request, context, now());
        if (compaction) {
          options.store.installCheckpoint(incoming, compaction, options.store.reviewDigest());
          if (request.reclaimPrefix) {
            if (closed) throw new Error('History replica is closed');
            parseHistoryExchangeRequest(request, context, now());
            const plan = options.store.planPrefixRetirement();
            options.store.retirePrefix(plan.approvalDigest);
          }
          status = 'installed';
        }
        else if (successor) { options.store.repair(incoming, successor); status = 'repaired'; }
        else { options.store.append(incoming); status = 'stored'; } // File + manifest durability precedes signing.
      } else {
        if (value.envelope !== null) throw new Error('Unexpected history request payload');
        if (request.action === 'freeze') {
          const freeze = parseHistoryFreeze(value.freeze, context);
          if (freeze.generation !== request.generation || freeze.nextGeneration !== request.sequence
            || freeze.challenge !== request.challenge) throw new Error('History freeze payload mismatch');
          options.store.freeze(freeze); // Flush the one-way barrier before signing any frozen head.
          status = 'frozen';
        } else if (request.action === 'head') status = 'head';
        else if (request.action === 'continuation') {
          envelope = options.store.activatedContinuation(); status = envelope ? 'continuation' : 'no-continuation';
        }
        else { envelope = options.store.envelopeAt(request.sequence); status = envelope ? 'block' : 'missing'; }
      }
      const response = createHistoryExchangeResponse(request, status, options.store.describe(), envelope, context, key);
      // A synchronous flush/verification may overrun the validity window.
      parseHistoryExchangeRequest(request, context, now());
      return response;
    },
    close() { if (!closed) { closed = true; key.secretKey.fill(0); } },
  };
}

/** Dedicated bounded loopback listener; Internet deployment needs a separately configured TLS proxy. */
export async function listenHistoryCheckpointReplica(role: ReturnType<typeof createHistoryCheckpointReplica>, options: {
  port?: number; maxConnections?: number; connectionTimeoutMs?: number;
} = {}) {
  const limit = options.maxConnections ?? 4, timeoutMs = options.connectionTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 50 || timeoutMs > 30_000) throw new Error('Invalid history listener bounds');
  const http = createServer({ maxHeaderSize: 4096 }, (_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: HISTORY_EXCHANGE_MAX_BYTES, perMessageDeflate: false });
  const sockets = new Set<Socket>();
  const deadlines = new WeakMap<object, number>();
  let closing = false;
  http.maxConnections = limit;
  http.on('connection', socket => {
    deadlines.set(socket, performance.now() + timeoutMs);
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    socket.once('close', () => clearTimeout(timer));
  });
  http.on('upgrade', (req, socket, head) => {
    if (closing || req.url !== '/history-checkpoint' || wss.clients.size >= limit) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const deadline = deadlines.get(socket) ?? performance.now();
      wss.emit('connection', ws, req);
      let used = false;
      ws.on('error', () => {}); // Protocol errors close this connection, not the listener.
      ws.on('message', (data, binary) => {
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        if (used || closing || binary || performance.now() >= deadline || bytes.length > HISTORY_EXCHANGE_MAX_BYTES) { ws.terminate(); return; }
        used = true;
        try {
          const response = role.exchange(JSON.parse(bytes.toString()));
          const encoded = JSON.stringify(response);
          if (Buffer.byteLength(encoded) > HISTORY_EXCHANGE_MAX_BYTES) throw new Error('Oversized history response');
          if (performance.now() >= deadline) { ws.terminate(); return; }
          ws.send(encoded, error => { if (error) ws.terminate(); else ws.close(1000, 'history_complete'); });
        } catch { ws.close(4003, 'history_refused'); }
      });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(options.port ?? 0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
  } catch (error) { wss.close(); throw error; }
  return {
    endpoint: `ws://127.0.0.1:${(http.address() as AddressInfo).port}/history-checkpoint`,
    async close() {
      if (closing) return; closing = true;
      const closed = new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      await closed;
    },
  };
}

/** The caller's AbortSignal bounds the complete exchange, including an established silent peer. */
export function exchangeHistoryCheckpoint(member: HistoryReplicaEndpoint, frame: HistoryExchangeFrame,
  signal: AbortSignal, onTransportSocket?: (socket: Socket) => void): Promise<unknown> {
  assertSecureRelayTransportEndpoint(member.endpoint);
  if (frame.request.replica !== member.publicKey) return Promise.reject(new Error('Wrong checkpoint target'));
  const encoded = JSON.stringify(frame);
  if (Buffer.byteLength(encoded) > HISTORY_EXCHANGE_MAX_BYTES) return Promise.reject(new Error('History request too large'));
  return new Promise((resolve, reject) => {
    let socket: WebSocket | undefined, settled = false;
    const deadline = performance.now() + 30_000;
    const finish = (value?: unknown, error?: Error) => {
      if (settled) return; settled = true;
      signal.removeEventListener('abort', abort); clearTimeout(timer); socket?.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(undefined, new Error('History exchange cancelled'));
    const timer = setTimeout(() => finish(undefined, new Error('History exchange timed out')), 30_000);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    try { socket = new WebSocket(member.endpoint, { ...relayTlsClientOptions, handshakeTimeout: 10_000, maxPayload: frame.request.action === 'read'
      ? HISTORY_EXCHANGE_MAX_BYTES : frame.request.action === 'continuation' ? HISTORY_CONTINUATION_RESPONSE_MAX_BYTES : 4096,
      perMessageDeflate: false, followRedirects: false }); }
    catch { finish(undefined, new Error('History connection failed')); return; }
    socket.on('error', () => finish(undefined, new Error('History connection failed')));
    socket.on('close', () => finish(undefined, new Error('History connection closed')));
    socket.on('upgrade', response => {
      if (settled) return;
      try { onTransportSocket?.(response.socket); } catch { finish(undefined, new Error('History socket accounting failed')); }
    });
    socket.on('open', () => {
      if (performance.now() >= deadline) finish(undefined, new Error('History exchange timed out'));
      else if (!settled) socket!.send(encoded);
    });
    socket.on('message', (data, binary) => {
      if (settled) return;
      if (binary || performance.now() >= deadline) { finish(undefined, new Error('Invalid or late history response')); return; }
      try { finish(JSON.parse(data.toString())); } catch { finish(undefined, new Error('Invalid history response')); }
    });
  });
}

/** Read one signed head, block or activated boundary; none proves global freshness. */
export async function readHistoryCheckpoint(member: HistoryReplicaEndpoint, request: HistoryExchangeRequest,
  context: HistoryCheckpointContext, signal: AbortSignal): Promise<HistoryExchangeResponse> {
  if (!['head', 'read', 'continuation'].includes(request.action)) throw new Error('Expected a history read request');
  const pinned = parseHistoryCheckpointContext(context), original = parseHistoryExchangeRequest(request, pinned, Date.now());
  const value = await exchangeHistoryCheckpoint(member, { request: original, envelope: null }, signal);
  if (signal.aborted) throw new Error('History exchange cancelled');
  parseHistoryExchangeRequest(original, pinned, Date.now());
  const response = parseHistoryExchangeResponse(value, original, pinned);
  if (signal.aborted) throw new Error('History exchange cancelled');
  parseHistoryExchangeRequest(original, pinned, Date.now());
  return response;
}
