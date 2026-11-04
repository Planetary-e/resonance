import { archivedAdmissionPolicyDigest, verifyAdmissionPolicyV3, parseArchivedAdmissionPolicyAdvance, type ArchivedAdmissionPolicy } from '@resonance/core/admission-policy-archive';
import { assertPolicyObserverCurrent } from './admission-policy-observer-state.js';
/** Infrastructure-side four-observer collection. Personal applications must use
 * private routing when this is integrated; direct fan-out would expose activity. */
import { verifyAdmissionPolicy } from '@resonance/core/admission-policy';
import { sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadRequest, parseAdmissionPolicyHeadRequest, parseAdmissionPolicyObservers, parseAdmissionPolicyHeadVote,
  parseAdmissionPolicyHeadCertificate, type AdmissionPolicyHeadCertificate, type AdmissionPolicyHeadVote,
  type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { exchangeAdmissionPolicyObservation, type AdmissionPolicyObservationFrame, type AdmissionPolicyObservationTransport } from './admission-policy-observation-transport.js';

export async function collectAdmissionPolicyObservation(options: {
  /** Omit policy only for a head-only check: callers must retain the returned
   * floor and match their authenticated installed policy before authorizing work. */
  context: AdmissionPolicyObservers; policy?: unknown; advance?: unknown;
  /** Preserve a personal caller's fresh challenge when collecting behind its private route. */
  request?: unknown;
  transport?: AdmissionPolicyObservationTransport; signal?: AbortSignal; timeoutMs?: number; now?: () => number;
}): Promise<AdmissionPolicyHeadCertificate> {
  const timeout = options.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) throw new Error('Policy observation timeout must be between 100 and 30000 ms');
  let deadline = performance.now() + timeout;
  const now = options.now ?? Date.now, signal = options.signal;
  const transport = options.transport ?? exchangeAdmissionPolicyObservation, context = parseAdmissionPolicyObservers(options.context);
  const policyInput = structuredClone(options.policy), advanceInput = options.advance === undefined ? undefined : structuredClone(options.advance);
  const requestNow = now();
  const suppliedRequest = options.request === undefined ? undefined : parseAdmissionPolicyHeadRequest(options.request, context, requestNow);
  if (suppliedRequest) deadline = Math.min(deadline, performance.now() + suppliedRequest.expiresAt - requestNow);
  const check = () => { signal?.throwIfAborted(); if (performance.now() >= deadline) throw new Error('Policy observation timed out'); };
  async function read<T>(work: () => Promise<T>): Promise<T> {
    check();
    let refuse!: () => void;
    const cancelled = new Promise<never>((_, reject) => { refuse = () => reject(new Error('Policy observation cancelled or timed out')); });
    const timer = setTimeout(refuse, Math.max(1, deadline - performance.now()));
    signal?.addEventListener('abort', refuse, { once: true });
    try { const result = await Promise.race([work(), cancelled]); check(); return result; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', refuse); }
  }
  if (policyInput === undefined && advanceInput !== undefined) throw new Error('Policy activation requires its authenticated policy');
  check(); const policy = policyInput === undefined ? undefined : await read<ArchivedAdmissionPolicy>(() => (policyInput as {version?: unknown})?.version === 3 ? verifyAdmissionPolicyV3(policyInput, context.authority) : verifyAdmissionPolicy(policyInput, context.authority));
  check(); if (policy) assertPolicyObserverCurrent(policy, now());
  const expected = policy && { revision: policy.revision, digest: archivedAdmissionPolicyDigest(policy), transition: archivedAdmissionPolicyDigest(policy) }, advance = advanceInput === undefined ? null : await read(() => parseArchivedAdmissionPolicyAdvance(advanceInput, context, { signal, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())) }));
  check();
  if (expected && (expected.revision < context.genesis.revision || (expected.revision === context.genesis.revision && !sameAdmissionPolicyHead(expected, context.genesis)))) throw new Error('Requested policy conflicts with the pinned genesis');
  if (advance && !(policy!.revision === advance.commitment.next.revision && archivedAdmissionPolicyDigest(policy!) === advance.commitment.next.digest)) throw new Error('Policy activation differs from the requested head');
  const request = suppliedRequest ? parseAdmissionPolicyHeadRequest(suppliedRequest, context, now()) : createAdmissionPolicyHeadRequest(context, now(), timeout);
  const frame: AdmissionPolicyObservationFrame = { request, advance };
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
        if (vote.observer !== member.publicKey || policy && !(policy.revision === vote.head.revision && archivedAdmissionPolicyDigest(policy) === vote.head.digest)
          || vote.head.revision < context.genesis.revision || vote.head.revision === context.genesis.revision && !sameAdmissionPolicyHead(vote.head, context.genesis)
          || (advance && !sameAdmissionPolicyHead(vote.head, advance.commitment.next))) throw new Error('Wrong observer or policy head');
        const branchId = JSON.stringify(vote.head), branch = votes.get(branchId) ?? []; branch.push(vote); votes.set(branchId, branch);
        if (branch.length >= 4) {
          const certificate = parseAdmissionPolicyHeadCertificate({ version: 1, kind: 'admission-policy-head-certificate', votes: branch }, request, context, vote.head, now());
          try { check(); if (policy) assertPolicyObserverCurrent(policy, now()); }
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
