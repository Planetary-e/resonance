import { assertArchivedAdmissionPolicyCurrent } from '@resonance/core/admission-policy-archive';
/** One fresh infrastructure observation per admitted decision. No cached
 * readiness, personal identifiers, caller-selected endpoints or token contents. */
import { type openAdmissionPolicyStore } from '@resonance/core/admission-policy';
import { sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyQuery } from '@resonance/core/admission-policy-query';
import { createAdmissionPolicyQueryResponder } from './admission-policy-query.js';
import type { Socket } from 'node:net';
import type { AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import type { AdmissionPolicyObservationTransport } from './admission-policy-observation-transport.js';
import { createAdmissionPolicyObservationPool, type OwnedPolicyObservationTransport } from './admission-policy-observation-pool.js';

export function createAdmissionPolicyFreshnessGate(options: {
  store: Awaited<ReturnType<typeof openAdmissionPolicyStore>>; transport?: AdmissionPolicyObservationTransport;
  transportFactory?: (context: AdmissionPolicyObservers) => OwnedPolicyObservationTransport;
  onSocket?: (socket: Socket) => void;
  timeoutMs?: number; now?: () => number;
  observe?: (observation: import('@resonance/core/admission-policy-trust').AdmissionPolicyObservation) => void | Promise<void>;
}) {
  const { store } = options, context = store.freshness()?.context, now = options.now ?? Date.now, timeout = options.timeoutMs ?? 3000;
  if (!context) throw new Error('Admission freshness requires independently pinned observers');
  if (options.transport && options.transportFactory) throw new Error('Choose one policy observation transport');
  const ownedTransport = options.transport ? undefined : options.transportFactory?.(context)
    ?? createAdmissionPolicyObservationPool(context, { now, onSocket: options.onSocket });
  const preparations = new Map<string, { pending: number; finished: boolean; release(): void; drained: Promise<void> }>();
  const transport = options.transport ?? ownedTransport!.exchange;
  const tracked: AdmissionPolicyObservationTransport = (member, frame, signal) => {
    const preparation = preparations.get(frame.request.challenge);
    if (!preparation) return transport(member, frame, signal);
    preparation.pending++;
    return Promise.resolve().then(() => transport(member, frame, signal)).finally(() => {
      preparation.pending--; preparation.release();
    });
  };
  const responder = createAdmissionPolicyQueryResponder({ context, policy: () => undefined, transport: tracked,
    timeoutMs: timeout, maximumOperations: 2, now });
  const operations = new Set<{ abort(): void; drained: Promise<void> }>();
  let closing: Promise<void> | undefined, closed = false;
  function available() { if (closed) throw new Error('Admission policy freshness is closed'); }
  function installed() {
    available(); const state = store.freshness();
    if (!state || state.conflict || !sameAdmissionPolicyHead(state.installed, state.observed)) throw new Error('Install the observed policy before admission; conflicting policies remain fenced');
    assertArchivedAdmissionPolicyCurrent(store.currentResolved()!, now()); return state.installed;
  }
  return {
    health() { return { operations: operations.size, observationOperations: responder.health().operations, maximumOperations: 2 }; },
    /** A new query for this caller, detached from collection cleanup but never
     * from its original expiry, cancellation or durable installed-policy floor. */
    prepare(signal?: AbortSignal): { ready: Promise<() => void>; drained: Promise<void> } {
      signal?.throwIfAborted(); installed();
      if (operations.size >= 2) throw new Error('Admission policy freshness capacity exhausted');
      const query = createAdmissionPolicyQuery(context, now(), timeout), deadline = performance.now() + timeout;
      const controller = new AbortController(), abort = () => controller.abort();
      let drained!: () => void, settled!: () => void;
      const job = { abort, drained: new Promise<void>(resolve => { drained = resolve; }) };
      const preparation = { pending: 0, finished: false, drained: new Promise<void>(resolve => { settled = resolve; }),
        release() { if (preparation.finished && preparation.pending === 0) settled(); } };
      preparations.set(query.request.challenge, preparation);
      operations.add(job); signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeout);
      const ready = (async () => {
        try {
          signal?.throwIfAborted();
          const reply = await responder.exchange(query, controller.signal);
          controller.signal.throwIfAborted();
          if (performance.now() >= deadline) throw new Error('Admission policy observation expired');
          await (options.observe ?? store.observe)({ query, reply });
          const head = installed();
          const assertCurrent = () => {
            available(); signal?.throwIfAborted();
            if (performance.now() >= deadline || now() < query.request.issuedAt || now() >= query.request.expiresAt
              || !sameAdmissionPolicyHead(head, installed())) throw new Error('Admission policy observation expired or changed');
          };
          assertCurrent(); return assertCurrent;
        } finally {
          clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort();
          preparation.finished = true; preparation.release();
          // Four matching replies can authorize this caller now. Keep its gate
          // slot and preparation lane charged until abort-ignoring adapters drain.
          void preparation.drained.then(() => {
            preparations.delete(query.request.challenge); operations.delete(job); drained();
          });
        }
      })();
      return { ready, drained: job.drained };
    },
    async run<T>(operation: (assertCurrent: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
      signal?.throwIfAborted(); installed();
      if (operations.size >= 2) throw new Error('Admission policy freshness capacity exhausted');
      const query = createAdmissionPolicyQuery(context, now(), timeout), deadline = performance.now() + timeout;
      const controller = new AbortController(), abort = () => controller.abort();
      let drained!: () => void; const job = { abort, drained: new Promise<void>(resolve => { drained = resolve; }) };
      operations.add(job); signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeout);
      try {
        signal?.throwIfAborted();
        const reply = await responder.exchange(query, controller.signal);
        controller.signal.throwIfAborted();
        if (performance.now() >= deadline) throw new Error('Admission policy observation expired');
        await (options.observe ?? store.observe)({ query, reply });
        const head = installed();
        const assertCurrent = () => {
          signal?.throwIfAborted(); controller.signal.throwIfAborted();
          if (performance.now() >= deadline || now() < query.request.issuedAt || now() >= query.request.expiresAt
            || !sameAdmissionPolicyHead(head, installed())) throw new Error('Admission policy observation expired or changed');
        };
        assertCurrent(); const result = await operation(assertCurrent); assertCurrent(); return result;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); operations.delete(job); drained(); }
    },
    close(): Promise<void> {
      if (!closing) {
        closed = true;
        const jobs = [...operations];
        closing = Promise.all([responder.close(), ownedTransport?.close(), ...jobs.map(job => job.drained)]).then(() => {});
        jobs.forEach(job => job.abort());
      }
      return closing;
    },
  };
}
