/** Experimental local policy observer. Not wired into production admission:
 * protected recovery and quorum activation remain required before enabling it. */
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { verifyAdmissionPolicy, assertAdmissionPolicyCurrent } from '@resonance/core/admission-policy';
import { admissionPolicyObserversId, parseAdmissionPolicyObservers, createAdmissionPolicyHeadVote, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { admissionPolicyHead, sameAdmissionPolicyHead, parseAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import type { SigningKeyPair } from '@resonance/core';

import { ADMISSION_POLICY_OBSERVER_MAX_BYTES, parseAdmissionPolicyObserverState, policyObserverStateHead,
  advanceAdmissionPolicyObserverState, assertPolicyObserverCurrent, type AdmissionPolicyObserverState as State } from './admission-policy-observer-state.js';
export { ADMISSION_POLICY_OBSERVER_MAX_BYTES } from './admission-policy-observer-state.js';
const DOMAIN = 'resonance:admission-policy-observer:v1';
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
    await parseAdmissionPolicyObserverState(storage.read(), context);
    const local = storage;
    const stateHead = (state: State) => policyObserverStateHead(state, context);
    const usable = () => { const state = local.read(); if (state.conflict) throw new Error('Community policy authority equivocated; retain evidence and stop observations'); return state; };
    return {
      status() {
        const state = local.read();
        return { head: structuredClone(stateHead(state)), blocked: state.conflict !== null,
          evidence: state.conflict ? structuredClone([state.advance!, state.conflict]) : [] };
      },
      policy() { return structuredClone(local.read().policy); },
      observe(request: unknown) {
        const state = usable(), time = now(); assertPolicyObserverCurrent(state.policy, time);
        return createAdmissionPolicyHeadVote(request, stateHead(state), context, owned, time);
      },
      async advance(value: unknown) {
        usable(); if (busy) throw new Error('Policy advance is already in progress'); busy = true;
        try {
          const next = await parseAdmissionPolicyAdvance(value, context), current = usable();
          const changed = advanceAdmissionPolicyObserverState(current, next, context);
          if (changed === current) return structuredClone(stateHead(current));
          if (!changed.conflict) assertPolicyObserverCurrent(changed.policy, now());
          local.write(changed);
          if (changed.conflict) throw new Error('Community policy authority equivocated; evidence retained');
          return structuredClone(stateHead(changed));
        } finally { busy = false; }
      },
      close() { local.close(); owned.secretKey.fill(0); },
    };
  } catch (error) { storage?.close(); owned.secretKey.fill(0); throw error; }
  finally { encryptionKey.fill(0); }
}
