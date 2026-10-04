/** Backend-only shared community admission policy: a pinned authority, revisions and cutoffs. */
import { createHash } from 'node:crypto';
import { parseAdmissionWitnessSet, type AdmissionWitnessSet } from './admission-witness.js';
import { sign, verify } from './crypto.js';
import { openEncryptedLocalState } from './local-encrypted-state.js';
import { admissionKeyFingerprint, parseAdmissionWalletProfile, type AdmissionWalletProfileV1 } from './admission-profile.js';
export { admissionKeyFingerprint, normalizeAdmissionRelay, parseAdmissionWalletProfile, type AdmissionWalletProfileV1 } from './admission-profile.js';

export interface AdmissionPolicyKey {
  profile: AdmissionWalletProfileV1;
  notBefore: number; issueUntil: number; spendUntil: number; retryUntil: number;
  witnesses?: AdmissionWitnessSet;
}
export interface AdmissionPolicyBody {
  version: 1 | 2; kind: 'admission-policy'; revision: number; issuedAt: number; expiresAt: number;
  activeKey: string; keys: AdmissionPolicyKey[];
  /** v2 only: permanently disabled configurations, retained to validate old local evidence. */
  archivedKeys?: AdmissionPolicyKey[];
}
export interface SignedAdmissionPolicy extends AdmissionPolicyBody { authority: string; signature: string }
const DOMAIN = 'resonance:admission-policy:v1'; // Also the unchanged encrypted-store domain.
export const MAX_ADMISSION_KEYS = 8;
export const MAX_ARCHIVED_ADMISSION_KEYS = 64;
export const MAX_ADMISSION_POLICY_BYTES = 512 * 1024;
export function admissionPolicyKeys(policy: AdmissionPolicyBody): AdmissionPolicyKey[] { return [...policy.keys, ...(policy.archivedKeys ?? [])]; }
export function isArchivedAdmissionKey(policy: AdmissionPolicyBody, issuerKey: string): boolean {
  return (policy.archivedKeys ?? []).some(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === issuerKey);
}
const MAX_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).sort().join(',') === fields.sort().join(',');
function bytes(value: unknown, size: number): value is string {
  return typeof value === 'string' && value.length <= 100 && Buffer.from(value, 'base64url').length === size && Buffer.from(value, 'base64url').toString('base64url') === value;
}
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function payload(body: AdmissionPolicyBody) {
  const entries = (keys: AdmissionPolicyKey[]) => keys.map(entry => [entry.profile, entry.notBefore, entry.issueUntil, entry.spendUntil, entry.retryUntil,
    ...(entry.witnesses ? [entry.witnesses] : [])]);
  return Buffer.from(`${body.version === 1 ? DOMAIN : 'resonance:admission-policy:v2'}\n${JSON.stringify([
    body.version, body.kind, body.revision, body.issuedAt, body.expiresAt, body.activeKey, entries(body.keys),
    ...(body.version === 2 ? [entries(body.archivedKeys ?? [])] : []),
  ])}`);
}
export function admissionAuthorityFingerprint(authority: string) {
  if (!bytes(authority, 32)) throw new Error('Invalid community authority key');
  return `sha256:${createHash('sha256').update(Buffer.from(authority, 'base64url')).digest('hex')}`;
}
/** Structural normalization only; this does not authenticate an unsigned policy. */
export async function parseAdmissionPolicyBody(value: unknown): Promise<AdmissionPolicyBody> {
  if (!exact(value, ['version','kind','revision','issuedAt','expiresAt','activeKey','keys', ...((value as AdmissionPolicyBody)?.version === 2 ? ['archivedKeys'] : [])]) || (value.version !== 1 && value.version !== 2) || value.kind !== 'admission-policy'
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || !timestamp(value.issuedAt) || !timestamp(value.expiresAt)
    || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > MAX_LIFETIME
    || typeof value.activeKey !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.activeKey)
    || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > MAX_ADMISSION_KEYS
    || (value.version === 2 && (!Array.isArray(value.archivedKeys) || value.archivedKeys.length > MAX_ARCHIVED_ADMISSION_KEYS))
    || Buffer.byteLength(JSON.stringify(value)) > (value.version === 1 ? 64 * 1024 : MAX_ADMISSION_POLICY_BYTES)) throw new Error('Invalid signed admission policy');
  const input = structuredClone(value); const keys: AdmissionPolicyKey[] = []; const seen = new Set<string>();
  for (const entry of [...input.keys as unknown[], ...(input.version === 2 ? input.archivedKeys as unknown[] : [])]) {
    if (!exact(entry, ['profile','notBefore','issueUntil','spendUntil','retryUntil',
      ...(entry && typeof entry === 'object' && Object.hasOwn(entry, 'witnesses') ? ['witnesses'] : [])])
      || !timestamp(entry.notBefore) || !timestamp(entry.issueUntil) || !timestamp(entry.spendUntil) || !timestamp(entry.retryUntil)
      || entry.notBefore >= entry.issueUntil || entry.issueUntil > entry.spendUntil || entry.spendUntil > entry.retryUntil) throw new Error('Invalid admission key cutoffs');
    const { profile } = await parseAdmissionWalletProfile(entry.profile); const id = admissionKeyFingerprint(profile.issuerPublicKey);
    if (seen.has(id)) throw new Error('Duplicate issuer key in admission policy');
    seen.add(id); keys.push({ profile, notBefore: entry.notBefore, issueUntil: entry.issueUntil, spendUntil: entry.spendUntil, retryUntil: entry.retryUntil,
      ...(Object.hasOwn(entry, 'witnesses') ? { witnesses: parseAdmissionWitnessSet(entry.witnesses) } : {}) });
  }
  const currentKeys = keys.slice(0, (input.keys as unknown[]).length), archivedKeys = keys.slice(currentKeys.length);
  if (archivedKeys.some(entry => entry.retryUntil > (input.issuedAt as number))) throw new Error('Archived keys must have passed their final retry cutoff before policy issuance');
  if (!currentKeys.some(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === input.activeKey)) throw new Error('Active issuer key is absent from the policy');
  return { version: input.version as 1 | 2, kind: 'admission-policy', revision: input.revision as number, issuedAt: input.issuedAt as number,
    expiresAt: input.expiresAt as number, activeKey: input.activeKey as string, keys: currentKeys, ...(input.version === 2 ? { archivedKeys } : {}) };
}
export async function signAdmissionPolicy(value: unknown, authority: string, secretKey: Uint8Array): Promise<SignedAdmissionPolicy> {
  admissionAuthorityFingerprint(authority); const secret = Uint8Array.from(secretKey);
  try {
    const body = await parseAdmissionPolicyBody(value); const signature = sign(payload(body), secret);
    if (!verify(payload(body), signature, Buffer.from(authority, 'base64url'))) throw new Error('Community authority private key does not match');
    const signed = { ...body, authority, signature: Buffer.from(signature).toString('base64url') };
    if (Buffer.byteLength(JSON.stringify(signed) + '\n') > (body.version === 1 ? 65536 : MAX_ADMISSION_POLICY_BYTES)) throw new Error('Signed admission policy exceeds its byte limit');
    return signed;
  } finally { secret.fill(0); }
}
export async function verifyAdmissionPolicy(value: unknown, authority: string): Promise<SignedAdmissionPolicy> {
  admissionAuthorityFingerprint(authority);
  if (!exact(value, ['version','kind','revision','issuedAt','expiresAt','activeKey','keys','authority','signature', ...((value as AdmissionPolicyBody)?.version === 2 ? ['archivedKeys'] : [])])
    || value.authority !== authority || !bytes(value.signature, 64)
    || Buffer.byteLength(JSON.stringify(value) + '\n') > (value.version === 1 ? 65536 : MAX_ADMISSION_POLICY_BYTES)) throw new Error('Admission policy is not signed by the pinned community authority');
  const input = structuredClone(value); const { signature, authority: _, ...unsigned } = input;
  const body = await parseAdmissionPolicyBody(unsigned);
  if (!verify(payload(body), Buffer.from(signature as string, 'base64url'), Buffer.from(authority, 'base64url'))) throw new Error('Invalid community policy signature');
  return { ...body, authority, signature: signature as string };
}
export function admissionPolicyDigest(policy: AdmissionPolicyBody) { return createHash('sha256').update(payload(policy)).digest('hex'); }
export function assertAdmissionPolicyCurrent(policy: AdmissionPolicyBody, now: number) {
  if (!timestamp(now) || now < policy.issuedAt || now >= policy.expiresAt) throw new Error('Community admission policy is not current; import a current signed revision');
}
export function assertAdmissionPolicySuccessor(previous: AdmissionPolicyBody, next: AdmissionPolicyBody) {
  if (next.revision < previous.revision || (next.revision === previous.revision && admissionPolicyDigest(next) !== admissionPolicyDigest(previous))) {
    throw new Error('Admission policy rollback or conflicting revision');
  }
  if (next.issuedAt < previous.issuedAt) throw new Error('Admission policy date moved backwards');
  if (previous.version === 2 && next.version !== 2) throw new Error('Cannot downgrade a policy with permanent archives');
  for (const old of previous.archivedKeys ?? []) {
    const archived = next.archivedKeys?.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === admissionKeyFingerprint(old.profile.issuerPublicKey));
    if (!archived || next.keys.some(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === admissionKeyFingerprint(old.profile.issuerPublicKey)) || JSON.stringify(archived) !== JSON.stringify(old)) throw new Error('Archived admission keys are permanent and immutable');
  }
  for (const old of previous.keys) {
    const archived = next.archivedKeys?.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === admissionKeyFingerprint(old.profile.issuerPublicKey));
    if (archived) {
      if (next.keys.some(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === admissionKeyFingerprint(old.profile.issuerPublicKey))
        || next.issuedAt < old.retryUntil || JSON.stringify(archived) !== JSON.stringify(old)) throw new Error('Archiving requires the original final cutoff and unchanged pins');
      continue;
    }
    const entry = next.keys.find(key => admissionKeyFingerprint(key.profile.issuerPublicKey) === admissionKeyFingerprint(old.profile.issuerPublicKey));
    if (!entry || JSON.stringify(entry.profile) !== JSON.stringify(old.profile) || JSON.stringify(entry.witnesses) !== JSON.stringify(old.witnesses) || entry.notBefore !== old.notBefore
      || entry.issueUntil > old.issueUntil || entry.spendUntil > old.spendUntil || entry.retryUntil > old.retryUntil) {
      throw new Error('A policy must retain prior keys and cannot change their pins or extend retirement cutoffs');
    }
  }
}
interface State { version: 1; authority: string | null; policy: SignedAdmissionPolicy | null }
/** The caller supplies a local storage key; signed content and the authority are public metadata. */
export async function openAdmissionPolicyStore(options: { path: string; encryptionKey: Uint8Array; now?: () => number; mode?: 'create-new' | 'open-existing' }) {
  const storage = openEncryptedLocalState<State>({ path: options.path, key: options.encryptionKey, domain: DOMAIN, maxBytes: 1024 * 1024,
    mode: options.mode, initial: { version: 1, authority: null, policy: null },
    validate: (value): value is State => exact(value, ['version','authority','policy']) && value.version === 1
      && ((value.authority === null && value.policy === null) || (bytes(value.authority, 32) && !!value.policy)) });
  let busy = false;
  try { const state = storage.read(); if (state.policy) await verifyAdmissionPolicy(state.policy, state.authority!); }
  catch (error) { storage.close(); throw error; }
  return {
    current() { const state = storage.read(); return state.policy ? structuredClone(state.policy) : undefined; },
    async install(value: unknown, authority: string) {
      const initial = storage.read(); if (busy) throw new Error('Policy update is already in progress');
      if (initial.authority && initial.authority !== authority) throw new Error('Community authority is already pinned');
      busy = true;
      try {
        const next = await verifyAdmissionPolicy(value, authority);
        const previous = storage.read().policy;
        assertAdmissionPolicyCurrent(next, (options.now ?? Date.now)());
        if (previous) assertAdmissionPolicySuccessor(previous, next);
        if (!previous || admissionPolicyDigest(previous) !== admissionPolicyDigest(next)) storage.write({ version: 1, authority, policy: next });
        return structuredClone(next);
      } finally { busy = false; }
    },
    close() { storage.close(); },
  };
}
