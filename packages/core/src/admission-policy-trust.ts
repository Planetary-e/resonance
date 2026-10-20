/** Retained infrastructure policy pins. Certificates authorize one live check,
 * never a cached permission; observations advance a durable minimum revision. */
import { exactWitnessFields } from './admission-witness.js';
import { parseAdmissionPolicyObservers, parseAdmissionPolicyHead, type AdmissionPolicyObservers, type AdmissionPolicyHead } from './admission-policy-freshness.js';
import { sameAdmissionPolicyHead } from './admission-policy-advance.js';
import { parseAdmissionPolicyQueryReply, type AdmissionPolicyQuery, type AdmissionPolicyQueryReply } from './admission-policy-query.js';
import { archivedAdmissionPolicyDigest, type ArchivedAdmissionPolicy } from './admission-policy-archive.js';

export interface AdmissionPolicyTrust {
  context: AdmissionPolicyObservers; installed: AdmissionPolicyHead; observed: AdmissionPolicyHead; conflict?: AdmissionPolicyHead;
}
export interface AdmissionPolicyObservation { query: AdmissionPolicyQuery; reply: AdmissionPolicyQueryReply }
export function parseAdmissionPolicyTrust(value: unknown, policy: ArchivedAdmissionPolicy): AdmissionPolicyTrust {
  if (!exactWitnessFields(value, ['context', 'installed', 'observed'])
    && !exactWitnessFields(value, ['context', 'installed', 'observed', 'conflict'])) throw new Error('Invalid retained policy observer state');
  const context = parseAdmissionPolicyObservers(value.context), installed = parseAdmissionPolicyHead(value.installed), observed = parseAdmissionPolicyHead(value.observed);
  const conflict = value.conflict === undefined ? undefined : parseAdmissionPolicyHead(value.conflict);
  if (context.authority !== policy.authority || !(policy.revision === installed.revision && archivedAdmissionPolicyDigest(policy) === installed.digest)
    || [installed, observed].some(head => head.revision < context.genesis.revision
      || head.revision === context.genesis.revision && !sameAdmissionPolicyHead(head, context.genesis))
    || observed.revision < installed.revision || observed.revision === installed.revision && !sameAdmissionPolicyHead(observed, installed)) {
    throw new Error('Policy differs from its retained observer pins');
  }
  if (conflict && (conflict.revision !== observed.revision || sameAdmissionPolicyHead(conflict, observed))) throw new Error('Invalid retained policy conflict');
  return { context, installed, observed, ...(conflict ? { conflict } : {}) };
}
/** The changed floor must be persisted even when the observation refuses use. */
export function inspectAdmissionPolicyObservation(state: AdmissionPolicyTrust, observation: AdmissionPolicyObservation, now: number) {
  if (state.conflict) throw new Error('Policy observations conflict; admission is fenced');
  const { certificate } = parseAdmissionPolicyQueryReply(observation.reply, observation.query, state.context, now);
  const head = certificate.votes[0].head;
  if (head.revision < state.observed.revision) throw new Error('Policy observation is older than the retained floor');
  if (head.revision === state.observed.revision && !sameAdmissionPolicyHead(head, state.observed)) {
    return { state: { ...state, conflict: head }, error: 'Policy observations conflict; admission is fenced' };
  }
  const next = head.revision > state.observed.revision ? { ...state, observed: head } : state;
  return { state: next, ...(!sameAdmissionPolicyHead(head, state.installed)
    ? { error: 'A newer community policy was observed; install its signed successor before admission' } : {}) };
}
