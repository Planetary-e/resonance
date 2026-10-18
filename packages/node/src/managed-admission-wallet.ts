/** Pinned active wallet plus immutable prior profiles for exact retries. */
import { verifyAdmissionPolicy, assertAdmissionPolicyCurrent, assertAdmissionPolicySuccessor, admissionAuthorityFingerprint, admissionPolicyDigest, admissionPolicyKeys, MAX_ADMISSION_KEYS, MAX_ARCHIVED_ADMISSION_KEYS, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { captureStorageReservationOperation, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { openWalletPolicyProofStore, parseWalletPolicyProofReference, type WalletPolicyProofReference, type WalletPolicyProofStorage } from './wallet-policy-proof-store.js';
import { archivedAdmissionPolicyDigest, inspectResolvedAdmissionPolicy, retainedResolvedAdmissionPolicyKey, resolveAdmissionPolicy, resolveAdmissionPolicyAdvance, type ArchivedAdmissionPolicy, type ResolvedAdmissionPolicy, type ArchivedAdmissionPolicyAdvance } from '@resonance/core/admission-policy-archive';
import type { AdmissionPolicyKey } from '@resonance/core/admission-policy';
import type { AdmissionPolicyProofStep } from '@resonance/core/admission-policy-transfer';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openEncryptedLocalState } from './encrypted-local-state.js';
import { openBlindAdmissionWalletV2, type BlindAdmissionWalletV2 } from './blind-admission-wallet.js';
import { admissionKeyFingerprint, normalizeAdmissionRelay, parseAdmissionWalletProfile, type AdmissionWalletProfileV1 } from './admission-wallet-profile.js';
import { createAdmissionIssuanceBatch, validateAdmissionIssuanceResponse, type AdmissionIssuanceRequest } from './blind-admission-issuance.js';
import { parseAdmissionPolicyObservers, admissionPolicyObserversId } from '@resonance/core/admission-policy-freshness';
import { admissionPolicyHead, sameAdmissionPolicyHead, parseAdmissionPolicyAdvance } from '@resonance/core/admission-policy-advance';
import { inspectWalletPolicyObservation, parseWalletPolicyFreshness, type WalletPolicyFreshness, type WalletPolicyObservation } from './wallet-policy-freshness.js';
import type { AdmissionCapabilityProviderV2, AdmissionCapabilityRequestContextV2 } from './relay-client.js';
export type { AdmissionWalletProfileV1 } from './admission-wallet-profile.js';

export interface AdmissionWalletStatus {
  freshness?: { required: true; installedRevision: number; observedRevision: number; conflicted: boolean };
  configured: boolean; scope?: AdmissionWalletProfileV1['scope']; keyFingerprint?: string; relayUrls?: string[];
  available: number; reserved: number; total: number; capacity: number; availableCapacity: number;
  archived: Array<{ scope: AdmissionWalletProfileV1['scope']; keyFingerprint: string; available: number; reserved: number; permanentlyRetired: boolean; canRetire: boolean; tokensRemoved?: number; reservationsRemoved?: number }>;
  pendingIssuance?: AdmissionIssuanceRequest;
  policy?: { currentKeys: number; archivedKeys: number; revision: number; authorityFingerprint: string; expiresAt: number; issueUntil: number; spendUntil: number; retryUntil: number };
}
interface StateV1 { version: 1; profile: AdmissionWalletProfileV1 | null }
interface StateV2 { version: 2 | 3 | 4 | 5 | 6; active: number; profiles: AdmissionWalletProfileV1[]; policy?: ArchivedAdmissionPolicy; freshness?: WalletPolicyFreshness; proof?: WalletPolicyProofReference }
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
      && (state.version === 4 ? state.policy.version === 2 : state.policy.version === 1))
    || (state.version === 5 && Object.keys(state).sort().join(',') === 'active,freshness,policy,profiles,version' && !!state.policy && !!state.freshness)
    || (state.version === 6 && Object.keys(state).sort().join(',') === 'active,freshness,policy,profiles,proof,version' && !!state.policy && !!state.freshness && !!state.proof))
    && Array.isArray(state.profiles) && state.profiles.length >= 1 && state.profiles.length <= (state.version >= 4 ? MAX_PROFILE_HISTORY : MAX_PROFILES)
    && Number.isInteger(state.active) && state.active >= 0 && state.active < state.profiles.length;
}

