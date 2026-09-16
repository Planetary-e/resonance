/** Outbound authenticated relay link and reconnecting connection manager. */

import WebSocket, { type RawData } from 'ws';
import {
  MAX_RELAY_DISCOVERY_FRAME_BYTES,
  MAX_RELAY_REPLICA_INVENTORY_BATCH_RECEIPTS,
  RELAY_REPLICA_INVENTORY_BATCH_RESPONSE_FRAME_TYPE,
  RELAY_REPLICA_INVENTORY_RESPONSE_FRAME_TYPE,
  RELAY_REPLICA_RECONCILIATION_RESPONSE_FRAME_TYPE,
  RELAY_REPLICA_RECEIPT_FRAME_TYPE,
  createRelayLinkOpenFrameV1,
  createRelayLinkOpenV1,
  createRelayReplicaInventoryRequestFrameV1,
  createRelayReplicaInventoryRequestV1,
  createRelayReplicaInventoryBatchRequestFrameV1,
  createRelayReplicaInventoryBatchRequestV1,
  createRelayReplicaReconciliationRequestFrameV1,
  createRelayReplicaReconciliationRequestV1,
  createRelayReplicaPutFrameV1,
  createRelayReplicaPutV1,
  isDurabilityReceiptV1,
  isRelayReplicaReconciliationReceiptV1,
  isRelayLinkAcceptActiveV1,
  parseRelayLinkAcceptFrameV1,
  parseRelayReplicaInventoryResponseFrameV1,
  parseRelayReplicaInventoryBatchResponseFrameV1,
  parseRelayReplicaReconciliationResponseFrameV1,
  parseRelayReplicaReceiptFrameV1,
  serializeRelayLinkOpenFrameV1,
  serializeRelayReplicaInventoryRequestFrameV1,
  serializeRelayReplicaInventoryBatchRequestFrameV1,
  serializeRelayReplicaReconciliationRequestFrameV1,
  serializeRelayReplicaPutFrameV1,
  verifyRelayReplicaInventoryResponseV1,
  verifyRelayReplicaInventoryBatchResponseV1,
  verifyRelayReplicaReconciliationResponseV1,
  verifyRelayReplicaReceiptV1,
  verifyRelayContactHintV1,
  type Identity,
  type PublicationOperation,
  type RelayContactHintV1,
  type RelayDescriptorV1,
  type RelayReplicaInventoryRequestV1,
  type RelayReplicaInventoryResponseV1,
  type RelayReplicaInventoryBatchRequestV1,
  type RelayReplicaInventoryBatchResponseV1,
  type RelayReplicaReconciliationRequestV1,
  type RelayReplicaReconciliationResponseV1,
  type RelayReplicaPutV1,
  type RelayReplicaReceiptV1,
} from '@resonance/core';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_PENDING_REPLICA_REQUESTS = 128;
const DEFAULT_DESCRIPTOR_REFRESH_INTERVAL_MS = 60_000;

