/** Outbound authenticated relay link and reconnecting connection manager. */

import WebSocket, { type RawData } from 'ws';
import {
  MAX_RELAY_DISCOVERY_FRAME_BYTES,
  RELAY_REPLICA_RECEIPT_FRAME_TYPE,
  createRelayLinkOpenFrameV1,
  createRelayLinkOpenV1,
  createRelayReplicaPutFrameV1,
  createRelayReplicaPutV1,
  isDurabilityReceiptV1,
  isRelayLinkAcceptActiveV1,
  parseRelayLinkAcceptFrameV1,
  parseRelayReplicaReceiptFrameV1,
  serializeRelayLinkOpenFrameV1,
  serializeRelayReplicaPutFrameV1,
  verifyRelayReplicaReceiptV1,
  verifyRelayContactHintV1,
  type Identity,
  type PublicationOperation,
  type RelayContactHintV1,
  type RelayDescriptorV1,
  type RelayReplicaPutV1,
  type RelayReplicaReceiptV1,
} from '@resonance/core';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_PENDING_REPLICA_REQUESTS = 128;

export interface RelayLinkClientOptions {
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  replicaRequestTimeoutMs?: number;
  now?: () => number;
}

export interface RelayLinkClose {
  code: number;
  reason: string;
}

export interface RelayLinkConnection {
  readonly localRelayId: string;
  readonly remoteDescriptor: RelayDescriptorV1;
  readonly openedAt: number;
  readonly closed: Promise<RelayLinkClose>;
  isOpen(): boolean;
  placeReplica(operation: PublicationOperation): Promise<RelayReplicaReceiptV1>;
  close(): void;
}

export interface RelayLinkManagerOptions extends RelayLinkClientOptions {
  targets: RelayContactHintV1[];
  maxConnections?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  onEvent?: (event: RelayLinkManagerEvent) => void;
}

export interface RelayLinkManagerEvent {
  kind: 'connected' | 'disconnected' | 'failed';
  endpoint: string;
  relayId?: string;
  error?: string;
}

export interface RelayLinkManagerStatus {
  running: boolean;
  targetCount: number;
  connectedRelayIds: string[];
  durabilityReceiptCount: number;
}

