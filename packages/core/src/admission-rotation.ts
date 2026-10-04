/** Offline preparation/review for a fresh witnessed issuer cohort. No history reset or network I/O. */
import { createHash } from 'node:crypto';
import {
  admissionAuthorityFingerprint, admissionKeyFingerprint, admissionPolicyDigest, admissionPolicyKeys, MAX_ADMISSION_KEYS, MAX_ARCHIVED_ADMISSION_KEYS, MAX_ADMISSION_POLICY_BYTES,
  assertAdmissionPolicyCurrent, assertAdmissionPolicySuccessor, parseAdmissionPolicyBody,
  signAdmissionPolicy, verifyAdmissionPolicy, type AdmissionPolicyBody, type AdmissionPolicyKey,
} from './admission-policy.js';
import { exactWitnessFields } from './admission-witness.js';

export interface AdmissionRotationRequest {
  version: 1 | 2; kind: 'admission-rotation-request'; issuedAt: number; expiresAt: number;
  newKey: AdmissionPolicyKey;
  /** v2 only: move these expired configurations into the permanent signed archive. */
  archive?: string[];
  /** Full explicit cutoffs for selected old keys; omitted keys remain unchanged. */
  retire: Array<{ issuerKey: string; issueUntil: number; spendUntil: number; retryUntil: number }>;
}
export interface AdmissionRotationPlan {
  version: 1; kind: 'admission-rotation-plan'; authority: string;
  previousRevision: number; previousDigest: string; body: AdmissionPolicyBody;
}
const MAX_KEYS = MAX_ADMISSION_KEYS;
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
  if (!exactWitnessFields(request, ['version','kind','issuedAt','expiresAt','newKey','retire', ...((request as AdmissionRotationRequest)?.version === 2 ? ['archive'] : [])])
    || (request.version !== 1 && request.version !== 2) || request.kind !== 'admission-rotation-request'
    || !Array.isArray(request.retire) || request.retire.length > MAX_KEYS) throw new Error('Invalid rotation request');
  const archive: string[] = request.version === 2 ? request.archive as string[] : [];
  if (!Array.isArray(archive) || archive.length > MAX_KEYS || new Set(archive).size !== archive.length
    || archive.some(id => typeof id !== 'string' || !previous.keys.some(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === id))) throw new Error('Invalid or duplicate archive selection');
  if (previous.keys.length - archive.length >= MAX_KEYS) throw new Error('Retained-key capacity exhausted; select eligible keys for permanent archival');
  const retire = new Map<string, Pick<AdmissionPolicyKey, 'issueUntil' | 'spendUntil' | 'retryUntil'>>();
  for (const row of request.retire) {
    if (!exactWitnessFields(row, ['issuerKey','issueUntil','spendUntil','retryUntil']) || typeof row.issuerKey !== 'string'
      || archive.includes(row.issuerKey) || retire.has(row.issuerKey) || !previous.keys.some(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === row.issuerKey)
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
      version: previous.version === 2 || archive.length ? 2 : 1,
      ...(previous.version === 2 || archive.length ? { archivedKeys: [...(previous.archivedKeys ?? []), ...previous.keys.filter(entry => archive.includes(admissionKeyFingerprint(entry.profile.issuerPublicKey)))] } : {}),
      keys: [...previous.keys.filter(entry => !archive.includes(admissionKeyFingerprint(entry.profile.issuerPublicKey)))
        .map(entry => ({ ...entry, ...retire.get(admissionKeyFingerprint(entry.profile.issuerPublicKey)) })), single.keys[0]] } };
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
  const body = await parseAdmissionPolicyBody(input.body);
  assertAdmissionPolicySuccessor(previous, body);
  const priorKeys = admissionPolicyKeys(previous), nextKeys = admissionPolicyKeys(body);
  if (body.revision !== previous.revision + 1 || nextKeys.length !== priorKeys.length + 1
    || !nextKeys.filter(entry => !priorKeys.some(old => admissionKeyFingerprint(old.profile.issuerPublicKey) === admissionKeyFingerprint(entry.profile.issuerPublicKey)))
      .every(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === body.activeKey)
    || priorKeys.some(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === body.activeKey)) {
    throw new Error('Rotation must add exactly one fresh active issuer key and the next revision');
  }
  const fresh = body.keys.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === body.activeKey)!;
  const oldActive = previous.keys.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === previous.activeKey)!;
  if (!fresh.witnesses) throw new Error('The new cohort requires a four-of-five witness set');
  if (fresh.profile.scope.issuer !== oldActive.profile.scope.issuer || fresh.profile.scope.community !== oldActive.profile.scope.community
    || priorKeys.some(entry => entry.profile.scope.epoch === fresh.profile.scope.epoch)) {
    throw new Error('Rotation requires the same community issuer and a fresh shared period');
  }
  const checkedAt = now(); assertIssuable(body, checkedAt);
  const signedFileBytes = Buffer.byteLength(JSON.stringify({ ...body, authority, signature: 'A'.repeat(86) }) + '\n');
  const maximumFileBytes = body.version === 1 ? 65536 : MAX_ADMISSION_POLICY_BYTES;
  if (signedFileBytes > maximumFileBytes) throw new Error('Signed rotation would exceed the policy file byte limit');
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
      const entry = nextKeys.find(key => admissionKeyFingerprint(key.profile.issuerPublicKey) === issuerKey)!;
      return { issuerKey, archived: !!body.archivedKeys?.includes(entry), scope: entry.profile.scope, witnesses: entry.witnesses ?? null,
        before: deadlines(old, previous.expiresAt), after: deadlines(entry, body.expiresAt) };
    }),
    newCohort: { issuerKey: body.activeKey, scope: fresh.profile.scope, relayUrls: fresh.profile.relayUrls,
      witnesses: fresh.witnesses, deadlines: deadlines(fresh, body.expiresAt) },
    policyCapacity: { retainedKeys: body.keys.length, maximumKeys: MAX_KEYS, remainingKeySlots: MAX_KEYS - body.keys.length,
      archivedKeys: body.archivedKeys?.length ?? 0, maximumArchivedKeys: MAX_ARCHIVED_ADMISSION_KEYS,
      remainingArchiveSlots: MAX_ARCHIVED_ADMISSION_KEYS - (body.archivedKeys?.length ?? 0), signedFileBytes, maximumFileBytes },
    historyCapacity: { inspected: false, reset: false,
      note: 'Existing vote, certificate, wallet and issuer limits still apply. Rotation does not free history; remaining capacity was not inspected.' },
    notices: [
      'Retained configurations keep their original verification rules. Archived keys are permanently disabled, including recorded retries. No conversion, refund or new permit budget is authorized by this plan.',
      'This checks the supplied predecessor, not global policy freshness or a device’s highest installed revision.',
      'Witness readiness, independent ownership, remote history and availability are not verified.',
      'Shortened dates apply on updated devices only. Unexpired older policies can remain active elsewhere.',
      ...(checkedAt >= previous.expiresAt ? ['The predecessor has expired; this preserves its pins but does not restore expired key cutoffs.'] : []),
      ...(body.keys.length === MAX_KEYS ? ['No further current-key additions fit without archiving eligible retired keys. Do not reset state to bypass the limit.'] : []),
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
