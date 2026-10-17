/** Shared semantic validation for local and replicated observer snapshots. */
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { verifyAdmissionPolicy, assertAdmissionPolicySuccessor, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionPolicyObserversId, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { admissionPolicyHead, sameAdmissionPolicyHead, matchesAdmissionPolicyHead, parseAdmissionPolicyAdvanceCommitment,
  type AdmissionPolicyAdvance, type AdmissionPolicyAdvanceCommitment } from '@resonance/core/admission-policy-advance';

export interface AdmissionPolicyObserverState {
  version: 1; contextId: string; policy: SignedAdmissionPolicy;
  previous: SignedAdmissionPolicy | null; advance: AdmissionPolicyAdvanceCommitment | null;
  conflict: AdmissionPolicyAdvanceCommitment | null;
}
export const ADMISSION_POLICY_OBSERVER_MAX_BYTES = 2 * 1024 * 1024;
export function samePolicyObserverAdvance(a: AdmissionPolicyAdvanceCommitment, b: AdmissionPolicyAdvanceCommitment) {
  return a.contextId === b.contextId && sameAdmissionPolicyHead(a.previous, b.previous) && sameAdmissionPolicyHead(a.next, b.next);
}
export const policyObserverStateHead = (state: AdmissionPolicyObserverState, context: AdmissionPolicyObservers) => state.advance?.next ?? context.genesis;
export async function parseAdmissionPolicyObserverState(value: unknown, context: AdmissionPolicyObservers): Promise<AdmissionPolicyObserverState> {
  if (!exactWitnessFields(value, ['version', 'contextId', 'policy', 'previous', 'advance', 'conflict'])
    || value.version !== 1 || value.contextId !== admissionPolicyObserversId(context)
    || Buffer.byteLength(JSON.stringify(value)) > ADMISSION_POLICY_OBSERVER_MAX_BYTES) throw new Error('Invalid policy observer state');
  const retained = structuredClone(value), policy = await verifyAdmissionPolicy(retained.policy, context.authority);
  if (retained.previous === null) {
    if (retained.advance !== null || retained.conflict !== null || !sameAdmissionPolicyHead(admissionPolicyHead(policy), context.genesis)) throw new Error('Invalid retained policy genesis');
    return { version: 1, contextId: retained.contextId as string, policy, previous: null, advance: null, conflict: null };
  }
  const previous = await verifyAdmissionPolicy(retained.previous, context.authority), advance = parseAdmissionPolicyAdvanceCommitment(retained.advance, context);
  if (!matchesAdmissionPolicyHead(previous, advance.previous) || !matchesAdmissionPolicyHead(policy, advance.next)) throw new Error('Retained policy transition differs from its signed heads');
  assertAdmissionPolicySuccessor(previous, policy);
  const conflict = retained.conflict === null ? null : parseAdmissionPolicyAdvanceCommitment(retained.conflict, context);
  if (conflict && (conflict.next.revision !== advance.next.revision || samePolicyObserverAdvance(conflict, advance))) throw new Error('Invalid retained policy conflict');
  return { version: 1, contextId: retained.contextId as string, policy, previous, advance, conflict };
}
/** Input advance must already have passed parseAdmissionPolicyAdvance. Currentness
 * is an execution check; historical replay may legitimately contain expired policies. */
export function advanceAdmissionPolicyObserverState(current: AdmissionPolicyObserverState, next: AdmissionPolicyAdvance, context: AdmissionPolicyObservers) {
  if (current.conflict) throw new Error('Community policy authority equivocated; retain evidence and stop observations');
  const head = policyObserverStateHead(current, context);
  if (next.commitment.next.revision === head.revision && current.advance) {
    return samePolicyObserverAdvance(next.commitment, current.advance) ? current : { ...current, conflict: next.commitment };
  }
  if (!sameAdmissionPolicyHead(next.commitment.previous, head)) throw new Error('Policy advance skips or rolls back the retained head');
  assertAdmissionPolicySuccessor(current.policy, next.policy);
  return { ...current, previous: current.policy, policy: next.policy, advance: next.commitment };
}
/** Both states must have been independently authenticated before this chain check. */
export function assertPolicyObserverStateSuccessor(before: AdmissionPolicyObserverState, after: AdmissionPolicyObserverState, context: AdmissionPolicyObservers) {
  if (before.conflict) throw new Error('Policy observer history continued after equivocation');
  if (after.conflict) {
    if (!before.advance || JSON.stringify({ ...after, conflict: null }) !== JSON.stringify(before)) throw new Error('Policy observer history lost conflict ancestry');
  } else {
    if (!after.advance || !after.previous || JSON.stringify(after.previous) !== JSON.stringify(before.policy)
      || !sameAdmissionPolicyHead(after.advance.previous, policyObserverStateHead(before, context))) throw new Error('Policy observer history skips or rolls back a head');
  }
}
