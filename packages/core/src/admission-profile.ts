import { createHash } from 'node:crypto';
import { assertSecureRelayTransportEndpoint } from './relay-transport.js';
import type { BlindAdmissionScopeV2 } from './blind-admission-v2.js';

export interface AdmissionWalletProfileV1 {
  version: 1; scope: BlindAdmissionScopeV2; issuerPublicKey: string; relayUrls: string[];
}
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
  value.relayUrls.forEach(normalizeAdmissionRelay);
}
export function normalizeAdmissionRelay(value: unknown): string {
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
export function admissionKeyFingerprint(pem: string) { return `sha256:${createHash('sha256').update(keyBytes(pem)).digest('hex')}`; }
export async function parseAdmissionWalletProfile(value: unknown) {
  validateProfile(value);
  // Copy all inputs before asynchronous crypto so the caller cannot change the pinned policy mid-validation.
  const input = structuredClone(value);
  const publicKey = await crypto.subtle.importKey('spki', Uint8Array.from(keyBytes(input.issuerPublicKey)),
    { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
  if ((publicKey.algorithm as RsaHashedKeyAlgorithm).modulusLength !== 2048) throw new Error('Issuer public key must use 2048-bit RSA');
  const der = Buffer.from(await crypto.subtle.exportKey('spki', publicKey)).toString('base64');
  const pem = `-----BEGIN PUBLIC KEY-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----\n`;
  const profile: AdmissionWalletProfileV1 = { version: 1, scope: { issuer: input.scope.issuer, community: input.scope.community, epoch: input.scope.epoch }, issuerPublicKey: pem,
    relayUrls: [...new Set(input.relayUrls.map(normalizeAdmissionRelay))].sort() };
  return { profile, publicKey };
}
