/** Encrypted, crash-safe local reservations for admission tokens. */
import { createHash, KeyObject } from 'node:crypto';
import { resolve } from 'node:path';
import { admissionKeyFingerprint, admissionPolicyKeys, admissionAuthorityFingerprint, admissionPolicyDigest, assertAdmissionPolicyCurrent, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import {
  type AdmissionCapabilityV2, type BlindAdmissionScopeV2, type RelayAdmissionActionV2,
  assertSecureRelayTransportEndpoint, createAdmissionRequestBindingV2,
  presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2,
} from '@resonance/core';
import type { AdmissionCapabilityRequestContextV2 } from './relay-client.js';
import { openEncryptedLocalState } from './encrypted-local-state.js';

interface Reservation { relayUrl: string; action: RelayAdmissionActionV2; binding: string }
interface WalletEntry { token: string; reservation?: Reservation }
interface LiveState { version: 1; scope: BlindAdmissionScopeV2; entries: WalletEntry[] }
interface Retirement {
  issuerKey: string; authorityFingerprint: string; policyRevision: number; policyDigest: string;
  retiredAt: number; retryUntil: number; tokensRemoved: number; reservationsRemoved: number;
}
interface RetiredState { version: 2; scope: BlindAdmissionScopeV2; entries: []; retirement: Retirement; deniedReservations: string[] }
type WalletState = LiveState | RetiredState;
export interface AdmissionWalletRetirementPlan {
  kind: 'admission-wallet-retirement'; issuerKey: string; scope: BlindAdmissionScopeV2;
  authorityFingerprint: string; policyRevision: number; policyDigest: string; retryUntil: number;
  tokensRemoved: number; unusedTokensRemoved: number; reservationsRemoved: number; denialMarkersRetained: number;
  approvalDigest: string;
}
export interface BlindAdmissionWalletSummary {
  available: number; reserved: number; total: number; capacity: number; availableCapacity: number;
  permanentlyRetired: boolean; retirement?: Retirement;
}
const MAX_AVAILABLE = 256;
const MAX_TOKENS = 4096; // Keep bounded reservation history; never recycle a token.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
export interface BlindAdmissionWalletV2 {
  importTokens(tokens: readonly string[]): Promise<number>;
  /** Reserve durably before network I/O. Exact retries reuse the same token. */
  capabilityFor(context: AdmissionCapabilityRequestContextV2): AdmissionCapabilityV2;
  /** Look up an exact prior reservation without allocating a fresh token. */
  reservedCapabilityFor(context: AdmissionCapabilityRequestContextV2): AdmissionCapabilityV2 | undefined;
  available(): number;
  summary(): BlindAdmissionWalletSummary;
  /** The operational caller must authenticate and pin this signed policy first. */
  planRetirement(policy: SignedAdmissionPolicy, configuration?: unknown): AdmissionWalletRetirementPlan;
  retire(policy: SignedAdmissionPolicy, approvedDigest: string, configuration?: unknown): AdmissionWalletRetirementPlan;
  close(): void;
}

export function openBlindAdmissionWalletV2(options: {
  path: string; encryptionKey: Uint8Array; issuerPublicKey: CryptoKey; scope: BlindAdmissionScopeV2;
  mode?: 'open-existing' | 'create-new'; now?: () => number;
}): BlindAdmissionWalletV2 {
  const scope = structuredClone(options.scope);
  const issuerKey = admissionKeyFingerprint(KeyObject.from(options.issuerPublicKey).export({ type: 'spki', format: 'pem' }).toString());
  // Keep the encryption domain for v1 migration. Older binaries reject retired v2 snapshots.
  const storage = openEncryptedLocalState<WalletState>({ path: options.path, key: options.encryptionKey,
    domain: 'resonance:blind-admission-wallet:v1', maxBytes: MAX_FILE_BYTES,
    mode: options.mode, initial: { version: 1, scope, entries: [] }, validate: (value): value is WalletState => validState(value, scope, issuerKey) });
  let importing = false;
  function live(): LiveState {
    const state = storage.read();
    if (state.version === 2) throw new Error('Admission wallet is permanently retired');
    return state;
  }
  function planRetirement(policy: SignedAdmissionPolicy, configuration?: unknown): AdmissionWalletRetirementPlan {
    ensureReady(); const state = live();
    const now = (options.now ?? Date.now)(); assertAdmissionPolicyCurrent(policy, now);
    const entry = admissionPolicyKeys(policy).find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === issuerKey);
    if (!entry || entry.profile.scope.issuer !== scope.issuer || entry.profile.scope.community !== scope.community || entry.profile.scope.epoch !== scope.epoch) {
      throw new Error('Wallet is absent from the signed community policy');
    }
    if (policy.activeKey === issuerKey) throw new Error('Cannot retire the active wallet; install a successor first');
    if (now < entry.retryUntil) throw new Error('Wallet history must remain until the key retry cutoff');
    const reservations = state.entries.flatMap(entry => entry.reservation ? [reservationDigest(entry.reservation)] : []);
    const policyDigest = admissionPolicyDigest(policy);
    return { kind: 'admission-wallet-retirement', issuerKey, scope: structuredClone(scope),
      authorityFingerprint: admissionAuthorityFingerprint(policy.authority), policyRevision: policy.revision, policyDigest,
      retryUntil: entry.retryUntil, tokensRemoved: state.entries.length, unusedTokensRemoved: state.entries.length - reservations.length,
      reservationsRemoved: reservations.length, denialMarkersRetained: new Set(reservations).size,
      approvalDigest: 'sha256:' + createHash('sha256').update(JSON.stringify([
        'resonance:admission-wallet-retirement:v1', resolve(options.path), issuerKey, policyDigest, state, configuration ?? null,
      ])).digest('hex') };
  }
  return {
    planRetirement,
    retire(policy, approvedDigest, configuration) {
      const plan = planRetirement(policy, configuration);
      if (approvedDigest !== plan.approvalDigest) throw new Error('Wallet history or setup changed; review cleanup again');
      const state = live(), retiredAt = (options.now ?? Date.now)(); assertAdmissionPolicyCurrent(policy, retiredAt);
      if (retiredAt < plan.retryUntil) throw new Error('Wallet history must remain until the key retry cutoff');
      // The key fence, retry denials, and token removal share one flushed atomic snapshot.
      storage.write({ version: 2, scope, entries: [],
        retirement: { issuerKey, authorityFingerprint: plan.authorityFingerprint, policyRevision: policy.revision,
          policyDigest: plan.policyDigest, retiredAt, retryUntil: plan.retryUntil,
          tokensRemoved: plan.tokensRemoved, reservationsRemoved: plan.reservationsRemoved },
        deniedReservations: [...new Set(state.entries.flatMap(entry => entry.reservation ? [reservationDigest(entry.reservation)] : []))].sort() });
      return plan;
    },
    async importTokens(tokens) {
      ensureReady(); live();
      if (!Array.isArray(tokens) || tokens.length > MAX_AVAILABLE
        || tokens.some(token => typeof token !== 'string' || !/^[A-Za-z0-9_-]{472}$/.test(token))) {
        throw new Error('Import at most 256 valid access tokens');
      }
      importing = true;
      try {
        const state = live();
        const unique = [...new Set(tokens)].filter(token => !state.entries.some(entry => entry.token === token));
        if (state.entries.length + unique.length > MAX_TOKENS) throw new Error('Admission wallet history capacity exceeded; retain the wallet and arrange a new issuer key');
        if (state.entries.filter(entry => !entry.reservation).length + unique.length > MAX_AVAILABLE) {
          throw new Error('Admission wallet has room for at most 256 available tokens');
        }
        const binding = createAdmissionRequestBindingV2('search', { kind: 'wallet-import' });
        for (const token of unique) {
          const proof = presentBlindAdmissionTokenV2(token, scope, 'search', binding);
          if (!await verifyBlindAdmissionTokenV2(proof, scope, 'search', binding, options.issuerPublicKey)) {
            throw new Error('Admission wallet token has an invalid issuer signature or scope');
          }
          storage.read(); // A session lock during verification makes this import terminal.
        }
        if (unique.length) storage.write({ ...state, entries: [...state.entries, ...unique.map(token => ({ token }))] });
        return unique.length;
      } finally { importing = false; }
    },
    capabilityFor(context) {
      ensureReady(); validateContext(context);
      const state = live();
      const reservation: Reservation = { relayUrl: context.relayUrl, action: context.action, binding: context.requestBinding };
      const previous = state.entries.find(entry => sameReservation(entry.reservation, reservation));
      if (previous) return presentBlindAdmissionTokenV2(previous.token, scope, context.action, context.requestBinding);
      const freeIndex = state.entries.findIndex(entry => !entry.reservation);
      if (freeIndex < 0) throw new Error('Admission wallet has no unreserved tokens; import more access tokens');
      const entries = state.entries.map((entry, index) => index === freeIndex ? { ...entry, reservation } : entry);
      storage.write({ ...state, entries });
      return presentBlindAdmissionTokenV2(entries[freeIndex].token, scope, context.action, context.requestBinding);
    },
    reservedCapabilityFor(context) {
      ensureReady(); validateContext(context);
      const state = storage.read();
      if (state.version === 2) {
        if (state.deniedReservations.includes(reservationDigest({ relayUrl: context.relayUrl, action: context.action, binding: context.requestBinding }))) {
          throw new Error('This request belongs to a permanently retired wallet; a replacement token cannot be used');
        }
        return undefined;
      }
      const entry = state.entries.find(entry => sameReservation(entry.reservation,
        { relayUrl: context.relayUrl, action: context.action, binding: context.requestBinding }));
      return entry ? presentBlindAdmissionTokenV2(entry.token, scope, context.action, context.requestBinding) : undefined;
    },
    available() { ensureReady(); return storage.read().entries.filter(entry => !entry.reservation).length; },
    summary() {
      const state = storage.read(), entries = state.entries; const available = entries.filter(entry => !entry.reservation).length;
      return { available, reserved: entries.length - available, total: entries.length,
        capacity: state.version === 2 ? 0 : MAX_TOKENS, availableCapacity: state.version === 2 ? 0 : MAX_AVAILABLE,
        permanentlyRetired: state.version === 2, ...(state.version === 2 ? { retirement: structuredClone(state.retirement) } : {}) };
    },
    close() { storage.close(); },
  };
  function ensureReady() { storage.read(); if (importing) throw new Error('Admission wallet import is in progress'); }
}

