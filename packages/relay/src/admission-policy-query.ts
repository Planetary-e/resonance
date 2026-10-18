/** Fixed-context infrastructure collector for private policy metadata requests.
 * The caller supplies a challenge, never destinations or observer membership. */
import { parseAdmissionPolicyObservers, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { ADMISSION_POLICY_QUERY_REPLY_TYPE, parseAdmissionPolicyQuery, parseAdmissionPolicyQueryReply } from '@resonance/core/admission-policy-query';
import { collectAdmissionPolicyObservation } from './admission-policy-observation.js';
import { exchangeAdmissionPolicyObservation, type AdmissionPolicyObservationTransport } from './admission-policy-observation-transport.js';

export function createAdmissionPolicyQueryResponder(options: {
  context: AdmissionPolicyObservers; policy: () => unknown; transport?: AdmissionPolicyObservationTransport;
  timeoutMs?: number; maximumOperations?: number; now?: () => number;
}) {
  const context = parseAdmissionPolicyObservers(options.context), transport = options.transport ?? exchangeAdmissionPolicyObservation;
  const maximum = options.maximumOperations ?? 1, timeout = options.timeoutMs ?? 3000, now = options.now ?? Date.now;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2 || !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30000) throw new Error('Invalid policy query responder bounds');
  const operations = new Set<{ abort: () => void; drained: Promise<void> }>();
  let closing: Promise<void> | undefined;
  return {
    health() { return { operations: operations.size, maximumOperations: maximum }; },
    async exchange(value: unknown, signal?: AbortSignal) {
      signal?.throwIfAborted(); const query = parseAdmissionPolicyQuery(value, context, now());
      if (closing || operations.size >= maximum) throw new Error('Policy query responder is unavailable');
      const controller = new AbortController(); let pending = 0, finished = false, released = false, drained!: () => void;
      const job = { abort: () => controller.abort(), drained: new Promise<void>(resolve => { drained = resolve; }) };
      const release = () => { if (finished && pending === 0 && !released) { released = true; operations.delete(job); drained(); } };
      const abort = () => controller.abort();
      const tracked: AdmissionPolicyObservationTransport = (member, frame, requestSignal) => {
        pending++;
        return Promise.resolve().then(() => { requestSignal.throwIfAborted(); return transport(member, frame, requestSignal); })
          .finally(() => { pending--; release(); });
      };
      operations.add(job); signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        const certificate = await collectAdmissionPolicyObservation({ context, policy: options.policy(), request: query.request,
          transport: tracked, timeoutMs: timeout, now, signal: controller.signal });
        signal?.throwIfAborted(); controller.signal.throwIfAborted();
        return parseAdmissionPolicyQueryReply({ version: 1, type: ADMISSION_POLICY_QUERY_REPLY_TYPE, certificate }, query, context, now());
      } finally { signal?.removeEventListener('abort', abort); finished = true; controller.abort(); release(); }
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
