/** Backend-only shared community admission policy: a pinned authority, revisions and cutoffs. */
import { createHash } from 'node:crypto';
import { sign, verify } from './crypto.js';
import { openEncryptedLocalState } from './local-encrypted-state.js';
import { admissionKeyFingerprint, parseAdmissionWalletProfile, type AdmissionWalletProfileV1 } from './admission-profile.js';
export { admissionKeyFingerprint, normalizeAdmissionRelay, parseAdmissionWalletProfile, type AdmissionWalletProfileV1 } from './admission-profile.js';

export interface AdmissionPolicyKey {
  profile: AdmissionWalletProfileV1;
  notBefore: number; issueUntil: number; spendUntil: number; retryUntil: number;
}
export interface AdmissionPolicyBody {
  version: 1; kind: 'admission-policy'; revision: number; issuedAt: number; expiresAt: number;
  activeKey: string; keys: AdmissionPolicyKey[];
}
export interface SignedAdmissionPolicy extends AdmissionPolicyBody { authority: string; signature: string }
const DOMAIN = 'resonance:admission-policy:v1';
const MAX_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const exact = (value: unknown, fields: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).sort().join(',') === fields.sort().join(',');
function bytes(value: unknown, size: number): value is string {
  return typeof value === 'string' && value.length <= 100 && Buffer.from(value, 'base64url').length === size && Buffer.from(value, 'base64url').toString('base64url') === value;
}
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function payload(body: AdmissionPolicyBody) {
  return Buffer.from(`${DOMAIN}\n${JSON.stringify([body.version, body.kind, body.revision, body.issuedAt, body.expiresAt, body.activeKey,
    body.keys.map(entry => [entry.profile, entry.notBefore, entry.issueUntil, entry.spendUntil, entry.retryUntil])])}`);
}
export function admissionAuthorityFingerprint(authority: string) {
  if (!bytes(authority, 32)) throw new Error('Invalid community authority key');
  return `sha256:${createHash('sha256').update(Buffer.from(authority, 'base64url')).digest('hex')}`;
}
async function parseBody(value: unknown): Promise<AdmissionPolicyBody> {
  if (!exact(value, ['version','kind','revision','issuedAt','expiresAt','activeKey','keys']) || value.version !== 1 || value.kind !== 'admission-policy'
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || !timestamp(value.issuedAt) || !timestamp(value.expiresAt)
    || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > MAX_LIFETIME
    || typeof value.activeKey !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.activeKey)
    || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 8
    || JSON.stringify(value).length > 64 * 1024) throw new Error('Invalid signed admission policy');
  const input = structuredClone(value); const keys: AdmissionPolicyKey[] = []; const seen = new Set<string>();
  for (const entry of input.keys as unknown[]) {
    if (!exact(entry, ['profile','notBefore','issueUntil','spendUntil','retryUntil'])
      || !timestamp(entry.notBefore) || !timestamp(entry.issueUntil) || !timestamp(entry.spendUntil) || !timestamp(entry.retryUntil)
      || entry.notBefore >= entry.issueUntil || entry.issueUntil > entry.spendUntil || entry.spendUntil > entry.retryUntil) throw new Error('Invalid admission key cutoffs');
    const { profile } = await parseAdmissionWalletProfile(entry.profile); const id = admissionKeyFingerprint(profile.issuerPublicKey);
    if (seen.has(id)) throw new Error('Duplicate issuer key in admission policy');
    seen.add(id); keys.push({ profile, notBefore: entry.notBefore, issueUntil: entry.issueUntil, spendUntil: entry.spendUntil, retryUntil: entry.retryUntil });
  }
  if (!seen.has(input.activeKey as string)) throw new Error('Active issuer key is absent from the policy');
  return { version: 1, kind: 'admission-policy', revision: input.revision as number, issuedAt: input.issuedAt as number,
    expiresAt: input.expiresAt as number, activeKey: input.activeKey as string, keys };
}
export async function signAdmissionPolicy(value: unknown, authority: string, secretKey: Uint8Array): Promise<SignedAdmissionPolicy> {
  admissionAuthorityFingerprint(authority); const secret = Uint8Array.from(secretKey);
  try {
    const body = await parseBody(value); const signature = sign(payload(body), secret);
    if (!verify(payload(body), signature, Buffer.from(authority, 'base64url'))) throw new Error('Community authority private key does not match');
    return { ...body, authority, signature: Buffer.from(signature).toString('base64url') };
  } finally { secret.fill(0); }
}
export async function verifyAdmissionPolicy(value: unknown, authority: string): Promise<SignedAdmissionPolicy> {
  admissionAuthorityFingerprint(authority);
  if (!exact(value, ['version','kind','revision','issuedAt','expiresAt','activeKey','keys','authority','signature'])
    || value.authority !== authority || !bytes(value.signature, 64)) throw new Error('Admission policy is not signed by the pinned community authority');
  const input = structuredClone(value); const { signature, authority: _, ...unsigned } = input;
  const body = await parseBody(unsigned);
  if (!verify(payload(body), Buffer.from(signature as string, 'base64url'), Buffer.from(authority, 'base64url'))) throw new Error('Invalid community policy signature');
  return { ...body, authority, signature: signature as string };
}
export function admissionPolicyDigest(policy: SignedAdmissionPolicy) { return createHash('sha256').update(payload(policy)).digest('hex'); }
export function assertAdmissionPolicyCurrent(policy: SignedAdmissionPolicy, now: number) {
  if (!timestamp(now) || now < policy.issuedAt || now >= policy.expiresAt) throw new Error('Community admission policy is not current; import a current signed revision');
}
export function assertAdmissionPolicySuccessor(previous: SignedAdmissionPolicy, next: SignedAdmissionPolicy) {
  if (next.revision < previous.revision || (next.revision === previous.revision && admissionPolicyDigest(next) !== admissionPolicyDigest(previous))) {
    throw new Error('Admission policy rollback or conflicting revision');
  }
  if (next.issuedAt < previous.issuedAt) throw new Error('Admission policy date moved backwards');
  for (const old of previous.keys) {
    const entry = next.keys.find(key => admissionKeyFingerprint(key.profile.issuerPublicKey) === admissionKeyFingerprint(old.profile.issuerPublicKey));
    if (!entry || JSON.stringify(entry.profile) !== JSON.stringify(old.profile) || entry.notBefore !== old.notBefore
      || entry.issueUntil > old.issueUntil || entry.spendUntil > old.spendUntil || entry.retryUntil > old.retryUntil) {
      throw new Error('A policy must retain prior keys and cannot change their pins or extend retirement cutoffs');
    }
  }
}
interface State { version: 1; authority: string | null; policy: SignedAdmissionPolicy | null }
/** The caller supplies a local storage key; signed content and the authority are public metadata. */
export async function openAdmissionPolicyStore(options: { path: string; encryptionKey: Uint8Array; now?: () => number; mode?: 'create-new' | 'open-existing' }) {
  const storage = openEncryptedLocalState<State>({ path: options.path, key: options.encryptionKey, domain: DOMAIN, maxBytes: 128 * 1024,
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
