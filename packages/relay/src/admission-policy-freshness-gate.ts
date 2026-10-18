/** One fresh infrastructure observation per admitted decision. No cached
 * readiness, personal identifiers, caller-selected endpoints or token contents. */
import { assertAdmissionPolicyCurrent, type openAdmissionPolicyStore } from '@resonance/core/admission-policy';
import { sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyQuery } from '@resonance/core/admission-policy-query';
import { createAdmissionPolicyQueryResponder } from './admission-policy-query.js';
import type { AdmissionPolicyObservationTransport } from './admission-policy-observation-transport.js';

export function createAdmissionPolicyFreshnessGate(options: {
  store: Awaited<ReturnType<typeof openAdmissionPolicyStore>>; transport?: AdmissionPolicyObservationTransport;
  timeoutMs?: number; now?: () => number;
}) {
  const { store } = options, context = store.freshness()?.context, now = options.now ?? Date.now, timeout = options.timeoutMs ?? 3000;
  if (!context) throw new Error('Admission freshness requires independently pinned observers');
  const responder = createAdmissionPolicyQueryResponder({ context, policy: () => undefined, transport: options.transport,
    timeoutMs: timeout, maximumOperations: 2, now });
  const operations = new Set<{ abort(): void; drained: Promise<void> }>();
  let closing: Promise<void> | undefined, closed = false;
  function available() { if (closed) throw new Error('Admission policy freshness is closed'); }
  function installed() {
    available(); const state = store.freshness();
    if (!state || state.conflict || !sameAdmissionPolicyHead(state.installed, state.observed)) throw new Error('Install the observed policy before admission; conflicting policies remain fenced');
    assertAdmissionPolicyCurrent(store.current()!, now()); return state.installed;
  }
  return {
    health() { return { operations: operations.size, observationOperations: responder.health().operations, maximumOperations: 2 }; },
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
        store.observe({ query, reply });
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
        closing = Promise.all([responder.close(), ...jobs.map(job => job.drained)]).then(() => {});
        jobs.forEach(job => job.abort());
      }
      return closing;
    },
  };
}
