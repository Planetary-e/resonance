/** Offline preparation/review for a fresh witnessed issuer cohort. No history reset or network I/O. */
import { createHash } from 'node:crypto';
import {
  admissionAuthorityFingerprint, admissionKeyFingerprint, admissionPolicyDigest,
  assertAdmissionPolicyCurrent, assertAdmissionPolicySuccessor, parseAdmissionPolicyBody,
  signAdmissionPolicy, verifyAdmissionPolicy, type AdmissionPolicyBody, type AdmissionPolicyKey,
} from './admission-policy.js';
import { exactWitnessFields } from './admission-witness.js';

export interface AdmissionRotationRequest {
  version: 1; kind: 'admission-rotation-request'; issuedAt: number; expiresAt: number;
  newKey: AdmissionPolicyKey;
  /** Full explicit cutoffs for selected old keys; omitted keys remain unchanged. */
  retire: Array<{ issuerKey: string; issueUntil: number; spendUntil: number; retryUntil: number }>;
}
export interface AdmissionRotationPlan {
  version: 1; kind: 'admission-rotation-plan'; authority: string;
  previousRevision: number; previousDigest: string; body: AdmissionPolicyBody;
}
const MAX_KEYS = 8, MAX_POLICY_FILE_BYTES = 65536;
const clone = (value: unknown) => structuredClone(value);
const utc = (value: number) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
function approvalDigest(plan: AdmissionRotationPlan): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify([
    'resonance:admission-rotation-plan:v1', plan.authority, plan.previousRevision, plan.previousDigest, plan.body,
  ])).digest('hex');
}
function assertIssuable(body: AdmissionPolicyBody, now: number) {
  assertAdmissionPolicyCurrent(body, now);
  const active = body.keys.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === body.activeKey)!;
  if (Math.max(now, active.notBefore) >= Math.min(active.issueUntil, body.expiresAt)) {
    throw new Error('New cohort has no remaining issuance window in this policy');
  }
}

export async function prepareAdmissionRotation(previousValue: unknown, requestValue: unknown, authority: string, now = Date.now) {
  const previousInput = clone(previousValue), request = clone(requestValue);
  const previous = await verifyAdmissionPolicy(previousInput, authority);
  if (!exactWitnessFields(request, ['version','kind','issuedAt','expiresAt','newKey','retire'])
    || request.version !== 1 || request.kind !== 'admission-rotation-request'
    || !Array.isArray(request.retire) || request.retire.length > MAX_KEYS) throw new Error('Invalid rotation request');
  if (previous.keys.length >= MAX_KEYS) throw new Error('Retained-key capacity exhausted; rotation cannot delete prior keys');
  const retire = new Map<string, Pick<AdmissionPolicyKey, 'issueUntil' | 'spendUntil' | 'retryUntil'>>();
  for (const row of request.retire) {
    if (!exactWitnessFields(row, ['issuerKey','issueUntil','spendUntil','retryUntil']) || typeof row.issuerKey !== 'string'
      || retire.has(row.issuerKey) || !previous.keys.some(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === row.issuerKey)
      || ![row.issueUntil, row.spendUntil, row.retryUntil].every(value => Number.isSafeInteger(value) && (value as number) >= 0)) {
      throw new Error('Invalid or duplicate retirement for a prior issuer key');
    }
    retire.set(row.issuerKey, { issueUntil: row.issueUntil as number, spendUntil: row.spendUntil as number, retryUntil: row.retryUntil as number });
  }
  const inputKey = request.newKey as AdmissionPolicyKey;
  if (typeof inputKey?.profile?.issuerPublicKey !== 'string') throw new Error('New cohort requires a public issuer profile');
  // Parse the new entry before reading its fingerprint. Full predecessor checks follow.
  const single = await parseAdmissionPolicyBody({ version: 1, kind: 'admission-policy', revision: previous.revision + 1,
    issuedAt: request.issuedAt, expiresAt: request.expiresAt,
    activeKey: admissionKeyFingerprint(inputKey.profile.issuerPublicKey), keys: [inputKey] });
  const plan: AdmissionRotationPlan = { version: 1, kind: 'admission-rotation-plan', authority,
    previousRevision: previous.revision, previousDigest: admissionPolicyDigest(previous), body: { ...single,
      keys: [...previous.keys.map(entry => ({ ...entry, ...retire.get(admissionKeyFingerprint(entry.profile.issuerPublicKey)) })), single.keys[0]] } };
  return checkAdmissionRotation(previous, plan, authority, now);
}

