/** Pinned active wallet plus immutable prior profiles for exact retries. */
import { verifyAdmissionPolicy, assertAdmissionPolicyCurrent, assertAdmissionPolicySuccessor, admissionAuthorityFingerprint, admissionPolicyDigest, admissionPolicyKeys, MAX_ADMISSION_KEYS, MAX_ARCHIVED_ADMISSION_KEYS, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { captureStorageReservationOperation, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { appendWalletEnrollmentCatalogue, readWalletEnrollmentCatalogue, parseWalletEnrollmentCatalogue, type WalletEnrollmentCatalogue } from './wallet-enrollment-catalogue.js';
import { openWalletPolicyProofStore, parseWalletPolicyProofReference, type WalletPolicyProofReference, type WalletPolicyProofStorage } from './wallet-policy-proof-store.js';
import { archivedAdmissionPolicyDigest, inspectResolvedAdmissionPolicy, AdmissionPolicyArchiveBudget, resolveAdmissionPolicyCatalogueMembership, inspectResolvedAdmissionPolicyKey, type ResolvedAdmissionPolicyKey, resolveAdmissionPolicy, resolveAdmissionPolicyAdvance, type ArchivedAdmissionPolicy, type ResolvedAdmissionPolicy, type ArchivedAdmissionPolicyAdvance } from '@resonance/core/admission-policy-archive';
import type { AdmissionPolicyKey } from '@resonance/core/admission-policy';
import type { AdmissionPolicyProofStep } from '@resonance/core/admission-policy-transfer';
import { existsSync, lstatSync } from 'node:fs';
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
  archivedTotal?: number; nextCursor?: string;
  archived: Array<{ scope: AdmissionWalletProfileV1['scope']; keyFingerprint: string; available: number; reserved: number; permanentlyRetired: boolean; canRetire: boolean; tokensRemoved?: number; reservationsRemoved?: number }>;
  pendingIssuance?: AdmissionIssuanceRequest;
  policy?: { currentKeys: number; archivedKeys: number; revision: number; authorityFingerprint: string; expiresAt: number; issueUntil: number; spendUntil: number; retryUntil: number };
}
interface StateV1 { version: 1; profile: AdmissionWalletProfileV1 | null }
interface StateV2 { version: 2 | 3 | 4 | 5 | 6 | 7; active: number; profiles: AdmissionWalletProfileV1[]; policy?: ArchivedAdmissionPolicy; freshness?: WalletPolicyFreshness; proof?: WalletPolicyProofReference; catalogue?: WalletEnrollmentCatalogue; firstWalletId?: string }
interface StateV7 { version: 7; activeIssuer: string; firstWalletId: string; catalogue: WalletEnrollmentCatalogue; policy: ArchivedAdmissionPolicy; freshness: WalletPolicyFreshness; proof: WalletPolicyProofReference }
type State = StateV1 | StateV2 | StateV7;
const MAX_PROFILES = MAX_ADMISSION_KEYS;
const MAX_PROFILE_HISTORY = MAX_ADMISSION_KEYS + MAX_ARCHIVED_ADMISSION_KEYS;
function validState(value: unknown): value is State {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as StateV1 | StateV2;
  if (state.version === 1) return Object.keys(state).sort().join(',') === 'profile,version'
    && (state.profile === null || (!!state.profile && typeof state.profile === 'object'));
  if (state.version === 7) {
    try { const item = state as unknown as StateV7; parseWalletEnrollmentCatalogue(item.catalogue);
      return Object.keys(item).sort().join(',') === 'activeIssuer,catalogue,firstWalletId,freshness,policy,proof,version'
        && /^sha256:[a-f0-9]{64}$/.test(item.activeIssuer) && /^sha256:[a-f0-9]{64}$/.test(item.firstWalletId) && !!item.policy && !!item.freshness && !!item.proof;
    } catch { return false; }
  }
  return ((state.version === 2 && Object.keys(state).sort().join(',') === 'active,profiles,version')
    || ((state.version === 3 || state.version === 4) && Object.keys(state).sort().join(',') === 'active,policy,profiles,version' && !!state.policy
      && (state.version === 4 ? state.policy.version === 2 : state.policy.version === 1))
    || (state.version === 5 && Object.keys(state).sort().join(',') === 'active,freshness,policy,profiles,version' && !!state.policy && !!state.freshness)
    || (state.version >= 6 && Object.keys(state).sort().join(',') === 'active,freshness,policy,profiles,proof,version' && !!state.policy && !!state.freshness && !!state.proof))
    && Array.isArray(state.profiles) && state.profiles.length >= 1 && state.profiles.length <= (state.version >= 4 ? MAX_PROFILE_HISTORY : MAX_PROFILES)
    && Number.isInteger(state.active) && state.active >= 0 && state.active < state.profiles.length;
}

interface ProofOperation { signal: AbortSignal; deadline: number; budget?: AdmissionPolicyArchiveBudget; check(): void; wait<T>(work: () => Promise<T>): Promise<T>; close(): void }
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
  return { signal: controller.signal, deadline, check,
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
  let enrolledProfiles: AdmissionWalletProfileV1[] = [];
  const parsedProfiles = new Map<string, Awaited<ReturnType<typeof parseAdmissionWalletProfile>>>();
  type Retirement = ReturnType<BlindAdmissionWalletV2['summary']>['retirement'];
  const authenticatedFiles = new Map<string, { identity: string; retirement: Retirement }>();
  function fileIdentity(index: number, profile: AdmissionWalletProfileV1) {
    const stat = lstatSync(file(index, profile));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Enrolled wallet file is aliased or invalid');
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  }
  function assertFileIdentity(index: number, profile: AdmissionWalletProfileV1) {
    const saved = authenticatedFiles.get(admissionKeyFingerprint(profile.issuerPublicKey));
    if (!saved || saved.identity !== fileIdentity(index, profile)) throw new Error('Enrolled wallet history changed; reopen to authenticate it');
    return saved.retirement;
  }
  function rememberFile(index: number, profile: AdmissionWalletProfileV1, wallet: BlindAdmissionWalletV2) {
    authenticatedFiles.set(admissionKeyFingerprint(profile.issuerPublicKey), { identity: fileIdentity(index, profile), retirement: wallet.summary().retirement });
  }
  let profileMemberships = new Map<string, ResolvedAdmissionPolicyKey>();
  function stateV2(state: State): StateV2 {
    if (state.version === 1) return { version: 2, active: 0, profiles: state.profile ? [state.profile] : [] };
    if (state.version !== 7) return state;
    const value = state as StateV7;
    return { version: 7, profiles: enrolledProfiles, active: enrolledProfiles.findIndex(profile => admissionKeyFingerprint(profile.issuerPublicKey) === value.activeIssuer),
      firstWalletId: value.firstWalletId, catalogue: value.catalogue, policy: value.policy, freshness: value.freshness, proof: value.proof };
  }
  function writeState(state: StateV2) {
    if (state.version !== 7) return storage.write(state);
    storage.write({ version: 7, activeIssuer: admissionKeyFingerprint(state.profiles[state.active].issuerPublicKey), firstWalletId: state.firstWalletId!,
      catalogue: state.catalogue!, policy: state.policy!, freshness: state.freshness!, proof: state.proof! });
  }
  function compactWallets(activeIndex: number) {
    for (const [index, wallet] of wallets.entries()) if (wallet && index !== activeIndex) { wallet.close(); delete wallets[index]; }
  }
  function withWallet<T>(index: number, state: StateV2, work: (wallet: BlindAdmissionWalletV2) => T, ownedMutation = false): T {
    const profile = state.profiles[index];
    assertFileIdentity(index, profile);
    const held = wallets[index];
    const parsed = parsedProfiles.get(admissionKeyFingerprint(profile.issuerPublicKey));
    if (!parsed) throw new Error('Wallet profile has not been authenticated');
    let wallet: BlindAdmissionWalletV2;
    try { wallet = held ?? open(index, parsed, true); } catch (error) { poisoned = true; throw error; }
    try {
      validateRetiredWallet(state, wallet, index);
      const result = work(wallet);
      // Read-only work cannot adopt a replacement using a receipt read from the
      // previous ciphertext. Only our completed publication may refresh identity.
      if (ownedMutation) rememberFile(index, profile, wallet);
      else assertFileIdentity(index, profile);
      return result;
    } catch (error) { try { wallet.summary(); } catch { poisoned = true; } throw error; }
    finally { if (!held) wallet.close(); }
  }
  let busy = false; let closed = false; let poisoned = false;
  let proof: ReturnType<typeof openWalletPolicyProofStore> | undefined;
  let resolved: ResolvedAdmissionPolicy | undefined;
  let proofCursor: { reference: WalletPolicyProofReference; resolved: ResolvedAdmissionPolicy } | undefined;
  let profileEntries = new Map<string, AdmissionPolicyKey>();
  function policyEntries(state: StateV2): AdmissionPolicyKey[] {
    if (!state.policy) return [];
    if (state.version >= 6) return [...profileEntries.values()];
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
  if (opening) opening.budget = new AdmissionPolicyArchiveBudget({ limits: proofStorage!.limits, signal: opening.signal, deadline: opening.deadline });
  try {
    if (proofStorage) proof = run(() => openWalletPolicyProofStore(proofStorage!, key));
    const saved = storage.read();
    if (saved.version === 7) {
      if (!proof || !proofStorage) throw new Error('Wallet v7 requires its funded policy proof storage');
      enrolledProfiles = readWalletEnrollmentCatalogue(proof, (saved as StateV7).catalogue, proofStorage.maxRecords * 64, () => opening!.check());
      if (admissionKeyFingerprint(enrolledProfiles[0].issuerPublicKey) !== (saved as StateV7).firstWalletId) throw new Error('Wallet original file identity differs');
    }
    const state = stateV2(saved);
    if (state.version >= 6) {
      if (!proof || !state.proof || !state.freshness || !state.policy) throw new Error('Wallet v6 requires its funded policy proof storage');
      const replay = await proof.resolve(parseWalletPolicyProofReference(state.proof), state.freshness.context, opening?.signal,
        state.profiles.map(profile => admissionKeyFingerprint(profile.issuerPublicKey)), opening?.budget);
      resolved = replay.resolved; profileEntries = replay.entries; profileMemberships = replay.memberships;
      const inspected = inspectResolvedAdmissionPolicy(resolved);
      if (JSON.stringify(inspected.policy) !== JSON.stringify(state.policy) || !sameAdmissionPolicyHead(inspected.head, state.freshness.installed)) throw new Error('Wallet profile differs from its exact original proof');
      proofCursor = { reference: state.proof, resolved };
    }
    if (state.policy) {
      if (state.version < 6) {
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
      parsedProfiles.set(fingerprint, parsed);
      const before = fileIdentity(index, profile), wallet = open(index, parsed, true);
      try {
        validateRetiredWallet(state, wallet, index);
        if (before !== fileIdentity(index, profile)) throw new Error('Enrolled wallet history changed while opening');
        rememberFile(index, profile, wallet); if (index === state.active) wallets[index] = wallet;
      }
      finally { if (wallets[index] !== wallet) wallet.close(); }
      opening?.check();
    }
    if (state.version === 6) {
      const catalogue = appendWalletEnrollmentCatalogue(proof!, undefined, state.profiles, () => opening!.check());
      const next: StateV2 = { ...state, version: 7, catalogue, firstWalletId: admissionKeyFingerprint(state.profiles[0].issuerPublicKey) };
      enrolledProfiles = state.profiles; writeState(next);
    }
    if (proof && state.version < 6 && proof.progress().progress) {
      const progress = proof.progress();
      if (!progress.context || !progress.progress || (state.freshness && admissionPolicyObserversId(state.freshness.context) !== admissionPolicyObserversId(progress.context))) throw new Error('Backfill differs from retained wallet pins');
      const replay = await proof.resolve(progress.progress, progress.context, opening?.signal, state.profiles.map(profile => admissionKeyFingerprint(profile.issuerPublicKey)), opening?.budget);
      const cursorPolicy = inspectResolvedAdmissionPolicy(replay.resolved).policy;
      if (state.policy && (cursorPolicy.revision > state.policy.revision || (cursorPolicy.revision === state.policy.revision && JSON.stringify(cursorPolicy) !== JSON.stringify(state.policy)))) throw new Error('Backfill differs from the installed wallet policy');
      proofCursor = { reference: progress.progress, resolved: replay.resolved };
      // A crash may have flushed completed non-authorizing progress just before
      // the profile activation. Revalidate and finish that exact commit on open.
      if (state.policy && cursorPolicy.revision === state.policy.revision) await activateProof(state, replay.resolved, progress.progress, replay.entries, opening?.signal, opening, replay.memberships);
    }
  } catch (error) { wallets.forEach(wallet => wallet.close()); proof?.close(); storage.close(); key.fill(0); throw error; }
  finally { opening?.close(); }
  function validateRetiredWallet(state: StateV2, wallet: BlindAdmissionWalletV2, index: number, entries = policyEntries(state)) {
    validateRetirementReceipt(state, wallet.summary().retirement, index, entries);
  }
  function validateRetirementReceipt(state: StateV2, r: Retirement, index: number, entries: AdmissionPolicyKey[]) {
    if (!r) return;
    const policy = state.policy, entry = entries.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === r.issuerKey);
    if (index === state.active) throw new Error('Cannot reactivate a permanently retired wallet');
    if (!policy || !entry || admissionAuthorityFingerprint(policy.authority) !== r.authorityFingerprint
      || policy.revision < r.policyRevision || entry.retryUntil > r.retryUntil
      || (policy.revision === r.policyRevision && archivedAdmissionPolicyDigest(policy) !== r.policyDigest)) throw new Error('Retired wallet does not match its pinned community policy');
  }
  function retirementTarget(issuerKey: string) {
    ready(); if (pending) throw new Error('Finish or cancel the pending token request before wallet cleanup');
    const state = stateV2(storage.read());
    if (!state.policy) throw new Error('Wallet cleanup requires an installed signed community policy');
    const index = state.profiles.findIndex(profile => admissionKeyFingerprint(profile.issuerPublicKey) === issuerKey);
    if (index < 0) throw new Error('Unknown access-token wallet');
    if (index === state.active) throw new Error('Cannot retire the active wallet; install a successor first');
    return { state, policy: state.policy, index };
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
    assertFileIdentity(state.active, state.profiles[state.active]);
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
    if (inspected.state !== state.freshness) writeState({ ...state, freshness: inspected.state });
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
      proofStorage!.authority.reserve({ path: file(profiles.length, entry.profile), component: 'encrypted-local-state', scope: 'file', maximumBytes: 16 * 1024 * 1024 + 8192 }).assertWritable();
      profiles.push(entry.profile);
    }
  }
  async function activateProof(previous: StateV2, handle: ResolvedAdmissionPolicy, ref: WalletPolicyProofReference,
    entries: Map<string, AdmissionPolicyKey>, signal?: AbortSignal, operation?: ProofOperation, memberships?: Map<string, ResolvedAdmissionPolicyKey>) {
    const store = requireProof(), candidate = inspectResolvedAdmissionPolicy(handle), policy = candidate.policy;
    let freshness = previous.freshness;
    if (previous.policy && previous.version < 6) {
      if (policy.revision < previous.policy.revision) return false;
      if (JSON.stringify(policy) !== JSON.stringify(previous.policy)
        || (freshness && !sameAdmissionPolicyHead(candidate.head, freshness.installed))) throw new Error('Backfill differs from the exact installed wallet policy');
    } else if (previous.version >= 6 && freshness) {
      if (freshness.conflict) throw new Error('Wallet policy observations conflict; spending is fenced');
      if (candidate.head.revision === freshness.observed.revision && !sameAdmissionPolicyHead(candidate.head, freshness.observed)) throw new Error('Policy update conflicts with the observed wallet floor');
    }
    if (!previous.policy || (previous.version >= 6 && candidate.head.revision >= (freshness?.observed.revision ?? 0))) current(policy);
    freshness = freshness ? { ...freshness, installed: candidate.head,
      observed: candidate.head.revision > freshness.observed.revision ? candidate.head : freshness.observed }
      : { context: candidate.context, installed: candidate.head, observed: candidate.head };
    parseWalletPolicyFreshness(freshness, policy);
    const profiles = [...previous.profiles];
    for (const profile of profiles) {
      const entry = entries.get(admissionKeyFingerprint(profile.issuerPublicKey));
      if (!entry || JSON.stringify(entry.profile) !== JSON.stringify(profile)) throw new Error('Signed policy must retain all existing wallet profiles with their original pins');
    }
    for (const entry of policy.keys) if (!profiles.some(profile => admissionKeyFingerprint(profile.issuerPublicKey) === admissionKeyFingerprint(entry.profile.issuerPublicKey))) profiles.push(entry.profile);
    if (profiles.length > proofStorage!.maxRecords * 64) throw new Error('Wallet enrollment exceeds its funded catalogue');
    const activeIndex = profiles.findIndex(profile => admissionKeyFingerprint(profile.issuerPublicKey) === policy.activeKey);
    if (activeIndex < 0) throw new Error('Wallet active key is missing');
    let nextActive: BlindAdmissionWalletV2 | undefined;
    try {
      // Each historical handle closes before the next is opened. Validate token
      // evidence before the catalogue or profile activation becomes authoritative.
      for (const [index, profile] of [...profiles.entries()].sort(([a], [b]) => Number(a === activeIndex) - Number(b === activeIndex))) {
        operation?.check(); storage.read(); signal?.throwIfAborted();
        if (index < previous.profiles.length) {
          const receipt = assertFileIdentity(index, profile);
          validateRetirementReceipt({ ...previous, active: activeIndex, profiles, policy }, receipt, index, [...entries.values()]);
          if (index !== activeIndex || wallets[index]) continue;
        }
        const fingerprint = admissionKeyFingerprint(profile.issuerPublicKey);
        let parsed = parsedProfiles.get(fingerprint);
        if (!parsed) { parsed = operation ? await operation.wait(() => parseAdmissionWalletProfile(profile)) : await parseAdmissionWalletProfile(profile); parsedProfiles.set(fingerprint, parsed); }
        storage.read(); operation?.check(); signal?.throwIfAborted();
        const held = wallets[index];
        let wallet: BlindAdmissionWalletV2;
        try { wallet = held ?? open(index, parsed, index < previous.profiles.length); }
        catch (error) { poisoned = true; throw error; }
        try {
          validateRetiredWallet({ ...previous, active: activeIndex, profiles, policy }, wallet, index, [...entries.values()]);
          rememberFile(index, profile, wallet);
          if (index === activeIndex && !held) nextActive = wallet;
        } finally { if (!held && nextActive !== wallet) wallet.close(); }
      }
      const added = profiles.slice(previous.version === 7 ? previous.profiles.length : 0);
      const catalogue = appendWalletEnrollmentCatalogue(store, previous.version === 7 ? previous.catalogue : undefined, added, () => { operation?.check(); storage.read(); signal?.throwIfAborted(); });
      const next: StateV2 = { version: 7, active: activeIndex, profiles, policy, freshness, proof: ref, catalogue,
        firstWalletId: previous.firstWalletId ?? admissionKeyFingerprint(profiles[0].issuerPublicKey) };
      operation?.check(); signal?.throwIfAborted(); store.assertWritable(); storage.read();
      try { writeState(next); } catch (error) { poisoned = true; throw error; }
      enrolledProfiles = profiles; compactWallets(activeIndex); if (nextActive) { wallets[activeIndex] = nextActive; nextActive = undefined; }
      profileEntries = entries; profileMemberships = memberships ?? profileMemberships; resolved = handle;
      return true;
    } finally { nextActive?.close(); }
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
      lifetime.budget = new AdmissionPolicyArchiveBudget({ limits: store.limits, signal, deadline: lifetime.deadline });
      busy = true;
      try {
        const previous = stateV2(storage.read());
        if (previous.freshness && admissionPolicyObserversId(previous.freshness.context) !== admissionPolicyObserversId(context)) throw new Error('Policy observers are already pinned');
        if (previous.policy && previous.policy.authority !== context.authority) throw new Error('Community authority is already pinned');
        if (previous.version >= 6) { const value = inspectResolvedAdmissionPolicy(proofCursor!.resolved); return structuredClone({ head: value.head, policy: value.policy }); }
        const handle = await resolveAdmissionPolicy({ context, genesis, advances: [], selectedHead: context.genesis, reader: store.reader, limits: store.limits, signal, budget: lifetime.budget });
        storage.read(); lifetime.check(); signal?.throwIfAborted();
        const policy = inspectResolvedAdmissionPolicy(handle).policy;
        const progress = store.progress();
        if (progress.progress) {
          if (!progress.context || admissionPolicyObserversId(progress.context) !== admissionPolicyObserversId(context)) throw new Error('Backfill observer context differs');
          const replay = await store.resolve(progress.progress, context, signal, previous.profiles.map(profile => admissionKeyFingerprint(profile.issuerPublicKey)), lifetime.budget);
          storage.read(); lifetime.check(); signal?.throwIfAborted();
          await activateProof(previous, replay.resolved, progress.progress, replay.entries, signal, lifetime, replay.memberships);
          proofCursor = { reference: progress.progress, resolved: replay.resolved };
        } else {
          if (!previous.policy || previous.policy.revision === policy.revision) reserveTokenFiles(policy, previous);
          const ref = store.publishGenesis(policy as SignedAdmissionPolicy, context);
          store.saveProgress(context, ref);
          const entries = new Map(policy.keys.map(entry => [admissionKeyFingerprint(entry.profile.issuerPublicKey), entry]));
          const memberships = await resolveAdmissionPolicyCatalogueMembership({ policy: handle, issuerKeys: [...entries.keys()], reader: store.reader, limits: store.limits, signal, budget: lifetime.budget });
          await activateProof(previous, handle, ref, entries, signal, lifetime, memberships);
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
      lifetime.budget = new AdmissionPolicyArchiveBudget({ limits: store.limits, signal, deadline: lifetime.deadline });
      busy = true;
      try {
        const previous = stateV2(storage.read()), old = inspectResolvedAdmissionPolicy(cursor.resolved);
        if (previous.version >= 6 && previous.freshness?.conflict) throw new Error('Wallet policy observations conflict; spending is fenced');
        const usedPages = new Set<string>();
        const handle = await resolveAdmissionPolicyAdvance({ previous: cursor.resolved, advance, selectedHead: advance.commitment.next,
          budget: lifetime.budget, reader: async (digest, readSignal) => {
            const page = pages.find(page => page.digest === digest);
            if (page) { usedPages.add(digest); return page.bytes; }
            return store.reader(digest, readSignal);
          }, limits: store.limits, signal });
        const candidate = inspectResolvedAdmissionPolicy(handle);
        if (previous.version < 6 && previous.policy && candidate.policy.revision > previous.policy.revision) throw new Error('Backfill passed the installed wallet head');
        const expectedPages = candidate.policy.version === 3 ? candidate.policy.archive.pageCount - (old.policy.version === 3 ? old.policy.archive.pageCount : 0) : 0;
        if (pages.length !== expectedPages || usedPages.size !== pages.length || new Set(pages.map(page => page.digest)).size !== pages.length) throw new Error('Proof pages differ from the exact appended archive');
        storage.read(); lifetime.check(); signal?.throwIfAborted();
        if (!previous.policy || previous.version >= 6 || candidate.policy.revision === previous.policy.revision) reserveTokenFiles(candidate.policy, previous);
        const ref = store.publishAdvance(cursor.reference, candidate.context, advance, pages);
        if (previous.version < 6) store.saveProgress(candidate.context, ref);
        const issuerKeys = [...new Set([...previous.profiles, ...candidate.policy.keys.map(entry => entry.profile)].map(profile => admissionKeyFingerprint(profile.issuerPublicKey)))];
        const memberships = await resolveAdmissionPolicyCatalogueMembership({ policy: handle, issuerKeys, reader: store.reader, limits: store.limits, signal, budget: lifetime.budget });
        const entries = new Map([...memberships].map(([id, membership]) => [id, inspectResolvedAdmissionPolicyKey(handle, membership)]));
        await activateProof(previous, handle, ref, entries, signal, lifetime, memberships);
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
      const { index, policy, state } = retirementTarget(issuerKey);
      return withWallet(index, state, wallet => resolved ? wallet.planResolvedRetirement(resolved, profileMemberships.get(issuerKey)!, state) : wallet.planRetirement(policy as SignedAdmissionPolicy, state));
    },
    retire(issuerKey: string, approvalDigest: string) {
      const { index, policy, state } = retirementTarget(issuerKey);
      return withWallet(index, state, wallet => resolved ? wallet.retireResolved(resolved, profileMemberships.get(issuerKey)!, approvalDigest, state) : wallet.retire(policy as SignedAdmissionPolicy, approvalDigest, state), true);
    },
    configured(): boolean { return stateV2(storage.read()).profiles.length > 0; },
    status(cursor?: string): AdmissionWalletStatus {
      ready(); const state = stateV2(storage.read());
      if (!state.profiles.length) return { configured: false, available: 0, reserved: 0, total: 0, capacity: 4096, availableCapacity: 256, archived: [], archivedTotal: 0 };
      const { wallet, profile } = active();
      const generation = state.catalogue ? `${state.catalogue.root}:${state.freshness!.installed.digest}:${state.active}` : (state.policy ? archivedAdmissionPolicyDigest(state.policy) : JSON.stringify(state.profiles));
      const archivedIndices = state.profiles.map((_, index) => index).filter(index => index !== state.active);
      let offset = 0;
      if (cursor !== undefined) {
        if (typeof cursor !== 'string' || cursor.length > 2048) throw new Error('Invalid wallet status cursor');
        let page: { generation: string; offset: number };
        try { page = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new Error('Invalid wallet status cursor'); }
        if (page.generation !== generation || !Number.isSafeInteger(page.offset) || page.offset < 0 || page.offset >= archivedIndices.length) throw new Error('Stale or invalid wallet status cursor');
        offset = page.offset;
      }
      const nextOffset = offset + 72, statusDeadline = performance.now() + (proofStorage?.limits.timeoutMs ?? 3000);
      return { archivedTotal: archivedIndices.length,
        ...(nextOffset < archivedIndices.length ? { nextCursor: Buffer.from(JSON.stringify({ generation, offset: nextOffset })).toString('base64url') } : {}), ...(state.freshness ? { freshness: { required: true as const, installedRevision: state.freshness.installed.revision,
        observedRevision: state.freshness.observed.revision, conflicted: !!state.freshness.conflict } } : {}), configured: true, scope: structuredClone(profile.scope), relayUrls: [...profile.relayUrls],
        keyFingerprint: admissionKeyFingerprint(profile.issuerPublicKey), ...wallet.summary(),
        archived: archivedIndices.slice(offset, nextOffset).flatMap(index => {
          if (performance.now() >= statusDeadline) throw new Error('Wallet status scan timed out');
          const prior = state.profiles[index];
          const summary = withWallet(index, state, wallet => wallet.summary()), keyFingerprint = admissionKeyFingerprint(prior.issuerPublicKey);
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
          if (withWallet(prior, state, wallet => wallet.summary().permanentlyRetired)) throw new Error('Cannot reactivate a permanently retired wallet');
          if (prior !== state.active) {
            const wallet = open(prior, parsed, true); try { writeState({ ...state, active: prior }); } catch (error) { wallet.close(); throw error; }
            compactWallets(prior); wallets[prior] = wallet;
          }
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
        parsedProfiles.set(admissionKeyFingerprint(parsed.profile.issuerPublicKey), parsed); rememberFile(state.profiles.length, parsed.profile, wallet); wallets[state.profiles.length] = wallet; compactWallets(state.profiles.length);
      } finally { busy = false; }
    },
    async installPolicy(value: unknown, authority: string, observersValue?: unknown, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (proof) {
        const state = stateV2(storage.read());
        if (state.version >= 6 || (state.freshness && value && typeof value === 'object' && 'commitment' in value)) {
          return api.appendPolicyProof({ advance: value as ArchivedAdmissionPolicyAdvance, pages: [] }, signal);
        }
        if (observersValue !== undefined) {
          const context = parseAdmissionPolicyObservers(observersValue);
          if (context.authority !== authority) throw new Error('Policy observer authority differs from the independently pinned authority');
          return api.beginPolicyProof(value, context, signal);
        }
      }
      ready(); if (pending) throw new Error('Finish or cancel the pending token request before changing community policy');
      busy = true; const opened = new Map<number, BlindAdmissionWalletV2>();
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
          profiles.push(entry.profile);
        }
        const active = profiles.findIndex(profile => admissionKeyFingerprint(profile.issuerPublicKey) === policy.activeKey);
        const next: StateV2 = { version: freshness ? 5 : policy.version === 2 ? 4 : 3, active, profiles, policy, ...(freshness ? { freshness } : {}) };
        for (let index = 0; index < previous.profiles.length; index++) validateRetirementReceipt(next, assertFileIdentity(index, profiles[index]), index, admissionPolicyKeys(policy));
        for (const [index, profile] of [...profiles.entries()].filter(([index]) => index >= previous.profiles.length).sort(([a], [b]) => Number(a === active) - Number(b === active))) {
          const parsed = await parseAdmissionWalletProfile(profile); storage.read(); signal?.throwIfAborted();
          parsedProfiles.set(admissionKeyFingerprint(parsed.profile.issuerPublicKey), parsed);
          const wallet = open(index, parsed);
          try { validateRetiredWallet(next, wallet, index); rememberFile(index, profile, wallet); if (index === active) opened.set(index, wallet); }
          finally { if (index !== active || !opened.has(index)) wallet.close(); }
        }
        if (!wallets[active] && active < previous.profiles.length) opened.set(active, open(active, parsedProfiles.get(admissionKeyFingerprint(profiles[active].issuerPublicKey))!, true));
        signal?.throwIfAborted(); storage.write(next);
        for (const [index, wallet] of opened) wallets[index] = wallet; opened.clear(); compactWallets(active);
      } finally { for (const wallet of opened.values()) wallet.close(); busy = false; }
    },
    async importTokens(tokens: readonly string[]) {
      ready(); if (pending) throw new Error('Finish or cancel the pending token request before importing manual tokens');
      busy = true;
      try { const { wallet, profile, state } = active(); checkPolicy(profile, 'spend'); const imported = await wallet.importTokens(tokens); if (imported) rememberFile(state.active, profile, wallet); else assertFileIdentity(state.active, profile); return imported; } finally { busy = false; }
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
        storage.read(); if (imported) rememberFile(target.state.active, target.profile, target.wallet); else assertFileIdentity(target.state.active, target.profile); pending = undefined;
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
      const scanDeadline = performance.now() + (proofStorage?.limits.timeoutMs ?? 3000);
      for (const [index] of state.profiles.entries()) {
        if (performance.now() >= scanDeadline) throw new Error('Wallet reservation scan timed out');
        // Scan every denial fence before returning even a reservation from an earlier wallet.
        const previous = withWallet(index, state, wallet => wallet.reservedCapabilityFor(normalized));
        if (previous && !reserved) reserved = { capability: previous, index };
      }
      if (performance.now() >= scanDeadline) throw new Error('Wallet reservation scan timed out');
      checkFreshness(context.policyObservation);
      if (reserved) { checkPolicy(state.profiles[reserved.index], 'retry'); return reserved.capability; }
      const { wallet, profile } = active(); checkPolicy(profile, 'spend');
      if (!profile.relayUrls.includes(normalized.relayUrl)) throw new Error('Destination is not in the pinned access-token relay list');
      const capability = wallet.capabilityFor(normalized); rememberFile(state.active, profile, wallet); return capability;
    },
    close() { if (closed) return; closed = true; pending = undefined; wallets.forEach(wallet => wallet.close()); proof?.close(); storage.close(); key.fill(0); },
  };
  return api;
}
export type ManagedAdmissionWallet = Awaited<ReturnType<typeof openManagedAdmissionWallet>>;
