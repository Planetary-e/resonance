/** Experimental local policy observer. Not wired into production admission:
 * protected recovery and quorum activation remain required before enabling it. */
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { verifyAdmissionPolicy, assertAdmissionPolicyCurrent, assertAdmissionPolicySuccessor, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionPolicyObserversId, parseAdmissionPolicyObservers, createAdmissionPolicyHeadVote, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { admissionPolicyHead, sameAdmissionPolicyHead, parseAdmissionPolicyAdvance, parseAdmissionPolicyAdvanceCommitment,
  type AdmissionPolicyAdvanceCommitment } from '@resonance/core/admission-policy-advance';
import type { SigningKeyPair } from '@resonance/core';

const DOMAIN = 'resonance:admission-policy-observer:v1';
export const ADMISSION_POLICY_OBSERVER_MAX_BYTES = 2 * 1024 * 1024;
interface State {
  version: 1; contextId: string; policy: SignedAdmissionPolicy;
  previous: SignedAdmissionPolicy | null; advance: AdmissionPolicyAdvanceCommitment | null;
  /** Two authority signatures for different transitions at the same revision. */
  conflict: AdmissionPolicyAdvanceCommitment | null;
}
function sameAdvance(a: AdmissionPolicyAdvanceCommitment, b: AdmissionPolicyAdvanceCommitment) {
  return a.contextId === b.contextId && sameAdmissionPolicyHead(a.previous, b.previous) && sameAdmissionPolicyHead(a.next, b.next);
}
export async function openAdmissionPolicyObserver(options: {
  path: string; encryptionKey: Uint8Array; context: AdmissionPolicyObservers; signingKey: SigningKeyPair;
  mode: 'create-new' | 'open-existing'; initialPolicy?: unknown; now?: () => number;
}) {
  if (!['create-new', 'open-existing'].includes(options.mode)) throw new Error('Policy observer requires an explicit initialization/open mode');
  if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.length !== 32) throw new Error('Policy observer requires a 32-byte encryption key');
  const context = parseAdmissionPolicyObservers(options.context), contextId = admissionPolicyObserversId(context);
  const owned = copyAdmissionSigningKey(options.signingKey), now = options.now ?? Date.now;
  const encryptionKey = Uint8Array.from(options.encryptionKey), path = options.path, mode = options.mode;
  let storage: ReturnType<typeof openEncryptedLocalState<State>> | undefined, busy = false;
  try {
    if (!context.members.some(member => member.publicKey === Buffer.from(owned.publicKey).toString('base64url'))) throw new Error('Policy observer key is not enrolled');
    let initial: State | undefined;
    if (mode === 'create-new') {
      const policy = await verifyAdmissionPolicy(options.initialPolicy, context.authority);
      if (!sameAdmissionPolicyHead(admissionPolicyHead(policy), context.genesis)) throw new Error('Initial policy differs from the independently pinned genesis');
      assertAdmissionPolicyCurrent(policy, now());
      initial = { version: 1, contextId, policy, previous: null, advance: null, conflict: null };
    }
    storage = openEncryptedLocalState<State>({ path, key: encryptionKey, domain: DOMAIN,
      maxBytes: ADMISSION_POLICY_OBSERVER_MAX_BYTES, mode, initial: initial!,
      validate: (value): value is State => exactWitnessFields(value, ['version', 'contextId', 'policy', 'previous', 'advance', 'conflict'])
        && value.version === 1 && value.contextId === contextId && !!value.policy });
    const retained = storage.read(), policy = await verifyAdmissionPolicy(retained.policy, context.authority);
    if (retained.previous === null) {
      if (retained.advance !== null || retained.conflict !== null || !sameAdmissionPolicyHead(admissionPolicyHead(policy), context.genesis)) throw new Error('Invalid retained policy genesis');
    } else {
      const previous = await verifyAdmissionPolicy(retained.previous, context.authority);
      const advance = parseAdmissionPolicyAdvanceCommitment(retained.advance, context);
      if (!sameAdmissionPolicyHead(advance.previous, admissionPolicyHead(previous)) || !sameAdmissionPolicyHead(advance.next, admissionPolicyHead(policy))) throw new Error('Retained policy transition differs from its signed heads');
      assertAdmissionPolicySuccessor(previous, policy);
      if (retained.conflict !== null) {
        const conflict = parseAdmissionPolicyAdvanceCommitment(retained.conflict, context);
        if (conflict.next.revision !== advance.next.revision || sameAdvance(conflict, advance)) throw new Error('Invalid retained policy conflict');
      }
    }
    const local = storage;
    const usable = () => { const state = local.read(); if (state.conflict) throw new Error('Community policy authority equivocated; retain evidence and stop observations'); return state; };
    return {
      status() {
        const state = local.read();
        return { head: admissionPolicyHead(state.policy), blocked: state.conflict !== null,
          evidence: state.conflict ? structuredClone([state.advance!, state.conflict]) : [] };
      },
      policy() { return structuredClone(local.read().policy); },
      observe(request: unknown) {
        const state = usable(), time = now(); assertAdmissionPolicyCurrent(state.policy, time);
        return createAdmissionPolicyHeadVote(request, admissionPolicyHead(state.policy), context, owned, time);
      },
      async advance(value: unknown) {
        usable(); if (busy) throw new Error('Policy advance is already in progress'); busy = true;
        try {
          const next = await parseAdmissionPolicyAdvance(value, context), current = usable(), currentHead = admissionPolicyHead(current.policy);
          if (next.commitment.next.revision === currentHead.revision && current.advance) {
            if (sameAdvance(next.commitment, current.advance)) return currentHead;
            local.write({ ...current, conflict: next.commitment });
            throw new Error('Community policy authority equivocated; evidence retained');
          }
          if (!sameAdmissionPolicyHead(next.commitment.previous, currentHead)) throw new Error('Policy advance skips or rolls back the retained head');
          assertAdmissionPolicySuccessor(current.policy, next.policy); assertAdmissionPolicyCurrent(next.policy, now());
          local.write({ ...current, previous: current.policy, policy: next.policy, advance: next.commitment });
          return admissionPolicyHead(next.policy);
        } finally { busy = false; }
      },
      close() { local.close(); owned.secretKey.fill(0); },
    };
  } catch (error) { storage?.close(); owned.secretKey.fill(0); throw error; }
  finally { encryptionKey.fill(0); }
}
