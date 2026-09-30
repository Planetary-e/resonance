/** Desktop pilot: one explicitly pinned issuer/scope and destination allowlist. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { assertSecureRelayTransportEndpoint, type BlindAdmissionScopeV2 } from '@resonance/core';
import { openEncryptedLocalState } from './encrypted-local-state.js';
import { openBlindAdmissionWalletV2, type BlindAdmissionWalletV2 } from './blind-admission-wallet.js';
import type { AdmissionCapabilityRequestContextV2 } from './relay-client.js';

export interface AdmissionWalletProfileV1 {
  version: 1; scope: BlindAdmissionScopeV2; issuerPublicKey: string; relayUrls: string[];
}
export interface AdmissionWalletStatus {
  configured: boolean; scope?: BlindAdmissionScopeV2; keyFingerprint?: string; relayUrls?: string[];
  available: number; reserved: number; total: number; capacity: number;
}
interface State { version: 1; profile: AdmissionWalletProfileV1 | null }

export async function openManagedAdmissionWallet(options: { directory: string; encryptionKey: Uint8Array }) {
  const key = Buffer.from(options.encryptionKey);
  let storage: ReturnType<typeof openEncryptedLocalState<State>>;
  try { storage = openEncryptedLocalState<State>({ path: join(options.directory, 'admission-profile.json'), key,
    domain: 'resonance:admission-profile:v1', maxBytes: 16 * 1024, initial: { version: 1, profile: null },
    validate: (value): value is State => {
      if (!object(value) || Object.keys(value).sort().join(',') !== 'profile,version' || value.version !== 1) return false;
      if (value.profile === null) return true;
      try { validateProfile(value.profile); return true; } catch { return false; }
    } }); } catch (error) { key.fill(0); throw error; }
  let wallet: BlindAdmissionWalletV2 | undefined;
  let configuring = false;
  let closed = false;
  try {
    const profile = storage.read().profile;
    if (profile) wallet = open(await parseProfile(profile));
  } catch (error) { storage.close(); key.fill(0); throw error; }
  function open(parsed: { profile: AdmissionWalletProfileV1; publicKey: CryptoKey }) {
    return openBlindAdmissionWalletV2({ path: join(options.directory, 'admission-wallet.json'), encryptionKey: key,
      scope: parsed.profile.scope, issuerPublicKey: parsed.publicKey });
  }
  return {
    configured(): boolean { return storage.read().profile !== null; },
    status(): AdmissionWalletStatus {
      const profile = storage.read().profile;
      if (!profile) return { configured: false, available: 0, reserved: 0, total: 0, capacity: 256 };
      if (!wallet) throw new Error('Access-token wallet is unavailable; lock and unlock to recover');
      return { configured: true, scope: structuredClone(profile.scope), relayUrls: [...profile.relayUrls],
        keyFingerprint: fingerprint(profile.issuerPublicKey), ...wallet.summary() };
    },
    async configure(value: unknown) {
      storage.read(); if (configuring) throw new Error('Wallet setup is already in progress');
      configuring = true;
      try {
        const parsed = await parseProfile(value);
        const previous = storage.read().profile; // Fails if the session locked during key validation.
        if (previous) {
          if (JSON.stringify(previous) !== JSON.stringify(parsed.profile)) {
            throw new Error('This pilot wallet is already pinned. Changing issuer, epoch, or relays requires a future migration; existing reservations must be retained');
          }
          return;
        }
        // Persist trust before opening the token file. A failure never falls back to unconfigured mode.
        storage.write({ version: 1, profile: parsed.profile });
        wallet = open(parsed);
      } finally { configuring = false; }
    },
    async importTokens(tokens: readonly string[]) {
      storage.read(); if (!wallet) throw new Error('Set up the access-token wallet first');
      return wallet.importTokens(tokens);
    },
    capabilityFor(context: AdmissionCapabilityRequestContextV2) {
      const profile = storage.read().profile;
      if (!profile) return undefined;
      if (!wallet) throw new Error('Access-token wallet is unavailable; lock and unlock to recover');
      if (!profile.relayUrls.includes(normalizeRelay(context.relayUrl))) {
        throw new Error('Destination is not in the pinned access-token relay list');
      }
      return wallet.capabilityFor({ ...context, relayUrl: normalizeRelay(context.relayUrl) });
    },
    close() { if (closed) return; closed = true; wallet?.close(); storage.close(); key.fill(0); },
  };
}
export type ManagedAdmissionWallet = Awaited<ReturnType<typeof openManagedAdmissionWallet>>;

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validateProfile(value: unknown): asserts value is AdmissionWalletProfileV1 {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'issuerPublicKey,relayUrls,scope,version' || value.version !== 1
    || !object(value.scope) || Object.keys(value.scope).sort().join(',') !== 'community,epoch,issuer'
    || typeof value.scope.issuer !== 'string' || !value.scope.issuer.trim() || value.scope.issuer.length > 128
    || /[\u0000-\u001f\u007f]/.test(value.scope.issuer)
    || value.scope.community !== 'public' || typeof value.scope.epoch !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.scope.epoch)
    || typeof value.issuerPublicKey !== 'string' || value.issuerPublicKey.length > 4096
    || !Array.isArray(value.relayUrls) || value.relayUrls.length < 1 || value.relayUrls.length > 8) {
    throw new Error('Invalid wallet setup: this pilot supports the public community, one issuer/epoch, and 1–8 destination relays');
  }
  value.relayUrls.forEach(normalizeRelay);
}
function normalizeRelay(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Invalid access-token relay address');
  assertSecureRelayTransportEndpoint(value);
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('Access-token relay addresses cannot contain credentials, queries, or fragments');
  return url.href;
}
function keyBytes(pem: string): Buffer {
  const match = pem.trim().match(/^-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----$/);
  if (!match) throw new Error('Wallet setup requires one SPKI PEM public key');
  return Buffer.from(match[1].replace(/\s/g, ''), 'base64');
}
function fingerprint(pem: string) { return `sha256:${createHash('sha256').update(keyBytes(pem)).digest('hex')}`; }
async function parseProfile(value: unknown) {
  validateProfile(value);
  // Copy all inputs before asynchronous crypto so the caller cannot change the pinned policy mid-validation.
  const input = structuredClone(value);
  const publicKey = await crypto.subtle.importKey('spki', Uint8Array.from(keyBytes(input.issuerPublicKey)),
    { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
  if ((publicKey.algorithm as RsaHashedKeyAlgorithm).modulusLength !== 2048) throw new Error('Issuer public key must use 2048-bit RSA');
  const der = Buffer.from(await crypto.subtle.exportKey('spki', publicKey)).toString('base64');
  const pem = `-----BEGIN PUBLIC KEY-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
  const profile: AdmissionWalletProfileV1 = { version: 1, scope: { issuer: input.scope.issuer, community: input.scope.community, epoch: input.scope.epoch }, issuerPublicKey: pem,
    relayUrls: [...new Set(input.relayUrls.map(normalizeRelay))].sort() };
  return { profile, publicKey };
}
