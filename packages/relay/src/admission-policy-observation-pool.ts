/** Owner-scoped infrastructure connections. No policy evidence is cached.
 * Each pinned member retains at most one idle socket and one busy-call overflow. */
import type { Socket } from 'node:net';
import WebSocket from 'ws';
import { assertSecureRelayTransportEndpoint, relayTlsClientOptions } from '@resonance/core';
import { ADMISSION_POLICY_HEAD_MAX_BYTES, parseAdmissionPolicyHeadRequest, parseAdmissionPolicyHeadVote,
  parseAdmissionPolicyObservers, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { ADMISSION_POLICY_OBSERVATION_MAX_BYTES, type AdmissionPolicyObservationTransport } from './admission-policy-observation-transport.js';

export interface OwnedPolicyObservationTransport {
  exchange: AdmissionPolicyObservationTransport;
  close(): Promise<void>;
}

export function createAdmissionPolicyObservationPool(contextValue: AdmissionPolicyObservers, options: {
  onSocket?: (socket: Socket) => void; now?: () => number;
  /** May shorten, never extend, the default observer's absolute connection lifetime. */
  connectionLifetimeMs?: number;
} = {}) {
  const context = parseAdmissionPolicyObservers(contextValue), now = options.now ?? Date.now;
  const lifetime = options.connectionLifetimeMs ?? 10_000;
  if (!Number.isSafeInteger(lifetime) || lifetime < 50 || lifetime > 10_000) throw new Error('Invalid policy connection lifetime');
  type Job = { send(): void; reply(data: WebSocket.RawData, binary: boolean): void; fail(error: Error): void };
  type Slot = { member: string; socket: WebSocket; cached: boolean; deadline: number; closing: boolean;
    job?: Job; timer: ReturnType<typeof setTimeout>; closed: Promise<void> };
  const slots = new Set<Slot>(), cached = new Map<string, Slot>();
  let closed = false, closing: Promise<void> | undefined;
  function retire(slot: Slot) {
    if (slot.closing) return;
    slot.closing = true; clearTimeout(slot.timer);
    if (cached.get(slot.member) === slot) cached.delete(slot.member);
    slot.socket.terminate();
  }
  const exchange: AdmissionPolicyObservationTransport = async (member, frame, signal) => {
    if (closed) throw new Error('Policy observation pool is closed');
    signal.throwIfAborted();
    const pin = context.members.find(pin => pin.publicKey === member.publicKey && pin.endpoint === member.endpoint);
    if (!pin) throw new Error('Policy observation endpoint is not pinned to this owner');
    assertSecureRelayTransportEndpoint(pin.endpoint);
    const input = structuredClone(frame), request = parseAdmissionPolicyHeadRequest(input.request, context, now());
    if (input.advance !== null) throw new Error('Reusable policy connections require read-only observations');
    const encoded = JSON.stringify(input);
    if (Buffer.byteLength(encoded) > ADMISSION_POLICY_OBSERVATION_MAX_BYTES) throw new Error('Oversized policy observation request');
    const duration = request.expiresAt - now(), deadline = performance.now() + duration;
    let slot = cached.get(pin.publicKey);
    // Do not put a fresh request on a socket too near its original expiry.
    if (slot && !slot.job && (slot.closing || slot.socket.readyState !== WebSocket.OPEN || slot.deadline < deadline)) {
      retire(slot); slot = undefined;
    }
    if (slot?.job) slot = undefined; // A separate bounded connection leaves the self-witness free to proceed.
    if (!slot) {
      if ([...slots].filter(item => item.member === pin.publicKey).length >= 2) throw new Error('Policy observation connection capacity exhausted');
      const socket = new WebSocket(pin.endpoint, { ...relayTlsClientOptions, handshakeTimeout: 3000,
        maxPayload: ADMISSION_POLICY_HEAD_MAX_BYTES, followRedirects: false, perMessageDeflate: false });
      let drained!: () => void;
      slot = { member: pin.publicKey, socket, cached: !cached.has(pin.publicKey), deadline: performance.now() + lifetime,
        closing: false, timer: undefined as unknown as ReturnType<typeof setTimeout>, closed: new Promise(resolve => { drained = resolve; }) };
      const connection = slot;
      slots.add(connection); if (connection.cached) cached.set(pin.publicKey, connection);
      connection.timer = setTimeout(() => { connection.job?.fail(new Error('Policy connection lifetime expired')); retire(connection); }, lifetime);
      connection.timer.unref?.();
      socket.on('error', () => { connection.job?.fail(new Error('Policy observation connection failed')); retire(connection); });
      socket.on('close', () => {
        connection.job?.fail(new Error('Policy observation connection closed')); clearTimeout(connection.timer);
        slots.delete(connection); if (cached.get(connection.member) === connection) cached.delete(connection.member);
        drained();
      });
      socket.on('upgrade', response => {
        if (connection.closing || closed) return;
        try { options.onSocket?.(response.socket); }
        catch { connection.job?.fail(new Error('Policy observation accounting failed')); retire(connection); }
      });
      socket.on('open', () => { if (!connection.closing && !closed) connection.job?.send(); });
      socket.on('message', (data, binary) => {
        if (!connection.closing && connection.job) connection.job.reply(data, binary);
        else retire(connection); // Never retain unsolicited or duplicate replies for another request.
      });
    }
    const connection = slot;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const live = (afterDrain = false) => {
        if (closed || signal.aborted || (!afterDrain && connection.closing) || performance.now() >= deadline
          || performance.now() >= connection.deadline || now() < request.issuedAt || now() >= request.expiresAt) {
          throw new Error('Policy observation cancelled or expired');
        }
      };
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); connection.job = undefined;
        if (error || !connection.cached) {
          retire(connection);
          // A cancelled call stays charged in the collector until its real socket closes.
          void connection.closed.then(() => {
            if (error) { reject(error); return; }
            try { live(true); resolve(value); } catch (expired) { reject(expired); }
          });
        } else resolve(value);
      };
      const abort = () => finish(new Error('Policy observation cancelled'));
      const timer = setTimeout(() => finish(new Error('Policy observation timed out')), Math.max(1, duration));
      connection.job = {
        fail: error => finish(error),
        send() {
          try { live(); connection.socket.send(encoded, error => { if (error) finish(new Error('Policy observation send failed')); }); }
          catch (error) { finish(error instanceof Error ? error : new Error('Policy observation send failed')); }
        },
        reply(data, binary) {
          try {
            live(); if (binary) throw new Error('Binary policy observation response');
            const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
            const value = JSON.parse(new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes));
            const vote = parseAdmissionPolicyHeadVote(value, request, context, now());
            if (vote.observer !== pin.publicKey) throw new Error('Policy observation came from another pinned observer');
            live(); finish(undefined, vote);
          } catch (error) { finish(error instanceof Error ? error : new Error('Invalid policy observation response')); }
        },
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else if (connection.socket.readyState === WebSocket.OPEN) connection.job.send();
    });
  };
  return { exchange,
    health: () => ({ connections: slots.size, busy: [...slots].filter(slot => slot.job).length, maximumConnections: context.members.length * 2 }),
    close(): Promise<void> {
      if (!closing) {
        closed = true; const pending = [...slots];
        for (const slot of pending) { slot.job?.fail(new Error('Policy observation pool is closed')); retire(slot); }
        closing = Promise.all(pending.map(slot => slot.closed)).then(() => {});
      }
      return closing;
    },
  };
}
