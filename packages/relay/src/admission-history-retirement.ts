/** Local, irreversible retirement. A fence replaces per-token evidence, never the other way round. */
import { createHash } from 'node:crypto';
import { admissionAuthorityFingerprint, admissionKeyFingerprint, admissionPolicyDigest,
  assertAdmissionPolicyCurrent, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';

export type AdmissionHistoryRole = 'witness' | 'coordinator' | 'local-spends';
export function validRetiredIssuerKeys(value: unknown, policy: SignedAdmissionPolicy, participant: string, role: AdmissionHistoryRole): value is string[] {
  return Array.isArray(value) && value.length <= 8 && new Set(value).size === value.length
    && value.every(id => typeof id === 'string' && policy.keys.some(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === id
      && (role === 'local-spends' || (role === 'witness' ? entry.witnesses?.members.some(member => member.publicKey === participant)
        : entry.witnesses?.coordinators.includes(participant)))));
}

export function planAdmissionHistoryRetirement(input: {
  role: AdmissionHistoryRole; participant: string; policy: SignedAdmissionPolicy; issuerKey: string;
  state: unknown; retiredIssuerKeys: string[]; entries: number; remove: number; maximumEntries: number; now: number;
}) {
  const { policy, issuerKey, role, participant } = input;
  assertAdmissionPolicyCurrent(policy, input.now);
  const entry = policy.keys.find(key => admissionKeyFingerprint(key.profile.issuerPublicKey) === issuerKey);
  if (!entry || (role !== 'local-spends' && (!entry.witnesses || !(role === 'witness' ? entry.witnesses.members.some(member => member.publicKey === participant)
    : entry.witnesses.coordinators.includes(participant))))) throw new Error('Issuer key is not assigned to this admission history role');
  if (issuerKey === policy.activeKey) throw new Error('Cannot permanently retire the active issuer key; install a successor first');
  if (input.now < entry.retryUntil) throw new Error('Admission history must remain until the key retry cutoff');
  if (input.retiredIssuerKeys.includes(issuerKey)) throw new Error('Issuer key is already permanently retired on this role');
  if (input.retiredIssuerKeys.length >= 8) throw new Error('Admission retirement fence capacity exhausted');
  const policyDigest = admissionPolicyDigest(policy);
  const approvalDigest = 'sha256:' + createHash('sha256').update(JSON.stringify([
    'resonance:admission-history-retirement:v1', role, participant, policy.authority, policyDigest, issuerKey, input.state,
  ])).digest('hex');
  return { kind: 'admission-history-retirement' as const, role, participant, issuerKey,
    authorityFingerprint: admissionAuthorityFingerprint(policy.authority), policyRevision: policy.revision, policyDigest,
    retryUntil: entry.retryUntil, recordsBefore: input.entries, recordsRemoved: input.remove,
    recordsAfter: input.entries - input.remove, maximumEntries: input.maximumEntries,
    retirementFencesAfter: input.retiredIssuerKeys.length + 1, approvalDigest,
    notice: 'Permanently disables this issuer key on this local role, including exact retries. Other histories, wallets, issuer budgets and policy key slots are unchanged.' };
}
export type AdmissionHistoryRetirementPlan = ReturnType<typeof planAdmissionHistoryRetirement>;
export interface AdmissionHistoryMaintenance {
  planRetirement(issuerKey: string): AdmissionHistoryRetirementPlan;
  retire(issuerKey: string, approvedDigest: string): AdmissionHistoryRetirementPlan;
}
