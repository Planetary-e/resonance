/** Bounded positive signature cache. Every call still checks the complete schema,
 * expected claim and current signed membership. Never caches a freshness decision. */
import { createHash } from 'node:crypto';
import { admissionSpendClaimId, admissionWitnessSetId, exactWitnessFields, validAdmissionSpendClaim, verifyAdmissionWitnessVote, witnessBytes,
  type AdmissionSpendCertificate, type AdmissionSpendClaim, type AdmissionWitnessSet, type AdmissionWitnessVote } from '@resonance/core/admission-witness';

export function createRetainedAdmissionVerification(maximum = 16384) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16384) throw new Error('Invalid retained signature cache bound');
  const verified = new Set<string>();
  function vote(value: unknown, claim: AdmissionSpendClaim, set: AdmissionWitnessSet): value is AdmissionWitnessVote {
    if (!exactWitnessFields(value, ['setId', 'issuerKey', 'spend', 'action', 'requestBinding', 'version', 'kind', 'witness', 'signature'])
      || value.version !== 1 || value.kind !== 'admission-witness-vote'
      || !witnessBytes(value.witness, 32) || !witnessBytes(value.signature, 64)) return false;
    const v = value as unknown as AdmissionWitnessVote;
    if (typeof v.setId !== 'string' || typeof v.issuerKey !== 'string' || !claim
      || typeof claim.setId !== 'string' || typeof claim.issuerKey !== 'string' || !validAdmissionSpendClaim(v) || !validAdmissionSpendClaim(claim)
      || v.setId !== admissionWitnessSetId(set) || !set.members.some(member => member.publicKey === v.witness)
      || admissionSpendClaimId(v) !== admissionSpendClaimId(claim)) return false;
    // Fixed primitive fields avoid caller-defined serialization hooks. The signed
    // set ID binds all member/coordinator keys and endpoints. SHA-256 collisions
    // have the same cryptographic assumption as retained history digests.
    const digest = createHash('sha256').update(JSON.stringify([v.setId, v.issuerKey, v.spend, v.action, v.requestBinding,
      v.version, v.kind, v.witness, v.signature])).digest('hex');
    if (verified.has(digest)) { verified.delete(digest); verified.add(digest); return true; }
    if (!verifyAdmissionWitnessVote(v, claim, set)) return false;
    if (verified.size === maximum) verified.delete(verified.values().next().value!);
    verified.add(digest); return true;
  }
  function certificate(value: unknown, claim: AdmissionSpendClaim, set: AdmissionWitnessSet): value is AdmissionSpendCertificate {
    return exactWitnessFields(value, ['version', 'votes']) && value.version === 1 && Array.isArray(value.votes)
      && value.votes.length >= 4 && value.votes.length <= 5 && new Set(value.votes.map(v => v?.witness)).size === value.votes.length
      && value.votes.every(v => vote(v, claim, set));
  }
  return { vote, certificate };
}
const retained = createRetainedAdmissionVerification();
export const verifyRetainedAdmissionVote = retained.vote;
export const verifyRetainedAdmissionCertificate = retained.certificate;
