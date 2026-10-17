/** Bounded history RPC on an already authenticated, explicitly pinned relay link.
 * This transports signed protocol values; callers still verify every response. */
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { HISTORY_AGREEMENT_MAX_FRAME_BYTES } from '@resonance/core/history-agreement';
import { HISTORY_AGREEMENT_DATA_MAX_BYTES } from '@resonance/core/history-agreement-data';
import { HISTORY_ENVELOPE_MAX_BYTES } from '@resonance/core/history-checkpoint';
import { HISTORY_PROVISION_MAX_BYTES } from '@resonance/core/history-provision';
import { HISTORY_EXCHANGE_MAX_BYTES } from './history-checkpoint-exchange.js';
import { HISTORY_AGREEMENT_MAX_RESPONSE_BYTES } from './history-agreement-exchange.js';

export const HISTORY_LINK_FRAME_TYPE = 'relay_history_v1';
export const HISTORY_LINK_CHUNK_BYTES = 128 * 1024;
export const HISTORY_LINK_MAX_FRAME_BYTES = Math.ceil(HISTORY_LINK_CHUNK_BYTES * 4 / 3) + 1024;
const MAX_BUFFERED_BYTES = 256 * 1024;
const LIMITS = {
  checkpoint: [HISTORY_EXCHANGE_MAX_BYTES, HISTORY_EXCHANGE_MAX_BYTES],
  agreement: [HISTORY_AGREEMENT_MAX_FRAME_BYTES, HISTORY_AGREEMENT_MAX_RESPONSE_BYTES],
  transfer: [HISTORY_AGREEMENT_DATA_MAX_BYTES, HISTORY_ENVELOPE_MAX_BYTES + 4096],
  provision: [HISTORY_PROVISION_MAX_BYTES, 1024],
} as const;
export type HistoryLinkMethod = keyof typeof LIMITS;
export interface HistoryLinkContext { signal: AbortSignal; deadline: number }
export type HistoryLinkHandler = (method: HistoryLinkMethod, value: unknown, context: HistoryLinkContext) => unknown | Promise<unknown>;

/** Shared across all a relay's history links. These are buffer/operation caps,
 * not a claim about total JS heap: JSON parsing and protocol validation also cost memory. */
export class HistoryLinkBudget {
  private bytes = 0;
  private operations = 0;
  constructor(readonly maxBytes = 64 * 1024 * 1024, readonly maxOperations = 8) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024
      || !Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > 8) throw new Error('Invalid history link budget');
  }
  acquire(): () => void {
    if (this.operations >= this.maxOperations) throw new Error('History link capacity reached');
    this.operations++; let released = false;
    return () => { if (!released) { released = true; this.operations--; } };
  }
  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || this.bytes + bytes > this.maxBytes) throw new Error('History link buffer capacity reached');
    this.bytes += bytes; let released = false;
    return () => { if (!released) { released = true; this.bytes -= bytes; } };
  }
  usage() { return { bytes: this.bytes, operations: this.operations }; }
}

type Side = 'request' | 'response';
interface Payload {
  side: Side; data: Buffer; offset: number; release: () => void;
}
interface Exchange {
  id: string; local: boolean; method: HistoryLinkMethod; maxResponse: number;
  deadline: number; timer: ReturnType<typeof setTimeout>; release: () => void;
  sending?: Payload; receiving?: Payload; requestSent: boolean; runningHandler: boolean;
  resolve?: (value: unknown) => void; reject?: (error: Error) => void; removeAbort?: () => void;
  controller: AbortController;
}

/** Construct only after the signed socket handshake, never for an unverified descriptor.
 * Pins are checked again here before any history allocation. One request in each
 * direction is permitted on a socket; reconnection never resumes transport chunks. */
