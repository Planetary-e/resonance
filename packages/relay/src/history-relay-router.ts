/** Explicit history-key → infrastructure-identity routing. No advertisements,
 * fallback identity, automatic membership change or transparent mutation retry. */
import WebSocket from 'ws';
import { HistoryRelayTurns } from './history-relay-turns.js';
import { HISTORY_ENVELOPE_MAX_BYTES } from '@resonance/core/history-checkpoint';
import { HistoryLinkBudget, HistoryRelayLink, type HistoryLinkHandler, type HistoryLinkMethod } from './history-relay-link.js';
import { HISTORY_CONTINUATION_RESPONSE_MAX_BYTES, HISTORY_EXCHANGE_MAX_BYTES,
  type HistoryCheckpointTransport } from './history-checkpoint-exchange.js';
import { HISTORY_AGREEMENT_MAX_RESPONSE_BYTES, type HistoryAgreementTransport,
  type HistoryAgreementDataTransport, type HistoryProvisionTransport } from './history-agreement-exchange.js';

export class HistoryRelayRouter {
  private readonly pins = new Map<string, string>();
  private readonly allowed: string[];
  private readonly links = new Map<string, { socket: WebSocket; peer: HistoryRelayLink }>();
  private readonly budget = new HistoryLinkBudget();
  private readonly waiting = new Set<{ relayId: string; finish(error?: Error): void }>();
  private readonly timeoutMs: number;
  private readonly turns = new HistoryRelayTurns();
  private closed = false;
  constructor(private readonly options: {
    members?: readonly { publicKey: string; relayId: string }[];
    /** Identities allowed to submit history requests. The role also verifies the owner's signed request. */
    acceptedRelayIds?: readonly string[];
    handler?: HistoryLinkHandler;
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
      this.pins.set(member.publicKey, member.relayId);
    }
    const accepted = options.acceptedRelayIds ?? [];
    this.allowed = [...new Set([...this.pins.values(), ...accepted])];
    if (this.pins.size > 5 || new Set(this.pins.values()).size !== this.pins.size || this.allowed.length < 1 || this.allowed.length > 32
      || this.allowed.some(id => typeof id !== 'string' || !/^did:key:z[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(id))
      || (!!options.handler !== (accepted.length > 0))) throw new Error('Invalid history relay routing configuration');
    // Copy authorizations; changing the caller's arrays later cannot widen them.
    this.options = { handler: options.handler, acceptedRelayIds: [...accepted], waitForConnection: options.waitForConnection, serializeRequests: options.serializeRequests };
  }

  /** Called only after both directions of the signed relay handshake are checked. */
  attach(relayId: string, socket: WebSocket): void {
    if (this.closed || !this.allowed.includes(relayId)) return;
    const previous = this.links.get(relayId);
    if (previous?.socket === socket) return;
    previous?.peer.close();
    const peer = new HistoryRelayLink(socket, relayId, { allowedRelayIds: this.allowed, budget: this.budget,
      handler: this.options.acceptedRelayIds!.includes(relayId) ? this.options.handler : undefined });
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
    if (frame.request.replica !== member.publicKey) return Promise.reject(new Error('Wrong history relay target'));
    return this.request(member.publicKey, 'checkpoint', frame, signal, frame.request.action === 'read'
      ? HISTORY_EXCHANGE_MAX_BYTES : frame.request.action === 'continuation' ? HISTORY_CONTINUATION_RESPONSE_MAX_BYTES : 4096);
  };
  readonly agreement: HistoryAgreementTransport = async (member, frame, signal) => {
    if (frame.request.replica !== member.publicKey) return Promise.reject(new Error('Wrong history relay target'));
    return this.request(member.publicKey, 'agreement', frame, signal,
      frame.request.action === 'promise' ? HISTORY_AGREEMENT_MAX_RESPONSE_BYTES : 4096);
  };
  readonly transfer: HistoryAgreementDataTransport = async (member, frame, signal) => {
    if (frame.authorization.request.replica !== member.publicKey) return Promise.reject(new Error('Wrong history relay target'));
    return this.request(member.publicKey, 'transfer', frame, signal, frame.action === 'read' ? HISTORY_ENVELOPE_MAX_BYTES + 4096 : 4096);
  };
  readonly provision: HistoryProvisionTransport = async (member, frame, signal) => {
    if (frame.replica !== member.publicKey) return Promise.reject(new Error('Wrong history relay target'));
    return this.request(member.publicKey, 'provision', frame, signal, 1024);
  };

  usage() { return this.budget.usage(); }
  close(): void {
    if (this.closed) return; this.closed = true; this.turns.close();
    for (const waiter of this.waiting) waiter.finish(new Error('History routing closed'));
    for (const { peer } of this.links.values()) peer.close();
    this.links.clear();
  }
  private async request(member: string, method: HistoryLinkMethod, frame: unknown, signal: AbortSignal, maximum: number) {
    const relayId = this.pins.get(member);
    if (this.closed || !relayId || signal.aborted) throw new Error('Pinned history relay link unavailable');
    const controller = new AbortController(), deadline = performance.now() + this.timeoutMs;
    const cancel = () => controller.abort(), timer = setTimeout(cancel, this.timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    let releaseReservation: (() => void) | undefined, releaseTurn: (() => void) | undefined;
    try {
      releaseReservation = this.budget.acquire();
      if (this.options.serializeRequests) releaseTurn = await this.turns.enter(relayId, controller.signal);
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
