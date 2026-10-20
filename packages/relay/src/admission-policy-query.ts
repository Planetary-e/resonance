/** Fixed-context infrastructure collector for private policy metadata requests.
 * The caller supplies a challenge, never destinations or observer membership. */
import { parseAdmissionPolicyObservers, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { ADMISSION_POLICY_QUERY_REPLY_TYPE, parseAdmissionPolicyQuery, parseAdmissionPolicyQueryReply } from '@resonance/core/admission-policy-query';
import { collectAdmissionPolicyObservation } from './admission-policy-observation.js';
import { exchangeAdmissionPolicyObservation, type AdmissionPolicyObservationTransport } from './admission-policy-observation-transport.js';

export const MAX_POLICY_QUERY_EXCHANGES = 8;

export function createAdmissionPolicyQueryResponder(options: {
  context: AdmissionPolicyObservers; policy: () => unknown; transport?: AdmissionPolicyObservationTransport;
  timeoutMs?: number; maximumOperations?: number; now?: () => number;
}) {
  const context = parseAdmissionPolicyObservers(options.context), transport = options.transport ?? exchangeAdmissionPolicyObservation;
  const maximum = options.maximumOperations ?? 1, timeout = options.timeoutMs ?? 3000, now = options.now ?? Date.now;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2 || !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30000) throw new Error('Invalid policy query responder bounds');
  const operations = new Set<{ abort(): void; drained: Promise<void>; active: boolean; finished: boolean;
    cancelled: boolean; start(): void }>();
  let closing: Promise<void> | undefined;
  function pump() {
    if (closing) return;
    let active = [...operations].filter(job => job.active).length;
    for (const job of operations) {
      if (active >= maximum) break;
      if (!job.active && !job.finished && !job.cancelled) { job.active = true; active++; job.start(); }
    }
  }
  return {
    health() { return { operations: [...operations].filter(job => job.active).length, maximumOperations: maximum,
      queuedOperations: [...operations].filter(job => !job.active).length, maximumExchanges: MAX_POLICY_QUERY_EXCHANGES }; },
    async exchange(value: unknown, signal?: AbortSignal) {
      signal?.throwIfAborted(); const query = parseAdmissionPolicyQuery(value, context, now());
      if (closing || operations.size >= MAX_POLICY_QUERY_EXCHANGES
        || [...operations].some(job => job.active && job.cancelled)) throw new Error('Policy query responder is unavailable');
      const deadline = performance.now() + Math.min(timeout, query.request.expiresAt - now());
      const controller = new AbortController(); let pending = 0, finished = false, released = false, drained!: () => void;
      let start!: () => void, refuse!: (error: Error) => void;
      const started = new Promise<void>((resolve, reject) => { start = resolve; refuse = reject; });
      const abort = () => { job.cancelled = true; controller.abort(); refuse(new Error('Policy query cancelled or timed out')); };
      const job = { abort, start, active: false, finished: false, cancelled: false,
        drained: new Promise<void>(resolve => { drained = resolve; }) };
      const release = () => { if (finished && pending === 0 && !released) {
        released = true; operations.delete(job); drained(); pump();
      } };
      const live = () => {
        signal?.throwIfAborted();
        if (controller.signal.aborted || performance.now() >= deadline || now() < query.request.issuedAt
          || now() >= query.request.expiresAt) throw new Error('Policy query cancelled or timed out');
      };
      const tracked: AdmissionPolicyObservationTransport = (member, frame, requestSignal) => {
        pending++;
        return Promise.resolve().then(() => { live(); requestSignal.throwIfAborted(); return transport(member, frame, requestSignal); })
          .finally(() => { pending--; release(); });
      };
      operations.add(job); signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.max(0, Math.ceil(deadline - performance.now()))); pump();
      try {
        if (signal?.aborted) abort();
        await started; live();
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0) throw new Error('Policy query timed out before observer collection');
        const certificate = await collectAdmissionPolicyObservation({ context, policy: options.policy(), request: query.request,
          // The collector has a 100 ms minimum; the original outer deadline
          // still aborts it and every transport checks that earlier deadline.
          transport: tracked, timeoutMs: Math.max(100, remaining), now, signal: controller.signal });
        live();
        return parseAdmissionPolicyQueryReply({ version: 1, type: ADMISSION_POLICY_QUERY_REPLY_TYPE, certificate }, query, context, now());
      } catch (error) {
        job.cancelled = true;
        if (performance.now() >= deadline) throw new Error('Policy query cancelled or timed out');
        throw error;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); finished = true; job.finished = true; controller.abort(); release(); }
    },
    close(): Promise<void> {
      if (!closing) {
        const jobs = [...operations];
        // Publish closure before abort handlers can attempt to admit more work.
        closing = Promise.all(jobs.map(job => job.drained)).then(() => {});
        jobs.forEach(job => job.abort());
      }
      return closing;
    },
  };
}
