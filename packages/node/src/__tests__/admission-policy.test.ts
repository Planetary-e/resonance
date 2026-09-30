import { beforeAll, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { createAdmissionRequestBindingV2, generateSigningKeyPair } from '@resonance/core';
import { signAdmissionPolicy, verifyAdmissionPolicy, openAdmissionPolicyStore, admissionKeyFingerprint, type AdmissionPolicyBody, type AdmissionWalletProfileV1 } from '@resonance/core/admission-policy';
import { createConfiguredAdmissionVerifier } from '@resonance/relay';
import { openManagedAdmissionWallet } from '../managed-admission-wallet.js';
import { openAdmissionIssuerLedger } from '../admission-issuer-ledger.js';
import { createAdmissionIssuanceBatch, issueAdmissionBatch } from '../blind-admission-issuance.js';

const signer = generateSigningKeyPair(); const authority = Buffer.from(signer.publicKey).toString('base64url');
let profiles: AdmissionWalletProfileV1[]; let keys: CryptoKeyPair[]; let body: AdmissionPolicyBody;
const start = Date.now();
beforeAll(async () => {
  profiles = []; keys = [];
  for (let i = 0; i < 2; i++) {
    const pair = await publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }); keys.push(pair);
    const der = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
    profiles.push({ version: 1, scope: { issuer: 'community-issuer', community: 'public', epoch: `period-${i}` },
      issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${der}\n-----END PUBLIC KEY-----\n`, relayUrls: ['ws://127.0.0.1:45445/'] });
  }
  body = { version: 1, kind: 'admission-policy', revision: 1, issuedAt: start - 1000, expiresAt: start + 10000,
    activeKey: admissionKeyFingerprint(profiles[0].issuerPublicKey),
    keys: [{ profile: profiles[0], notBefore: start - 1000, issueUntil: start + 100, spendUntil: start + 200, retryUntil: start + 300 }] };
});
const signed = (value: AdmissionPolicyBody = body) => signAdmissionPolicy(value, authority, signer.secretKey);
const nextBody = (): AdmissionPolicyBody => ({ ...body, revision: 2, activeKey: admissionKeyFingerprint(profiles[1].issuerPublicKey),
  keys: [...body.keys, { profile: profiles[1], notBefore: start, issueUntil: start + 5000, spendUntil: start + 6000, retryUntil: start + 7000 }] });

it('authenticates revisions against a separate pinned authority and rejects rollback, forks and retirement extensions after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'community-policy-')); const encryptionKey = randomBytes(32);
  const options = { path: join(directory, 'policy.json'), encryptionKey, now: () => start };
  let store = await openAdmissionPolicyStore(options);
  try {
    const first = await signed();
    await expect(store.install({ ...first, activeKey: 'sha256:' + 'a'.repeat(64) }, authority)).rejects.toThrow();
    const stranger = generateSigningKeyPair(); const strangerPublic = Buffer.from(stranger.publicKey).toString('base64url');
    await expect(verifyAdmissionPolicy(first, strangerPublic)).rejects.toThrow('pinned');
    await store.install(first, authority); await store.install(first, authority);
    const fork = await signed({ ...body, expiresAt: body.expiresAt + 1 });
    await expect(store.install(fork, authority)).rejects.toThrow('conflicting revision');
    const second = await signed(nextBody()); await store.install(second, authority);
    await expect(store.install(first, authority)).rejects.toThrow('rollback');
    await expect(store.install(await signAdmissionPolicy(nextBody(), strangerPublic, stranger.secretKey), strangerPublic)).rejects.toThrow('already pinned');
    const extended = await signed({ ...nextBody(), revision: 3, keys: [{ ...body.keys[0], retryUntil: start + 1000 }, nextBody().keys[1]] });
    await expect(store.install(extended, authority)).rejects.toThrow('extend retirement');
    const omitted = await signed({ ...nextBody(), revision: 3, keys: [nextBody().keys[1]] });
    await expect(store.install(omitted, authority)).rejects.toThrow('retain prior');
    store.close(); store = await openAdmissionPolicyStore({ ...options, mode: 'open-existing' });
    expect(store.current()?.revision).toBe(2); await expect(store.install(first, authority)).rejects.toThrow('rollback');
    expect(readFileSync(options.path, 'utf8')).not.toContain(authority);
    const pending = store.install(await signed({ ...nextBody(), revision: 3 }), authority); store.close(); await expect(pending).rejects.toThrow('closed');
    rmSync(options.path); await expect(openAdmissionPolicyStore({ ...options, mode: 'open-existing' })).rejects.toThrow('missing');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('coordinates issuer shutdown, fresh spends, recorded retries and final retirement while retaining wallet and relay history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'policy-transition-')); let time = start; const now = () => time;
  const encryptionKey = randomBytes(32); const policy = await signed(); const second = await signed(nextBody());
  const issuerOptions = { path: join(directory, 'issuer.json'), privateKey: keys[0].privateKey, expectedProfile: profiles[0], now };
  const issuer = await openAdmissionIssuerLedger({ ...issuerOptions, create: { batchSize: 2, maxPermits: 2 } });
  let wallet = await openManagedAdmissionWallet({ directory, encryptionKey, now });
  const relayOptions = { directory: join(directory, 'relay'), authority, encryptionKey, policy, now };
  let relay = await createConfiguredAdmissionVerifier({ ...relayOptions, initialize: true });
  try {
    await issuer.installPolicy(policy, authority);
    // Migrate an existing manual wallet, preserving the same key and all reservations.
    await wallet.configure(profiles[0]); await wallet.installPolicy(policy, authority);
    await expect(wallet.configure(profiles[0])).rejects.toThrow('signed community policy');
    const permit = issuer.grant(); const spare = issuer.grant();
    const batch = await wallet.requestTokens(2); const response = await issuer.approve(permit, batch); await wallet.completeIssuance(response);
    const context = { relayUrl: profiles[0].relayUrls[0], action: 'publication-write' as const,
      requestBinding: createAdmissionRequestBindingV2('publication-write', { existing: true }) };
    const old = wallet.capabilityFor(context)!;
    expect(await relay.verifyAndSpend(old, { ...context, now: time })).toEqual({ status: 'accepted' });
    const neverDeliveredContext = { ...context, requestBinding: createAdmissionRequestBindingV2('publication-write', { neverDelivered: true }) };
    const neverDelivered = wallet.capabilityFor(neverDeliveredContext)!;
    time = start + 100;
    expect(() => issuer.grant()).toThrow('retired');
    await expect(issuer.approve(spare, (await createAdmissionIssuanceBatch(profiles[0], 2)).request)).rejects.toThrow('retired');
    expect(await issuer.approve(permit, batch)).toEqual(response); // Earlier response remains recoverable before the fresh-spend cutoff.
    await expect(wallet.requestTokens(1)).rejects.toThrow('not active');
    await wallet.installPolicy(second, authority); await issuer.installPolicy(second, authority);
    expect(wallet.status()).toMatchObject({ policy: { revision: 2 }, available: 0, archived: [{ reserved: 2 }] });
    const newBatch = await wallet.requestTokens(1);
    await wallet.completeIssuance(await issueAdmissionBatch({ request: newBatch, expectedProfile: profiles[1], privateKey: keys[1].privateKey }));
    wallet.close(); wallet = await openManagedAdmissionWallet({ directory, encryptionKey, now });
    relay.close(); relay = await createConfiguredAdmissionVerifier({ ...relayOptions, policy: second });
    time = start + 200;
    expect(wallet.capabilityFor(context)).toEqual(old);
    expect(await relay.verifyAndSpend(old, { ...context, now: time })).toEqual({ status: 'replay' });
    expect(await relay.verifyAndSpend(neverDelivered, { ...neverDeliveredContext, now: time })).toEqual({ status: 'rejected', reason: 'key_retired' });
    const newContext = { ...context, requestBinding: createAdmissionRequestBindingV2('publication-write', { fresh: true }) };
    const fresh = wallet.capabilityFor(newContext)!;
    expect(await relay.verifyAndSpend(fresh, { ...newContext, now: time })).toEqual({ status: 'accepted' });
    await expect(wallet.installPolicy(policy, authority)).rejects.toThrow('rollback');
    time = start + 300;
    expect(() => wallet.capabilityFor(context)).toThrow('not active');
    expect(await relay.verifyAndSpend(old, { ...context, now: time })).toMatchObject({ status: 'rejected' });
    expect(wallet.status().archived[0].reserved).toBe(2);
    relay.close(); await expect(createConfiguredAdmissionVerifier(relayOptions)).rejects.toThrow('rollback');
    relay = await createConfiguredAdmissionVerifier({ ...relayOptions, policy: second });
    time = body.expiresAt;
    await expect(relay.verifyAndSpend(fresh, { ...newContext, now: time })).rejects.toThrow('not current');
    expect(() => wallet.capabilityFor(newContext)).toThrow('not current');
  } finally { issuer.close(); relay.close(); wallet.close(); rmSync(directory, { recursive: true, force: true }); }
}, 20_000);

it('rejects new work if a retirement cutoff passes during token verification', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'policy-clock-')); let time = start;
  const config = await signed();
  const batch = await createAdmissionIssuanceBatch(profiles[0], 1);
  const tokens = await batch.finalize(await issueAdmissionBatch({ request: batch.request, expectedProfile: profiles[0], privateKey: keys[0].privateKey }));
  const wallet = await openManagedAdmissionWallet({ directory, encryptionKey: randomBytes(32), now: () => time });
  const relay = await createConfiguredAdmissionVerifier({ directory: join(directory, 'relay'), authority, policy: config, encryptionKey: randomBytes(32), initialize: true, now: () => time });
  try {
    await wallet.installPolicy(config, authority); await wallet.importTokens(tokens);
    const context = { relayUrl: profiles[0].relayUrls[0], action: 'search' as const, requestBinding: createAdmissionRequestBindingV2('search', { delayed: true }), now: time };
    const cap = wallet.capabilityFor(context)!; const pending = relay.verifyAndSpend(cap, context);
    time = start + 200;
    expect(await pending).toEqual({ status: 'rejected', reason: 'key_retired' });
  } finally { relay.close(); wallet.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('creates and signs a real authority configuration using the operator command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'policy-command-'));
  const script = fileURLToPath(new URL('../../../../scripts/admission-policy.ts', import.meta.url));
  const secretPath = join(directory, 'authority.json'); const publicPath = join(directory, 'authority.pub'); const input = join(directory, 'input.json'); const output = join(directory, 'signed.json');
  try {
    // Keep the manifest current but retire the issuer, so the CLI must retain its
    // earlier permit while refusing another grant after signed-policy installation.
    writeFileSync(input, JSON.stringify({ ...body, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 86400000 }));
    for (const args of [['authority-keygen', secretPath, publicPath], ['storage-keygen', join(directory, 'state.hex')], ['sign', secretPath, input, output]]) {
      const run = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8', timeout: 10000 }); expect(run.status, run.stderr).toBe(0);
    }
    const verified = await verifyAdmissionPolicy(JSON.parse(readFileSync(output, 'utf8')), readFileSync(publicPath, 'utf8').trim());
    expect(verified.revision).toBe(1); expect(readFileSync(join(directory, 'state.hex'), 'utf8').trim()).toHaveLength(64);
    const overwrite = spawnSync(process.execPath, ['--import', 'tsx', script, 'sign', secretPath, input, output], { encoding: 'utf8', timeout: 10000 });
    expect(overwrite.status).toBe(1);
    const issuerScript = fileURLToPath(new URL('../../../../scripts/issue-admission-tokens.ts', import.meta.url));
    const profilePath = join(directory, 'profile.json'), privatePath = join(directory, 'private.pem'), ledgerPath = join(directory, 'issuer.json');
    writeFileSync(profilePath, JSON.stringify(profiles[0]));
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys[0].privateKey));
    try { writeFileSync(privatePath, `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----\n`, { mode: 0o600 }); }
    finally { der.fill(0); }
    const runIssuer = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', issuerScript, ...args], { encoding: 'utf8', timeout: 10000 });
    for (const args of [['init', profilePath, privatePath, ledgerPath, '1', '2'],
      ['grant', '--approve', profilePath, privatePath, ledgerPath, join(directory, 'first-permit.json')],
      ['policy', '--approve', profilePath, privatePath, ledgerPath, publicPath, output]]) {
      const run = runIssuer(...args); expect(run.status, run.stderr).toBe(0);
    }
    const status = runIssuer('status', profilePath, privatePath, ledgerPath);
    expect(status.status, status.stderr).toBe(0); expect(JSON.parse(status.stdout)).toMatchObject({ allocatedPermits: 1 });
    const retired = runIssuer('grant', '--approve', profilePath, privatePath, ledgerPath, join(directory, 'second-permit.json'));
    expect(retired.status).toBe(1); expect(retired.stderr).toContain('retired');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 20_000);
