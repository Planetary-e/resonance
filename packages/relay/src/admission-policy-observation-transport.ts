/** Experimental policy observation transport. The listener is loopback-only;
 * remote deployment needs a TLS terminator and an independently pinned context. */
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { assertSecureRelayTransportEndpoint, relayTlsClientOptions } from '@resonance/core';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { ADMISSION_POLICY_HEAD_MAX_BYTES, parseAdmissionPolicyHeadRequest, parseAdmissionPolicyObservers,
  type AdmissionPolicyHeadRequest, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { ADMISSION_POLICY_ADVANCE_MAX_BYTES, type AdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';


import { POLICY_ARCHIVE_PAGE_TYPE, POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES, policyArchivePageReply } from './policy-observer-page-transfer.js';

import type { ArchivedAdmissionPolicyAdvance } from '@resonance/core/admission-policy-archive';
export interface AdmissionPolicyObservationFrame { request: AdmissionPolicyHeadRequest; advance: ArchivedAdmissionPolicyAdvance | null }
export const ADMISSION_POLICY_OBSERVATION_MAX_BYTES = ADMISSION_POLICY_ADVANCE_MAX_BYTES + 1024;
export type AdmissionPolicyObservationTransport = (member: AdmissionPolicyObservers['members'][number],
  frame: AdmissionPolicyObservationFrame, signal: AbortSignal) => Promise<unknown>;

export const MAX_POLICY_OBSERVER_EXCHANGES = 8;

export function createAdmissionPolicyObserverExchange(observer: {
  advance(value: unknown): Promise<unknown>;
  advanceRemote?(value: unknown, request: {deadline: number; signal?: AbortSignal; check?: () => void}): Promise<unknown>; observe(request: unknown): unknown | Promise<unknown>;
  /** Explicit local implementation capability; never accepted from a peer. */
  archivePageAtHead?(head: unknown, digest: string, signal?: AbortSignal): Promise<Uint8Array>;
  archivePage?(digest: string, signal?: AbortSignal): Promise<Uint8Array>;
  status?(): { head: unknown };
  maximumConcurrentObservations?: 1 | 2;
  /** Opt-in local capability; the wire cannot select batch membership or validity checks. */
  maximumObservationBatchSize?: 1 | 2;
  observeBatch?(requests: readonly unknown[], checks: readonly (() => void)[]): Promise<PromiseSettledResult<unknown>[]>;
},
  contextValue: AdmissionPolicyObservers, now = Date.now) {
  const context = parseAdmissionPolicyObservers(contextValue);
  const maximumReaders = observer.maximumConcurrentObservations ?? 1;
  if (maximumReaders !== 1 && maximumReaders !== 2) throw new Error('Invalid observer read concurrency');
  const batchSize = observer.observeBatch && observer.maximumObservationBatchSize;
  if (batchSize !== undefined && (batchSize !== 1 && batchSize !== 2 || batchSize > maximumReaders)) throw new Error('Invalid observer batch size');
  let pending = 0, readers = 0, writing = false;
  let scheduled = false;
  type Job = { write: boolean; request: AdmissionPolicyHeadRequest; current(): void;
    run(): Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void };
  const queue: Job[] = [];
  function drainBatch() {
    if (writing || readers || !queue.length) return;
    if (queue[0].write) {
      const next = queue.shift()!; writing = true;
      const release = () => { pending--; writing = false; drain(); };
      void next.run().then(value => { release(); next.resolve(value); }, error => { release(); next.reject(error); });
      return;
    }
    const jobs: Job[] = [];
    while (queue.length && !queue[0].write && jobs.length < batchSize!) {
      const next = queue.shift()!;
      try { next.current(); jobs.push(next); }
      catch (error) { pending--; next.reject(error); }
    }
    if (!jobs.length) { drain(); return; }
    readers = jobs.length;
    // Membership is fixed now. Later arrivals cannot reuse this fresh collection.
    const release = () => { pending -= jobs.length; readers = 0; drain(); };
    void Promise.resolve().then(() => observer.observeBatch!(jobs.map(job => job.request), jobs.map(job => job.current)))
      .then(results => {
        if (!Array.isArray(results) || results.length !== jobs.length) throw new Error('Invalid local observer batch result');
        return results;
      }).then(results => {
        release();
        results.forEach((result, index) => {
          const job = jobs[index];
          try {
            job.current();
            if (result.status === 'fulfilled') job.resolve(result.value); else job.reject(result.reason);
          } catch (error) { job.reject(error); }
        });
      }, error => { release(); jobs.forEach(job => job.reject(error)); });
  }
  function drain() {
    if (batchSize) {
      if (!scheduled && !writing && !readers && queue.length) {
        scheduled = true;
        // Gather only callers already waiting by the next check phase; no timed window.
        setImmediate(() => { scheduled = false; drainBatch(); });
      }
      return;
    }
    while (!writing && queue.length) {
      const next = queue[0];
      if (next.write ? readers > 0 : readers >= maximumReaders) return;
      queue.shift(); if (next.write) writing = true; else readers++;
      const release = () => {
        pending--; if (next.write) writing = false; else readers--;
        drain();
      };
      void next.run().then(value => { release(); next.resolve(value); }, error => { release(); next.reject(error); });
    }
  }
  return async (value: unknown, signalOrIndex?: AbortSignal | number) => {
    // Preserve use as an Array.map callback in existing local batching callers.
    const signal = typeof signalOrIndex === 'number' ? undefined : signalOrIndex;
    signal?.throwIfAborted();
    if ((value as { type?: unknown })?.type === POLICY_ARCHIVE_PAGE_TYPE) {
      if (!observer.archivePage || !observer.status) throw new Error('Observer does not support archive page transfer');
      if (pending || writing || readers) throw new Error('Observer archive transfer is busy');
      pending++;
      try { return await policyArchivePageReply(value, context, observer.status().head, (digest, signal) => observer.archivePage!(digest, signal), observer.archivePageAtHead?.bind(observer), signal); }
      finally { pending--; }
    }
    if (!exactWitnessFields(value, ['request', 'advance']) || Buffer.byteLength(JSON.stringify(value)) > ADMISSION_POLICY_OBSERVATION_MAX_BYTES) throw new Error('Invalid policy observation frame');
    if (pending >= MAX_POLICY_OBSERVER_EXCHANGES) throw new Error('Policy observer queue is full');
    const input = structuredClone(value), request = parseAdmissionPolicyHeadRequest(input.request, context, now());
    const deadline = performance.now() + request.expiresAt - now();
    const current = () => {
      signal?.throwIfAborted();
      if (performance.now() >= deadline) throw new Error('Policy observation expired in observer queue');
      parseAdmissionPolicyHeadRequest(request, context, now());
    };
    pending++;
    // Explicit local batches share only a newly started history collection.
    // Every caller retains its own request, original deadline and signed vote.
    // Policy updates remain exclusive FIFO barriers on both paths.
    return new Promise<unknown>((resolve, reject) => {
      queue.push({ write: input.advance !== null, request, current, resolve, reject, async run() {
        current();
        if (input.advance !== null) {
          if ((input.advance as {policy?: {version?: unknown}})?.policy?.version === 3) {
            if (!observer.advanceRemote) throw new Error('Observer implementation refuses remote v3 archive ingestion');
            await observer.advanceRemote(input.advance, {deadline,signal,check:current});
          } else await observer.advance(input.advance);
        }
        current(); // Applied updates may outlive a request, but cannot return a late vote.
        const reply = await observer.observe(request); current(); return reply;
      } });
      drain();
    });
  };
}

export function policyObservationFailureCategory(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  switch (message) {
    case 'Policy observation expired in observer queue': return 'queue-expired';
    case 'Invalid or expired admission policy head request': return 'request-invalid-or-expired';
    case 'Policy observation completed too late': return 'observation-too-late';
    case 'Four current history heads unavailable': return 'history-quorum-unavailable';
    case 'Current history observation completed too late': return 'history-observation-too-late';
    case 'Four durable history acknowledgements unavailable': return 'history-write-quorum-unavailable';
    default: return 'unspecified';
  }
}
export interface PolicyObservationHandlerDiagnostic {
  phase: 'observation-handler'; category: ReturnType<typeof policyObservationFailureCategory>;
}

/** No lifecycle authority: the caller owns the observer and closes it only after
 * this listener has awaited all work that was already admitted to its handler. */
export async function listenAdmissionPolicyObserver(exchange: (value: unknown, signal?: AbortSignal) => Promise<unknown>, options: {
  port?: number; maxConnections?: number; connectionTimeoutMs?: number;
  /** Trusted local opt-in. One request at a time; the original connection expiry remains absolute. */
  allowSequentialRequests?: boolean;
  onSocket?: (socket: Socket) => void;
  onHandlerFailure?: (diagnostic: PolicyObservationHandlerDiagnostic) => void;
  /** A fresh observation can cause replica traffic even without an update. */
  acceptNewWork?: (bytes: number) => boolean;
} = {}) {
  const limit = options.maxConnections ?? MAX_POLICY_OBSERVER_EXCHANGES, timeout = options.connectionTimeoutMs ?? 10_000;
  const reusable = options.allowSequentialRequests ?? false;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 || !Number.isSafeInteger(timeout)
    || timeout < 50 || timeout > 30_000 || typeof reusable !== 'boolean') throw new Error('Invalid policy observation listener bounds');
  const server = createServer({ maxHeaderSize: 4096 }, (_request, response) => { response.writeHead(404); response.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: ADMISSION_POLICY_OBSERVATION_MAX_BYTES, perMessageDeflate: false });
  const sockets = new Set<Socket>(), connections = new WeakMap<object, { socket: Socket; deadline: number }>(), active = new Set<Promise<void>>();
  const idle = new Map<Socket, WebSocket>();
  let stopped = false, stopping: Promise<void> | undefined;
  function reserveAdmissionSlot(incoming = 0) {
    if (!reusable || [...sockets].filter(socket => !socket.destroyed).length + incoming < limit) return;
    // Node refuses the ninth physical socket before our connection handler.
    // Proactively retain at most limit-1 whenever a completed reusable socket
    // exists, so another owner can arrive without increasing the physical cap.
    // Destroyed sockets remain charged in sockets until their actual close event.
    for (const [socket, ws] of idle) {
      idle.delete(socket);
      if (socket.destroyed || ws.readyState !== WebSocket.OPEN) continue;
      ws.terminate(); return;
    }
  }
  server.maxConnections = limit;
  server.on('connection', socket => {
    try { options.onSocket?.(socket); } catch { socket.destroy(); return; }
    reserveAdmissionSlot(1);
    sockets.add(socket); connections.set(socket, { socket, deadline: performance.now() + timeout });
    const timer = setTimeout(() => socket.destroy(), timeout);
    socket.once('close', () => { sockets.delete(socket); idle.delete(socket); clearTimeout(timer); });
  });
  server.on('upgrade', (request, socket, head) => {
    if (stopped || request.url !== '/policy-head' || wss.clients.size >= limit) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      const connection = connections.get(socket), deadline = connection?.deadline ?? performance.now(); let used = false;
      wss.emit('connection', ws, request); ws.on('error', () => {});
      ws.on('message', (data, binary) => {
        if (used || stopped || binary || performance.now() >= deadline) { ws.terminate(); return; }
        if (connection) idle.delete(connection.socket);
        used = true;
        const controller = new AbortController(), abort = () => controller.abort();
        ws.once('close', abort);
        const work = (async () => {
          try {
            const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
            if (options.acceptNewWork?.(bytes.byteLength) === false) throw new Error('Policy observation paused by owner');
            const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
            const reply = await exchange(value,controller.signal), encoded = JSON.stringify(reply);
            if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > ((value as { type?: unknown })?.type === POLICY_ARCHIVE_PAGE_TYPE ? POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES : ADMISSION_POLICY_HEAD_MAX_BYTES)) throw new Error('Policy observation reply exceeds its bound');
            if (stopped || performance.now() >= deadline || ws.readyState !== WebSocket.OPEN) { ws.terminate(); return; }
            ws.send(encoded, error => {
              if (error) ws.terminate();
              else if (!reusable) ws.close(1000, 'policy_observed');
              else if (stopped || performance.now() >= deadline || ws.readyState !== WebSocket.OPEN || !connection) ws.terminate();
              else {
                used = false; idle.set(connection.socket, ws); reserveAdmissionSlot();
              }
            });
          } catch (error) {
            try {
              void Promise.resolve(options.onHandlerFailure?.({ phase: 'observation-handler', category: policyObservationFailureCategory(error) })).catch(() => {});
            } catch { /* Local diagnostics cannot affect refusal or cleanup. */ }
            if (ws.readyState === WebSocket.OPEN) ws.close(4003, 'policy_observation_refused');
          } finally { ws.removeListener('close',abort); controller.abort(); }
        })();
        active.add(work); void work.finally(() => active.delete(work));
      });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  } catch (error) { wss.close(); throw error; }
  return {
    endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/policy-head`,
    close() {
      if (stopping) return stopping;
      stopped = true;
      stopping = (async () => {
        const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        for (const socket of sockets) socket.destroy(); for (const socket of wss.clients) socket.terminate();
        await new Promise<void>(resolve => wss.close(() => resolve())); await closed; await Promise.all([...active]);
      })();
      return stopping;
    },
  };
}

/** Transport only; quorum collection authenticates every reply against its pin. */
export function exchangeAdmissionPolicyObservation(member: Parameters<AdmissionPolicyObservationTransport>[0],
  frame: Parameters<AdmissionPolicyObservationTransport>[1], signal: AbortSignal, onSocket?: (socket: Socket) => void): Promise<unknown> {
  return exchangeAdmissionPolicyObserverFrame(member, frame, signal, ADMISSION_POLICY_HEAD_MAX_BYTES, onSocket);
}
export function exchangeAdmissionPolicyObserverFrame(member: Parameters<AdmissionPolicyObservationTransport>[0],
  frame: unknown, signal: AbortSignal, replyMaximum: number, onSocket?: (socket: Socket) => void): Promise<unknown> {
  if (replyMaximum !== ADMISSION_POLICY_HEAD_MAX_BYTES && replyMaximum !== POLICY_ARCHIVE_PAGE_REPLY_MAX_BYTES) return Promise.reject(new Error('Invalid observer response bound'));
  try { assertSecureRelayTransportEndpoint(member.endpoint); } catch (error) { return Promise.reject(error); }
  let encoded: string;
  try { encoded = JSON.stringify(frame); if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > ADMISSION_POLICY_OBSERVATION_MAX_BYTES) throw new Error(); }
  catch { return Promise.reject(new Error('Invalid or oversized policy observation request')); }
  return new Promise((resolve, reject) => {
    let socket: WebSocket | undefined, done = false;
    const deadline = performance.now() + 30_000;
    const finish = (error?: Error, value?: unknown) => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); socket?.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error('Policy observation cancelled'));
    const timer = setTimeout(() => finish(new Error('Policy observation timed out')), 30_000);
    if (signal.aborted) { abort(); return; } signal.addEventListener('abort', abort, { once: true });
    try { socket = new WebSocket(member.endpoint, { ...relayTlsClientOptions, handshakeTimeout: 3000, maxPayload: replyMaximum, followRedirects: false, perMessageDeflate: false }); }
    catch { finish(new Error('Policy observation connection failed')); return; }
    socket.on('error', () => finish(new Error('Policy observation connection failed')));
    socket.on('close', code => finish(new Error(`Policy observation connection closed (${Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : 1006})`)));
    socket.on('upgrade', response => {
      if (done) return;
      try { onSocket?.(response.socket); } catch { finish(new Error('Policy observation accounting failed')); }
    });
    socket.on('open', () => {
      if (done) return;
      if (performance.now() >= deadline) { finish(new Error('Policy observation timed out')); return; }
      try { socket!.send(encoded); } catch { finish(new Error('Policy observation send failed')); }
    });
    socket.on('message', (data, binary) => {
      if (done) return;
      if (binary || performance.now() >= deadline) { finish(new Error('Invalid or late policy observation response')); return; }
      try { finish(undefined, JSON.parse(data.toString())); } catch { finish(new Error('Invalid policy observation response')); }
    });
  });
}
