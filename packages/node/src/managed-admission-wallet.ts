/** Pinned active wallet plus immutable prior profiles for exact retries. */
import { verifyAdmissionPolicy, assertAdmissionPolicyCurrent, assertAdmissionPolicySuccessor, admissionAuthorityFingerprint, admissionPolicyDigest, admissionPolicyKeys, MAX_ADMISSION_KEYS, MAX_ARCHIVED_ADMISSION_KEYS, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openEncryptedLocalState } from './encrypted-local-state.js';
import { openBlindAdmissionWalletV2, type BlindAdmissionWalletV2 } from './blind-admission-wallet.js';
import { admissionKeyFingerprint, normalizeAdmissionRelay, parseAdmissionWalletProfile, type AdmissionWalletProfileV1 } from './admission-wallet-profile.js';
import { createAdmissionIssuanceBatch, validateAdmissionIssuanceResponse, type AdmissionIssuanceRequest } from './blind-admission-issuance.js';
import type { AdmissionCapabilityRequestContextV2 } from './relay-client.js';
export type { AdmissionWalletProfileV1 } from './admission-wallet-profile.js';

export interface AdmissionWalletStatus {
  configured: boolean; scope?: AdmissionWalletProfileV1['scope']; keyFingerprint?: string; relayUrls?: string[];
  available: number; reserved: number; total: number; capacity: number; availableCapacity: number;
  archived: Array<{ scope: AdmissionWalletProfileV1['scope']; keyFingerprint: string; available: number; reserved: number; permanentlyRetired: boolean; canRetire: boolean; tokensRemoved?: number; reservationsRemoved?: number }>;
  pendingIssuance?: AdmissionIssuanceRequest;
  policy?: { currentKeys: number; archivedKeys: number; revision: number; authorityFingerprint: string; expiresAt: number; issueUntil: number; spendUntil: number; retryUntil: number };
}
interface StateV1 { version: 1; profile: AdmissionWalletProfileV1 | null }
interface StateV2 { version: 2 | 3 | 4; active: number; profiles: AdmissionWalletProfileV1[]; policy?: SignedAdmissionPolicy }
type State = StateV1 | StateV2;
const MAX_PROFILES = MAX_ADMISSION_KEYS;
const MAX_PROFILE_HISTORY = MAX_ADMISSION_KEYS + MAX_ARCHIVED_ADMISSION_KEYS;
function stateV2(state: State): StateV2 {
  return state.version !== 1 ? state : { version: 2, active: 0, profiles: state.profile ? [state.profile] : [] };
}
function validState(value: unknown): value is State {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as State;
  if (state.version === 1) return Object.keys(state).sort().join(',') === 'profile,version'
    && (state.profile === null || (!!state.profile && typeof state.profile === 'object'));
  return ((state.version === 2 && Object.keys(state).sort().join(',') === 'active,profiles,version')
    || ((state.version === 3 || state.version === 4) && Object.keys(state).sort().join(',') === 'active,policy,profiles,version' && !!state.policy
      && (state.version === 4 ? state.policy.version === 2 : state.policy.version === 1)))
    && Array.isArray(state.profiles) && state.profiles.length >= 1 && state.profiles.length <= (state.version === 4 ? MAX_PROFILE_HISTORY : MAX_PROFILES)
    && Number.isInteger(state.active) && state.active >= 0 && state.active < state.profiles.length;
}

