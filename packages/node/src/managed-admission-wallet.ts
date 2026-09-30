/** Pinned active wallet plus immutable prior profiles for exact retries. */
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
  archived: Array<{ scope: AdmissionWalletProfileV1['scope']; keyFingerprint: string; available: number; reserved: number }>;
  pendingIssuance?: AdmissionIssuanceRequest;
}
interface StateV1 { version: 1; profile: AdmissionWalletProfileV1 | null }
interface StateV2 { version: 2; active: number; profiles: AdmissionWalletProfileV1[] }
type State = StateV1 | StateV2;
const MAX_PROFILES = 8;
function stateV2(state: State): StateV2 {
  return state.version === 2 ? state : { version: 2, active: 0, profiles: state.profile ? [state.profile] : [] };
}
function validState(value: unknown): value is State {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as State;
  if (state.version === 1) return Object.keys(state).sort().join(',') === 'profile,version'
    && (state.profile === null || (!!state.profile && typeof state.profile === 'object'));
  return state.version === 2 && Object.keys(state).sort().join(',') === 'active,profiles,version'
    && Array.isArray(state.profiles) && state.profiles.length >= 1 && state.profiles.length <= MAX_PROFILES
    && Number.isInteger(state.active) && state.active >= 0 && state.active < state.profiles.length;
}

export async function openManagedAdmissionWallet(options: { directory: string; encryptionKey: Uint8Array }) {
  const key = Buffer.from(options.encryptionKey);
  let storage: ReturnType<typeof openEncryptedLocalState<State>>;
  try { storage = openEncryptedLocalState<State>({ path: join(options.directory, 'admission-profile.json'), key,
    domain: 'resonance:admission-profile:v1', maxBytes: 128 * 1024, initial: { version: 1, profile: null }, validate: validState });
  } catch (error) { key.fill(0); throw error; }
  const wallets: BlindAdmissionWalletV2[] = [];
  let busy = false; let closed = false;
  let pending: { batch: Awaited<ReturnType<typeof createAdmissionIssuanceBatch>>; tokens?: string[]; response?: string } | undefined;
  function file(index: number, profile: AdmissionWalletProfileV1) {
    return join(options.directory, index === 0 ? 'admission-wallet.json' : `admission-wallet-${admissionKeyFingerprint(profile.issuerPublicKey).slice(7)}.json`);
  }
  function open(index: number, parsed: Awaited<ReturnType<typeof parseAdmissionWalletProfile>>) {
    return openBlindAdmissionWalletV2({ path: file(index, parsed.profile), encryptionKey: key,
      scope: parsed.profile.scope, issuerPublicKey: parsed.publicKey });
  }
  try {
    const state = stateV2(storage.read()); const seen = new Set<string>();
    for (const [index, profile] of state.profiles.entries()) {
      const parsed = await parseAdmissionWalletProfile(profile);
      const fingerprint = admissionKeyFingerprint(parsed.profile.issuerPublicKey);
      if (seen.has(fingerprint)) throw new Error('A wallet key cannot be shared across pinned profiles');
      seen.add(fingerprint);
      // Missing history is not a new wallet. Never recreate it and permit token reuse.
      if (!existsSync(file(index, profile))) throw new Error('Saved access-token wallet is missing; restore its history');
      wallets.push(open(index, parsed));
    }
  } catch (error) { wallets.forEach(wallet => wallet.close()); storage.close(); key.fill(0); throw error; }
  function ready() { storage.read(); if (busy) throw new Error('Access-token wallet update is in progress'); }
  function active() {
    const state = stateV2(storage.read()); const wallet = wallets[state.active];
    if (!wallet) throw new Error('Set up the access-token wallet first');
    return { state, wallet, profile: state.profiles[state.active] };
  }
  return {
    configured(): boolean { return stateV2(storage.read()).profiles.length > 0; },
    status(): AdmissionWalletStatus {
      const state = stateV2(storage.read());
      if (!state.profiles.length) return { configured: false, available: 0, reserved: 0, total: 0, capacity: 4096, availableCapacity: 256, archived: [] };
      const { wallet, profile } = active();
      return { configured: true, scope: structuredClone(profile.scope), relayUrls: [...profile.relayUrls],
        keyFingerprint: admissionKeyFingerprint(profile.issuerPublicKey), ...wallet.summary(),
        archived: state.profiles.flatMap((prior, index) => index === state.active ? [] : [{ scope: structuredClone(prior.scope),
          keyFingerprint: admissionKeyFingerprint(prior.issuerPublicKey), available: wallets[index].summary().available, reserved: wallets[index].summary().reserved }]),
        ...(pending ? { pendingIssuance: structuredClone(pending.batch.request) } : {}) };
    },
    async configure(value: unknown) {
      ready(); if (pending) throw new Error('Finish or cancel the pending token request before changing wallet setup');
      busy = true;
      try {
        const parsed = await parseAdmissionWalletProfile(value);
        const state = stateV2(storage.read()); // Session lock during crypto prevents commit.
        const prior = state.profiles.findIndex(profile => admissionKeyFingerprint(profile.issuerPublicKey) === admissionKeyFingerprint(parsed.profile.issuerPublicKey));
        if (prior !== -1) {
          if (JSON.stringify(state.profiles[prior]) !== JSON.stringify(parsed.profile)) throw new Error('This issuer key is already pinned; a different period or setup requires a new key');
          if (prior !== state.active) storage.write({ ...state, active: prior });
          return;
        }
        if (state.profiles.length >= MAX_PROFILES) throw new Error('Wallet profile history is full; existing reservations must be retained');
        // Create the empty token file first. A crash can leave an orphan, never a pinned missing wallet.
        const wallet = open(state.profiles.length, parsed);
        try { storage.write({ version: 2, active: state.profiles.length, profiles: [...state.profiles, parsed.profile] }); }
        catch (error) { wallet.close(); throw error; }
        wallets.push(wallet);
      } finally { busy = false; }
    },
    async importTokens(tokens: readonly string[]) {
      ready(); if (pending) throw new Error('Finish or cancel the pending token request before importing manual tokens');
      busy = true;
      try { return await active().wallet.importTokens(tokens); } finally { busy = false; }
    },
    async requestTokens(count: number) {
      ready(); if (pending) throw new Error('A token request is already pending');
      busy = true;
      try {
        const { wallet, profile } = active(); const summary = wallet.summary();
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
        const imported = await active().wallet.importTokens(current.tokens);
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
      for (const wallet of wallets) {
        const previous = wallet.reservedCapabilityFor(normalized); if (previous) return previous;
      }
      const { wallet, profile } = active();
      if (!profile.relayUrls.includes(normalized.relayUrl)) throw new Error('Destination is not in the pinned access-token relay list');
      return wallet.capabilityFor(normalized);
    },
    close() { if (closed) return; closed = true; pending = undefined; wallets.forEach(wallet => wallet.close()); storage.close(); key.fill(0); },
  };
}
export type ManagedAdmissionWallet = Awaited<ReturnType<typeof openManagedAdmissionWallet>>;