export class HistoryRelayLink {
  private readonly exchanges = new Map<string, Exchange>();
  private closed = false;
  private readonly onClose = () => this.close();
  private readonly timeoutMs: number;
  constructor(private readonly socket: WebSocket, readonly remoteRelayId: string, private readonly options: {
    allowedRelayIds: readonly string[]; budget: HistoryLinkBudget; handler?: HistoryLinkHandler; timeoutMs?: number;
  }) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!options.allowedRelayIds.includes(remoteRelayId) || socket.readyState !== WebSocket.OPEN
      || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 50 || this.timeoutMs > 30_000) {
      throw new Error('History relay link is not authorized');
    }
    socket.once('close', this.onClose);
  }

  request(method: HistoryLinkMethod, value: unknown, signal: AbortSignal, maxResponse = LIMITS[method]?.[1], deadline?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let state: Exchange | undefined;
      try {
        if (signal.aborted || this.closed || !Object.hasOwn(LIMITS, method)
          || !Number.isSafeInteger(maxResponse) || maxResponse < 1 || maxResponse > LIMITS[method][1]) throw new Error('History link request refused');
        state = this.begin(randomBytes(24).toString('base64url'), true, method, maxResponse, deadline);
        state.resolve = resolve; state.reject = reject;
        const original = state;
        const abort = () => this.finish(original, new Error('History link request cancelled'), true);
        signal.addEventListener('abort', abort, { once: true }); state.removeAbort = () => signal.removeEventListener('abort', abort);
        this.startPayload(state, 'request', value);
      } catch (error) {
        if (state) this.finish(state, new Error('History link request refused'), true);
        else reject(error);
      }
    });
  }

  /** Only dispatch HISTORY_LINK_FRAME_TYPE frames from this exact authenticated socket. */
  handle(raw: string): void {
    if (this.closed) return;
    try {
      if (Buffer.byteLength(raw) > HISTORY_LINK_MAX_FRAME_BYTES) throw new Error('Oversized history frame');
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid history frame');
      const frame = value as Record<string, unknown>;
      if (frame.type !== HISTORY_LINK_FRAME_TYPE || typeof frame.id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(frame.id)) throw new Error('Invalid history frame');
      if (frame.kind === 'open') { this.openPayload(frame); return; }
      if (frame.kind === 'cancel' || frame.kind === 'error') {
        if (!exactWitnessFields(frame, ['type', 'id', 'kind'])) throw new Error('Invalid history cancellation');
        const state = this.exchanges.get(frame.id);
        if (state) this.finish(state, new Error('History peer refused or cancelled the exchange'));
        return;
      }
      if (frame.kind === 'ack') {
        if (!exactWitnessFields(frame, ['type', 'id', 'kind', 'side', 'offset'])
          || !Number.isSafeInteger(frame.offset) || (frame.offset as number) < 0
          || (frame.side !== 'request' && frame.side !== 'response')) throw new Error('Invalid history acknowledgement');
        const state = this.exchanges.get(frame.id); if (!state) return; // Late frame after a local cancellation.
        this.live(state);
        const sending = state.sending;
        if (!sending || sending.side !== frame.side || sending.offset !== frame.offset) throw new Error('Unbound history acknowledgement');
        if (sending.offset === sending.data.length) {
          sending.release(); state.sending = undefined;
          if (state.local) state.requestSent = true;
          else this.finish(state);
          return;
        }
        const offset = sending.offset, end = Math.min(sending.data.length, offset + HISTORY_LINK_CHUNK_BYTES);
        const data = sending.data.subarray(offset, end).toString('base64url'); sending.offset = end;
        this.send({ id: state.id, kind: 'data', side: sending.side, offset, data }, state);
        return;
      }
      if (frame.kind !== 'data' || !exactWitnessFields(frame, ['type', 'id', 'kind', 'side', 'offset', 'data'])
        || (frame.side !== 'request' && frame.side !== 'response') || !Number.isSafeInteger(frame.offset)
        || (frame.offset as number) < 0 || typeof frame.data !== 'string'
        || frame.data.length > Math.ceil(HISTORY_LINK_CHUNK_BYTES * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(frame.data)) throw new Error('Invalid history chunk');
      const state = this.exchanges.get(frame.id); if (!state) return;
      this.live(state);
      const receiving = state.receiving, decoded = Buffer.from(frame.data, 'base64url');
      if (!receiving || receiving.side !== frame.side || receiving.offset !== frame.offset
        || decoded.toString('base64url') !== frame.data
        || decoded.length !== Math.min(HISTORY_LINK_CHUNK_BYTES, receiving.data.length - receiving.offset)) throw new Error('Unbound history chunk');
      decoded.copy(receiving.data, receiving.offset); receiving.offset += decoded.length;
      this.send({ id: state.id, kind: 'ack', side: receiving.side, offset: receiving.offset }, state);
      if (receiving.offset === receiving.data.length) {
        const value: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(receiving.data));
        this.live(state); // Parsing/validation work consumes the same complete-exchange deadline.
        receiving.release(); state.receiving = undefined;
        if (state.local) { state.resolve?.(value); this.finish(state); }
        else {
          state.runningHandler = true;
          // Any signature/authorization/storage failure returns only a generic refusal.
          Promise.resolve().then(() => {
            this.live(state);
            return this.options.handler!(state.method, value, { signal: state.controller.signal, deadline: state.deadline });
          })
            .then(response => { this.live(state); this.startPayload(state, 'response', response); })
            .catch(() => this.finish(state, new Error('History service refused the exchange'), true))
            .finally(() => {
              state.runningHandler = false;
              // Cancellation cannot make still-running service work disappear from the global cap.
              if (this.exchanges.get(state.id) !== state) state.release();
            });
        }
      }
    } catch {
      this.close(); this.socket.close(4000, 'invalid_history_link_frame');
    }
  }

  close(): void {
    if (this.closed) return; this.closed = true; this.socket.removeListener('close', this.onClose);
    for (const state of this.exchanges.values()) this.finish(state, new Error('History relay link closed'));
  }

  private begin(id: string, local: boolean, method: HistoryLinkMethod, maxResponse: number, cutoff?: number): Exchange {
    if (this.closed || this.exchanges.has(id) || [...this.exchanges.values()].some(s => s.local === local)) throw new Error('History link busy');
    const now = performance.now(), deadline = Math.min(cutoff ?? Infinity, now + this.timeoutMs);
    if (!Number.isFinite(deadline) || deadline <= now) throw new Error('History link deadline expired');
    const release = this.options.budget.acquire();
    const timer = setTimeout(() => this.finish(state, new Error('History link exchange timed out'), true), deadline - now);
    timer.unref?.();
    const state: Exchange = { id, local, method, maxResponse, deadline, timer, release, requestSent: false, runningHandler: false,
      controller: new AbortController() };
    this.exchanges.set(id, state); return state;
  }

  private openPayload(frame: Record<string, unknown>) {
    const local = frame.side === 'response';
    if ((frame.side !== 'request' && !local)
      || !exactWitnessFields(frame, local ? ['type', 'id', 'kind', 'side', 'bytes'] : ['type', 'id', 'kind', 'side', 'bytes', 'method', 'maxResponse'])
      || !Number.isSafeInteger(frame.bytes) || (frame.bytes as number) < 1) throw new Error('Invalid history payload');
    let state = this.exchanges.get(frame.id as string);
    if (local) {
      if (!state) return;
      if (!state.local || !state.requestSent || state.receiving || (frame.bytes as number) > state.maxResponse) throw new Error('Unbound history response');
    } else {
      if (typeof frame.method !== 'string' || !Object.hasOwn(LIMITS, frame.method)
        || (frame.bytes as number) > LIMITS[frame.method as HistoryLinkMethod][0]
        || !Number.isSafeInteger(frame.maxResponse) || (frame.maxResponse as number) < 1
        || (frame.maxResponse as number) > LIMITS[frame.method as HistoryLinkMethod][1]) throw new Error('Invalid history request limits');
      if (state) throw new Error('Repeated history request');
      if (!this.options.handler) { this.send({ id: frame.id, kind: 'error' }); return; }
      try { state = this.begin(frame.id as string, false, frame.method as HistoryLinkMethod, frame.maxResponse as number); }
      catch { this.send({ id: frame.id, kind: 'error' }); return; }
    }
    this.live(state);
    try {
      const release = this.options.budget.reserve(frame.bytes as number);
      try { state.receiving = { side: frame.side as Side, data: Buffer.alloc(frame.bytes as number), offset: 0, release }; }
      catch (error) { release(); throw error; }
      this.send({ id: state.id, kind: 'ack', side: frame.side, offset: 0 }, state);
    } catch { this.finish(state, new Error('History link capacity reached'), true); }
  }

  private startPayload(state: Exchange, side: Side, value: unknown) {
    this.live(state);
    const encoded = JSON.stringify(value), size = typeof encoded === 'string' ? Buffer.byteLength(encoded) : 0;
    if (!size || size > (side === 'request' ? LIMITS[state.method][0] : state.maxResponse)) throw new Error('History link payload too large');
    const release = this.options.budget.reserve(size);
    try { state.sending = { side, data: Buffer.from(encoded), offset: 0, release }; }
    catch (error) { release(); throw error; }
    this.send({ id: state.id, kind: 'open', side, bytes: size,
      ...(side === 'request' ? { method: state.method, maxResponse: state.maxResponse } : {}) }, state);
  }

  private live(state: Exchange) {
    if (this.closed || this.exchanges.get(state.id) !== state || performance.now() >= state.deadline
      || this.socket.readyState !== WebSocket.OPEN) throw new Error('History link exchange is no longer active');
  }

  private send(fields: Record<string, unknown>, state?: Exchange) {
    if (state) this.live(state);
    if (this.closed || this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > MAX_BUFFERED_BYTES) throw new Error('History link backpressure limit');
    this.socket.send(JSON.stringify({ type: HISTORY_LINK_FRAME_TYPE, ...fields }), error => {
      if (!error) return;
      this.close(); this.socket.terminate();
    });
  }

  private finish(state: Exchange, error?: Error, notify = false) {
    if (this.exchanges.get(state.id) !== state) return;
    this.exchanges.delete(state.id); clearTimeout(state.timer); state.removeAbort?.();
    state.controller.abort();
    state.sending?.release(); state.receiving?.release(); state.sending = undefined; state.receiving = undefined;
    if (!state.runningHandler) state.release();
    if (error) state.reject?.(error);
    if (notify && !this.closed) {
      try { this.send({ id: state.id, kind: state.local ? 'cancel' : 'error' }); } catch { /* Socket/backpressure failure already bounds this exchange. */ }
    }
  }
}
