import { copyAdmissionReplayValue, chargeAdmissionReplayCopy } from './admission-replay-values.js';
/** Offline-authorized immediate policy successor for the experimental observers. */
import { createHash } from 'node:crypto';
import { sign, verify, type SigningKeyPair } from './crypto.js';
import { exactWitnessFields, witnessBytes, copyAdmissionSigningKey } from './admission-witness.js';
import { admissionPolicyDigest, assertAdmissionPolicySuccessor, verifyAdmissionPolicy,
  type SignedAdmissionPolicy } from './admission-policy.js';
import { MAX_ADMISSION_POLICY_BYTES } from './admission-policy-limits.js';
import { chargeAdmissionWork, chargeAdmissionWorkBase64, type AdmissionWorkMeter } from './admission-work.js';
import { admissionPolicyObserversId, parseAdmissionPolicyHead, parseAdmissionPolicyObservers,
  type AdmissionPolicyHead, type AdmissionPolicyObservers } from './admission-policy-freshness.js';

export interface AdmissionPolicyAdvanceCommitment {
  version: 1; kind: 'admission-policy-advance'; contextId: string;
  previous: AdmissionPolicyHead; next: AdmissionPolicyHead; authority: string; signature: string;
}
export interface AdmissionPolicyAdvance { commitment: AdmissionPolicyAdvanceCommitment; policy: SignedAdmissionPolicy }
export const ADMISSION_POLICY_ADVANCE_MAX_BYTES = MAX_ADMISSION_POLICY_BYTES + 4096;
const DOMAIN = 'resonance:admission-policy-advance:v1';
/** With no transition this constructs an independently pinned genesis head. */
export function admissionPolicyHead(policy: SignedAdmissionPolicy, transition?: string, work?: AdmissionWorkMeter): AdmissionPolicyHead {
  const digest = admissionPolicyDigest(policy, work); return { revision: policy.revision, digest, transition: transition ?? digest };
}
export const matchesAdmissionPolicyHead = (policy: SignedAdmissionPolicy, value: AdmissionPolicyHead) =>
  policy.revision === value.revision && admissionPolicyDigest(policy) === value.digest;
function transitionDigest(contextId: string, previous: AdmissionPolicyHead, next: Pick<AdmissionPolicyHead, 'revision' | 'digest'>) {
  return createHash('sha256').update(`${DOMAIN}:chain\n${JSON.stringify([contextId, previous.revision, previous.digest, previous.transition, next.revision, next.digest])}`).digest('hex');
}
export const sameAdmissionPolicyHead = (a: AdmissionPolicyHead, b: AdmissionPolicyHead) => a.revision === b.revision && a.digest === b.digest && a.transition === b.transition;
function payload(contextId: string, previous: AdmissionPolicyHead, next: AdmissionPolicyHead, authority: string, work?: AdmissionWorkMeter) {
  const bytes = Buffer.from(`${DOMAIN}\n${JSON.stringify([contextId, previous.revision, previous.digest, previous.transition, next.revision, next.digest, next.transition, authority])}`); chargeAdmissionWork(work, bytes.length, 'serialize'); return bytes;
}
export function parseAdmissionPolicyAdvanceCommitment(value: unknown, contextValue: AdmissionPolicyObservers, work?: AdmissionWorkMeter): AdmissionPolicyAdvanceCommitment {
  const context = parseAdmissionPolicyObservers(contextValue), contextId = admissionPolicyObserversId(context);
  if (!exactWitnessFields(value, ['version', 'kind', 'contextId', 'previous', 'next', 'authority', 'signature'])
    || value.version !== 1 || value.kind !== 'admission-policy-advance' || value.contextId !== contextId
    || value.authority !== context.authority || !witnessBytes(value.signature, 64)) throw new Error('Invalid policy advance commitment');
  const previous = parseAdmissionPolicyHead(value.previous), next = parseAdmissionPolicyHead(value.next);
  chargeAdmissionWork(work, 64, 'base64');
  if (previous.revision < context.genesis.revision || (previous.revision === context.genesis.revision && !sameAdmissionPolicyHead(previous, context.genesis))
    || next.revision !== previous.revision + 1 || next.transition !== transitionDigest(contextId, previous, next)
    || !verify(payload(contextId, previous, next, context.authority, work), Buffer.from(value.signature, 'base64url'), Buffer.from(context.authority, 'base64url'))) {
    throw new Error('Policy advance is not an authenticated immediate successor');
  }
  return { version: 1, kind: 'admission-policy-advance', contextId, previous, next, authority: context.authority, signature: value.signature };
}
/** Verifies the signed commitment/body only. The role also checks successor
 * semantics against its retained predecessor and current time before installing. */
