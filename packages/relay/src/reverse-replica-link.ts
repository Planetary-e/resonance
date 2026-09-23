/** Controller requests carried over a volunteer's already-authenticated outbound link. */

import WebSocket from 'ws';
import {
  MAX_RELAY_REPLICA_INVENTORY_BATCH_RECEIPTS,
  RELAY_MAILBOX_SYNC_RESPONSE_FRAME_TYPE,
  RELAY_REPLICA_INVENTORY_BATCH_RESPONSE_FRAME_TYPE,
  RELAY_REPLICA_RECONCILIATION_RESPONSE_FRAME_TYPE,
  RELAY_REPLICA_RECEIPT_FRAME_TYPE,
  createRelayMailboxSyncRequestV1,
  createRelayReplicaInventoryBatchRequestFrameV1,
  createRelayReplicaInventoryBatchRequestV1,
  createRelayReplicaPutFrameV1,
  createRelayReplicaPutV1,
  createRelayReplicaReconciliationRequestFrameV1,
  createRelayReplicaReconciliationRequestV1,
  isDurabilityReceiptV1,
  isRelayReplicaReconciliationReceiptV1,
  parseRelayMailboxSyncResponseFrameV1,
  parseRelayReplicaInventoryBatchResponseFrameV1,
  parseRelayReplicaReceiptFrameV1,
  parseRelayReplicaReconciliationResponseFrameV1,
  serializeRelayMailboxSyncRequestFrameV1,
  serializeRelayReplicaInventoryBatchRequestFrameV1,
  serializeRelayReplicaPutFrameV1,
  serializeRelayReplicaReconciliationRequestFrameV1,
  verifyRelayMailboxSyncResponseV1,
  verifyRelayReplicaInventoryBatchResponseV1,
  verifyRelayReplicaReceiptV1,
  verifyRelayReplicaReconciliationResponseV1,
  type Identity,
  type PublicationOperation,
  type RelayDescriptorV1,
  type RelayMailboxEventV1,
  type RelayMailboxSyncResponseV1,
  type RelayReplicaInventoryBatchResponseV1,
  type RelayReplicaReceiptV1,
  type RelayReplicaReconciliationResponseV1,
} from '@resonance/core';

export interface ReverseReplicaLink {
  socket: WebSocket;
  descriptor: RelayDescriptorV1;
}

interface Pending {
  socket: WebSocket;
  relayId: string;
  type: string;
  timer: ReturnType<typeof setTimeout>;
  accept: (raw: string) => void;
  reject: (error: Error) => void;
}

const RESPONSE_TYPES = new Set<string>([
  RELAY_REPLICA_RECEIPT_FRAME_TYPE,
  RELAY_REPLICA_INVENTORY_BATCH_RESPONSE_FRAME_TYPE,
  RELAY_REPLICA_RECONCILIATION_RESPONSE_FRAME_TYPE,
  RELAY_MAILBOX_SYNC_RESPONSE_FRAME_TYPE,
]);
const MAX_PENDING = 128;
const REQUEST_TIMEOUT_MS = 10_000;

