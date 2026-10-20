import { beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createCipheriv, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { createBlindAdmissionRequestV2, issueBlindAdmissionRequestV2, createAdmissionRequestBindingV2 } from '@resonance/core';
import { openManagedAdmissionWallet, type AdmissionWalletProfileV1 } from '../managed-admission-wallet.js';
import { openBlindAdmissionWalletV2 } from '../blind-admission-wallet.js';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
let keys: CryptoKeyPair; let profile: AdmissionWalletProfileV1; let tokens: string[];
const scope = { issuer: 'volunteer-test-issuer', community: 'public', epoch: '2026-09' };
const context = { relayUrl: 'ws://127.0.0.1:45999/', action: 'search' as const,
  requestBinding: createAdmissionRequestBindingV2('search', { example: 'one' }) };
beforeAll(async () => {
  keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
  const issuer = new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, scope.issuer, keys.privateKey, keys.publicKey);
  const der = Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64');
  profile = { version: 1, scope, issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${der}\n-----END PUBLIC KEY-----`, relayUrls: [context.relayUrl] };
  tokens = [];
  for (let i = 0; i < 3; i++) {
    const request = await createBlindAdmissionRequestV2(scope, keys.publicKey);
    tokens.push(await request.finalize(await issueBlindAdmissionRequestV2(issuer, request.request)));
  }
});

it('pins trust and destination scope, encrypts data, and retains exact reservations through restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'managed-wallet-')); const encryptionKey = randomBytes(32);
  let wallet = await openManagedAdmissionWallet({ directory, encryptionKey });
  try {
    expect(wallet.capabilityFor(context)).toBeUndefined();
    await wallet.configure(profile); expect(wallet.status()).toMatchObject({ configured: true, available: 0 });
    await wallet.configure({ ...profile, relayUrls: [context.relayUrl.slice(0, -1)] });
    await expect(wallet.configure({ ...profile, scope: { ...scope, epoch: '2026-10' } })).rejects.toThrow('already pinned');
    await expect(wallet.configure({ ...profile, issuerPublicKey: 'not a key' })).rejects.toThrow();
    expect(await wallet.importTokens(tokens)).toBe(3); expect(await wallet.importTokens(tokens)).toBe(0);
    await expect(wallet.importTokens(Array(257).fill(tokens[0]))).rejects.toThrow('at most 256');
    expect(() => wallet.capabilityFor({ ...context, relayUrl: 'ws://127.0.0.1:45998/' })).toThrow('pinned');
    expect(wallet.status().available).toBe(3);
    const first = wallet.capabilityFor(context);
    expect(wallet.status()).toMatchObject({ available: 2, reserved: 1, total: 3 });
    for (const file of ['admission-profile.json', 'admission-wallet.json']) {
      const raw = readFileSync(join(directory, file), 'utf8');
      for (const secret of [scope.issuer, tokens[0], context.requestBinding, context.relayUrl]) expect(raw).not.toContain(secret);
    }
    expect(JSON.stringify(wallet.status())).not.toContain(tokens[0]);
    wallet.close(); wallet = await openManagedAdmissionWallet({ directory, encryptionKey });
    expect(wallet.capabilityFor(context)).toEqual(first); expect(wallet.status().available).toBe(2);
    expect(wallet.capabilityFor({ ...context, relayUrl: context.relayUrl.slice(0, -1) })).toEqual(first);
    await expect(openManagedAdmissionWallet({ directory, encryptionKey })).rejects.toThrow('already open');
  } finally { wallet.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('does not finish wallet configuration after its session closes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wallet-setup-lock-')); const encryptionKey = randomBytes(32);
  const wallet = await openManagedAdmissionWallet({ directory, encryptionKey });
  try {
    const pending = wallet.configure(profile); wallet.close();
    await expect(pending).rejects.toThrow('closed');
    const reopened = await openManagedAdmissionWallet({ directory, encryptionKey });
    try { expect(reopened.status().configured).toBe(false); } finally { reopened.close(); }
  } finally { wallet.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('aborts an import on close, rejects a mixed invalid batch atomically, and never spends after a failed write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wallet-failure-')); const encryptionKey = randomBytes(32);
  const options = { path: join(directory, 'wallet.json'), encryptionKey, issuerPublicKey: keys.publicKey, scope };
  let wallet = openBlindAdmissionWalletV2(options);
  try {
    const pending = wallet.importTokens(tokens); wallet.close();
    await expect(pending).rejects.toThrow('closed');
    wallet = openBlindAdmissionWalletV2(options); expect(wallet.available()).toBe(0);
    await expect(wallet.importTokens([tokens[0], 'A'.repeat(472)])).rejects.toThrow('invalid issuer');
    expect(wallet.available()).toBe(0);
    await wallet.importTokens(tokens);
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    expect(() => wallet.capabilityFor(context)).toThrow('disk unavailable');
    expect(() => wallet.capabilityFor(context)).toThrow('write failed');
    wallet.close(); wallet = openBlindAdmissionWalletV2(options);
    expect(wallet.available()).toBe(3); wallet.capabilityFor(context); expect(wallet.available()).toBe(2);
  } finally { wallet.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('reads the prototype encrypted snapshot format without losing a reservation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wallet-compat-')); const encryptionKey = randomBytes(32);
  const path = join(directory, 'wallet.json'); const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce); cipher.setAAD(Buffer.from('resonance:blind-admission-wallet:v1'));
  const state = { version: 1, scope, entries: [{ token: tokens[0], reservation: { relayUrl: context.relayUrl, action: context.action, binding: context.requestBinding } }] };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
  writeFileSync(path, JSON.stringify({ version: 1, nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }) + '\n');
  const wallet = openBlindAdmissionWalletV2({ path, encryptionKey, issuerPublicKey: keys.publicKey, scope });
  try { expect(wallet.available()).toBe(0); expect(wallet.capabilityFor(context).token).toBe(tokens[0]); }
  finally { wallet.close(); rmSync(directory, { recursive: true, force: true }); }
});