interface ProofOperation { signal: AbortSignal; check(): void; wait<T>(work: () => Promise<T>): Promise<T>; close(): void }
function proofOperation(timeoutMs: number, external?: AbortSignal): ProofOperation {
  const controller = new AbortController(), deadline = performance.now() + timeoutMs;
  const abort = () => controller.abort();
  external?.addEventListener('abort', abort, { once: true });
  if (external?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  function check() {
    if (performance.now() >= deadline) abort();
    if (controller.signal.aborted) throw new Error('Wallet proof operation cancelled or timed out');
  }
  return { signal: controller.signal, check,
    async wait<T>(work: () => Promise<T>) {
      check(); let onAbort: (() => void) | undefined;
      try {
        const refusal = new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error('Wallet proof operation cancelled or timed out'));
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        const result = await Promise.race([refusal, Promise.resolve().then(work)]); check(); return result;
      } finally { if (onAbort) controller.signal.removeEventListener('abort', onAbort); }
    },
    close() { clearTimeout(timer); external?.removeEventListener('abort', abort); },
  };
}

export async function openManagedAdmissionWallet(options: { directory: string; encryptionKey: Uint8Array; now?: () => number; proofStorage?: WalletPolicyProofStorage }) {
  options = { ...options };
  const proofStorage = options.proofStorage ? { ...options.proofStorage, limits: structuredClone(options.proofStorage.limits) } : undefined;
  if (proofStorage && proofStorage.authority.status().authorityId !== proofStorage.authorityId) throw new Error('Wallet proof storage authority differs from its independently selected pin');
  const inheritedOperation = captureStorageReservationOperation();
  const run = <T>(work: () => T): T => proofStorage
    ? withStorageReservationAuthority(proofStorage.authority, work) : inheritedOperation(work);
  const key = Buffer.from(options.encryptionKey);
  let storage: ReturnType<typeof openEncryptedLocalState<State>>;
  try { storage = run(() => openEncryptedLocalState<State>({ path: join(options.directory, 'admission-profile.json'), key,
    domain: 'resonance:admission-profile:v1', maxBytes: 2 * 1024 * 1024, initial: { version: 1, profile: null }, validate: validState }));
  } catch (error) { key.fill(0); throw error; }
  const wallets: BlindAdmissionWalletV2[] = [];
  let busy = false; let closed = false; let poisoned = false;
  let proof: ReturnType<typeof openWalletPolicyProofStore> | undefined;
  let resolved: ResolvedAdmissionPolicy | undefined;
  let proofCursor: { reference: WalletPolicyProofReference; resolved: ResolvedAdmissionPolicy } | undefined;
  let profileEntries = new Map<string, AdmissionPolicyKey>();
  function policyEntries(state: StateV2): AdmissionPolicyKey[] {
    if (!state.policy) return [];
    if (state.version === 6) return [...profileEntries.values()];
    if (state.policy.version === 3) throw new Error('V3 requires the wallet v6 proof reference');
    return admissionPolicyKeys(state.policy);
  }
  function current(policy: ArchivedAdmissionPolicy) {
    const now = (options.now ?? Date.now)();
    if (now < policy.issuedAt || now >= policy.expiresAt) throw new Error('Community policy is not current');
  }
  let pending: { batch: Awaited<ReturnType<typeof createAdmissionIssuanceBatch>>; tokens?: string[]; response?: string } | undefined;
  function file(index: number, profile: AdmissionWalletProfileV1) {
    return join(options.directory, index === 0 ? 'admission-wallet.json' : `admission-wallet-${admissionKeyFingerprint(profile.issuerPublicKey).slice(7)}.json`);
  }
  function open(index: number, parsed: Awaited<ReturnType<typeof parseAdmissionWalletProfile>>, existing = false) {
    return run(() => openBlindAdmissionWalletV2({ path: file(index, parsed.profile), encryptionKey: key,
      scope: parsed.profile.scope, issuerPublicKey: parsed.publicKey, now: options.now, mode: existing ? 'open-existing' : undefined }));
  }
  const opening = proofStorage ? proofOperation(proofStorage.limits.timeoutMs) : undefined;
  try {
    const state = stateV2(storage.read());
    if (proofStorage) proof = run(() => openWalletPolicyProofStore(proofStorage!, key));
    if (state.version === 6) {
      if (!proof || !state.proof || !state.freshness || !state.policy) throw new Error('Wallet v6 requires its funded policy proof storage');
      const replay = await proof.resolve(parseWalletPolicyProofReference(state.proof), state.freshness.context, opening?.signal,
        state.profiles.map(profile => admissionKeyFingerprint(profile.issuerPublicKey)));
      resolved = replay.resolved; profileEntries = replay.entries;
      const inspected = inspectResolvedAdmissionPolicy(resolved);
      if (JSON.stringify(inspected.policy) !== JSON.stringify(state.policy) || !sameAdmissionPolicyHead(inspected.head, state.freshness.installed)) throw new Error('Wallet profile differs from its exact original proof');
      proofCursor = { reference: state.proof, resolved };
    }
    if (state.policy) {
      if (state.version !== 6) {
        const policy = state.policy;
        if (opening) await opening.wait(() => verifyAdmissionPolicy(policy, policy.authority));
        else await verifyAdmissionPolicy(policy, policy.authority);
      }
      if (state.freshness) parseWalletPolicyFreshness(state.freshness, state.policy);
      for (const profile of state.profiles) if (!policyEntries(state).some(entry => JSON.stringify(entry.profile) === JSON.stringify(profile))) throw new Error('Wallet profile is absent from its signed policy');
      if (admissionKeyFingerprint(state.profiles[state.active].issuerPublicKey) !== state.policy.activeKey) throw new Error('Wallet active key differs from signed policy');
    }
    const seen = new Set<string>();
    for (const [index, profile] of state.profiles.entries()) {
      const parsed = opening ? await opening.wait(() => parseAdmissionWalletProfile(profile)) : await parseAdmissionWalletProfile(profile);
      const fingerprint = admissionKeyFingerprint(parsed.profile.issuerPublicKey);
      if (seen.has(fingerprint)) throw new Error('A wallet key cannot be shared across pinned profiles');
      seen.add(fingerprint);
      // Missing history is not a new wallet. Never recreate it and permit token reuse.
      if (!existsSync(file(index, profile))) throw new Error('Saved access-token wallet is missing; restore its history');
      wallets.push(open(index, parsed, true));
    }
    validateRetiredWallets(state, wallets);
    if (proof && state.version !== 6 && proof.progress().progress) {
      const progress = proof.progress();
      if (!progress.context || !progress.progress || (state.freshness && admissionPolicyObserversId(state.freshness.context) !== admissionPolicyObserversId(progress.context))) throw new Error('Backfill differs from retained wallet pins');
      const replay = await proof.resolve(progress.progress, progress.context, opening?.signal, state.profiles.map(profile => admissionKeyFingerprint(profile.issuerPublicKey)));
      const cursorPolicy = inspectResolvedAdmissionPolicy(replay.resolved).policy;
      if (state.policy && (cursorPolicy.revision > state.policy.revision || (cursorPolicy.revision === state.policy.revision && JSON.stringify(cursorPolicy) !== JSON.stringify(state.policy)))) throw new Error('Backfill differs from the installed wallet policy');
      proofCursor = { reference: progress.progress, resolved: replay.resolved };
      // A crash may have flushed completed non-authorizing progress just before
      // the profile activation. Revalidate and finish that exact commit on open.
      if (state.policy && cursorPolicy.revision === state.policy.revision) await activateProof(state, replay.resolved, progress.progress, replay.entries, opening?.signal, opening);
    }
  } catch (error) { wallets.forEach(wallet => wallet.close()); proof?.close(); storage.close(); key.fill(0); throw error; }
  finally { opening?.close(); }
  function validateRetiredWallets(state: StateV2, candidates: BlindAdmissionWalletV2[]) {
    for (const [index, wallet] of candidates.entries()) {
      const r = wallet.summary().retirement; if (!r) continue;
      const policy = state.policy, entry = policy ? policyEntries(state).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === r.issuerKey) : undefined;
      if (index === state.active) throw new Error('Cannot reactivate a permanently retired wallet');
      if (!policy || !entry || admissionAuthorityFingerprint(policy.authority) !== r.authorityFingerprint
        || policy.revision < r.policyRevision || entry.retryUntil > r.retryUntil
        || (policy.revision === r.policyRevision && archivedAdmissionPolicyDigest(policy) !== r.policyDigest)) {
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
    try { current(state.policy); } catch { return false; }
    const entry = policyEntries(state).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === issuerKey);
    return !!entry && state.policy.activeKey !== issuerKey && (options.now ?? Date.now)() >= entry.retryUntil;
  }
  function ready() { storage.read(); if (poisoned) throw new Error('Wallet activation write failed; close and reopen before reuse'); proof?.assertWritable(); if (busy) throw new Error('Access-token wallet update is in progress'); }
  function active() {
    const state = stateV2(storage.read()); const wallet = wallets[state.active];
    if (!wallet) throw new Error('Set up the access-token wallet first');
    return { state, wallet, profile: state.profiles[state.active] };
  }
  function checkPolicy(profile: AdmissionWalletProfileV1, use: 'issue' | 'spend' | 'retry') {
    const state = stateV2(storage.read()); if (!state.policy) return;
    const now = (options.now ?? Date.now)(); current(state.policy);
    const entry = policyEntries(state).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === admissionKeyFingerprint(profile.issuerPublicKey));
    const cutoff = use === 'issue' ? entry?.issueUntil : use === 'spend' ? entry?.spendUntil : entry?.retryUntil;
    if (!entry || now < entry.notBefore || now >= cutoff!) throw new Error('Issuer key is not active for this operation under the community policy');
  }
  function checkFreshness(observation: WalletPolicyObservation | undefined, updating = false) {
    ready(); const state = stateV2(storage.read()); if (!state.freshness) return;
    const inspected = inspectWalletPolicyObservation(state.freshness, observation, (options.now ?? Date.now)());
    if (inspected.state !== state.freshness) storage.write({ ...state, freshness: inspected.state });
    if (inspected.error) {
      if (updating && !inspected.state.conflict) return;
      throw new Error(inspected.error);
    }
    current(state.policy!);
  }
  function requireProof() {
    if (!proof) throw new Error('Policy proof migration requires explicitly funded wallet proof storage');
    return proof;
  }
  function reserveTokenFiles(policy: ArchivedAdmissionPolicy, state: StateV2) {
    const profiles = [...state.profiles];
    for (const entry of policy.keys) {
      if (profiles.some(profile => admissionKeyFingerprint(profile.issuerPublicKey) === admissionKeyFingerprint(entry.profile.issuerPublicKey))) continue;
      if (profiles.length >= MAX_PROFILE_HISTORY) throw new Error('Wallet profile history is full');
      proofStorage!.authority.reserve({ path: file(profiles.length, entry.profile), component: 'encrypted-local-state', scope: 'file', maximumBytes: 16 * 1024 * 1024 + 8192 }).assertWritable();
      profiles.push(entry.profile);
    }
  }
  async function activateProof(previous: StateV2, handle: ResolvedAdmissionPolicy, ref: WalletPolicyProofReference,
    entries: Map<string, AdmissionPolicyKey>, signal?: AbortSignal, operation?: ProofOperation) {
    const store = requireProof(), candidate = inspectResolvedAdmissionPolicy(handle), policy = candidate.policy;
    let freshness = previous.freshness;
    if (previous.policy && previous.version !== 6) {
      // Backfill is non-authorizing until the exact pre-existing body/head.
      if (policy.revision < previous.policy.revision) return false;
      if (JSON.stringify(policy) !== JSON.stringify(previous.policy)
        || (freshness && !sameAdmissionPolicyHead(candidate.head, freshness.installed))) throw new Error('Backfill differs from the exact installed wallet policy');
    } else if (previous.version === 6 && freshness) {
      if (freshness.conflict) throw new Error('Wallet policy observations conflict; spending is fenced');
      if (candidate.head.revision === freshness.observed.revision && !sameAdmissionPolicyHead(candidate.head, freshness.observed)) throw new Error('Policy update conflicts with the observed wallet floor');
    }
    if (!previous.policy || (previous.version === 6 && candidate.head.revision >= (freshness?.observed.revision ?? 0))) current(policy);
    freshness = freshness ? { ...freshness, installed: candidate.head,
      observed: candidate.head.revision > freshness.observed.revision ? candidate.head : freshness.observed }
      : { context: candidate.context, installed: candidate.head, observed: candidate.head };
    parseWalletPolicyFreshness(freshness, policy);
    const profiles = [...previous.profiles], opened: BlindAdmissionWalletV2[] = [];
    for (const profile of profiles) {
      const entry = entries.get(admissionKeyFingerprint(profile.issuerPublicKey));
      if (!entry || JSON.stringify(entry.profile) !== JSON.stringify(profile)) throw new Error('Signed policy must retain all existing wallet profiles with their original pins');
    }
    try {
      for (const entry of policy.keys) {
        if (profiles.some(profile => admissionKeyFingerprint(profile.issuerPublicKey) === admissionKeyFingerprint(entry.profile.issuerPublicKey))) continue;
        if (profiles.length >= MAX_PROFILE_HISTORY) throw new Error('Wallet profile history is full');
        const parsed = operation ? await operation.wait(() => parseAdmissionWalletProfile(entry.profile)) : await parseAdmissionWalletProfile(entry.profile); storage.read(); operation?.check(); signal?.throwIfAborted();
        try { opened.push(open(profiles.length, parsed)); } catch (error) { poisoned = true; throw error; } profiles.push(parsed.profile);
      }
      const active = profiles.findIndex(profile => admissionKeyFingerprint(profile.issuerPublicKey) === policy.activeKey);
      if (active < 0) throw new Error('Wallet active key is missing');
      const next: StateV2 = { version: 6, active, profiles, policy, freshness, proof: ref };
      const oldEntries = profileEntries;
      profileEntries = entries;
      try { validateRetiredWallets(next, [...wallets, ...opened]); }
      finally { profileEntries = oldEntries; }
      operation?.check(); signal?.throwIfAborted(); store.assertWritable();
      storage.write(next); // Sole activation commit; uncertainty poisons this snapshot.
      wallets.push(...opened); opened.length = 0; profileEntries = entries; resolved = handle;
      return true;
    } finally { opened.forEach(wallet => wallet.close()); }
  }
  const api = {
    hasPolicyProofStorage() { ready(); return !!proof; },
    policyProofCursor() {
      ready(); if (!proofCursor) return undefined;
      const value = inspectResolvedAdmissionPolicy(proofCursor.resolved);
      return structuredClone({ head: value.head, policy: value.policy });
    },
    async beginPolicyProof(genesisValue: unknown, observersValue: unknown, signal?: AbortSignal) {
      signal?.throwIfAborted(); ready(); const store = requireProof();
      if (pending) throw new Error('Finish or cancel the pending token request before changing community policy');
      const genesis = structuredClone(genesisValue), context = parseAdmissionPolicyObservers(structuredClone(observersValue));
      const lifetime = proofOperation(store.limits.timeoutMs, signal); signal = lifetime.signal;
      busy = true;
      try {
        const previous = stateV2(storage.read());
        if (previous.freshness && admissionPolicyObserversId(previous.freshness.context) !== admissionPolicyObserversId(context)) throw new Error('Policy observers are already pinned');
        if (previous.policy && previous.policy.authority !== context.authority) throw new Error('Community authority is already pinned');
        if (previous.version === 6) { const value = inspectResolvedAdmissionPolicy(proofCursor!.resolved); return structuredClone({ head: value.head, policy: value.policy }); }
        const handle = await resolveAdmissionPolicy({ context, genesis, advances: [], selectedHead: context.genesis, reader: store.reader, limits: store.limits, signal, retainIssuerKeys: previous.profiles.map(profile => admissionKeyFingerprint(profile.issuerPublicKey)) });
        storage.read(); lifetime.check(); signal?.throwIfAborted();
        const policy = inspectResolvedAdmissionPolicy(handle).policy;
        const progress = store.progress();
        if (progress.progress) {
          if (!progress.context || admissionPolicyObserversId(progress.context) !== admissionPolicyObserversId(context)) throw new Error('Backfill observer context differs');
          const replay = await store.resolve(progress.progress, context, signal, previous.profiles.map(profile => admissionKeyFingerprint(profile.issuerPublicKey)));
          storage.read(); lifetime.check(); signal?.throwIfAborted();
          await activateProof(previous, replay.resolved, progress.progress, replay.entries, signal, lifetime);
          proofCursor = { reference: progress.progress, resolved: replay.resolved };
        } else {
          if (!previous.policy || previous.policy.revision === policy.revision) reserveTokenFiles(policy, previous);
          const ref = store.publishGenesis(policy as SignedAdmissionPolicy, context);
          store.saveProgress(context, ref);
          const entries = new Map(policy.keys.map(entry => [admissionKeyFingerprint(entry.profile.issuerPublicKey), entry]));
          await activateProof(previous, handle, ref, entries, signal, lifetime);
          proofCursor = { reference: ref, resolved: handle };
        }
        const value = inspectResolvedAdmissionPolicy(proofCursor.resolved);
        return structuredClone({ head: value.head, policy: value.policy });
      } finally { lifetime.close(); busy = false; }
    },
    async appendPolicyProof(stepValue: AdmissionPolicyProofStep, signal?: AbortSignal) {
      signal?.throwIfAborted(); ready(); const store = requireProof();
      if (pending) throw new Error('Finish or cancel the pending token request before changing community policy');
      if (!proofCursor) throw new Error('Begin original policy proof backfill first');
      // The private wire ceiling is also enforced for direct callers.
      if (!stepValue || !Array.isArray(stepValue.pages) || stepValue.pages.length > 2) throw new Error('Wallet proof step permits at most two pages');
      const advance = structuredClone(stepValue.advance), pages = stepValue.pages.map(page => ({ digest: page.digest, bytes: Uint8Array.from(page.bytes) }));
      const cursor = proofCursor;
      const lifetime = proofOperation(store.limits.timeoutMs, signal); signal = lifetime.signal;
      busy = true;
      try {
        const previous = stateV2(storage.read()), old = inspectResolvedAdmissionPolicy(cursor.resolved);
        if (previous.version === 6 && previous.freshness?.conflict) throw new Error('Wallet policy observations conflict; spending is fenced');
        const usedPages = new Set<string>();
        const handle = await resolveAdmissionPolicyAdvance({ previous: cursor.resolved, advance, selectedHead: advance.commitment.next,
          reader: async (digest, readSignal) => {
            const page = pages.find(page => page.digest === digest);
            if (page) { usedPages.add(digest); return page.bytes; }
            return store.reader(digest, readSignal);
          }, limits: store.limits, signal });
        const candidate = inspectResolvedAdmissionPolicy(handle);
        if (previous.version !== 6 && previous.policy && candidate.policy.revision > previous.policy.revision) throw new Error('Backfill passed the installed wallet head');
        const expectedPages = candidate.policy.version === 3 ? candidate.policy.archive.pageCount - (old.policy.version === 3 ? old.policy.archive.pageCount : 0) : 0;
        if (pages.length !== expectedPages || usedPages.size !== pages.length || new Set(pages.map(page => page.digest)).size !== pages.length) throw new Error('Proof pages differ from the exact appended archive');
        storage.read(); lifetime.check(); signal?.throwIfAborted();
        if (!previous.policy || previous.version === 6 || candidate.policy.revision === previous.policy.revision) reserveTokenFiles(candidate.policy, previous);
        const ref = store.publishAdvance(cursor.reference, candidate.context, advance, pages);
        let entries = new Map(profileEntries);
        for (const entry of candidate.policy.keys) entries.set(admissionKeyFingerprint(entry.profile.issuerPublicKey), entry);
        if (previous.version !== 6) {
          store.saveProgress(candidate.context, ref);
          if (previous.policy && candidate.policy.revision === previous.policy.revision) {
            const replay = await store.resolve(ref, candidate.context, signal, previous.profiles.map(profile => admissionKeyFingerprint(profile.issuerPublicKey)));
            entries = replay.entries;
            for (const entry of candidate.policy.keys) entries.set(admissionKeyFingerprint(entry.profile.issuerPublicKey), entry);
          }
        }
        await activateProof(previous, handle, ref, entries, signal, lifetime);
        proofCursor = { reference: ref, resolved: handle };
        return structuredClone({ head: candidate.head, policy: candidate.policy });
      } finally { lifetime.close(); busy = false; }
    },
    policyUpdatePins() {
      ready(); const freshness = stateV2(storage.read()).freshness;
      if (!freshness) throw new Error('Pin independently verified policy observers before a private update');
      if (freshness.conflict) throw new Error('Wallet policy observations conflict; spending is fenced');
      return structuredClone({ context: freshness.context, previous: freshness.installed, observed: freshness.observed });
    },
    observePolicy(observation: WalletPolicyObservation) {
      api.policyUpdatePins(); checkFreshness(observation, true); return api.policyUpdatePins();
    },
    provider(): AdmissionCapabilityProviderV2 {
      return Object.assign((context: AdmissionCapabilityRequestContextV2) => api.capabilityFor(context), {
        policyObservers: () => { ready(); return structuredClone(stateV2(storage.read()).freshness?.context); },
        assertCurrent: (context: AdmissionCapabilityRequestContextV2) => { checkFreshness(context.policyObservation); },
        assertMaintenanceDestination: (relayUrl: string) => {
          ready(); const state = stateV2(storage.read()); if (!state.profiles.length) return;
          const profile = state.profiles[state.active];
          if (!profile.relayUrls.includes(normalizeAdmissionRelay(relayUrl))) throw new Error('Destination is not in the pinned access-token relay list');
        },
      });
    },
    planRetirement(issuerKey: string) {
      const { wallet, policy, state } = retirementTarget(issuerKey);
      const entry = policyEntries(state).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === issuerKey)!;
      return resolved ? wallet.planResolvedRetirement(resolved, retainedResolvedAdmissionPolicyKey(resolved, issuerKey), state) : wallet.planRetirement(policy as SignedAdmissionPolicy, state);
    },
    retire(issuerKey: string, approvalDigest: string) {
      const { wallet, policy, state } = retirementTarget(issuerKey);
      const entry = policyEntries(state).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === issuerKey)!;
      return resolved ? wallet.retireResolved(resolved, retainedResolvedAdmissionPolicyKey(resolved, issuerKey), approvalDigest, state) : wallet.retire(policy as SignedAdmissionPolicy, approvalDigest, state);
    },
    configured(): boolean { return stateV2(storage.read()).profiles.length > 0; },
    status(): AdmissionWalletStatus {
      ready(); const state = stateV2(storage.read());
      if (!state.profiles.length) return { configured: false, available: 0, reserved: 0, total: 0, capacity: 4096, availableCapacity: 256, archived: [] };
      const { wallet, profile } = active();
      return { ...(state.freshness ? { freshness: { required: true as const, installedRevision: state.freshness.installed.revision,
        observedRevision: state.freshness.observed.revision, conflicted: !!state.freshness.conflict } } : {}), configured: true, scope: structuredClone(profile.scope), relayUrls: [...profile.relayUrls],
        keyFingerprint: admissionKeyFingerprint(profile.issuerPublicKey), ...wallet.summary(),
        archived: state.profiles.flatMap((prior, index) => {
          if (index === state.active) return [];
          const summary = wallets[index].summary(), keyFingerprint = admissionKeyFingerprint(prior.issuerPublicKey);
          return [{ scope: structuredClone(prior.scope), keyFingerprint, available: summary.available, reserved: summary.reserved,
            permanentlyRetired: summary.permanentlyRetired, canRetire: !summary.permanentlyRetired && eligible(state, keyFingerprint),
            ...(summary.retirement ? { tokensRemoved: summary.retirement.tokensRemoved, reservationsRemoved: summary.retirement.reservationsRemoved } : {}) }];
        }),
        ...(state.policy ? { policy: { currentKeys: state.policy.keys.length, archivedKeys: state.policy.version === 3 ? state.policy.archive.entryCount : state.policy.archivedKeys?.length ?? 0, revision: state.policy.revision, authorityFingerprint: admissionAuthorityFingerprint(state.policy.authority), expiresAt: state.policy.expiresAt,
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
    async installPolicy(value: unknown, authority: string, observersValue?: unknown, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (proof) {
        const state = stateV2(storage.read());
        if (state.version === 6 || (state.freshness && value && typeof value === 'object' && 'commitment' in value)) {
          return api.appendPolicyProof({ advance: value as ArchivedAdmissionPolicyAdvance, pages: [] }, signal);
        }
        if (observersValue !== undefined) {
          const context = parseAdmissionPolicyObservers(observersValue);
          if (context.authority !== authority) throw new Error('Policy observer authority differs from the independently pinned authority');
          return api.beginPolicyProof(value, context, signal);
        }
      }
      ready(); if (pending) throw new Error('Finish or cancel the pending token request before changing community policy');
      busy = true; const opened: BlindAdmissionWalletV2[] = [];
      try {
        const previous = stateV2(storage.read());
        if (proof?.progress().progress) throw new Error('Finish original policy proof backfill before changing the installed policy');
        if (previous.policy && previous.policy.authority !== authority) throw new Error('Community authority is already pinned');
        // Copy caller inputs before asynchronous signature verification.
        const input = structuredClone(value), observers = observersValue === undefined ? undefined : parseAdmissionPolicyObservers(observersValue);
        let freshness = previous.freshness;
        if (freshness?.conflict) throw new Error('Wallet policy observations conflict; spending is fenced');
        if (freshness && observers && admissionPolicyObserversId(observers) !== admissionPolicyObserversId(freshness.context)) throw new Error('Policy observers are already pinned');
        const advance = freshness && input && typeof input === 'object' && 'commitment' in input
          ? await parseAdmissionPolicyAdvance(input, freshness.context) : undefined;
        const policy = advance?.policy ?? await verifyAdmissionPolicy(input, authority);
        storage.read(); signal?.throwIfAborted();
        // A fresh observed later head can require replaying an expired immediate
        // predecessor. Retain that authenticated step without authorizing use of
        // its keys; the final observed revision must still be current.
        if (!advance || !freshness || policy.revision >= freshness.observed.revision) {
          assertAdmissionPolicyCurrent(policy, (options.now ?? Date.now)());
        }
        if (freshness) {
          if (advance) {
            if (!sameAdmissionPolicyHead(advance.commitment.previous, freshness.installed)
              && !sameAdmissionPolicyHead(advance.commitment.next, freshness.installed)) throw new Error('Policy update must extend the retained wallet transition');
            const next = advance.commitment.next;
            if (next.revision === freshness.observed.revision && !sameAdmissionPolicyHead(next, freshness.observed)) throw new Error('Policy update conflicts with the observed wallet floor');
            freshness = { ...freshness, installed: next, observed: next.revision > freshness.observed.revision ? next : freshness.observed };
          } else if (admissionPolicyDigest(policy) !== freshness.installed.digest) throw new Error('Pinned policy freshness requires a signed immediate successor');
        } else if (observers) {
          const head = admissionPolicyHead(policy);
          if (observers.authority !== authority || !sameAdmissionPolicyHead(head, observers.genesis)) throw new Error('Initial observer pins must match this independently verified genesis policy');
          freshness = { context: observers, installed: head, observed: head };
        }
        if (freshness) parseWalletPolicyFreshness(freshness, policy);
        if (previous.policy) {
          if (previous.policy.version === 3) throw new Error('V3 requires funded resolved installation');
          assertAdmissionPolicySuccessor(previous.policy, policy);
        }
        const profiles = [...previous.profiles];
        for (const profile of profiles) if (!admissionPolicyKeys(policy).some(entry => JSON.stringify(entry.profile) === JSON.stringify(profile))) {
          throw new Error('Signed policy must retain all existing wallet profiles with their original pins');
        }
        for (const entry of policy.keys) {
          if (profiles.some(profile => admissionKeyFingerprint(profile.issuerPublicKey) === admissionKeyFingerprint(entry.profile.issuerPublicKey))) continue;
          if (profiles.length >= (policy.version === 2 ? MAX_PROFILE_HISTORY : MAX_PROFILES)) throw new Error('Wallet profile history is full');
          const parsed = await parseAdmissionWalletProfile(entry.profile); storage.read(); signal?.throwIfAborted();
          opened.push(open(profiles.length, parsed)); profiles.push(parsed.profile);
        }
        const active = profiles.findIndex(profile => admissionKeyFingerprint(profile.issuerPublicKey) === policy.activeKey);
        validateRetiredWallets({ version: policy.version === 2 ? 4 : 3, active, profiles, policy }, [...wallets, ...opened]);
        signal?.throwIfAborted();
        storage.write({ version: freshness ? 5 : policy.version === 2 ? 4 : 3, active, profiles, policy, ...(freshness ? { freshness } : {}) });
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
      checkFreshness(context.policyObservation);
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
    close() { if (closed) return; closed = true; pending = undefined; wallets.forEach(wallet => wallet.close()); proof?.close(); storage.close(); key.fill(0); },
  };
  return api;
}
export type ManagedAdmissionWallet = Awaited<ReturnType<typeof openManagedAdmissionWallet>>;
