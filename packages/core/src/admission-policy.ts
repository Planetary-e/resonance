import { inspectResolvedAdmissionPolicy, parseAdmissionPolicyProofReference, archivedAdmissionPolicyDigest, verifyArchivedAdmissionPolicy, type ArchivedAdmissionPolicy, type AdmissionPolicyProofReference, type ResolvedAdmissionPolicy } from './admission-policy-archive.js';
/** Backend-only shared community admission policy: a pinned authority, revisions and cutoffs. */
import { createHash } from 'node:crypto';
import { parseAdmissionWitnessSet, type AdmissionWitnessSet } from './admission-witness.js';
import { sign, verify } from './crypto.js';
import { openEncryptedLocalState } from './local-encrypted-state.js';
import { admissionKeyFingerprint, parseAdmissionWalletProfile, type AdmissionWalletProfileV1, type AdmissionProfileKeyImports } from './admission-profile.js';
import { admissionPolicyObserversId, parseAdmissionPolicyObservers } from './admission-policy-freshness.js';
import { matchesAdmissionPolicyHead, parseAdmissionPolicyAdvance, sameAdmissionPolicyHead } from './admission-policy-advance.js';
import { inspectAdmissionPolicyObservation, parseAdmissionPolicyTrust, type AdmissionPolicyObservation, type AdmissionPolicyTrust } from './admission-policy-trust.js';
import { MAX_ADMISSION_KEYS, MAX_ARCHIVED_ADMISSION_KEYS, MAX_ADMISSION_POLICY_BYTES } from './admission-policy-limits.js';
export { MAX_ADMISSION_KEYS, MAX_ARCHIVED_ADMISSION_KEYS, MAX_ADMISSION_POLICY_BYTES } from './admission-policy-limits.js';
export { admissionKeyFingerprint, normalizeAdmissionRelay, parseAdmissionWalletProfile, type AdmissionWalletProfileV1, type AdmissionProfileKeyImports } from './admission-profile.js';

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
function legacyPolicy(policy: AdmissionPolicyBody) {
  if (policy?.version !== 1 && policy?.version !== 2) throw new Error('Legacy policy helper refuses v3; resolve its archive first');
}
export function admissionPolicyKeys(policy: AdmissionPolicyBody): AdmissionPolicyKey[] { legacyPolicy(policy); return [...policy.keys, ...(policy.archivedKeys ?? [])]; }
export function isArchivedAdmissionKey(policy: AdmissionPolicyBody, issuerKey: string): boolean {
  legacyPolicy(policy);
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
  legacyPolicy(body);
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
export async function parseAdmissionPolicyBody(value: unknown, imports?: AdmissionProfileKeyImports): Promise<AdmissionPolicyBody> {
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
    const { profile } = await parseAdmissionWalletProfile(entry.profile, imports); const id = admissionKeyFingerprint(profile.issuerPublicKey);
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
export async function verifyAdmissionPolicy(value: unknown, authority: string, imports?: AdmissionProfileKeyImports): Promise<SignedAdmissionPolicy> {
  admissionAuthorityFingerprint(authority);
  if (!exact(value, ['version','kind','revision','issuedAt','expiresAt','activeKey','keys','authority','signature', ...((value as AdmissionPolicyBody)?.version === 2 ? ['archivedKeys'] : [])])
    || value.authority !== authority || !bytes(value.signature, 64)
    || Buffer.byteLength(JSON.stringify(value) + '\n') > (value.version === 1 ? 65536 : MAX_ADMISSION_POLICY_BYTES)) throw new Error('Admission policy is not signed by the pinned community authority');
  const input = structuredClone(value); const { signature, authority: _, ...unsigned } = input;
  const body = await parseAdmissionPolicyBody(unsigned, imports);
  if (!verify(payload(body), Buffer.from(signature as string, 'base64url'), Buffer.from(authority, 'base64url'))) throw new Error('Invalid community policy signature');
  return { ...body, authority, signature: signature as string };
}
export function admissionPolicyDigest(policy: AdmissionPolicyBody) { return createHash('sha256').update(payload(policy)).digest('hex'); }
export function assertAdmissionPolicyCurrent(policy: AdmissionPolicyBody, now: number) {
  legacyPolicy(policy);
  if (!timestamp(now) || now < policy.issuedAt || now >= policy.expiresAt) throw new Error('Community admission policy is not current; import a current signed revision');
}
export function assertAdmissionPolicySuccessor(previous: AdmissionPolicyBody, next: AdmissionPolicyBody) {
  legacyPolicy(previous); legacyPolicy(next);
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
type State = { version: 1; authority: string | null; policy: SignedAdmissionPolicy | null }
  | { version: 2; authority: string; policy: SignedAdmissionPolicy; protectedHistoryContext: string }
  | { version: 3; authority: string; policy: SignedAdmissionPolicy; protectedHistoryContext: string | null; freshness: AdmissionPolicyTrust }
  | { version: 4; authority: string; policy: ArchivedAdmissionPolicy; protectedHistoryContext: string; freshness: AdmissionPolicyTrust; policyProof: AdmissionPolicyProofReference };
const historyContextId = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
/** The caller supplies a local storage key; signed content and the authority are public metadata. */
export async function openAdmissionPolicyStore(options: { path: string; encryptionKey: Uint8Array; now?: () => number; mode?: 'create-new' | 'open-existing' }) {
  const storage = openEncryptedLocalState<State>({ path: options.path, key: options.encryptionKey, domain: DOMAIN, maxBytes: 1024 * 1024,
    mode: options.mode, initial: { version: 1, authority: null, policy: null },
    validate: (value): value is State => (exact(value, ['version','authority','policy']) && value.version === 1
      && ((value.authority === null && value.policy === null) || (bytes(value.authority, 32) && !!value.policy)))
      || (exact(value, ['version','authority','policy','protectedHistoryContext']) && value.version === 2
        && bytes(value.authority, 32) && !!value.policy && historyContextId(value.protectedHistoryContext))
      || (exact(value, ['version','authority','policy','protectedHistoryContext','freshness']) && value.version === 3
        && bytes(value.authority, 32) && !!value.policy && (value.protectedHistoryContext === null || historyContextId(value.protectedHistoryContext))
        && (() => { try { parseAdmissionPolicyTrust(value.freshness, value.policy as SignedAdmissionPolicy); return true; } catch { return false; } })())
      || (exact(value, ['version','authority','policy','protectedHistoryContext','freshness','policyProof']) && value.version === 4
        && bytes(value.authority, 32) && !!value.policy && historyContextId(value.protectedHistoryContext)
        && (() => { try { parseAdmissionPolicyTrust(value.freshness, value.policy as ArchivedAdmissionPolicy); parseAdmissionPolicyProofReference(value.policyProof); return true; } catch { return false; } })()) });
  let busy = false, resolved: ResolvedAdmissionPolicy | undefined;
  try { const state = storage.read(); if (state.policy) await verifyArchivedAdmissionPolicy(state.policy, state.authority!); }
  catch (error) { storage.close(); throw error; }
  return {
    current() { const state = storage.read(); if (state.version === 4) throw new Error('Protected policy requires resolved retained history'); return state.policy ? structuredClone(state.policy) : undefined; },
    retained() { return structuredClone(storage.read()); },
    currentResolved() { const state = storage.read(); if (state.version === 4 && (!resolved || archivedAdmissionPolicyDigest(inspectResolvedAdmissionPolicy(resolved).policy) !== archivedAdmissionPolicyDigest(state.policy))) throw new Error('Protected policy mirror needs exact retained history validation'); return state.policy ? structuredClone(state.policy) : undefined; },
    protectedHistoryContext() { const state = storage.read(); return state.version !== 1 ? state.protectedHistoryContext ?? undefined : undefined; },
    freshness() { const state = storage.read(); return (state.version === 3 || state.version === 4) ? structuredClone(state.freshness) : undefined; },
    observe(observation: AdmissionPolicyObservation) {
      const state = storage.read();
      if (busy) throw new Error('Policy update is already in progress');
      if (state.version !== 3 && state.version !== 4) throw new Error('Policy observers have not been independently pinned');
      const inspected = inspectAdmissionPolicyObservation(state.freshness, observation, (options.now ?? Date.now)());
      if (inspected.state !== state.freshness) storage.write({ ...state, freshness: inspected.state });
      if (inspected.error) throw new Error(inspected.error);
    },
    /** Caller must verify prepared history before permanently binding its context.
     * This local format fence survives policy updates and rejects older readers. */
    bindProtectedHistory(contextId: string) {
      const state = storage.read();
      if (busy) throw new Error('Policy update is already in progress');
      if (!historyContextId(contextId) || !state.policy || !state.authority) throw new Error('A protected history binding requires an installed policy and valid context');
      if (state.version !== 1 && state.protectedHistoryContext) {
        if (state.protectedHistoryContext !== contextId) throw new Error('Protected history context is already pinned');
        return;
      }
      storage.write(state.version === 3 || state.version === 4 ? { ...state, protectedHistoryContext: contextId }
        : { version: 2, authority: state.authority, policy: state.policy, protectedHistoryContext: contextId });
    },
    async install(value: unknown, authority: string, pins: { observers?: unknown; advance?: unknown } = {}) {
      const initial = storage.read(); if (initial.version === 4) throw new Error('Protected policy installation must commit retained history first'); if (busy) throw new Error('Policy update is already in progress');
      if (initial.authority && initial.authority !== authority) throw new Error('Community authority is already pinned');
      busy = true;
      try {
        const input = structuredClone(value), advanceInput = pins.advance === undefined ? undefined : structuredClone(pins.advance);
        const observers = pins.observers === undefined ? undefined : parseAdmissionPolicyObservers(pins.observers);
        const next = await verifyAdmissionPolicy(input, authority);
        const previous = storage.read().policy;
        let freshness = initial.version === 3 ? initial.freshness : undefined;
        if (freshness?.conflict) throw new Error('Policy observations conflict; admission is fenced');
        if (freshness && observers && admissionPolicyObserversId(observers) !== admissionPolicyObserversId(freshness.context)) throw new Error('Policy observers are already pinned');
        const advance = advanceInput === undefined ? undefined : await parseAdmissionPolicyAdvance(advanceInput, freshness?.context ?? observers!);
        storage.read();
        if (!advance || !freshness || next.revision >= freshness.observed.revision) assertAdmissionPolicyCurrent(next, (options.now ?? Date.now)());
        if (freshness) {
          if (advance) {
            if (!matchesAdmissionPolicyHead(next, advance.commitment.next)
              || !sameAdmissionPolicyHead(advance.commitment.previous, freshness.installed) && !sameAdmissionPolicyHead(advance.commitment.next, freshness.installed)) {
              throw new Error('Policy update must extend the retained signed transition');
            }
            const head = advance.commitment.next;
            if (head.revision === freshness.observed.revision && !sameAdmissionPolicyHead(head, freshness.observed)) throw new Error('Policy update conflicts with the observed floor');
            freshness = { ...freshness, installed: head, observed: head.revision > freshness.observed.revision ? head : freshness.observed };
          } else if (!matchesAdmissionPolicyHead(next, freshness.installed)) throw new Error('Pinned policy freshness requires a signed immediate successor');
        } else if (observers) {
          if (advance || !matchesAdmissionPolicyHead(next, observers.genesis)) throw new Error('Initial observer binding requires its independently pinned genesis');
          freshness = parseAdmissionPolicyTrust({ context: observers, installed: observers.genesis, observed: observers.genesis }, next);
        } else if (advance) throw new Error('Policy transition requires independently pinned observers');
        if (previous) { if (previous.version === 3) throw new Error('Cannot use legacy installation after v3'); assertAdmissionPolicySuccessor(previous, next); }
        const current = storage.read();
        if (freshness) {
          const state: State = { version: 3, authority, policy: next,
            protectedHistoryContext: current.version === 1 ? null : current.protectedHistoryContext, freshness };
          if (JSON.stringify(state) !== JSON.stringify(current)) storage.write(state);
        } else if (!previous || admissionPolicyDigest(previous) !== admissionPolicyDigest(next)) storage.write({ ...current, authority, policy: next });
        return structuredClone(next);
      } finally { busy = false; }
    },
    /** The protected history has already passed four-copy commit. This mirrors only that exact opaque capability. */
    mirrorResolved(capability: ResolvedAdmissionPolicy, referenceValue: AdmissionPolicyProofReference, trustValue: AdmissionPolicyTrust, contextId: string) {
      const before = storage.read(); if (busy) throw new Error('Policy update is already in progress');
      const checked = inspectResolvedAdmissionPolicy(capability), policy = checked.policy, reference = parseAdmissionPolicyProofReference(referenceValue);
      const freshness = parseAdmissionPolicyTrust(structuredClone(trustValue), policy);
      if (!historyContextId(contextId) || !sameAdmissionPolicyHead(checked.head, reference.head) || !sameAdmissionPolicyHead(reference.head, freshness.installed)
        || admissionPolicyObserversId(checked.context) !== admissionPolicyObserversId(freshness.context)
        || admissionPolicyObserversId(reference.context) !== admissionPolicyObserversId(freshness.context)) throw new Error('Protected mirror differs from exact committed proof');
      if (before.authority && before.authority !== policy.authority || before.version !== 1 && before.protectedHistoryContext && before.protectedHistoryContext !== contextId) throw new Error('Protected mirror independent pins changed');
      const old = before.version === 3 || before.version === 4 ? before.freshness : undefined;
      if (old && (old.conflict && JSON.stringify(old) !== JSON.stringify(freshness)
        || admissionPolicyObserversId(old.context) !== admissionPolicyObserversId(freshness.context)
        || freshness.installed.revision < old.installed.revision || freshness.observed.revision < old.observed.revision
        || freshness.observed.revision === old.observed.revision && !sameAdmissionPolicyHead(freshness.observed, old.observed))) throw new Error('Protected mirror lost freshness floor or conflict');
      if (before.version === 4 && JSON.stringify(before.policyProof.limits) !== JSON.stringify(reference.limits)) throw new Error('Protected proof funding limits changed');
      const next: State = { version: 4, authority: policy.authority, policy, protectedHistoryContext: contextId, freshness, policyProof: reference };
      if (JSON.stringify(before) !== JSON.stringify(next)) storage.write(next);
      resolved = capability; return structuredClone(policy);
    },
    close() { storage.close(); },
  };
}
