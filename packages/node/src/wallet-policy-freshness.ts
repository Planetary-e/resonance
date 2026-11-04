/** Retained policy floor for personal wallets; observations are never a cache. */
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { parseAdmissionPolicyObservers, parseAdmissionPolicyHead, type AdmissionPolicyObservers, type AdmissionPolicyHead } from '@resonance/core/admission-policy-freshness';
import { matchesAdmissionPolicyHead, sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { parseAdmissionPolicyQueryReply, type AdmissionPolicyQuery, type AdmissionPolicyQueryReply } from '@resonance/core/admission-policy-query';
import { archivedAdmissionPolicyDigest, type ArchivedAdmissionPolicy } from '@resonance/core/admission-policy-archive';

export interface WalletPolicyObservation { query: AdmissionPolicyQuery; reply: AdmissionPolicyQueryReply }
export interface WalletPolicyFreshness {
  context: AdmissionPolicyObservers; installed: AdmissionPolicyHead; observed: AdmissionPolicyHead;
  conflict?: AdmissionPolicyHead;
}
export function parseWalletPolicyFreshness(value: unknown, policy: ArchivedAdmissionPolicy): WalletPolicyFreshness {
  if (!exactWitnessFields(value, ['context', 'installed', 'observed'])
    && !exactWitnessFields(value, ['context', 'installed', 'observed', 'conflict'])) throw new Error('Invalid wallet policy freshness state');
  const context = parseAdmissionPolicyObservers(value.context), installed = parseAdmissionPolicyHead(value.installed), observed = parseAdmissionPolicyHead(value.observed);
  const conflict = value.conflict === undefined ? undefined : parseAdmissionPolicyHead(value.conflict);
  if (context.authority !== policy.authority || !(policy.revision === installed.revision && archivedAdmissionPolicyDigest(policy) === installed.digest)
    || [installed, observed].some(head => head.revision < context.genesis.revision
      || (head.revision === context.genesis.revision && !sameAdmissionPolicyHead(head, context.genesis)))
    || observed.revision < installed.revision
    || (observed.revision === installed.revision && !sameAdmissionPolicyHead(observed, installed))) throw new Error('Wallet policy differs from its retained observer pins');
  if (conflict && (conflict.revision !== observed.revision || sameAdmissionPolicyHead(conflict, observed))) throw new Error('Invalid retained policy conflict');
  return { context, installed, observed, ...(conflict ? { conflict } : {}) };
}
/** Returns a changed floor even when it forbids spending. Persist it before
 * reporting that refusal; otherwise restart could accept the older head again. */
export function inspectWalletPolicyObservation(state: WalletPolicyFreshness, observation: WalletPolicyObservation | undefined, now: number) {
  if (state.conflict) throw new Error('Wallet policy observations conflict; spending is fenced');
  if (!observation) throw new Error('A fresh private policy observation is required before reserving an access token');
  const reply = parseAdmissionPolicyQueryReply(observation.reply, observation.query, state.context, now);
  const head = reply.certificate.votes[0].head;
  if (head.revision < state.observed.revision) throw new Error('Policy observation is older than the retained wallet floor');
  if (head.revision === state.observed.revision && !sameAdmissionPolicyHead(head, state.observed)) {
    return { state: { ...state, conflict: head }, error: 'Wallet policy observations conflict; spending is fenced' };
  }
  const next = head.revision > state.observed.revision ? { ...state, observed: head } : state;
  return { state: next, ...(!sameAdmissionPolicyHead(head, state.installed)
    ? { error: 'A newer community policy was observed; install its signed successor before spending' } : {}) };
}
