/** Offline evidence verification only. Recovery never spends a token or requests witness votes. */
import { createHash } from 'node:crypto';
import { isRelayAdmissionActionV2, verifyAdmissionCapabilityV2, verifyBlindAdmissionTokenV2,
  type AdmissionCapabilityV2, type RelayAdmissionActionV2 } from '@resonance/core';
import { admissionAuthorityFingerprint, admissionKeyFingerprint, admissionPolicyDigest, admissionPolicyKeys,
  assertAdmissionPolicyCurrent, parseAdmissionWalletProfile, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import type { AdmissionSpendRecord } from './admission-spend-history.js';

export interface AdmissionLegacySpendProof {
  version: 1; kind: 'admission-legacy-spend-proof'; issuerKey: string;
  capability: AdmissionCapabilityV2; action: RelayAdmissionActionV2; requestBinding: string;
}
export interface AdmissionSpendState {
  version: 2; authority: string; spends: AdmissionSpendRecord[]; retiredIssuerKeys: string[];
}
const exact = (value: unknown, names: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).sort().join(',') === names.sort().join(',');

/** Callers authenticate the policy and hold the spend ledger's writer lock throughout this operation. */
export async function checkAdmissionLegacyRecovery(options: {
  directory: string; policy: SignedAdmissionPolicy; state: AdmissionSpendState; proofs: unknown; now: () => number;
}) {
  const { policy, state, now } = options;
  if (!Array.isArray(options.proofs) || options.proofs.length < 1 || options.proofs.length > 32) throw new Error('Recovery requires 1–32 legacy spend proofs');
  let input: AdmissionLegacySpendProof[];
  try {
    if (Buffer.byteLength(JSON.stringify(options.proofs)) > 65536) throw new Error();
    input = structuredClone(options.proofs);
  } catch { throw new Error('Recovery proof batch exceeds its size limit or is malformed'); }
  const byKey = new Map(admissionPolicyKeys(policy).map(entry => [admissionKeyFingerprint(entry.profile.issuerPublicKey), entry]));
  const publicKeys = new Map<string, CryptoKey>(), recovered = new Map<string, string>();
  const rows = new Map(state.spends.map(row => [row.spend, row]));
  function eligible(issuerKey: string) {
    const time = now(); assertAdmissionPolicyCurrent(policy, time);
    const entry = byKey.get(issuerKey);
    if (!entry) throw new Error('Recovery issuer is absent from the installed policy');
    if (issuerKey === policy.activeKey) throw new Error('Cannot recover legacy spends under the active issuer key');
    if (time < entry.retryUntil) throw new Error('Legacy spend recovery must wait for the final retry cutoff');
    return entry;
  }
  for (const proof of input) {
    if (!exact(proof, ['version','kind','issuerKey','capability','action','requestBinding']) || proof.version !== 1
      || proof.kind !== 'admission-legacy-spend-proof' || typeof proof.issuerKey !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(proof.issuerKey) || !isRelayAdmissionActionV2(proof.action)
      || typeof proof.requestBinding !== 'string' || !/^admreq_[A-Za-z0-9_-]{86}$/.test(proof.requestBinding)
      || !verifyAdmissionCapabilityV2(proof.capability)) throw new Error('Invalid legacy spend proof');
    const entry = eligible(proof.issuerKey);
    let publicKey = publicKeys.get(proof.issuerKey);
    if (!publicKey) { publicKey = (await parseAdmissionWalletProfile(entry.profile)).publicKey; publicKeys.set(proof.issuerKey, publicKey); }
    const spend = await verifyBlindAdmissionTokenV2(proof.capability, entry.profile.scope, proof.action, proof.requestBinding, publicKey);
    if (!spend) throw new Error('Legacy spend proof failed cryptographic verification');
    eligible(proof.issuerKey); // Recheck after asynchronous key/token verification.
    if (recovered.has(spend)) throw new Error('Duplicate legacy spend proof');
    const row = rows.get(spend);
    if (!row || row.issuerKey !== null || row.action !== proof.action || row.binding !== proof.requestBinding) {
      throw new Error('Legacy proof must match one existing unattributed record exactly');
    }
    recovered.set(spend, proof.issuerKey);
  }
  const issuerKeys = [...new Set(recovered.values())].sort();
  const keys = issuerKeys.map(issuerKey => ({ issuerKey, retryUntil: eligible(issuerKey).retryUntil,
    alreadyRetired: state.retiredIssuerKeys.includes(issuerKey),
    provenLegacyRecords: [...recovered.values()].filter(id => id === issuerKey).length,
    attributedRecordsRemoved: state.spends.filter(row => row.issuerKey === issuerKey).length }));
  const retained = state.spends.filter(row => !recovered.has(row.spend) && (row.issuerKey === null || !issuerKeys.includes(row.issuerKey)));
  const next: AdmissionSpendState = { ...state, spends: retained, retiredIssuerKeys: [...new Set([...state.retiredIssuerKeys, ...issuerKeys])].sort() };
  const policyDigest = admissionPolicyDigest(policy);
  const approvalDigest = 'sha256:' + createHash('sha256').update(JSON.stringify([
    'resonance:admission-legacy-spend-recovery:v1', options.directory, policy.authority, policyDigest, state,
    [...recovered].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  ])).digest('hex');
  return { next, plan: {
    kind: 'admission-legacy-spend-recovery' as const, directory: options.directory,
    authorityFingerprint: admissionAuthorityFingerprint(policy.authority), policyRevision: policy.revision, policyDigest, keys,
    recordsBefore: state.spends.length, recordsRemoved: state.spends.length - retained.length, recordsAfter: retained.length,
    provenLegacyRecords: recovered.size, unattributedRecordsRetained: retained.filter(row => row.issuerKey === null).length,
    retirementFencesAfter: next.retiredIssuerKeys.length, approvalDigest,
    notice: 'Permanently disables the proven issuer keys on this local spend ledger, including exact retries. Removes only cryptographically proven legacy rows and rows already attributed to those keys. Other histories and allowances are unchanged.',
  } };
}
export type AdmissionLegacyRecoveryPlan = Awaited<ReturnType<typeof checkAdmissionLegacyRecovery>>['plan'];
export interface AdmissionLegacyRecovery {
  planLegacyRecovery(proofs: unknown): Promise<AdmissionLegacyRecoveryPlan>;
  recoverLegacy(proofs: unknown, approvedDigest: string): Promise<AdmissionLegacyRecoveryPlan>;
}
