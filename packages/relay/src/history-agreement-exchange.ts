/** Bounded one-request connections for the experimental agreement protocol. */
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { assertSecureRelayTransportEndpoint } from '@resonance/core';
import { HISTORY_AGREEMENT_MAX_FRAME_BYTES, type HistoryAgreementFrame } from '@resonance/core/history-agreement';
import { HISTORY_ENVELOPE_MAX_BYTES } from '@resonance/core/history-checkpoint';
import { HISTORY_AGREEMENT_DATA_MAX_BYTES, type HistoryAgreementDataFrame } from '@resonance/core/history-agreement-data';
import type { HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';
import type { createHistoryAgreementReplica } from './history-checkpoint-agreement.js';
import { HISTORY_PROVISION_MAX_BYTES, type HistoryProvisionRequest } from '@resonance/core/history-provision';
import { HISTORY_EXCHANGE_MAX_BYTES } from './history-checkpoint-exchange.js';

export type HistoryAgreementTransport = (member: HistoryReplicaEndpoint, frame: HistoryAgreementFrame, signal: AbortSignal) => Promise<unknown>;
const PATH = '/history-agreement', DATA_PATH = '/history-agreement-data';
const PROVISION_PATH = '/history-provision', CHECKPOINT_PATH = '/history-checkpoint';
export type HistoryAgreementDataTransport = (member: HistoryReplicaEndpoint, frame: HistoryAgreementDataFrame, signal: AbortSignal) => Promise<unknown>;
export const HISTORY_AGREEMENT_MAX_RESPONSE_BYTES = 64 * 1024;

/** Loopback only. Remote deployment needs an explicitly configured TLS proxy. */
export async function listenHistoryAgreementReplica(role: Pick<ReturnType<typeof createHistoryAgreementReplica>, 'exchange' | 'transfer'> & {
  provision?(value: unknown): unknown; checkpoint?(value: unknown): unknown;
}, options: {
  port?: number; maxConnections?: number; connectionTimeoutMs?: number;
} = {}) {
  const limit = options.maxConnections ?? 4, timeoutMs = options.connectionTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 50 || timeoutMs > 30_000) throw new Error('Invalid agreement listener bounds');
  const http = createServer({ maxHeaderSize: 4096 }, (_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: HISTORY_AGREEMENT_MAX_FRAME_BYTES, perMessageDeflate: false });
  const dataWss = new WebSocketServer({ noServer: true, maxPayload: HISTORY_AGREEMENT_DATA_MAX_BYTES, perMessageDeflate: false });
  const provisionWss = new WebSocketServer({ noServer: true, maxPayload: HISTORY_PROVISION_MAX_BYTES, perMessageDeflate: false });
  const checkpointWss = new WebSocketServer({ noServer: true, maxPayload: HISTORY_EXCHANGE_MAX_BYTES, perMessageDeflate: false });
  const servers = [wss, dataWss, provisionWss, checkpointWss];
  const sockets = new Set<Socket>(), deadlines = new WeakMap<object, number>();
  let closing = false;
  http.maxConnections = limit;
  http.on('connection', socket => {
    deadlines.set(socket, performance.now() + timeoutMs); sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    socket.once('close', () => { sockets.delete(socket); clearTimeout(timer); });
  });
  http.on('upgrade', (request, socket, head) => {
    const route = request.url === PATH ? { server: wss, max: HISTORY_AGREEMENT_MAX_FRAME_BYTES, reply: HISTORY_AGREEMENT_MAX_RESPONSE_BYTES, run: (v: unknown) => role.exchange(v) }
      : request.url === DATA_PATH ? { server: dataWss, max: HISTORY_AGREEMENT_DATA_MAX_BYTES, reply: HISTORY_ENVELOPE_MAX_BYTES + 4096, run: (v: unknown) => role.transfer(v) }
      : request.url === PROVISION_PATH && role.provision ? { server: provisionWss, max: HISTORY_PROVISION_MAX_BYTES, reply: 1024, run: (v: unknown) => role.provision!(v) }
      : request.url === CHECKPOINT_PATH && role.checkpoint ? { server: checkpointWss, max: HISTORY_EXCHANGE_MAX_BYTES, reply: HISTORY_EXCHANGE_MAX_BYTES, run: (v: unknown) => role.checkpoint!(v) } : null;
    if (closing || !route || servers.reduce((sum, s) => sum + s.clients.size, 0) >= limit) { socket.destroy(); return; }
    const { server, max: maxRequest } = route;
    server.handleUpgrade(request, socket, head, ws => {
      const deadline = deadlines.get(socket) ?? performance.now();
      let used = false;
      ws.on('error', () => {});
      ws.on('message', (payload, binary) => {
        const bytes = Buffer.isBuffer(payload) ? payload : Array.isArray(payload) ? Buffer.concat(payload) : Buffer.from(payload);
        if (used || closing || binary || performance.now() >= deadline || bytes.length > maxRequest) { ws.terminate(); return; }
        used = true;
        try {
          const encoded = JSON.stringify(route.run(JSON.parse(bytes.toString())));
          if (Buffer.byteLength(encoded) > route.reply) throw new Error('Oversized agreement reply');
          if (performance.now() >= deadline) { ws.terminate(); return; }
          ws.send(encoded, error => { if (error) ws.terminate(); else ws.close(1000, 'agreement_complete'); });
        } catch { ws.close(4003, 'agreement_refused'); }
      });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(options.port ?? 0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
  } catch (error) { servers.forEach(s => s.close()); throw error; }
  return {
    endpoint: `ws://127.0.0.1:${(http.address() as AddressInfo).port}${PATH}`,
    checkpointEndpoint: `ws://127.0.0.1:${(http.address() as AddressInfo).port}${CHECKPOINT_PATH}`,
    async close() {
      if (closing) return; closing = true;
      const closed = new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      for (const server of servers) for (const ws of server.clients) ws.terminate();
      await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); await closed;
    },
  };
}

export type HistoryProvisionTransport = (member: HistoryReplicaEndpoint, request: HistoryProvisionRequest, signal: AbortSignal) => Promise<unknown>;
export function exchangeHistoryProvision(member: HistoryReplicaEndpoint, request: HistoryProvisionRequest, signal: AbortSignal): Promise<unknown> {
  assertSecureRelayTransportEndpoint(member.endpoint);
  if (request.replica !== member.publicKey) return Promise.reject(new Error('Wrong history provision target'));
  const encoded = JSON.stringify(request), endpoint = new URL(member.endpoint);
  if (Buffer.byteLength(encoded) > HISTORY_PROVISION_MAX_BYTES || endpoint.pathname !== PATH) return Promise.reject(new Error('Invalid history provision transport request'));
  endpoint.pathname = PROVISION_PATH;
  return exchange(endpoint.href, encoded, 1024, signal);
}

/** Low-level transport; the coordinator authenticates the reply against its original request. */
export function exchangeHistoryAgreement(member: HistoryReplicaEndpoint, frame: HistoryAgreementFrame,
  signal: AbortSignal, onTransportSocket?: (socket: Socket) => void): Promise<unknown> {
  assertSecureRelayTransportEndpoint(member.endpoint);
  if (frame.request.replica !== member.publicKey) return Promise.reject(new Error('Wrong agreement target'));
  const encoded = JSON.stringify(frame);
  if (Buffer.byteLength(encoded) > HISTORY_AGREEMENT_MAX_FRAME_BYTES) return Promise.reject(new Error('Agreement request too large'));
  return exchange(member.endpoint, encoded, frame.request.action === 'promise' ? HISTORY_AGREEMENT_MAX_RESPONSE_BYTES : 4096, signal, onTransportSocket);
}

export function exchangeHistoryAgreementData(member: HistoryReplicaEndpoint, frame: HistoryAgreementDataFrame,
  signal: AbortSignal, onTransportSocket?: (socket: Socket) => void): Promise<unknown> {
  assertSecureRelayTransportEndpoint(member.endpoint);
  if (frame.authorization.request.replica !== member.publicKey) return Promise.reject(new Error('Wrong agreement data target'));
  const encoded = JSON.stringify(frame), endpoint = new URL(member.endpoint);
  if (Buffer.byteLength(encoded) > HISTORY_AGREEMENT_DATA_MAX_BYTES) return Promise.reject(new Error('Agreement data request too large'));
  // Data and votes use separate bounded endpoints on the same pinned transport origin.
  if (endpoint.pathname !== PATH) return Promise.reject(new Error('Unexpected agreement endpoint'));
  endpoint.pathname = DATA_PATH;
  return exchange(endpoint.href, encoded, frame.action === 'read' ? HISTORY_ENVELOPE_MAX_BYTES + 4096 : 4096, signal, onTransportSocket);
}
function exchange(endpoint: string, encoded: string, maxPayload: number, signal: AbortSignal,
  onTransportSocket?: (socket: Socket) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket | undefined, settled = false;
    const deadline = performance.now() + 30_000;
    const finish = (value?: unknown, error?: Error) => {
      if (settled) return; settled = true;
      signal.removeEventListener('abort', abort); clearTimeout(timer); socket?.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(undefined, new Error('Agreement exchange cancelled'));
    const timer = setTimeout(() => finish(undefined, new Error('Agreement exchange timed out')), 30_000);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    try { socket = new WebSocket(endpoint, { handshakeTimeout: 10_000, maxPayload, perMessageDeflate: false, followRedirects: false }); }
    catch { finish(undefined, new Error('Agreement connection failed')); return; }
    socket.on('error', () => finish(undefined, new Error('Agreement connection failed')));
    socket.on('close', () => finish(undefined, new Error('Agreement connection closed')));
    socket.on('upgrade', response => {
      if (settled) return;
      try { onTransportSocket?.(response.socket); } catch { finish(undefined, new Error('Agreement socket accounting failed')); }
    });
    socket.on('open', () => {
      if (performance.now() >= deadline) finish(undefined, new Error('Agreement exchange timed out'));
      else if (!settled) socket!.send(encoded);
    });
    socket.on('message', (data, binary) => {
      if (settled) return;
      if (binary || performance.now() >= deadline) { finish(undefined, new Error('Invalid or late agreement response')); return; }
      try { finish(JSON.parse(data.toString())); } catch { finish(undefined, new Error('Invalid agreement response')); }
    });
  });
}
