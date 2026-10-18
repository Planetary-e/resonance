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


export interface AdmissionPolicyObservationFrame { request: AdmissionPolicyHeadRequest; advance: AdmissionPolicyAdvance | null }
export const ADMISSION_POLICY_OBSERVATION_MAX_BYTES = ADMISSION_POLICY_ADVANCE_MAX_BYTES + 1024;
export type AdmissionPolicyObservationTransport = (member: AdmissionPolicyObservers['members'][number],
  frame: AdmissionPolicyObservationFrame, signal: AbortSignal) => Promise<unknown>;

export const MAX_POLICY_OBSERVER_EXCHANGES = 8;

export function createAdmissionPolicyObserverExchange(observer: {
  advance(value: unknown): Promise<unknown>; observe(request: unknown): unknown | Promise<unknown>;
  /** Explicit local implementation capability; never accepted from a peer. */
  maximumConcurrentObservations?: 1 | 2;
},
  contextValue: AdmissionPolicyObservers, now = Date.now) {
  const context = parseAdmissionPolicyObservers(contextValue);
  const maximumReaders = observer.maximumConcurrentObservations ?? 1;
  if (maximumReaders !== 1 && maximumReaders !== 2) throw new Error('Invalid observer read concurrency');
  let pending = 0, readers = 0, writing = false;
  type Job = { write: boolean; run(): Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void };
  const queue: Job[] = [];
  function drain() {
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
  return async (value: unknown) => {
    if (!exactWitnessFields(value, ['request', 'advance']) || Buffer.byteLength(JSON.stringify(value)) > ADMISSION_POLICY_OBSERVATION_MAX_BYTES) throw new Error('Invalid policy observation frame');
    if (pending >= MAX_POLICY_OBSERVER_EXCHANGES) throw new Error('Policy observer queue is full');
    const input = structuredClone(value), request = parseAdmissionPolicyHeadRequest(input.request, context, now());
    const deadline = performance.now() + request.expiresAt - now();
    const current = () => {
      if (performance.now() >= deadline) throw new Error('Policy observation expired in observer queue');
      parseAdmissionPolicyHeadRequest(request, context, now());
    };
    pending++;
    // Each reader has its own fresh history challenge. Two read-only checks may
    // overlap only when supported by the local observer. A queued policy update
    // is an exclusive FIFO barrier, so later readers cannot bypass it. Waiting
    // still consumes each caller's original monotonic and signed deadline.
    return new Promise<unknown>((resolve, reject) => {
      queue.push({ write: input.advance !== null, resolve, reject, async run() {
        current();
        if (input.advance !== null) await observer.advance(input.advance);
        current(); // Applied updates may outlive a request, but cannot return a late vote.
        const reply = await observer.observe(request); current(); return reply;
      } });
      drain();
    });
  };
}

/** No lifecycle authority: the caller owns the observer and closes it only after
 * this listener has awaited all work that was already admitted to its handler. */
export async function listenAdmissionPolicyObserver(exchange: (value: unknown) => Promise<unknown>, options: {
  port?: number; maxConnections?: number; connectionTimeoutMs?: number;
  onSocket?: (socket: Socket) => void;
  /** A fresh observation can cause replica traffic even without an update. */
  acceptNewWork?: (bytes: number) => boolean;
} = {}) {
  const limit = options.maxConnections ?? MAX_POLICY_OBSERVER_EXCHANGES, timeout = options.connectionTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 || !Number.isSafeInteger(timeout)
    || timeout < 50 || timeout > 30_000) throw new Error('Invalid policy observation listener bounds');
  const server = createServer({ maxHeaderSize: 4096 }, (_request, response) => { response.writeHead(404); response.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: ADMISSION_POLICY_OBSERVATION_MAX_BYTES, perMessageDeflate: false });
  const sockets = new Set<Socket>(), deadlines = new WeakMap<object, number>(), active = new Set<Promise<void>>();
  let stopped = false, stopping: Promise<void> | undefined;
  server.maxConnections = limit;
  server.on('connection', socket => {
    try { options.onSocket?.(socket); } catch { socket.destroy(); return; }
    sockets.add(socket); deadlines.set(socket, performance.now() + timeout);
    const timer = setTimeout(() => socket.destroy(), timeout);
    socket.once('close', () => { sockets.delete(socket); clearTimeout(timer); });
  });
  server.on('upgrade', (request, socket, head) => {
    if (stopped || request.url !== '/policy-head' || wss.clients.size >= limit) { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      const deadline = deadlines.get(socket) ?? performance.now(); let used = false;
      wss.emit('connection', ws, request); ws.on('error', () => {});
      ws.on('message', (data, binary) => {
        if (used || stopped || binary || performance.now() >= deadline) { ws.terminate(); return; }
        used = true;
        const work = (async () => {
          try {
            const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
            if (options.acceptNewWork?.(bytes.byteLength) === false) throw new Error('Policy observation paused by owner');
            const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
            const reply = await exchange(value), encoded = JSON.stringify(reply);
            if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > ADMISSION_POLICY_HEAD_MAX_BYTES) throw new Error('Policy observation reply exceeds its bound');
            if (stopped || performance.now() >= deadline || ws.readyState !== WebSocket.OPEN) { ws.terminate(); return; }
            ws.send(encoded, error => { if (error) ws.terminate(); else ws.close(1000, 'policy_observed'); });
          } catch { if (ws.readyState === WebSocket.OPEN) ws.close(4003, 'policy_observation_refused'); }
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
    try { socket = new WebSocket(member.endpoint, { ...relayTlsClientOptions, handshakeTimeout: 3000, maxPayload: ADMISSION_POLICY_HEAD_MAX_BYTES, followRedirects: false, perMessageDeflate: false }); }
    catch { finish(new Error('Policy observation connection failed')); return; }
    socket.on('error', () => finish(new Error('Policy observation connection failed')));
    socket.on('close', () => finish(new Error('Policy observation connection closed')));
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