export class ReverseReplicaRequests {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly identity: Identity,
    private readonly linkFor: (relayId: string) => ReverseReplicaLink | undefined,
  ) {}

  private send<T>(
    relayId: string, requestId: string, frame: string, type: string,
    parseAndVerify: (raw: string) => T, expiresAt: number,
  ): Promise<T> {
    const link = this.linkFor(relayId);
    if (!link || link.socket.readyState !== WebSocket.OPEN
      || link.descriptor.relayId !== relayId
      || !link.descriptor.capabilities.replicaExchange) {
      return Promise.reject(new Error('Reverse replica link is unavailable'));
    }
    if (this.pending.size >= MAX_PENDING || this.pending.has(requestId)) {
      return Promise.reject(new Error('Reverse replica request limit reached'));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Reverse replica request timed out'));
      }, Math.max(1, Math.min(REQUEST_TIMEOUT_MS, expiresAt - Date.now())));
      timer.unref?.();
      this.pending.set(requestId, {
        socket: link.socket, relayId, type, timer, reject,
        accept: raw => {
          try { resolve(parseAndVerify(raw)); }
          catch (error) {
            link.socket.close(4000, 'invalid_reverse_replica_response');
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
      link.socket.send(frame, error => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  /** Returns true for a replica response frame, including a harmless late reply. */
  handleResponse(raw: string, relayId: string, socket: WebSocket): boolean {
    let frame: { type?: string; receipt?: { requestId?: string }; response?: { requestId?: string } };
    try { frame = JSON.parse(raw); } catch { return false; }
    if (!frame || !RESPONSE_TYPES.has(frame.type ?? '')) return false;
    const requestId = frame.receipt?.requestId ?? frame.response?.requestId;
    if (!requestId) { socket.close(4000, 'invalid_reverse_replica_response'); return true; }
    const pending = this.pending.get(requestId);
    if (!pending) return true;
    if (pending.socket !== socket || pending.relayId !== relayId || pending.type !== frame.type) {
      socket.close(4000, 'unbound_reverse_replica_response');
      return true;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.accept(raw);
    return true;
  }

  failSocket(socket: WebSocket): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(new Error('Reverse replica link closed'));
    }
  }

  placeReplica(relayId: string, operation: PublicationOperation): Promise<RelayReplicaReceiptV1> {
    const request = createRelayReplicaPutV1(operation, this.identity);
    return this.send(relayId, request.requestId,
      serializeRelayReplicaPutFrameV1(createRelayReplicaPutFrameV1(request)),
      RELAY_REPLICA_RECEIPT_FRAME_TYPE, raw => {
        const { receipt } = parseRelayReplicaReceiptFrameV1(raw);
        if (!verifyRelayReplicaReceiptV1(receipt, request)
          || receipt.responderRelayId !== relayId) throw new Error('Invalid reverse replica receipt');
        return receipt;
      }, request.expiresAt);
  }

  checkReplicaBatch(
    relayId: string, receipts: readonly RelayReplicaReceiptV1[],
  ): Promise<RelayReplicaInventoryBatchResponseV1> {
    if (receipts.length < 1 || receipts.length > MAX_RELAY_REPLICA_INVENTORY_BATCH_RECEIPTS
      || receipts.some(receipt => !isDurabilityReceiptV1(receipt)
        || receipt.senderRelayId !== this.identity.did || receipt.responderRelayId !== relayId)) {
      return Promise.reject(new Error('Reverse inventory requires target-bound durability receipts'));
    }
    const request = createRelayReplicaInventoryBatchRequestV1(receipts, this.identity);
    return this.send(relayId, request.requestId,
      serializeRelayReplicaInventoryBatchRequestFrameV1(
        createRelayReplicaInventoryBatchRequestFrameV1(request)),
      RELAY_REPLICA_INVENTORY_BATCH_RESPONSE_FRAME_TYPE, raw => {
        const { response } = parseRelayReplicaInventoryBatchResponseFrameV1(raw);
        if (!verifyRelayReplicaInventoryBatchResponseV1(response, request)
          || response.responderRelayId !== relayId) throw new Error('Invalid reverse inventory response');
        return response;
      }, request.expiresAt);
  }

  reconcileReplica(
    relayId: string, receipt: RelayReplicaReceiptV1,
  ): Promise<RelayReplicaReconciliationResponseV1> {
    if (!isRelayReplicaReconciliationReceiptV1(receipt)
      || receipt.senderRelayId !== this.identity.did || receipt.responderRelayId !== relayId) {
      return Promise.reject(new Error('Reverse reconciliation requires a target-bound refusal'));
    }
    const request = createRelayReplicaReconciliationRequestV1(receipt, this.identity);
    return this.send(relayId, request.requestId,
      serializeRelayReplicaReconciliationRequestFrameV1(
        createRelayReplicaReconciliationRequestFrameV1(request)),
      RELAY_REPLICA_RECONCILIATION_RESPONSE_FRAME_TYPE, raw => {
        const { response } = parseRelayReplicaReconciliationResponseFrameV1(raw);
        if (!verifyRelayReplicaReconciliationResponseV1(response, request)
          || response.responderRelayId !== relayId) throw new Error('Invalid reverse reconciliation response');
        return response;
      }, request.expiresAt);
  }

  syncMailbox(
    relayId: string, receipt: RelayReplicaReceiptV1, cursor: number,
    events: RelayMailboxEventV1[],
  ): Promise<RelayMailboxSyncResponseV1> {
    if (!isDurabilityReceiptV1(receipt)
      || receipt.senderRelayId !== this.identity.did || receipt.responderRelayId !== relayId) {
      return Promise.reject(new Error('Reverse mailbox sync requires a target-bound receipt'));
    }
    const request = createRelayMailboxSyncRequestV1(receipt, cursor, events, this.identity);
    return this.send(relayId, request.requestId,
      serializeRelayMailboxSyncRequestFrameV1(request),
      RELAY_MAILBOX_SYNC_RESPONSE_FRAME_TYPE, raw => {
        const response = parseRelayMailboxSyncResponseFrameV1(raw);
        if (!verifyRelayMailboxSyncResponseV1(response, request)
          || response.senderRelayId !== relayId) throw new Error('Invalid reverse mailbox response');
        return response;
      }, request.expiresAt);
  }
}
