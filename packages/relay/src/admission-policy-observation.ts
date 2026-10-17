/** Infrastructure-side four-observer collection. Personal applications must use
 * private routing when this is integrated; direct fan-out would expose activity. */
import { assertAdmissionPolicyCurrent, verifyAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionPolicyHead, matchesAdmissionPolicyHead, parseAdmissionPolicyAdvance, sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadRequest, parseAdmissionPolicyObservers, parseAdmissionPolicyHeadVote,
  parseAdmissionPolicyHeadCertificate, type AdmissionPolicyHeadCertificate, type AdmissionPolicyHeadVote,
  type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { exchangeAdmissionPolicyObservation, type AdmissionPolicyObservationFrame, type AdmissionPolicyObservationTransport } from './admission-policy-observation-transport.js';

export async function collectAdmissionPolicyObservation(options: {
  context: AdmissionPolicyObservers; policy: unknown; advance?: unknown;
  transport?: AdmissionPolicyObservationTransport; signal?: AbortSignal; timeoutMs?: number; now?: () => number;
}): Promise<AdmissionPolicyHeadCertificate> {
  const timeout = options.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) throw new Error('Policy observation timeout must be between 100 and 30000 ms');
  const deadline = performance.now() + timeout, now = options.now ?? Date.now, signal = options.signal;
  const transport = options.transport ?? exchangeAdmissionPolicyObservation, context = parseAdmissionPolicyObservers(options.context);
  const policyInput = structuredClone(options.policy), advanceInput = options.advance === undefined ? undefined : structuredClone(options.advance);
  const check = () => { signal?.throwIfAborted(); if (performance.now() >= deadline) throw new Error('Policy observation timed out'); };
  check(); const policy = await verifyAdmissionPolicy(policyInput, context.authority); check(); assertAdmissionPolicyCurrent(policy, now());
  const expected = admissionPolicyHead(policy), advance = advanceInput === undefined ? null : await parseAdmissionPolicyAdvance(advanceInput, context);
  check();
  if (expected.revision < context.genesis.revision || (expected.revision === context.genesis.revision && !sameAdmissionPolicyHead(expected, context.genesis))) throw new Error('Requested policy conflicts with the pinned genesis');
  if (advance && !matchesAdmissionPolicyHead(policy, advance.commitment.next)) throw new Error('Policy activation differs from the requested head');
  const request = createAdmissionPolicyHeadRequest(context, now(), timeout), frame: AdmissionPolicyObservationFrame = { request, advance };
  return new Promise((resolve, reject) => {
    const controller = new AbortController(), votes = new Map<string, AdmissionPolicyHeadVote[]>();
    let done = false, remaining = context.members.length;
    const finish = (error?: unknown, result?: AdmissionPolicyHeadCertificate) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort();
      if (error !== undefined) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error('Policy observation cancelled'));
    const timer = setTimeout(() => finish(new Error('Policy observation timed out')), Math.max(1, deadline - performance.now()));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    const receive = (member: AdmissionPolicyObservers['members'][number], value: unknown) => {
      if (done) return;
      try {
        check();
        const vote = parseAdmissionPolicyHeadVote(value, request, context, now());
        if (vote.observer !== member.publicKey || !matchesAdmissionPolicyHead(policy, vote.head)
          || (advance && !sameAdmissionPolicyHead(vote.head, advance.commitment.next))) throw new Error('Wrong observer or policy head');
        const branch = votes.get(vote.head.transition) ?? []; branch.push(vote); votes.set(vote.head.transition, branch);
        if (branch.length >= 4) {
          const certificate = parseAdmissionPolicyHeadCertificate({ version: 1, kind: 'admission-policy-head-certificate', votes: branch }, request, context, vote.head, now());
          try { check(); assertAdmissionPolicyCurrent(policy, now()); }
          catch (error) { finish(error); return; }
          finish(undefined, certificate);
        }
      } catch (error) {
        if (signal?.aborted || performance.now() >= deadline) finish(error);
      }
    };
    for (const member of context.members) {
      if (done) break;
      void Promise.resolve().then(() => {
        if (done) throw new Error('Policy observation already finished'); check();
        return transport(member, structuredClone(frame), controller.signal);
      }).then(value => receive(member, value), () => {}).finally(() => {
        if (--remaining === 0 && !done) finish(new Error(`Policy observation lacks four matching replies (${Math.max(0, ...[...votes.values()].map(branch => branch.length))}/4)`));
      });
    }
  });
}