export async function openManagedAdmissionWallet(options: { directory: string; encryptionKey: Uint8Array; now?: () => number }) {
  const key = Buffer.from(options.encryptionKey);
  let storage: ReturnType<typeof openEncryptedLocalState<State>>;
  try { storage = openEncryptedLocalState<State>({ path: join(options.directory, 'admission-profile.json'), key,
    domain: 'resonance:admission-profile:v1', maxBytes: 2 * 1024 * 1024, initial: { version: 1, profile: null }, validate: validState });
  } catch (error) { key.fill(0); throw error; }
  const wallets: BlindAdmissionWalletV2[] = [];
  let busy = false; let closed = false;
  let pending: { batch: Awaited<ReturnType<typeof createAdmissionIssuanceBatch>>; tokens?: string[]; response?: string } | undefined;
  function file(index: number, profile: AdmissionWalletProfileV1) {
    return join(options.directory, index === 0 ? 'admission-wallet.json' : `admission-wallet-${admissionKeyFingerprint(profile.issuerPublicKey).slice(7)}.json`);
  }
  function open(index: number, parsed: Awaited<ReturnType<typeof parseAdmissionWalletProfile>>, existing = false) {
    return openBlindAdmissionWalletV2({ path: file(index, parsed.profile), encryptionKey: key,
      scope: parsed.profile.scope, issuerPublicKey: parsed.publicKey, now: options.now, mode: existing ? 'open-existing' : undefined });
  }
  try {
    const state = stateV2(storage.read());
    if (state.policy) {
      await verifyAdmissionPolicy(state.policy, state.policy.authority);
      for (const profile of state.profiles) if (!admissionPolicyKeys(state.policy).some(entry => JSON.stringify(entry.profile) === JSON.stringify(profile))) throw new Error('Wallet profile is absent from its signed policy');
      if (admissionKeyFingerprint(state.profiles[state.active].issuerPublicKey) !== state.policy.activeKey) throw new Error('Wallet active key differs from signed policy');
    }
    const seen = new Set<string>();
    for (const [index, profile] of state.profiles.entries()) {
      const parsed = await parseAdmissionWalletProfile(profile);
      const fingerprint = admissionKeyFingerprint(parsed.profile.issuerPublicKey);
      if (seen.has(fingerprint)) throw new Error('A wallet key cannot be shared across pinned profiles');
      seen.add(fingerprint);
      // Missing history is not a new wallet. Never recreate it and permit token reuse.
      if (!existsSync(file(index, profile))) throw new Error('Saved access-token wallet is missing; restore its history');
      wallets.push(open(index, parsed, true));
    }
    validateRetiredWallets(state, wallets);
  } catch (error) { wallets.forEach(wallet => wallet.close()); storage.close(); key.fill(0); throw error; }
  function validateRetiredWallets(state: StateV2, candidates: BlindAdmissionWalletV2[]) {
    for (const [index, wallet] of candidates.entries()) {
      const r = wallet.summary().retirement; if (!r) continue;
      const policy = state.policy, entry = policy ? admissionPolicyKeys(policy).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === r.issuerKey) : undefined;
      if (index === state.active) throw new Error('Cannot reactivate a permanently retired wallet');
      if (!policy || !entry || admissionAuthorityFingerprint(policy.authority) !== r.authorityFingerprint
        || policy.revision < r.policyRevision || entry.retryUntil > r.retryUntil
        || (policy.revision === r.policyRevision && admissionPolicyDigest(policy) !== r.policyDigest)) {
        throw new Error('Retired wallet does not match its pinned community policy');
      }
    }
  }
  function retirementTarget(issuerKey: string) {
    ready(); if (pending) throw new Error('Finish or cancel the pending token request before wallet cleanup');
    const state = stateV2(storage.read());
    if (!state.policy) throw new Error('Wallet cleanup requires an installed signed community policy');
    const index = state.profiles.findIndex(profile => admissionKeyFingerprint(profile.issuerPublicKey) === issuerKey);
    if (index < 0) throw new Error('Unknown access-token wallet');
    if (index === state.active) throw new Error('Cannot retire the active wallet; install a successor first');
    return { state, policy: state.policy, wallet: wallets[index] };
  }
  function eligible(state: StateV2, issuerKey: string) {
    if (busy || pending || !state.policy) return false;
    try { assertAdmissionPolicyCurrent(state.policy, (options.now ?? Date.now)()); } catch { return false; }
    const entry = admissionPolicyKeys(state.policy).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === issuerKey);
    return !!entry && state.policy.activeKey !== issuerKey && (options.now ?? Date.now)() >= entry.retryUntil;
  }
  function ready() { storage.read(); if (busy) throw new Error('Access-token wallet update is in progress'); }
  function active() {
    const state = stateV2(storage.read()); const wallet = wallets[state.active];
    if (!wallet) throw new Error('Set up the access-token wallet first');
    return { state, wallet, profile: state.profiles[state.active] };
  }
  function checkPolicy(profile: AdmissionWalletProfileV1, use: 'issue' | 'spend' | 'retry') {
    const state = stateV2(storage.read()); if (!state.policy) return;
    const now = (options.now ?? Date.now)(); assertAdmissionPolicyCurrent(state.policy, now);
    const entry = state.policy.keys.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === admissionKeyFingerprint(profile.issuerPublicKey));
    const cutoff = use === 'issue' ? entry?.issueUntil : use === 'spend' ? entry?.spendUntil : entry?.retryUntil;
    if (!entry || now < entry.notBefore || now >= cutoff!) throw new Error('Issuer key is not active for this operation under the community policy');
  }
  return {
    planRetirement(issuerKey: string) {
      const { wallet, policy, state } = retirementTarget(issuerKey);
      return wallet.planRetirement(policy, state);
    },
    retire(issuerKey: string, approvalDigest: string) {
      const { wallet, policy, state } = retirementTarget(issuerKey);
      return wallet.retire(policy, approvalDigest, state);
    },
    configured(): boolean { return stateV2(storage.read()).profiles.length > 0; },
    status(): AdmissionWalletStatus {
      const state = stateV2(storage.read());
      if (!state.profiles.length) return { configured: false, available: 0, reserved: 0, total: 0, capacity: 4096, availableCapacity: 256, archived: [] };
      const { wallet, profile } = active();
      return { configured: true, scope: structuredClone(profile.scope), relayUrls: [...profile.relayUrls],
        keyFingerprint: admissionKeyFingerprint(profile.issuerPublicKey), ...wallet.summary(),
        archived: state.profiles.flatMap((prior, index) => {
          if (index === state.active) return [];
          const summary = wallets[index].summary(), keyFingerprint = admissionKeyFingerprint(prior.issuerPublicKey);
          return [{ scope: structuredClone(prior.scope), keyFingerprint, available: summary.available, reserved: summary.reserved,
            permanentlyRetired: summary.permanentlyRetired, canRetire: !summary.permanentlyRetired && eligible(state, keyFingerprint),
            ...(summary.retirement ? { tokensRemoved: summary.retirement.tokensRemoved, reservationsRemoved: summary.retirement.reservationsRemoved } : {}) }];
        }),
        ...(state.policy ? { policy: { currentKeys: state.policy.keys.length, archivedKeys: state.policy.archivedKeys?.length ?? 0, revision: state.policy.revision, authorityFingerprint: admissionAuthorityFingerprint(state.policy.authority), expiresAt: state.policy.expiresAt,
          ...(() => { const entry = state.policy!.keys.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === state.policy!.activeKey)!;
            return { issueUntil: entry.issueUntil, spendUntil: entry.spendUntil, retryUntil: entry.retryUntil }; })() } } : {}),
        ...(pending ? { pendingIssuance: structuredClone(pending.batch.request) } : {}) };
    },
    async configure(value: unknown) {
      ready(); if (stateV2(storage.read()).policy) throw new Error('Wallet setup is managed by signed community policy; import a newer signed revision');
      if (pending) throw new Error('Finish or cancel the pending token request before changing wallet setup');
      busy = true;
      try {
        const parsed = await parseAdmissionWalletProfile(value);
        const state = stateV2(storage.read()); // Session lock during crypto prevents commit.
        const prior = state.profiles.findIndex(profile => admissionKeyFingerprint(profile.issuerPublicKey) === admissionKeyFingerprint(parsed.profile.issuerPublicKey));
        if (prior !== -1) {
          if (JSON.stringify(state.profiles[prior]) !== JSON.stringify(parsed.profile)) throw new Error('This issuer key is already pinned; a different period or setup requires a new key');
          if (wallets[prior].summary().permanentlyRetired) throw new Error('Cannot reactivate a permanently retired wallet');
          if (prior !== state.active) storage.write({ ...state, active: prior });
          return;
        }
        if (state.profiles.length >= MAX_PROFILES) throw new Error('Wallet profile history is full; existing reservations must be retained');
        // Create the empty token file first. A crash can leave an orphan, never a pinned missing wallet.
        const wallet = open(state.profiles.length, parsed);
        try {
          if (wallet.summary().permanentlyRetired) throw new Error('Cannot reactivate a permanently retired wallet');
          storage.write({ version: 2, active: state.profiles.length, profiles: [...state.profiles, parsed.profile] });
        }
        catch (error) { wallet.close(); throw error; }
        wallets.push(wallet);
      } finally { busy = false; }
    },
    async installPolicy(value: unknown, authority: string) {
      ready(); if (pending) throw new Error('Finish or cancel the pending token request before changing community policy');
      busy = true; const opened: BlindAdmissionWalletV2[] = [];
      try {
        const previous = stateV2(storage.read());
        if (previous.policy && previous.policy.authority !== authority) throw new Error('Community authority is already pinned');
        const policy = await verifyAdmissionPolicy(value, authority);
        storage.read(); assertAdmissionPolicyCurrent(policy, (options.now ?? Date.now)());
        if (previous.policy) assertAdmissionPolicySuccessor(previous.policy, policy);
        const profiles = [...previous.profiles];
        for (const profile of profiles) if (!admissionPolicyKeys(policy).some(entry => JSON.stringify(entry.profile) === JSON.stringify(profile))) {
          throw new Error('Signed policy must retain all existing wallet profiles with their original pins');
        }
        for (const entry of policy.keys) {
          if (profiles.some(profile => admissionKeyFingerprint(profile.issuerPublicKey) === admissionKeyFingerprint(entry.profile.issuerPublicKey))) continue;
          if (profiles.length >= (policy.version === 2 ? MAX_PROFILE_HISTORY : MAX_PROFILES)) throw new Error('Wallet profile history is full');
          const parsed = await parseAdmissionWalletProfile(entry.profile); storage.read();
          opened.push(open(profiles.length, parsed)); profiles.push(parsed.profile);
        }
        const active = profiles.findIndex(profile => admissionKeyFingerprint(profile.issuerPublicKey) === policy.activeKey);
        validateRetiredWallets({ version: policy.version === 2 ? 4 : 3, active, profiles, policy }, [...wallets, ...opened]);
        storage.write({ version: policy.version === 2 ? 4 : 3, active, profiles, policy });
        wallets.push(...opened); opened.length = 0;
      } finally { opened.forEach(wallet => wallet.close()); busy = false; }
    },
    async importTokens(tokens: readonly string[]) {
      ready(); if (pending) throw new Error('Finish or cancel the pending token request before importing manual tokens');
      busy = true;
      try { const { wallet, profile } = active(); checkPolicy(profile, 'spend'); return await wallet.importTokens(tokens); } finally { busy = false; }
    },
    async requestTokens(count: number) {
      ready(); if (pending) throw new Error('A token request is already pending');
      busy = true;
      try {
        const { wallet, profile } = active(); checkPolicy(profile, 'issue'); const summary = wallet.summary();
        if (count + summary.available > summary.availableCapacity || count + summary.total > summary.capacity) throw new Error('Not enough wallet capacity for this token request');
        const batch = await createAdmissionIssuanceBatch(profile, count);
        storage.read(); pending = { batch };
        return structuredClone(batch.request);
      } finally { busy = false; }
    },
    async completeIssuance(value: unknown) {
      ready(); if (!pending) throw new Error('No pending token request; locking or restarting cancels unfinished issuance');
      busy = true;
      try {
        const current = pending;
        validateAdmissionIssuanceResponse(value, current.batch.request);
        const response = JSON.stringify([value.batchId, value.responses]);
        if (current.response && current.response !== response) throw new Error('Retry with the same signed response');
        if (!current.tokens) {
          try { current.tokens = await current.batch.finalize(value); }
          catch { if (pending === current) pending = undefined; throw new Error('Invalid issuer response; request a new blinded batch'); }
          storage.read(); current.response = response;
        }
        const target = active(); checkPolicy(target.profile, 'spend');
        const imported = await target.wallet.importTokens(current.tokens);
        storage.read(); pending = undefined;
        return imported;
      } finally { busy = false; }
    },
    cancelIssuance() { ready(); pending = undefined; },
    capabilityFor(context: AdmissionCapabilityRequestContextV2) {
      ready(); const state = stateV2(storage.read()); if (!state.profiles.length) return undefined;
      const normalized = { ...context, relayUrl: normalizeAdmissionRelay(context.relayUrl) };
      // Search ALL old reservations before allocating from the active profile. An old retry
      // must fail at the relay if its epoch is retired, never silently spend a fresh token.
      let reserved: { capability: NonNullable<ReturnType<BlindAdmissionWalletV2['reservedCapabilityFor']>>; index: number } | undefined;
      for (const [index, wallet] of wallets.entries()) {
        // Scan every denial fence before returning even a reservation from an earlier wallet.
        const previous = wallet.reservedCapabilityFor(normalized);
        if (previous && !reserved) reserved = { capability: previous, index };
      }
      if (reserved) { checkPolicy(state.profiles[reserved.index], 'retry'); return reserved.capability; }
      const { wallet, profile } = active(); checkPolicy(profile, 'spend');
      if (!profile.relayUrls.includes(normalized.relayUrl)) throw new Error('Destination is not in the pinned access-token relay list');
      return wallet.capabilityFor(normalized);
    },
    close() { if (closed) return; closed = true; pending = undefined; wallets.forEach(wallet => wallet.close()); storage.close(); key.fill(0); },
  };
}
export type ManagedAdmissionWallet = Awaited<ReturnType<typeof openManagedAdmissionWallet>>;
