/** Encrypted, crash-safe local reservations for admission tokens. */
import {
  type AdmissionCapabilityV2, type BlindAdmissionScopeV2, type RelayAdmissionActionV2,
  assertSecureRelayTransportEndpoint, createAdmissionRequestBindingV2,
  presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2,
} from '@resonance/core';
import type { AdmissionCapabilityRequestContextV2 } from './relay-client.js';
import { openEncryptedLocalState } from './encrypted-local-state.js';

interface Reservation { relayUrl: string; action: RelayAdmissionActionV2; binding: string }
interface WalletEntry { token: string; reservation?: Reservation }
interface WalletState { version: 1; scope: BlindAdmissionScopeV2; entries: WalletEntry[] }
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
  summary(): { available: number; reserved: number; total: number; capacity: number; availableCapacity: number };
  close(): void;
}

export function openBlindAdmissionWalletV2(options: {
  path: string; encryptionKey: Uint8Array; issuerPublicKey: CryptoKey; scope: BlindAdmissionScopeV2;
}): BlindAdmissionWalletV2 {
  const scope = structuredClone(options.scope);
  // Preserve the original snapshot domain/shape so existing SDK wallets remain readable.
  const storage = openEncryptedLocalState<WalletState>({ path: options.path, key: options.encryptionKey,
    domain: 'resonance:blind-admission-wallet:v1', maxBytes: MAX_FILE_BYTES,
    initial: { version: 1, scope, entries: [] }, validate: (value): value is WalletState => validState(value, scope) });
  let importing = false;
  return {
    async importTokens(tokens) {
      ensureReady();
      if (!Array.isArray(tokens) || tokens.length > MAX_AVAILABLE
        || tokens.some(token => typeof token !== 'string' || !/^[A-Za-z0-9_-]{472}$/.test(token))) {
        throw new Error('Import at most 256 valid access tokens');
      }
      importing = true;
      try {
        const state = storage.read();
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
      const state = storage.read();
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
      const entry = storage.read().entries.find(entry => sameReservation(entry.reservation,
        { relayUrl: context.relayUrl, action: context.action, binding: context.requestBinding }));
      return entry ? presentBlindAdmissionTokenV2(entry.token, scope, context.action, context.requestBinding) : undefined;
    },
    available() { ensureReady(); return storage.read().entries.filter(entry => !entry.reservation).length; },
    summary() {
      const entries = storage.read().entries; const available = entries.filter(entry => !entry.reservation).length;
      return { available, reserved: entries.length - available, total: entries.length, capacity: MAX_TOKENS, availableCapacity: MAX_AVAILABLE };
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

function validState(value: unknown, scope: BlindAdmissionScopeV2): value is WalletState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (!exactKeys(state, ['entries', 'scope', 'version']) || state.version !== 1
    || !state.scope || typeof state.scope !== 'object' || Array.isArray(state.scope)
    || !exactKeys(state.scope, ['community', 'epoch', 'issuer'])) return false;
  const stored = state.scope as Record<string, unknown>;
  if (stored.issuer !== scope.issuer || stored.community !== scope.community
    || stored.epoch !== scope.epoch || !Array.isArray(state.entries)
    || state.entries.length > MAX_TOKENS) return false;
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