function sameReservation(first: Reservation | undefined, second: Reservation): boolean {
  return first?.relayUrl === second.relayUrl
    && first.action === second.action && first.binding === second.binding;
}

function validateContext(context: AdmissionCapabilityRequestContextV2): void {
  assertSecureRelayTransportEndpoint(context.relayUrl);
  if (context.relayUrl.length > 512
    || !['publication-write', 'search', 'mailbox-fetch', 'mailbox-acknowledge', 'mailbox-deposit'].includes(context.action)
    || !/^admreq_[A-Za-z0-9_-]{86}$/.test(context.requestBinding)) {
    throw new Error('Invalid admission wallet reservation');
  }
}

function reservationDigest(reservation: Reservation): string {
  // Canonicalize legacy URL spellings as well as new managed reservations.
  return createHash('sha256').update(JSON.stringify(['resonance:admission-wallet-denial:v1',
    new URL(reservation.relayUrl).href, reservation.action, reservation.binding])).digest('hex');
}
function validState(value: unknown, scope: BlindAdmissionScopeV2, issuerKey: string): value is WalletState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (!exactKeys(state, state.version === 2 ? ['entries', 'scope', 'version', 'retirement', 'deniedReservations'] : ['entries', 'scope', 'version']) || (state.version !== 1 && state.version !== 2)
    || !state.scope || typeof state.scope !== 'object' || Array.isArray(state.scope)
    || !exactKeys(state.scope, ['community', 'epoch', 'issuer'])) return false;
  const stored = state.scope as Record<string, unknown>;
  if (stored.issuer !== scope.issuer || stored.community !== scope.community
    || stored.epoch !== scope.epoch || !Array.isArray(state.entries)
    || state.entries.length > MAX_TOKENS) return false;
  if (state.version === 2) {
    const r = state.retirement as Retirement | undefined;
    const hashes = state.deniedReservations;
    return state.entries.length === 0 && !!r && typeof r === 'object' && !Array.isArray(r)
      && exactKeys(r, ['issuerKey', 'authorityFingerprint', 'policyRevision', 'policyDigest', 'retiredAt', 'retryUntil', 'tokensRemoved', 'reservationsRemoved'])
      && r.issuerKey === issuerKey && /^sha256:[a-f0-9]{64}$/.test(r.authorityFingerprint) && /^[a-f0-9]{64}$/.test(r.policyDigest)
      && [r.policyRevision, r.retiredAt, r.retryUntil, r.tokensRemoved, r.reservationsRemoved].every(n => Number.isSafeInteger(n) && n >= 0)
      && r.policyRevision > 0 && r.retiredAt >= r.retryUntil && r.tokensRemoved <= MAX_TOKENS && r.reservationsRemoved <= r.tokensRemoved
      && r.tokensRemoved - r.reservationsRemoved <= MAX_AVAILABLE && Array.isArray(hashes)
      && hashes.length <= r.reservationsRemoved && (hashes.length === 0) === (r.reservationsRemoved === 0)
      && hashes.every((hash, i) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && (i === 0 || hash > hashes[i - 1]));
  }
  const seen = new Set<string>();
  for (const item of state.entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    if (!exactKeys(entry, entry.reservation === undefined ? ['token'] : ['reservation', 'token'])
      || typeof entry.token !== 'string' || !/^[A-Za-z0-9_-]{472}$/.test(entry.token)
      || seen.has(entry.token)) return false;
    seen.add(entry.token);
    if (entry.reservation !== undefined) {
      if (!entry.reservation || typeof entry.reservation !== 'object'
        || Array.isArray(entry.reservation)
        || !exactKeys(entry.reservation, ['action', 'binding', 'relayUrl'])) return false;
      const reservation = entry.reservation as Record<string, unknown>;
      try {
        validateContext({
          relayUrl: reservation.relayUrl, action: reservation.action,
          requestBinding: reservation.binding,
        } as AdmissionCapabilityRequestContextV2);
      } catch { return false; }
    }
  }
  return state.entries.filter(entry => !(entry as WalletEntry).reservation).length <= MAX_AVAILABLE;
}

function exactKeys(value: object, wanted: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...wanted].sort().join(',');
}