export interface RelayLinkClientOptions {
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  replicaRequestTimeoutMs?: number;
  /** Re-authenticate the link to refresh signed peer metadata. */
  descriptorRefreshIntervalMs?: number;
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
  checkReplica(receipt: RelayReplicaReceiptV1): Promise<RelayReplicaInventoryResponseV1>;
  checkReplicaBatch(receipts: readonly RelayReplicaReceiptV1[]): Promise<RelayReplicaInventoryBatchResponseV1>;
  reconcileReplica(receipt: RelayReplicaReceiptV1): Promise<RelayReplicaReconciliationResponseV1>;
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

export interface ConnectedRelayPeer {
  relayId: string;
  endpoint: string;
  source: RelayContactHintV1['source'];
  descriptor: RelayDescriptorV1;
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
  const descriptorRefreshIntervalMs = options.descriptorRefreshIntervalMs
    ?? DEFAULT_DESCRIPTOR_REFRESH_INTERVAL_MS;
  validateTiming(handshakeTimeoutMs, heartbeatIntervalMs, heartbeatTimeoutMs);
  if (!Number.isSafeInteger(replicaRequestTimeoutMs)
    || replicaRequestTimeoutMs < 100
    || replicaRequestTimeoutMs > 60_000) {
    return Promise.reject(new Error('Replica request timeout must be between 100 and 60000 ms'));
  }
  if (!Number.isSafeInteger(descriptorRefreshIntervalMs)
    || descriptorRefreshIntervalMs < 100
    || descriptorRefreshIntervalMs > MAX_TIMER_DELAY_MS) {
    return Promise.reject(new Error('Descriptor refresh interval must be between 100 ms and the maximum timer delay'));
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
    const pendingInventories = new Map<string, {
      request: RelayReplicaInventoryRequestV1;
      timer: ReturnType<typeof setTimeout>;
      resolve: (response: RelayReplicaInventoryResponseV1) => void;
      reject: (error: Error) => void;
    }>();
    const pendingInventoryBatches = new Map<string, {
      request: RelayReplicaInventoryBatchRequestV1;
      timer: ReturnType<typeof setTimeout>;
      resolve: (response: RelayReplicaInventoryBatchResponseV1) => void;
      reject: (error: Error) => void;
    }>();
    const pendingReconciliations = new Map<string, {
      request: RelayReplicaReconciliationRequestV1;
      timer: ReturnType<typeof setTimeout>;
      resolve: (response: RelayReplicaReconciliationResponseV1) => void;
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
        if (!isObject(candidate)) {
          socket.close(4000, 'unexpected_link_message');
          return;
        }
        if (candidate.type === RELAY_REPLICA_RECEIPT_FRAME_TYPE) {
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
        if (candidate.type === RELAY_REPLICA_INVENTORY_RESPONSE_FRAME_TYPE) {
          try {
            const frame = parseRelayReplicaInventoryResponseFrameV1(raw);
            const pending = pendingInventories.get(frame.response.requestId);
            if (!pending
              || !verifyRelayReplicaInventoryResponseV1(frame.response, pending.request)
              || frame.response.responderRelayId !== acceptedRemoteDescriptor?.relayId) {
              throw new Error('Replica inventory response is not bound to this relay request');
            }
            clearTimeout(pending.timer);
            pendingInventories.delete(frame.response.requestId);
            pending.resolve(frame.response);
          } catch {
            socket.close(4000, 'invalid_replica_inventory_response');
          }
          return;
        }
        if (candidate.type === RELAY_REPLICA_INVENTORY_BATCH_RESPONSE_FRAME_TYPE) {
          try {
            const frame = parseRelayReplicaInventoryBatchResponseFrameV1(raw);
            const pending = pendingInventoryBatches.get(frame.response.requestId);
            if (!pending
              || !verifyRelayReplicaInventoryBatchResponseV1(frame.response, pending.request)
              || frame.response.responderRelayId !== acceptedRemoteDescriptor?.relayId) {
              throw new Error('Replica inventory batch response is not bound to this relay request');
            }
            clearTimeout(pending.timer);
            pendingInventoryBatches.delete(frame.response.requestId);
            pending.resolve(frame.response);
          } catch {
            socket.close(4000, 'invalid_replica_inventory_batch_response');
          }
          return;
        }
        if (candidate.type === RELAY_REPLICA_RECONCILIATION_RESPONSE_FRAME_TYPE) {
          try {
            const frame = parseRelayReplicaReconciliationResponseFrameV1(raw);
            const pending = pendingReconciliations.get(frame.response.requestId);
            if (!pending
              || !verifyRelayReplicaReconciliationResponseV1(frame.response, pending.request)
              || frame.response.responderRelayId !== acceptedRemoteDescriptor?.relayId) {
              throw new Error('Replica reconciliation response is not bound to this relay request');
            }
            clearTimeout(pending.timer);
            pendingReconciliations.delete(frame.response.requestId);
            pending.resolve(frame.response);
          } catch {
            socket.close(4000, 'invalid_replica_reconciliation_response');
          }
          return;
        }
        socket.close(4000, 'unexpected_link_message');
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
          descriptorRefreshIntervalMs,
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
            if (pendingReplicas.size + pendingInventories.size + pendingInventoryBatches.size
              + pendingReconciliations.size
              >= MAX_PENDING_REPLICA_REQUESTS) {
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
          checkReplica: (receipt) => {
            if (socket.readyState !== WebSocket.OPEN) {
              return Promise.reject(new Error('Relay link is not open'));
            }
            if (!remoteDescriptor.capabilities.replicaExchange) {
              return Promise.reject(new Error('Remote relay does not accept replica inventory checks'));
            }
            if (!isDurabilityReceiptV1(receipt)
              || receipt.senderRelayId !== localDescriptor.relayId
              || receipt.responderRelayId !== remoteDescriptor.relayId) {
              return Promise.reject(new Error('Replica inventory check requires this link\'s durability receipt'));
            }
            if (pendingReplicas.size + pendingInventories.size + pendingInventoryBatches.size
              + pendingReconciliations.size
              >= MAX_PENDING_REPLICA_REQUESTS) {
              return Promise.reject(new Error('Relay link replica request limit reached'));
            }
            const requestCreatedAt = clock();
            const inventoryRequest = createRelayReplicaInventoryRequestV1(
              receipt,
              identity,
              requestCreatedAt,
              requestCreatedAt + Math.min(60_000, replicaRequestTimeoutMs + 5_000),
            );
            const inventoryFrame = serializeRelayReplicaInventoryRequestFrameV1(
              createRelayReplicaInventoryRequestFrameV1(inventoryRequest),
            );
            return new Promise<RelayReplicaInventoryResponseV1>((resolveInventory, rejectInventory) => {
              const timer = setTimeout(() => {
                pendingInventories.delete(inventoryRequest.requestId);
                rejectInventory(new Error('Replica inventory check timed out'));
              }, replicaRequestTimeoutMs);
              timer.unref?.();
              pendingInventories.set(inventoryRequest.requestId, {
                request: inventoryRequest,
                timer,
                resolve: resolveInventory,
                reject: rejectInventory,
              });
              socket.send(inventoryFrame, error => {
                if (!error) return;
                const pending = pendingInventories.get(inventoryRequest.requestId);
                if (!pending) return;
                clearTimeout(pending.timer);
                pendingInventories.delete(inventoryRequest.requestId);
                pending.reject(asError(error, 'Cannot send replica inventory check'));
              });
            });
          },
          checkReplicaBatch: (receipts) => {
            if (socket.readyState !== WebSocket.OPEN) {
              return Promise.reject(new Error('Relay link is not open'));
            }
            if (!remoteDescriptor.capabilities.replicaExchange) {
              return Promise.reject(new Error('Remote relay does not accept replica inventory batches'));
            }
            if (receipts.length < 1
              || receipts.length > MAX_RELAY_REPLICA_INVENTORY_BATCH_RECEIPTS
              || receipts.some(receipt => !isDurabilityReceiptV1(receipt)
                || receipt.senderRelayId !== localDescriptor.relayId
                || receipt.responderRelayId !== remoteDescriptor.relayId)) {
              return Promise.reject(new Error('Replica inventory batch requires this link\'s durability receipts'));
            }
            if (pendingReplicas.size + pendingInventories.size + pendingInventoryBatches.size
              + pendingReconciliations.size >= MAX_PENDING_REPLICA_REQUESTS) {
              return Promise.reject(new Error('Relay link replica request limit reached'));
            }
            const requestCreatedAt = clock();
            const batchRequest = createRelayReplicaInventoryBatchRequestV1(
              receipts,
              identity,
              requestCreatedAt,
              requestCreatedAt + Math.min(60_000, replicaRequestTimeoutMs + 5_000),
            );
            const batchFrame = serializeRelayReplicaInventoryBatchRequestFrameV1(
              createRelayReplicaInventoryBatchRequestFrameV1(batchRequest),
            );
            return new Promise<RelayReplicaInventoryBatchResponseV1>((resolveBatch, rejectBatch) => {
              const timer = setTimeout(() => {
                pendingInventoryBatches.delete(batchRequest.requestId);
                rejectBatch(new Error('Replica inventory batch timed out'));
              }, replicaRequestTimeoutMs);
              timer.unref?.();
              pendingInventoryBatches.set(batchRequest.requestId, {
                request: batchRequest,
                timer,
                resolve: resolveBatch,
                reject: rejectBatch,
              });
              socket.send(batchFrame, error => {
                if (!error) return;
                const pending = pendingInventoryBatches.get(batchRequest.requestId);
                if (!pending) return;
                clearTimeout(pending.timer);
                pendingInventoryBatches.delete(batchRequest.requestId);
                pending.reject(asError(error, 'Cannot send replica inventory batch'));
              });
            });
          },
          reconcileReplica: (receipt) => {
            if (socket.readyState !== WebSocket.OPEN) {
              return Promise.reject(new Error('Relay link is not open'));
            }
            if (!remoteDescriptor.capabilities.replicaExchange) {
              return Promise.reject(new Error('Remote relay does not accept replica reconciliation'));
            }
            if (!isRelayReplicaReconciliationReceiptV1(receipt)
              || receipt.senderRelayId !== localDescriptor.relayId
              || receipt.responderRelayId !== remoteDescriptor.relayId) {
              return Promise.reject(new Error('Replica reconciliation requires this link\'s signed state refusal'));
            }
            if (pendingReplicas.size + pendingInventories.size + pendingInventoryBatches.size
              + pendingReconciliations.size
              >= MAX_PENDING_REPLICA_REQUESTS) {
              return Promise.reject(new Error('Relay link replica request limit reached'));
            }
            const requestCreatedAt = clock();
            const reconciliationRequest = createRelayReplicaReconciliationRequestV1(
              receipt,
              identity,
              requestCreatedAt,
              requestCreatedAt + Math.min(60_000, replicaRequestTimeoutMs + 5_000),
            );
            const reconciliationFrame = serializeRelayReplicaReconciliationRequestFrameV1(
              createRelayReplicaReconciliationRequestFrameV1(reconciliationRequest),
            );
            return new Promise<RelayReplicaReconciliationResponseV1>((resolveReconciliation, rejectReconciliation) => {
              const timer = setTimeout(() => {
                pendingReconciliations.delete(reconciliationRequest.requestId);
                rejectReconciliation(new Error('Replica reconciliation timed out'));
              }, replicaRequestTimeoutMs);
              timer.unref?.();
              pendingReconciliations.set(reconciliationRequest.requestId, {
                request: reconciliationRequest,
                timer,
                resolve: resolveReconciliation,
                reject: rejectReconciliation,
              });
              socket.send(reconciliationFrame, error => {
                if (!error) return;
                const pending = pendingReconciliations.get(reconciliationRequest.requestId);
                if (!pending) return;
                clearTimeout(pending.timer);
                pendingReconciliations.delete(reconciliationRequest.requestId);
                pending.reject(asError(error, 'Cannot send replica reconciliation request'));
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
      for (const pending of pendingInventories.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Relay link closed before replica inventory response (${code})`));
      }
      pendingInventories.clear();
      for (const pending of pendingInventoryBatches.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Relay link closed before replica inventory batch response (${code})`));
      }
      pendingInventoryBatches.clear();
      for (const pending of pendingReconciliations.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Relay link closed before replica reconciliation response (${code})`));
      }
      pendingReconciliations.clear();
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
    const maxConnections = options.maxConnections ?? 5;
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
    return this.replicateTo(operation, this.connectedPeers().map(peer => peer.relayId));
  }

  async replicateTo(
    operation: PublicationOperation,
    relayIds: Iterable<string>,
  ): Promise<RelayReplicaReceiptV1[]> {
    const requested = new Set(relayIds);
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
      [...this.connections.values()]
        .filter(connection => requested.has(connection.remoteDescriptor.relayId))
        .map(connection => connection.placeReplica(operation)),
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

  async checkReplicaReceipts(
    receipts: Iterable<RelayReplicaReceiptV1>,
  ): Promise<RelayReplicaInventoryResponseV1[]> {
    const byRelayId = new Map<string, RelayReplicaReceiptV1[]>();
    for (const receipt of receipts) {
      if (!isDurabilityReceiptV1(receipt) || receipt.senderRelayId !== this.identity.did) continue;
      const existing = byRelayId.get(receipt.responderRelayId);
      if (existing) existing.push(receipt);
      else byRelayId.set(receipt.responderRelayId, [receipt]);
    }
    const results = await Promise.allSettled(
      [...this.connections.values()].flatMap(connection => {
        const targetReceipts = byRelayId.get(connection.remoteDescriptor.relayId) ?? [];
        return targetReceipts.map(receipt => connection.checkReplica(receipt));
      }),
    );
    return results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  }

  async checkReplicaReceiptBatches(
    receipts: Iterable<RelayReplicaReceiptV1>,
  ): Promise<RelayReplicaInventoryBatchResponseV1[]> {
    const byRelayId = new Map<string, RelayReplicaReceiptV1[]>();
    for (const receipt of receipts) {
      if (!isDurabilityReceiptV1(receipt) || receipt.senderRelayId !== this.identity.did) continue;
      const existing = byRelayId.get(receipt.responderRelayId);
      if (existing) existing.push(receipt);
      else byRelayId.set(receipt.responderRelayId, [receipt]);
    }
    const requests = [...this.connections.values()].flatMap(connection => {
      const targetReceipts = byRelayId.get(connection.remoteDescriptor.relayId) ?? [];
      const chunks: RelayReplicaReceiptV1[][] = [];
      for (let index = 0; index < targetReceipts.length;
        index += MAX_RELAY_REPLICA_INVENTORY_BATCH_RECEIPTS) {
        chunks.push(targetReceipts.slice(index, index + MAX_RELAY_REPLICA_INVENTORY_BATCH_RECEIPTS));
      }
      return chunks.map(chunk => connection.checkReplicaBatch(chunk));
    });
    const results = await Promise.allSettled(requests);
    return results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  }

  async reconcileReplicaReceipts(
    receipts: Iterable<RelayReplicaReceiptV1>,
  ): Promise<RelayReplicaReconciliationResponseV1[]> {
    const byRelayId = new Map<string, RelayReplicaReceiptV1[]>();
    for (const receipt of receipts) {
      if (!isRelayReplicaReconciliationReceiptV1(receipt)
        || receipt.senderRelayId !== this.identity.did) continue;
      const existing = byRelayId.get(receipt.responderRelayId);
      if (existing) existing.push(receipt);
      else byRelayId.set(receipt.responderRelayId, [receipt]);
    }
    const results = await Promise.allSettled(
      [...this.connections.values()].flatMap(connection => {
        const targetReceipts = byRelayId.get(connection.remoteDescriptor.relayId) ?? [];
        return targetReceipts.map(receipt => connection.reconcileReplica(receipt));
      }),
    );
    return results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  }

  connectedPeers(): ConnectedRelayPeer[] {
    const hintsByEndpoint = new Map(this.targets.map(hint => [hint.endpoint, hint]));
    return [...this.connections.entries()]
      .map(([endpoint, connection]) => {
        const hint = hintsByEndpoint.get(endpoint);
        if (!hint) return undefined;
        return {
          relayId: connection.remoteDescriptor.relayId,
          endpoint,
          source: hint.source,
          descriptor: copyDescriptor(connection.remoteDescriptor),
        };
      })
      .filter((peer): peer is ConnectedRelayPeer => peer !== undefined)
      .sort((first, second) => first.relayId.localeCompare(second.relayId));
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
    const maxConnections = this.options.maxConnections ?? 5;
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
      if (closed.code === 1000 && closed.reason === 'relay_descriptor_refresh') {
        this.attempts.set(hint.endpoint, 0);
        if (this.running) this.schedule(hint, this.options.reconnectBaseMs ?? 1_000);
        return;
      }
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

function copyDescriptor(value: RelayDescriptorV1): RelayDescriptorV1 {
  return {
    ...value,
    endpoints: [...value.endpoints],
    capabilities: { ...value.capabilities },
    supportedGroups: [...value.supportedGroups],
    storage: { ...value.storage },
  };
}
