import { beforeAll, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { createAdmissionRequestBindingV2, verifyBlindAdmissionTokenV2 } from '@resonance/core';
import { openManagedAdmissionWallet, type AdmissionWalletProfileV1 } from '../managed-admission-wallet.js';
import { createAdmissionIssuanceBatch, issueAdmissionBatch } from '../blind-admission-issuance.js';
import { openEncryptedLocalState } from '../encrypted-local-state.js';
import { openBlindAdmissionWalletV2 } from '../blind-admission-wallet.js';
import { parseAdmissionWalletProfile } from '../admission-wallet-profile.js';

let keys: CryptoKeyPair; let nextKeys: CryptoKeyPair;
let profile: AdmissionWalletProfileV1; let nextProfile: AdmissionWalletProfileV1;
const context = { relayUrl: 'ws://127.0.0.1:45898/', action: 'publication-write' as const,
  requestBinding: createAdmissionRequestBindingV2('publication-write', { record: 'uncertain-publication' }) };
beforeAll(async () => {
  async function setup(epoch: string) {
    const keys = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
    const der = Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64');
    return { keys, profile: { version: 1 as const, scope: { issuer: 'volunteer', community: 'public', epoch },
      issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${der}\n-----END PUBLIC KEY-----`, relayUrls: [context.relayUrl] } };
  }
  ({ keys, profile } = await setup('period-one'));
  ({ keys: nextKeys, profile: nextProfile } = await setup('period-two'));
});

it('issues blinded batches offline, rejects mismatches, and retains old exact reservations through key rotation and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'issuance-')); const encryptionKey = randomBytes(32);
  let wallet = await openManagedAdmissionWallet({ directory, encryptionKey });
  try {
    await wallet.configure(profile);
    const creating = wallet.requestTokens(2);
    await expect(wallet.requestTokens(2)).rejects.toThrow('in progress');
    const request = await creating;
    await expect(wallet.configure(nextProfile)).rejects.toThrow('Finish or cancel');
    await expect(wallet.importTokens([])).rejects.toThrow('Finish or cancel');
    await expect(issueAdmissionBatch({ request, expectedProfile: nextProfile, privateKey: nextKeys.privateKey })).rejects.toThrow('different issuer');
    await expect(issueAdmissionBatch({ request, expectedProfile: profile, privateKey: nextKeys.privateKey })).rejects.toThrow('does not match');
    const response = await issueAdmissionBatch({ request, expectedProfile: profile, privateKey: keys.privateKey });
    await expect(wallet.completeIssuance({ ...response, batchId: 'wrong' })).rejects.toThrow('does not match');
    expect(wallet.status().available).toBe(0);
    expect(await wallet.completeIssuance(response)).toBe(2);
    await expect(wallet.completeIssuance(response)).rejects.toThrow('No pending');
    const original = wallet.capabilityFor(context)!;
    expect(JSON.stringify(request)).not.toContain(original.token); expect(JSON.stringify(response)).not.toContain(original.token);
    expect(await verifyBlindAdmissionTokenV2(original, profile.scope, context.action, context.requestBinding, keys.publicKey)).toBeTruthy();
    await wallet.configure(nextProfile);
    expect(wallet.status()).toMatchObject({ available: 0, reserved: 0, archived: [{ available: 1, reserved: 1 }] });
    expect(wallet.capabilityFor(context)).toEqual(original);
    const freshContext = { ...context, requestBinding: createAdmissionRequestBindingV2(context.action, { record: 'fresh' }) };
    expect(() => wallet.capabilityFor(freshContext)).toThrow('no unreserved tokens'); // No fallback to old unspent tokens.
    const nextRequest = await wallet.requestTokens(1);
    await wallet.completeIssuance(await issueAdmissionBatch({ request: nextRequest, expectedProfile: nextProfile, privateKey: nextKeys.privateKey }));
    const fresh = wallet.capabilityFor(freshContext)!;
    expect(await verifyBlindAdmissionTokenV2(fresh, nextProfile.scope, freshContext.action, freshContext.requestBinding, nextKeys.publicKey)).toBeTruthy();
    wallet.close(); wallet = await openManagedAdmissionWallet({ directory, encryptionKey });
    expect(wallet.capabilityFor(context)).toEqual(original); expect(wallet.capabilityFor(freshContext)).toEqual(fresh);
    expect(wallet.status().scope).toEqual(nextProfile.scope);
    await wallet.configure(profile); expect(wallet.status().available).toBe(1); // Explicitly reactivate identical prior pins.
    expect(await wallet.importTokens([original.token])).toBe(0); // Even archived/reserved tokens never become free again.
    await expect(wallet.configure({ ...profile, scope: { ...profile.scope, epoch: 'another' } })).rejects.toThrow('already pinned');
    const ciphertext = readFileSync(join(directory, 'admission-profile.json'), 'utf8');
    expect(ciphertext).not.toContain('volunteer');
    wallet.close(); rmSync(join(directory, 'admission-wallet.json'));
    await expect(openManagedAdmissionWallet({ directory, encryptionKey })).rejects.toThrow('history');
  } finally { wallet.close(); rmSync(directory, { recursive: true, force: true }); }
}, 20_000);

it('discards a cryptographically invalid batch atomically and cancels ephemeral issuance on close', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'issuance-invalid-')); const encryptionKey = randomBytes(32);
  let wallet = await openManagedAdmissionWallet({ directory, encryptionKey });
  try {
    await wallet.configure(profile);
    const request = await wallet.requestTokens(2);
    const response = await issueAdmissionBatch({ request, expectedProfile: profile, privateKey: keys.privateKey });
    await expect(wallet.completeIssuance({ ...response, responses: [response.responses[0], Buffer.alloc(256).toString('base64url')] })).rejects.toThrow('Invalid issuer response');
    expect(wallet.status()).toMatchObject({ available: 0, total: 0 }); expect(wallet.status().pendingIssuance).toBeUndefined();
    const next = await wallet.requestTokens(1);
    const signed = await issueAdmissionBatch({ request: next, expectedProfile: profile, privateKey: keys.privateKey });
    const completing = wallet.completeIssuance(signed); wallet.close();
    await expect(completing).rejects.toThrow('closed');
    wallet = await openManagedAdmissionWallet({ directory, encryptionKey });
    expect(wallet.status().total).toBe(0);
    await expect(wallet.completeIssuance(signed)).rejects.toThrow('No pending');
    const creating = wallet.requestTokens(1); wallet.close(); await expect(creating).rejects.toThrow('closed');
    wallet = await openManagedAdmissionWallet({ directory, encryptionKey });
    await wallet.requestTokens(1); wallet.cancelIssuance(); expect(wallet.status().pendingIssuance).toBeUndefined();
    for (const invalid of [0, 33, 1.5, NaN]) await expect(wallet.requestTokens(invalid)).rejects.toThrow();
  } finally { wallet.close(); rmSync(directory, { recursive: true, force: true }); }
}, 15_000);

it('migrates the original desktop profile without changing its encrypted token file or reservation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'issuance-migrate-')); const encryptionKey = randomBytes(32);
  const parsed = await parseAdmissionWalletProfile(profile);
  const config = openEncryptedLocalState({ path: join(directory, 'admission-profile.json'), key: encryptionKey,
    domain: 'resonance:admission-profile:v1', maxBytes: 16384, initial: { version: 1, profile: parsed.profile }, validate: (_): _ is { version: number; profile: AdmissionWalletProfileV1 } => true });
  config.close();
  const legacy = openBlindAdmissionWalletV2({ path: join(directory, 'admission-wallet.json'), encryptionKey, scope: profile.scope, issuerPublicKey: keys.publicKey });
  const batch = await createAdmissionIssuanceBatch(profile, 1);
  await legacy.importTokens(await batch.finalize(await issueAdmissionBatch({ request: batch.request, expectedProfile: profile, privateKey: keys.privateKey })));
  const original = legacy.capabilityFor(context); legacy.close();
  const raw = readFileSync(join(directory, 'admission-wallet.json'), 'utf8');
  const wallet = await openManagedAdmissionWallet({ directory, encryptionKey });
  try {
    await wallet.configure(nextProfile); expect(wallet.capabilityFor(context)).toEqual(original);
    expect(readFileSync(join(directory, 'admission-wallet.json'), 'utf8')).toBe(raw);
  } finally { wallet.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('replenishes beyond 256 historical reservations without recycling them, while enforcing the history bound', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'issuance-capacity-')); const encryptionKey = randomBytes(32);
  const path = join(directory, 'wallet.json');
  const batch = await createAdmissionIssuanceBatch(profile, 2);
  const tokens = await batch.finalize(await issueAdmissionBatch({ request: batch.request, expectedProfile: profile, privateKey: keys.privateKey }));
  // Authenticated snapshot fixture models accumulated history without thousands of RSA operations.
  function seed(count: number) {
    const entries = Array.from({ length: count }, (_, index) => ({ token: index === 0 ? tokens[0] : randomBytes(354).toString('base64url'),
      reservation: { relayUrl: context.relayUrl, action: context.action, binding: index === 0 ? context.requestBinding : createAdmissionRequestBindingV2(context.action, { index }) } }));
    const storage = openEncryptedLocalState({ path, key: encryptionKey, domain: 'resonance:blind-admission-wallet:v1', maxBytes: 8 * 1024 * 1024,
      initial: { version: 1, scope: profile.scope, entries }, validate: (_): _ is { version: number; scope: typeof profile.scope; entries: typeof entries } => true });
    storage.write({ version: 1, scope: profile.scope, entries }); storage.close();
  }
  try {
    seed(256);
    let wallet = openBlindAdmissionWalletV2({ path, encryptionKey, scope: profile.scope, issuerPublicKey: keys.publicKey });
    try {
      expect(await wallet.importTokens(tokens)).toBe(1);
      expect(wallet.summary()).toMatchObject({ available: 1, reserved: 256, total: 257 });
      expect(wallet.capabilityFor(context).token).toBe(tokens[0]); expect(wallet.available()).toBe(1);
    } finally { wallet.close(); }
    seed(4096); wallet = openBlindAdmissionWalletV2({ path, encryptionKey, scope: profile.scope, issuerPublicKey: keys.publicKey });
    try { await expect(wallet.importTokens([tokens[1]])).rejects.toThrow('history capacity'); expect(wallet.capabilityFor(context).token).toBe(tokens[0]); }
    finally { wallet.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15_000);

it('enforces permits in the offline PKCS8 issuer command and refuses overwriting the response', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'issuance-cli-'));
  try {
    const batch = await createAdmissionIssuanceBatch(profile, 1);
    const profileFile = join(directory, 'profile.json'); const keyFile = join(directory, 'private.pem');
    const requestFile = join(directory, 'request.json'); const responseFile = join(directory, 'response.json');
    writeFileSync(profileFile, JSON.stringify(profile)); writeFileSync(requestFile, JSON.stringify(batch.request));
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
    writeFileSync(keyFile, `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----\n`, { mode: 0o600 });
    const script = fileURLToPath(new URL('../../../../scripts/issue-admission-tokens.ts', import.meta.url));
    const ledgerFile = join(directory, 'ledger.json'); const permitFile = join(directory, 'permit.json');
    const base = ['--import', 'tsx', script];
    for (const command of [
      ['init', profileFile, keyFile, ledgerFile, '1', '1'],
      ['grant', '--approve', profileFile, keyFile, ledgerFile, permitFile],
    ]) {
      const result = spawnSync(process.execPath, [...base, ...command], { encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
    }
    const args = [...base, 'issue', '--approve', profileFile, keyFile, ledgerFile, permitFile, requestFile, responseFile];
    const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10_000 });
    expect(run.status, run.stderr).toBe(0);
    const response = readFileSync(responseFile, 'utf8');
    expect(await batch.finalize(JSON.parse(response))).toHaveLength(1);
    expect(spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10_000 }).status).toBe(1);
    expect(readFileSync(responseFile, 'utf8')).toBe(response);
    const recoveredFile = join(directory, 'recovered.json');
    const retry = spawnSync(process.execPath, [...args.slice(0, -1), recoveredFile], { encoding: 'utf8', timeout: 10_000 });
    expect(retry.status, retry.stderr).toBe(0); expect(readFileSync(recoveredFile, 'utf8')).toBe(response);
    const exhausted = spawnSync(process.execPath, [...base, 'grant', '--approve', profileFile, keyFile, ledgerFile, join(directory, 'extra.json')], { encoding: 'utf8', timeout: 10_000 });
    expect(exhausted.status).toBe(1); expect(exhausted.stderr).toContain('allowance exhausted');
    const unapproved = spawnSync(process.execPath, args.filter(value => value !== '--approve'), { encoding: 'utf8', timeout: 10_000 });
    expect(unapproved.status).toBe(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15_000);