export async function parseAdmissionPolicyAdvance(value: unknown, context: AdmissionPolicyObservers, work?: AdmissionWorkMeter): Promise<AdmissionPolicyAdvance> {
  if (!exactWitnessFields(value, ['commitment', 'policy']) || Buffer.byteLength(JSON.stringify(value)) > ADMISSION_POLICY_ADVANCE_MAX_BYTES) throw new Error('Invalid or oversized policy advance');
  const input = copyAdmissionReplayValue(value), commitment = parseAdmissionPolicyAdvanceCommitment(input.commitment, context, work);
  const policy = await verifyAdmissionPolicy(input.policy, commitment.authority, undefined, work);
  if (!matchesAdmissionPolicyHead(policy, commitment.next)) throw new Error('Policy advance body differs from its signed digest');
  return { commitment, policy };
}
/** Signed transition primitive only; callers must resolve policy/archive successor semantics. */
export function createAdmissionPolicyAdvanceCommitment(previousValue: AdmissionPolicyHead,
  nextValue: Pick<AdmissionPolicyHead, 'revision' | 'digest'>, contextValue: AdmissionPolicyObservers,
  key: SigningKeyPair, work?: AdmissionWorkMeter): AdmissionPolicyAdvanceCommitment {
  const context = parseAdmissionPolicyObservers(contextValue), previous = parseAdmissionPolicyHead(copyAdmissionReplayValue(previousValue));
  const owned = copyAdmissionSigningKey(key);
  try {
    if (Buffer.from(owned.publicKey).toString('base64url') !== context.authority) throw new Error('Policy advance authority differs from its pin');
    const contextId = admissionPolicyObserversId(context), next = parseAdmissionPolicyHead({ revision: nextValue.revision,
      digest: nextValue.digest, transition: transitionDigest(contextId, previous, nextValue) });
    return parseAdmissionPolicyAdvanceCommitment({ version: 1, kind: 'admission-policy-advance', contextId, previous, next,
      authority: context.authority, signature: chargeAdmissionWorkBase64(work, sign(payload(contextId, previous, next, context.authority, work), owned.secretKey)) }, context, work);
  } finally { owned.secretKey.fill(0); }
}
export async function createAdmissionPolicyAdvance(previousValue: unknown, nextValue: unknown,
  contextValue: AdmissionPolicyObservers, key: SigningKeyPair, retainedHead?: AdmissionPolicyHead, work?: AdmissionWorkMeter): Promise<AdmissionPolicyAdvance> {
  const context = parseAdmissionPolicyObservers(contextValue), owned = copyAdmissionSigningKey(key);
  try {
    const previousInput = copyAdmissionReplayValue(previousValue), nextInput = copyAdmissionReplayValue(nextValue), prior = copyAdmissionReplayValue(retainedHead ?? context.genesis);
    if (Buffer.from(owned.publicKey).toString('base64url') !== context.authority) throw new Error('Policy advance authority differs from its pin');
    const previousPolicy = await verifyAdmissionPolicy(previousInput, context.authority, undefined, work), policy = await verifyAdmissionPolicy(nextInput, context.authority, undefined, work);
    assertAdmissionPolicySuccessor(previousPolicy, policy);
    const previous = parseAdmissionPolicyHead(prior);
    if (!matchesAdmissionPolicyHead(previousPolicy, previous)) throw new Error('Policy advance requires its retained predecessor transition');
    return parseAdmissionPolicyAdvance({ commitment: createAdmissionPolicyAdvanceCommitment(previous, admissionPolicyHead(policy, undefined, work), context, owned, work), policy }, context, work);
  } finally { owned.secretKey.fill(0); }
}