export async function checkAdmissionRotation(previousValue: unknown, planValue: unknown, authority: string, now = Date.now) {
  const previousInput = clone(previousValue), input = clone(planValue);
  const previous = await verifyAdmissionPolicy(previousInput, authority);
  if (!exactWitnessFields(input, ['version','kind','authority','previousRevision','previousDigest','body'])
    || input.version !== 1 || input.kind !== 'admission-rotation-plan' || input.authority !== authority
    || input.previousRevision !== previous.revision || input.previousDigest !== admissionPolicyDigest(previous)) {
    throw new Error('Rotation plan does not match the supplied signed predecessor and pinned authority');
  }
  if (previous.keys.length >= MAX_KEYS) throw new Error('Retained-key capacity exhausted; rotation cannot delete prior keys');
  const body = await parseAdmissionPolicyBody(input.body);
  assertAdmissionPolicySuccessor(previous, body);
  if (body.revision !== previous.revision + 1 || body.keys.length !== previous.keys.length + 1
    || previous.keys.some(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === body.activeKey)) {
    throw new Error('Rotation must add exactly one fresh active issuer key and the next revision');
  }
  const fresh = body.keys.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === body.activeKey)!;
  const oldActive = previous.keys.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === previous.activeKey)!;
  if (!fresh.witnesses) throw new Error('The new cohort requires a four-of-five witness set');
  if (fresh.profile.scope.issuer !== oldActive.profile.scope.issuer || fresh.profile.scope.community !== oldActive.profile.scope.community
    || previous.keys.some(entry => entry.profile.scope.epoch === fresh.profile.scope.epoch)) {
    throw new Error('Rotation requires the same community issuer and a fresh shared period');
  }
  const checkedAt = now(); assertIssuable(body, checkedAt);
  const signedFileBytes = Buffer.byteLength(JSON.stringify({ ...body, authority, signature: 'A'.repeat(86) }) + '\n');
  if (signedFileBytes > MAX_POLICY_FILE_BYTES) throw new Error('Signed rotation would exceed the 64 KiB policy file limit');
  const plan: AdmissionRotationPlan = { version: 1, kind: 'admission-rotation-plan', authority,
    previousRevision: previous.revision, previousDigest: admissionPolicyDigest(previous), body };
  const deadlines = (entry: AdmissionPolicyKey, expiresAt: number) => ({ notBefore: entry.notBefore,
    issueUntil: entry.issueUntil, spendUntil: entry.spendUntil, retryUntil: entry.retryUntil,
    effectiveIssueUntil: Math.min(expiresAt, entry.issueUntil), effectiveSpendUntil: Math.min(expiresAt, entry.spendUntil),
    effectiveRetryUntil: Math.min(expiresAt, entry.retryUntil),
    utc: { notBefore: utc(entry.notBefore), issueUntil: utc(entry.issueUntil), spendUntil: utc(entry.spendUntil), retryUntil: utc(entry.retryUntil),
      effectiveIssueUntil: utc(Math.min(expiresAt, entry.issueUntil)), effectiveSpendUntil: utc(Math.min(expiresAt, entry.spendUntil)),
      effectiveRetryUntil: utc(Math.min(expiresAt, entry.retryUntil)) } });
  const summary = {
    approvalDigest: approvalDigest(plan), checkedAt, checkedAtUtc: utc(checkedAt), authorityFingerprint: admissionAuthorityFingerprint(authority),
    previousRevision: previous.revision, revision: body.revision, previousDigest: plan.previousDigest,
    policyExpiry: { before: previous.expiresAt, after: body.expiresAt, beforeUtc: utc(previous.expiresAt), afterUtc: utc(body.expiresAt) },
    retained: previous.keys.map(old => {
      const issuerKey = admissionKeyFingerprint(old.profile.issuerPublicKey);
      const entry = body.keys.find(key => admissionKeyFingerprint(key.profile.issuerPublicKey) === issuerKey)!;
      return { issuerKey, scope: entry.profile.scope, witnesses: entry.witnesses ?? null,
        before: deadlines(old, previous.expiresAt), after: deadlines(entry, body.expiresAt) };
    }),
    newCohort: { issuerKey: body.activeKey, scope: fresh.profile.scope, relayUrls: fresh.profile.relayUrls,
      witnesses: fresh.witnesses, deadlines: deadlines(fresh, body.expiresAt) },
    policyCapacity: { retainedKeys: body.keys.length, maximumKeys: MAX_KEYS, remainingKeySlots: MAX_KEYS - body.keys.length,
      signedFileBytes, maximumFileBytes: MAX_POLICY_FILE_BYTES },
    historyCapacity: { inspected: false, reset: false,
      note: 'Existing vote, certificate, wallet and issuer limits still apply. Rotation does not free history; remaining capacity was not inspected.' },
    notices: [
      'Old tokens retain their original keys and verification rules. No conversion, refund or new permit budget is authorized by this plan.',
      'This checks the supplied predecessor, not global policy freshness or a device’s highest installed revision.',
      'Witness readiness, independent ownership, remote history and availability are not verified.',
      'Shortened dates apply on updated devices only. Unexpired older policies can remain active elsewhere.',
      ...(checkedAt >= previous.expiresAt ? ['The predecessor has expired; this preserves its pins but does not restore expired key cutoffs.'] : []),
      ...(body.keys.length === MAX_KEYS ? ['No further issuer-key additions fit. Do not reset state to bypass the limit.'] : []),
    ],
  };
  return { plan, summary };
}

export async function signAdmissionRotation(previous: unknown, plan: unknown, authority: string, secretKey: Uint8Array,
  approvedDigest: string, now = Date.now) {
  const checked = await checkAdmissionRotation(previous, plan, authority, now);
  if (approvedDigest !== checked.summary.approvalDigest) throw new Error('Approval digest does not match this rotation plan; review it again');
  const policy = await signAdmissionPolicy(checked.plan.body, authority, secretKey);
  // A slow signing operation must not write a plan whose issuance window ended.
  assertIssuable(policy, now());
  return { policy, summary: checked.summary };
}
