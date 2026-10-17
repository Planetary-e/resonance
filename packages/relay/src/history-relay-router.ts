/** Explicit history-key → infrastructure-identity routing. No advertisements,
 * fallback identity, automatic membership change or transparent mutation retry. */
import WebSocket from 'ws';
import { HistoryRelayTurns } from './history-relay-turns.js';
import type { HistoryTransportHealth } from './history-health.js';
import { HistoryLinkBudget, HistoryRelayLink, type HistoryRoleHandler, type HistoryRoleMethod,
  type HistoryLinkMethod, type HistoryLinkContext } from './history-relay-link.js';
import { isHistoryRelayId, parseHistoryBridgeFrame, historyRoleResponseLimit,
  type HistoryRelayMemberRoute, type HistoryRelayBridgeRoute } from './history-relay-bridge.js';
import type { HistoryCheckpointTransport } from './history-checkpoint-exchange.js';
import type { HistoryAgreementTransport, HistoryAgreementDataTransport, HistoryProvisionTransport, HistoryCompactionTransport, HistoryCompactionControlTransport, HistoryFrontierTransport } from './history-agreement-exchange.js';

export class HistoryRelayRouter {
  private readonly pins = new Map<string, HistoryRelayMemberRoute>();
  private readonly bridgeRoutes: readonly HistoryRelayBridgeRoute[];
  private readonly multiplexed = new Set<string>();
  private readonly bridgeIngress = new HistoryLinkBudget(64 * 1024 * 1024, 4);
  private readonly allowed: string[];
  private readonly links = new Map<string, { socket: WebSocket; peer: HistoryRelayLink }>();
  private readonly budget = new HistoryLinkBudget();
  private readonly waiting = new Set<{ relayId: string; finish(error?: Error): void }>();
  private readonly timeoutMs: number;
  private readonly turns = new HistoryRelayTurns();
  private closed = false;
  constructor(private readonly options: {
    members?: readonly HistoryRelayMemberRoute[];
    bridgeRoutes?: readonly HistoryRelayBridgeRoute[];
    acceptForward?: (bytes: number) => boolean;
    /** Identities allowed to submit history requests. The role also verifies the owner's signed request. */
    acceptedRelayIds?: readonly string[];
    handler?: HistoryRoleHandler;
    /** Wait within the same RPC deadline for an authenticated pinned link. */
    waitForConnection?: boolean;
    /** Serialize unsent requests sharing one pinned socket within their original deadline. */
    serializeRequests?: boolean;
    timeoutMs?: number;
  }) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 50 || this.timeoutMs > 30_000) throw new Error('Invalid history routing deadline');
    for (const member of options.members ?? []) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(member.publicKey) || Buffer.from(member.publicKey, 'base64url').toString('base64url') !== member.publicKey
        || this.pins.has(member.publicKey)) throw new Error('Invalid history relay member pin');
      if (!isHistoryRelayId(member.relayId) || (member.viaRelayId !== undefined
        && (!isHistoryRelayId(member.viaRelayId) || member.viaRelayId === member.relayId))) throw new Error('Invalid history relay route');
      this.pins.set(member.publicKey, { ...member });
      if (member.viaRelayId) this.multiplexed.add(member.viaRelayId);
    }
    const accepted = options.acceptedRelayIds ?? [];
    this.bridgeRoutes = (options.bridgeRoutes ?? []).map(route => ({ ...route }));
    if (this.bridgeRoutes.length > 32 || this.bridgeRoutes.some(route => !isHistoryRelayId(route.controllerRelayId)
      || !isHistoryRelayId(route.targetRelayId) || route.controllerRelayId === route.targetRelayId)
      || new Set(this.bridgeRoutes.map(r => `${r.controllerRelayId}:${r.targetRelayId}`)).size !== this.bridgeRoutes.length) {
      throw new Error('Invalid history bridge routes');
    }
    this.allowed = [...new Set([...this.pins.values()].map(m => m.viaRelayId ?? m.relayId).concat(accepted,
      this.bridgeRoutes.flatMap(r => [r.controllerRelayId, r.targetRelayId])))];
    if (this.pins.size > 5 || new Set([...this.pins.values()].map(m => m.relayId)).size !== this.pins.size
      || this.allowed.length < 1 || this.allowed.length > 32 || this.allowed.some(id => !isHistoryRelayId(id))
      || (!!options.handler !== (accepted.length > 0))) throw new Error('Invalid history relay routing configuration');
    // Copy authorizations; changing the caller's arrays later cannot widen them.
    this.options = { handler: options.handler, acceptedRelayIds: [...accepted], acceptForward: options.acceptForward,
      waitForConnection: options.waitForConnection, serializeRequests: options.serializeRequests };
  }

  /** Called only after both directions of the signed relay handshake are checked. */
  attach(relayId: string, socket: WebSocket): void {
    if (this.closed || !this.allowed.includes(relayId)) return;
    const previous = this.links.get(relayId);
    if (previous?.socket === socket) return;
    previous?.peer.close();
    const receivesBridge = this.bridgeRoutes.some(route => route.controllerRelayId === relayId);
    const receivesRole = this.options.acceptedRelayIds!.includes(relayId);
    const peer = new HistoryRelayLink(socket, relayId, { allowedRelayIds: this.allowed, budget: this.budget,
      maxOutgoing: this.multiplexed.has(relayId) ? 4 : 1, maxIncoming: receivesBridge ? 4 : 1,
      incomingBudget: receivesBridge ? this.bridgeIngress : undefined,
      handler: receivesBridge || receivesRole ? (method, value, context) => {
        if (method === 'bridge') return this.forward(relayId, value, context);
        if (!receivesRole) throw new Error('History role is not authorized on this connection');
        return this.options.handler!(method, value, context);
      } : undefined });
    const entry = { peer, socket }; this.links.set(relayId, entry);
    socket.once('close', () => { if (this.links.get(relayId) === entry) this.links.delete(relayId); });
    for (const waiter of this.waiting) if (waiter.relayId === relayId) waiter.finish();
  }

  handle(raw: string, relayId: string, socket: WebSocket): void {
    const link = this.links.get(relayId);
    if (this.closed || !link || link.socket !== socket) { socket.close(4003, 'history_link_not_pinned'); return; }
    link.peer.handle(raw);
  }

  readonly checkpoint: HistoryCheckpointTransport = async (member, frame, signal) => {
    if (frame.request.replica !== member.publicKey) throw new Error('Wrong history relay target');
    return this.request(member.publicKey, 'checkpoint', frame, signal);
  };
  readonly agreement: HistoryAgreementTransport = async (member, frame, signal) => {
    if (frame.request.replica !== member.publicKey) throw new Error('Wrong history relay target');
    return this.request(member.publicKey, 'agreement', frame, signal);
  };
  readonly transfer: HistoryAgreementDataTransport = async (member, frame, signal) => {
    if (frame.authorization.request.replica !== member.publicKey) throw new Error('Wrong history relay target');
    return this.request(member.publicKey, 'transfer', frame, signal);
  };
  readonly provision: HistoryProvisionTransport = async (member, frame, signal) => {
    if (frame.replica !== member.publicKey) throw new Error('Wrong history relay target');
    return this.request(member.publicKey, 'provision', frame, signal);
  };
  readonly compaction: HistoryCompactionTransport = (member, proposal, signal) =>
    this.request(member.publicKey, 'compaction', proposal, signal);
  readonly compactionControl: HistoryCompactionControlTransport = (member, frame, signal) => {
    if (frame.request.replica !== member.publicKey) return Promise.reject(new Error('Wrong compaction control target'));
    return this.request(member.publicKey, 'compaction', frame, signal);
  };
  readonly frontier: HistoryFrontierTransport = (member, request, signal) => {
    if (request.replica !== member.publicKey) return Promise.reject(new Error('Wrong history frontier target'));
    return this.request(member.publicKey, 'compaction', request, signal);
  };

  private request(member: string, method: HistoryRoleMethod, frame: unknown, signal: AbortSignal) {
    const pin = this.pins.get(member);
    if (!pin) return Promise.reject(new Error('Pinned history relay link unavailable'));
    const maximum = historyRoleResponseLimit(method, frame);
    return pin.viaRelayId ? this.requestRelay(pin.viaRelayId, 'bridge', { version: 1, targetRelayId: pin.relayId, method, frame }, signal, maximum, true)
      : this.requestRelay(pin.relayId, method, frame, signal, maximum, !!this.options.serializeRequests);
  }

  private forward(source: string, raw: unknown, context: HistoryLinkContext) {
    const frame = parseHistoryBridgeFrame(raw);
    if (!this.bridgeRoutes.some(r => r.controllerRelayId === source && r.targetRelayId === frame.targetRelayId)
      || this.options.acceptForward?.(Buffer.byteLength(JSON.stringify(raw))) === false) throw new Error('History bridge route refused');
    return this.requestRelay(frame.targetRelayId, frame.method, frame.frame, context.signal,
      historyRoleResponseLimit(frame.method, frame.frame), true, context.deadline);
  }

  usage() { return this.budget.usage(); }
  health(): HistoryTransportHealth {
    if (this.closed) throw new Error('History router closed');
    const connected = (id: string) => this.links.get(id)?.socket.readyState === WebSocket.OPEN;
    const direct = [...this.pins.values()].filter(pin => !pin.viaRelayId);
    const targets = new Set(this.bridgeRoutes.map(route => route.targetRelayId));
    const controllers = new Set([...this.options.acceptedRelayIds!, ...this.bridgeRoutes.map(route => route.controllerRelayId)]);
    const usage = this.budget.usage();
    return { configuredMembers: this.pins.size, connectedDirectMembers: direct.filter(pin => connected(pin.relayId)).length,
      configuredOwnerBridges: this.multiplexed.size, connectedOwnerBridges: [...this.multiplexed].filter(connected).length,
      configuredBridgeRoutes: this.bridgeRoutes.length, connectedBridgeTargets: [...targets].filter(connected).length,
      configuredControllers: controllers.size, connectedControllers: [...controllers].filter(connected).length,
      operations: usage.operations, maximumOperations: this.budget.maxOperations, bufferBytes: usage.bytes, maximumBufferBytes: this.budget.maxBytes };
  }
  close(): void {
    if (this.closed) return; this.closed = true; this.turns.close();
    for (const waiter of this.waiting) waiter.finish(new Error('History routing closed'));
    for (const { peer } of this.links.values()) peer.close();
    this.links.clear();
  }
  private async requestRelay(relayId: string, method: HistoryLinkMethod, frame: unknown, signal: AbortSignal, maximum: number,
    serialize: boolean, cutoff = Infinity) {
    if (this.closed || !this.allowed.includes(relayId) || signal.aborted) throw new Error('Pinned history relay link unavailable');
    const now = performance.now(), deadline = Math.min(now + this.timeoutMs, cutoff);
    if (!Number.isFinite(deadline) || deadline <= now) throw new Error('History routing deadline expired');
    const controller = new AbortController();
    const cancel = () => controller.abort(), timer = setTimeout(cancel, deadline - now);
    signal.addEventListener('abort', cancel, { once: true });
    let releaseReservation: (() => void) | undefined, releaseTurn: (() => void) | undefined;
    try {
      releaseReservation = cutoff === Infinity ? this.budget.acquire() : await this.budget.acquireForward(controller.signal);
      if (serialize) releaseTurn = await this.turns.enter(relayId, controller.signal, this.multiplexed.has(relayId) ? 4 : 1);
      if (!this.links.has(relayId)) {
        if (!this.options.waitForConnection) throw new Error('Pinned history relay link unavailable');
        await new Promise<void>((resolve, reject) => {
          const abort = () => waiter.finish(new Error('History link wait cancelled or timed out'));
          const waiter = { relayId, finish: (error?: Error) => {
            if (!this.waiting.delete(waiter)) return;
            controller.signal.removeEventListener('abort', abort);
            if (error) reject(error); else resolve();
          } };
          this.waiting.add(waiter); controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        });
      }
      const link = this.links.get(relayId);
      if (this.closed || !link || controller.signal.aborted || performance.now() >= deadline) throw new Error('History link request cancelled or timed out');
      // The outer timer remains active; connecting cannot renew the exchange budget.
      releaseReservation();
      return await link.peer.request(method, frame, controller.signal, maximum, deadline);
    } finally {
      releaseReservation?.(); releaseTurn?.(); clearTimeout(timer); signal.removeEventListener('abort', cancel);
    }
  }
}