export function connectRelayLinkV1(
  hint: RelayContactHintV1,
  localDescriptor: RelayDescriptorV1,
  identity: Identity,
  options: RelayLinkClientOptions = {},
): Promise<RelayLinkConnection> {
  if (!verifyRelayContactHintV1(hint)) return Promise.reject(new Error('Invalid relay contact hint'));
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 90_000;
  const replicaRequestTimeoutMs = options.replicaRequestTimeoutMs ?? 10_000;
  validateTiming(handshakeTimeoutMs, heartbeatIntervalMs, heartbeatTimeoutMs);
  if (!Number.isSafeInteger(replicaRequestTimeoutMs)
    || replicaRequestTimeoutMs < 100
    || replicaRequestTimeoutMs > 60_000) {
    return Promise.reject(new Error('Replica request timeout must be between 100 and 60000 ms'));
  }

  const clock = options.now ?? Date.now;
  const createdAt = clock();
  const request = createRelayLinkOpenV1(
    localDescriptor,
    identity,
    createdAt,
    createdAt + Math.min(30_000, handshakeTimeoutMs + 5_000),
  );
  const serialized = serializeRelayLinkOpenFrameV1(createRelayLinkOpenFrameV1(request));

  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    let accepted = false;
    let acceptedRemoteDescriptor: RelayDescriptorV1 | null = null;
    let settled = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let descriptorExpiryTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPongAt = createdAt;
    const pendingReplicas = new Map<string, {
      request: RelayReplicaPutV1;
      timer: ReturnType<typeof setTimeout>;
      resolve: (receipt: RelayReplicaReceiptV1) => void;
      reject: (error: Error) => void;
    }>();
    let resolveClosed!: (value: RelayLinkClose) => void;
    const closed = new Promise<RelayLinkClose>(resolveClosedPromise => {
      resolveClosed = resolveClosedPromise;
    });

    const failHandshake = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimer);
      if (socket.readyState === WebSocket.OPEN) socket.close(4000, 'invalid_link_handshake');
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      reject(error);
    };

    const handshakeTimer = setTimeout(() => {
      failHandshake(new Error('Relay link handshake timed out'));
    }, handshakeTimeoutMs);

    try {
      socket = new WebSocket(hint.endpoint, {
        handshakeTimeout: handshakeTimeoutMs,
        maxPayload: MAX_RELAY_DISCOVERY_FRAME_BYTES,
      });
    } catch (error) {
      clearTimeout(handshakeTimer);
      reject(asError(error, 'Cannot open relay link'));
      return;
    }

    socket.on('open', () => socket.send(serialized));
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (accepted) {
        if (isBinary) {
          socket.close(4000, 'relay_message_must_be_json');
          return;
        }
        let candidate: unknown;
        const raw = rawDataToString(data);
        try { candidate = JSON.parse(raw); } catch {
          socket.close(4000, 'invalid_relay_message');
          return;
        }
        if (!isObject(candidate) || candidate.type !== RELAY_REPLICA_RECEIPT_FRAME_TYPE) {
          socket.close(4000, 'unexpected_link_message');
          return;
        }
        try {
          const frame = parseRelayReplicaReceiptFrameV1(raw);
          const pending = pendingReplicas.get(frame.receipt.requestId);
          if (!pending
            || !verifyRelayReplicaReceiptV1(frame.receipt, pending.request)
            || frame.receipt.responderRelayId !== acceptedRemoteDescriptor?.relayId) {
            throw new Error('Replica receipt is not bound to this relay request');
          }
          clearTimeout(pending.timer);
          pendingReplicas.delete(frame.receipt.requestId);
          pending.resolve(frame.receipt);
        } catch {
          socket.close(4000, 'invalid_replica_receipt');
        }
        return;
      }
      if (isBinary) {
        failHandshake(new Error('Relay link acceptance must be UTF-8 JSON'));
        return;
      }
      try {
        const frame = parseRelayLinkAcceptFrameV1(rawDataToString(data));
        const receivedAt = clock();
        if (!isRelayLinkAcceptActiveV1(frame.response, request, receivedAt)) {
          throw new Error('Relay link acceptance is invalid or inactive');
        }
        const remoteDescriptor = frame.response.responderDescriptor;
        if (hint.expectedRelayId && remoteDescriptor.relayId !== hint.expectedRelayId) {
          throw new Error('Relay link responder does not match the pinned relay identity');
        }
        if (remoteDescriptor.reachability !== 'direct'
          || !remoteDescriptor.endpoints.includes(hint.endpoint)) {
          throw new Error('Relay link responder descriptor does not bind the contacted endpoint');
        }

        accepted = true;
        acceptedRemoteDescriptor = remoteDescriptor;
        settled = true;
        clearTimeout(handshakeTimer);
        lastPongAt = receivedAt;
        heartbeat = setInterval(() => {
          const now = clock();
          if (now - lastPongAt > heartbeatTimeoutMs) {
            socket.terminate();
            return;
          }
          if (socket.readyState === WebSocket.OPEN) socket.ping();
        }, heartbeatIntervalMs);
        heartbeat.unref?.();
        descriptorExpiryTimer = setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'relay_descriptor_refresh');
        }, Math.max(1, Math.min(
          localDescriptor.expiresAt - receivedAt,
          remoteDescriptor.expiresAt - receivedAt,
          MAX_TIMER_DELAY_MS,
        )));
        descriptorExpiryTimer.unref?.();

        resolve({
          localRelayId: localDescriptor.relayId,
          remoteDescriptor,
          openedAt: receivedAt,
          closed,
          isOpen: () => socket.readyState === WebSocket.OPEN,
          placeReplica: (operation) => {
            if (socket.readyState !== WebSocket.OPEN) {
              return Promise.reject(new Error('Relay link is not open'));
            }
            if (!remoteDescriptor.capabilities.replicaExchange) {
              return Promise.reject(new Error('Remote relay does not accept replica placement'));
            }
            if (pendingReplicas.size >= MAX_PENDING_REPLICA_REQUESTS) {
              return Promise.reject(new Error('Relay link replica request limit reached'));
            }
            const requestCreatedAt = clock();
            const replicaRequest = createRelayReplicaPutV1(
              operation,
              identity,
              requestCreatedAt,
              requestCreatedAt + Math.min(60_000, replicaRequestTimeoutMs + 5_000),
            );
            const replicaFrame = serializeRelayReplicaPutFrameV1(
              createRelayReplicaPutFrameV1(replicaRequest),
            );
            return new Promise<RelayReplicaReceiptV1>((resolveReplica, rejectReplica) => {
              const timer = setTimeout(() => {
                pendingReplicas.delete(replicaRequest.requestId);
                rejectReplica(new Error('Replica placement timed out'));
              }, replicaRequestTimeoutMs);
              timer.unref?.();
              pendingReplicas.set(replicaRequest.requestId, {
                request: replicaRequest,
                timer,
                resolve: resolveReplica,
                reject: rejectReplica,
              });
              socket.send(replicaFrame, error => {
                if (!error) return;
                const pending = pendingReplicas.get(replicaRequest.requestId);
                if (!pending) return;
                clearTimeout(pending.timer);
                pendingReplicas.delete(replicaRequest.requestId);
                pending.reject(asError(error, 'Cannot send replica placement'));
              });
            });
          },
          close: () => {
            if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'relay_link_closed');
            else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
          },
        });
      } catch (error) {
        failHandshake(asError(error, 'Invalid relay link acceptance'));
      }
    });
    socket.on('pong', () => { lastPongAt = clock(); });
    socket.on('error', error => {
      if (!accepted) failHandshake(asError(error, 'Relay link connection failed'));
    });
    socket.on('close', (code, reason) => {
      clearTimeout(handshakeTimer);
      if (heartbeat) clearInterval(heartbeat);
      if (descriptorExpiryTimer) clearTimeout(descriptorExpiryTimer);
      for (const pending of pendingReplicas.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Relay link closed before replica receipt (${code})`));
      }
      pendingReplicas.clear();
      if (!accepted) {
        failHandshake(new Error(`Relay link closed before acceptance (${code})`));
        return;
      }
      resolveClosed({ code, reason: reason.toString('utf8') });
    });
  });
}

export class RelayLinkManager {
  private readonly targets: RelayContactHintV1[];
  private readonly connections = new Map<string, RelayLinkConnection>();
  private readonly relayEndpoints = new Map<string, string>();
  private readonly attempts = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly durabilityReceipts = new Map<string, Map<string, RelayReplicaReceiptV1>>();
  private running = false;

  constructor(
    private readonly identity: Identity,
    private readonly descriptor: () => RelayDescriptorV1,
    private readonly options: RelayLinkManagerOptions,
  ) {
    const unique = new Map<string, RelayContactHintV1>();
    for (const hint of options.targets) {
      if (!verifyRelayContactHintV1(hint)) throw new Error('Invalid relay link target');
      const existing = unique.get(hint.endpoint);
      if (existing && existing.expectedRelayId !== hint.expectedRelayId) {
        throw new Error('Conflicting relay identity pins for one endpoint');
      }
      unique.set(hint.endpoint, { ...hint });
    }
    this.targets = [...unique.values()].sort((first, second) => (
      first.endpoint < second.endpoint ? -1 : first.endpoint > second.endpoint ? 1 : 0
    ));
    const maxConnections = options.maxConnections ?? 4;
    const reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
    const reconnectMaxMs = options.reconnectMaxMs ?? 60_000;
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 32) {
      throw new Error('Relay link target count must be between 1 and 32');
    }
    if (!Number.isSafeInteger(reconnectBaseMs) || reconnectBaseMs < 10
      || !Number.isSafeInteger(reconnectMaxMs)
      || reconnectMaxMs < reconnectBaseMs
      || reconnectMaxMs > MAX_TIMER_DELAY_MS) {
      throw new Error('Invalid relay link reconnect timing');
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const hint of this.targets) this.schedule(hint, 0);
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    this.relayEndpoints.clear();
  }

  status(): RelayLinkManagerStatus {
    return {
      running: this.running,
      targetCount: this.targets.length,
      connectedRelayIds: [...this.relayEndpoints.keys()].sort(),
      durabilityReceiptCount: [...this.durabilityReceipts.values()]
        .reduce((total, receipts) => total + receipts.size, 0),
    };
  }

  async replicate(operation: PublicationOperation): Promise<RelayReplicaReceiptV1[]> {
    const existing = this.durabilityReceipts.get(operation.publicationId);
    if (existing) {
      for (const [relayId, receipt] of existing) {
        if (receipt.operationSequence < operation.sequence
          || (receipt.operationSequence === operation.sequence
            && receipt.operationSignature !== operation.signature)) {
          existing.delete(relayId);
        }
      }
      if (existing.size === 0) this.durabilityReceipts.delete(operation.publicationId);
    }
    const results = await Promise.allSettled(
      [...this.connections.values()].map(connection => connection.placeReplica(operation)),
    );
    const receipts: RelayReplicaReceiptV1[] = [];
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const receipt = result.value;
      receipts.push(receipt);
      if (!isDurabilityReceiptV1(receipt)) continue;
      let byRelay = this.durabilityReceipts.get(receipt.publicationId);
      if (!byRelay) {
        byRelay = new Map();
        this.durabilityReceipts.set(receipt.publicationId, byRelay);
      }
      const current = byRelay.get(receipt.responderRelayId);
      if (!current || receipt.operationSequence >= current.operationSequence) {
        byRelay.set(receipt.responderRelayId, receipt);
      }
    }
    return receipts;
  }

  receipts(publicationId: string): RelayReplicaReceiptV1[] {
    return [...(this.durabilityReceipts.get(publicationId)?.values() ?? [])]
      .sort((first, second) => first.responderRelayId.localeCompare(second.responderRelayId))
      .map(receipt => ({ ...receipt }));
  }

  private schedule(hint: RelayContactHintV1, delayMs: number): void {
    if (!this.running || this.timers.has(hint.endpoint)) return;
    const timer = setTimeout(() => {
      this.timers.delete(hint.endpoint);
      void this.connect(hint);
    }, delayMs);
    timer.unref?.();
    this.timers.set(hint.endpoint, timer);
  }

  private async connect(hint: RelayContactHintV1): Promise<void> {
    if (!this.running || this.connections.has(hint.endpoint)) return;
    const maxConnections = this.options.maxConnections ?? 4;
    if (this.connections.size >= maxConnections) {
      this.schedule(hint, this.options.reconnectBaseMs ?? 1_000);
      return;
    }
    try {
      const connection = await connectRelayLinkV1(hint, this.descriptor(), this.identity, this.options);
      if (!this.running || this.connections.size >= maxConnections
        || this.relayEndpoints.has(connection.remoteDescriptor.relayId)) {
        connection.close();
        this.schedule(hint, this.options.reconnectBaseMs ?? 1_000);
        return;
      }
      this.connections.set(hint.endpoint, connection);
      this.relayEndpoints.set(connection.remoteDescriptor.relayId, hint.endpoint);
      this.attempts.set(hint.endpoint, 0);
      this.options.onEvent?.({
        kind: 'connected',
        endpoint: hint.endpoint,
        relayId: connection.remoteDescriptor.relayId,
      });
      const closed = await connection.closed;
      this.connections.delete(hint.endpoint);
      this.relayEndpoints.delete(connection.remoteDescriptor.relayId);
      this.options.onEvent?.({
        kind: 'disconnected',
        endpoint: hint.endpoint,
        relayId: connection.remoteDescriptor.relayId,
        error: `${closed.code}:${closed.reason}`,
      });
    } catch (error) {
      this.options.onEvent?.({
        kind: 'failed',
        endpoint: hint.endpoint,
        error: String(error),
      });
    }
    if (!this.running) return;
    const attempt = (this.attempts.get(hint.endpoint) ?? 0) + 1;
    this.attempts.set(hint.endpoint, attempt);
    const base = this.options.reconnectBaseMs ?? 1_000;
    const maximum = this.options.reconnectMaxMs ?? 60_000;
    const delay = Math.min(maximum, base * (2 ** Math.min(attempt - 1, 16)));
    this.schedule(hint, delay);
  }
}

function validateTiming(handshake: number, heartbeat: number, timeout: number): void {
  if (!Number.isSafeInteger(handshake) || handshake < 100 || handshake > 30_000) {
    throw new Error('Relay link handshake timeout must be between 100 and 30000 ms');
  }
  if (!Number.isSafeInteger(heartbeat) || heartbeat < 25
    || heartbeat > MAX_TIMER_DELAY_MS
    || !Number.isSafeInteger(timeout)
    || timeout <= heartbeat
    || timeout > MAX_TIMER_DELAY_MS) {
    throw new Error('Invalid relay link heartbeat timing');
  }
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
