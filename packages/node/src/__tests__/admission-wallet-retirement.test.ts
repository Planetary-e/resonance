import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, fsyncSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { createAdmissionRequestBindingV2, generateSigningKeyPair } from '@resonance/core';
import { admissionKeyFingerprint, parseAdmissionWalletProfile, signAdmissionPolicy, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { openBlindAdmissionWalletV2 } from '../blind-admission-wallet.js';
import { openManagedAdmissionWallet } from '../managed-admission-wallet.js';
import { createAdmissionIssuanceBatch, issueAdmissionBatch } from '../blind-admission-issuance.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
const clean: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); for (const close of clean.splice(0).reverse()) close(); });
type Profile = Awaited<ReturnType<typeof parseAdmissionWalletProfile>>['profile'];
let keys: CryptoKeyPair[], profiles: Profile[], tokens: string[][], old: SignedAdmissionPolicy, policy: SignedAdmissionPolicy;
let start: number, authority: string, authorityKeys: ReturnType<typeof generateSigningKeyPair>, ids: string[];
const relayUrl = 'ws://127.0.0.1:45997/';
const context = (id = 'old') => ({ relayUrl, action: 'search' as const, requestBinding: createAdmissionRequestBindingV2('search', { id }) });
beforeAll(async () => {
  keys = await Promise.all([0, 1].map(() => publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]) })));
  profiles = await Promise.all(keys.map(async (pair, index) => (await parseAdmissionWalletProfile({ version: 1,
    scope: { issuer: 'wallet-retirement', community: 'public', epoch: index ? 'fresh' : 'old' },
    issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----`,
    relayUrls: [relayUrl] })).profile));
  ids = profiles.map(p => admissionKeyFingerprint(p.issuerPublicKey));
  tokens = await Promise.all(profiles.map(async (profile, i) => {
    const batch = await createAdmissionIssuanceBatch(profile, 4);
    return batch.finalize(await issueAdmissionBatch({ request: batch.request, expectedProfile: profile, privateKey: keys[i].privateKey }));
  }));
  start = Date.now() - 60000; authorityKeys = generateSigningKeyPair(); authority = Buffer.from(authorityKeys.publicKey).toString('base64url');
  const body = { version: 1, kind: 'admission-policy', revision: 1, issuedAt: start - 1000, expiresAt: start + 86400000, activeKey: ids[0],
    keys: profiles.map((profile, i) => ({ profile, notBefore: start - 1000, issueUntil: start + (i ? 3600000 : 10000),
      spendUntil: start + (i ? 7200000 : 20000), retryUntil: start + (i ? 10800000 : 30000) })) };
  old = await signAdmissionPolicy(body, authority, authorityKeys.secretKey);
  policy = await signAdmissionPolicy({ ...body, revision: 2, activeKey: ids[1] }, authority, authorityKeys.secretKey);
}, 15000);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wallet-retirement-')), encryptionKey = randomBytes(32);
  clean.push(() => rmSync(directory, { recursive: true, force: true }));
  const options = { directory, encryptionKey, time: start, now: (): number => options.time };
  return options;
}
async function open(options: ReturnType<typeof fixture>) {
  const wallet = await openManagedAdmissionWallet(options); clean.push(() => wallet.close()); return wallet;
}
function raw(options: ReturnType<typeof fixture>, name = 'admission-wallet.json') {
  return openEncryptedLocalState<Record<string, any>>({ path: join(options.directory, name), key: options.encryptionKey,
    domain: name === 'admission-profile.json' ? 'resonance:admission-profile:v1' : 'resonance:blind-admission-wallet:v1',
    maxBytes: 8 * 1024 * 1024, mode: 'open-existing', initial: {}, validate: (v): v is Record<string, any> => !!v });
}
async function prepared(options: ReturnType<typeof fixture>) {
  const wallet = await open(options); await wallet.installPolicy(old, authority); await wallet.importTokens(tokens[0]);
  const capability = wallet.capabilityFor(context()); await wallet.installPolicy(policy, authority); await wallet.importTokens(tokens[1]);
  options.time = policy.keys[0].retryUntil;
  return { wallet, capability };
}

it('removes tokens and request details, retains encrypted retry denials, and keeps the active wallet usable after restart and clock rollback', async () => {
  const options = fixture(); let { wallet } = await prepared(options);
  const path = join(options.directory, 'admission-wallet.json'), before = readFileSync(path);
  const plan = wallet.planRetirement(ids[0]);
  expect(plan).toMatchObject({ tokensRemoved: 4, unusedTokensRemoved: 3, reservationsRemoved: 1, denialMarkersRetained: 1 });
  expect(readFileSync(path)).toEqual(before);
  for (const secret of [...tokens[0], context().requestBinding, relayUrl]) expect(JSON.stringify(plan)).not.toContain(secret);
  wallet.retire(ids[0], plan.approvalDigest);
  expect(wallet.status()).toMatchObject({ available: 4, reserved: 0, archived: [{ available: 0, reserved: 0, permanentlyRetired: true, canRetire: false, tokensRemoved: 4, reservationsRemoved: 1 }] });
  expect(() => wallet.capabilityFor(context())).toThrow('replacement token');
  expect(() => wallet.capabilityFor({ ...context(), relayUrl: relayUrl.slice(0, -1) })).toThrow('replacement token');
  expect(wallet.status().available).toBe(4); wallet.close();
  const saved = raw(options); expect(saved.read().entries).toEqual([]); expect(saved.read().deniedReservations).toHaveLength(1);
  for (const secret of [...tokens[0], context().requestBinding, relayUrl]) expect(JSON.stringify(saved.read())).not.toContain(secret);
  const marker = structuredClone(saved.read()); saved.close();
  expect(readFileSync(path).length).toBeLessThan(before.length);
  options.time = start; wallet = await open(options);
  expect(() => wallet.capabilityFor(context())).toThrow('replacement token');
  expect(wallet.capabilityFor(context('new'))).toBeDefined(); expect(wallet.status()).toMatchObject({ available: 3, reserved: 1 });
  wallet.close();
  const low = openBlindAdmissionWalletV2({ path, encryptionKey: options.encryptionKey, scope: profiles[0].scope, issuerPublicKey: keys[0].publicKey, mode: 'open-existing' });
  try {
    expect(low.available()).toBe(0); expect(low.summary()).toMatchObject({ capacity: 0, availableCapacity: 0, permanentlyRetired: true });
    await expect(low.importTokens(tokens[0])).rejects.toThrow('permanently retired');
    expect(() => low.capabilityFor(context('unused'))).toThrow('permanently retired');
    expect(low.reservedCapabilityFor(context('unrelated'))).toBeUndefined();
    const summary = low.summary(); summary.retirement!.tokensRemoved = 0; expect(low.summary().retirement).toEqual(marker.retirement);
  } finally { low.close(); }
});

it('requires signed current policy, an inactive key, its final cutoff, no pending work and an exact reviewed digest', async () => {
  const options = fixture(), wallet = await open(options); await wallet.configure(profiles[0]);
  expect(() => wallet.planRetirement(ids[0])).toThrow('signed community policy');
  await wallet.installPolicy(old, authority);
  expect(() => wallet.planRetirement(ids[0])).toThrow('active wallet');
  await wallet.importTokens(tokens[0]); wallet.capabilityFor(context());
  const updating = wallet.installPolicy(policy, authority); expect(() => wallet.planRetirement(ids[0])).toThrow('in progress'); await updating;
  expect(() => wallet.planRetirement(ids[0])).toThrow('retry cutoff');
  options.time = policy.keys[0].retryUntil - 1; expect(() => wallet.planRetirement(ids[0])).toThrow('retry cutoff');
  options.time = policy.keys[0].retryUntil;
  expect(wallet.status().archived[0].canRetire).toBe(true);
  expect(() => wallet.planRetirement('sha256:' + '0'.repeat(64))).toThrow('Unknown');
  const plan = wallet.planRetirement(ids[0]), before = readFileSync(join(options.directory, 'admission-wallet.json'));
  expect(() => wallet.retire(ids[0], 'unreviewed')).toThrow('review cleanup');
  const importing = wallet.importTokens(tokens[1]); expect(() => wallet.retire(ids[0], plan.approvalDigest)).toThrow('in progress'); await importing;
  await wallet.requestTokens(1); expect(wallet.status().archived[0].canRetire).toBe(false);
  expect(() => wallet.retire(ids[0], plan.approvalDigest)).toThrow('pending token'); wallet.cancelIssuance();
  options.time = policy.expiresAt; expect(wallet.status().archived[0].canRetire).toBe(false);
  expect(() => wallet.retire(ids[0], plan.approvalDigest)).toThrow('not current');
  options.time = policy.keys[0].retryUntil;
  const { signature: _, authority: __, ...body } = policy;
  const next = await signAdmissionPolicy({ ...body, revision: 3 }, authority, authorityKeys.secretKey);
  await wallet.installPolicy(next, authority); expect(() => wallet.retire(ids[0], plan.approvalDigest)).toThrow('review cleanup');
  expect(readFileSync(join(options.directory, 'admission-wallet.json'))).toEqual(before);
  wallet.close(); expect(() => wallet.planRetirement(ids[0])).toThrow('closed');
});

it('refuses reactivation through a newer signed policy and inconsistent saved configuration', async () => {
  const options = fixture(); let { wallet } = await prepared(options);
  wallet.retire(ids[0], wallet.planRetirement(ids[0]).approvalDigest);
  const { signature: _, authority: __, ...body } = policy;
  const reactivated = await signAdmissionPolicy({ ...body, revision: 3, activeKey: ids[0] }, authority, authorityKeys.secretKey);
  await expect(wallet.installPolicy(reactivated, authority)).rejects.toThrow('reactivate');
  expect(wallet.status().policy!.revision).toBe(2); wallet.close();
  const saved = raw(options, 'admission-profile.json'), original = structuredClone(saved.read());
  saved.write({ ...original, active: 0, policy: reactivated }); saved.close();
  await expect(open(options)).rejects.toThrow('reactivate');
  const rollback = raw(options, 'admission-profile.json'); rollback.write({ ...original, policy: old, active: 0 }); rollback.close();
  await expect(open(options)).rejects.toThrow();
  const manual = raw(options, 'admission-profile.json'); manual.write({ version: 2, active: 1, profiles }); manual.close();
  await expect(open(options)).rejects.toThrow('pinned community policy');
});

it.each(process.platform === 'win32' ? [false] : [false, true])('recovers complete reservations or permanent denials after failed flush (after rename=%s)', async afterRename => {
  const options = fixture(); let { wallet, capability } = await prepared(options);
  const plan = wallet.planRetirement(ids[0]);
  if (afterRename) vi.mocked(fsyncSync).mockImplementationOnce(actualFsync);
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('wallet retirement flush failed'); });
  expect(() => wallet.retire(ids[0], plan.approvalDigest)).toThrow('wallet retirement flush failed');
  expect(() => wallet.status()).toThrow('write failed'); expect(() => wallet.capabilityFor(context('fresh'))).toThrow('write failed'); wallet.close();
  vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); options.time = start;
  wallet = await open(options); expect(wallet.status().archived[0].permanentlyRetired).toBe(afterRename);
  if (afterRename) expect(() => wallet.capabilityFor(context())).toThrow('replacement token');
  else expect(wallet.capabilityFor(context())).toEqual(capability);
  expect(wallet.status().available).toBe(4);
});

it('refuses malformed or missing retirement history and pins the actual issuer key', async () => {
  const options = fixture(), { wallet } = await prepared(options);
  wallet.retire(ids[0], wallet.planRetirement(ids[0]).approvalDigest); wallet.close();
  const saved = raw(options), original = structuredClone(saved.read()); saved.close();
  const r = original.retirement, hash = original.deniedReservations[0];
  for (const change of [
    { retirement: null }, { retirement: { ...r, issuerKey: ids[1] } }, { retirement: { ...r, tokensRemoved: 4097 } },
    { retirement: { ...r, reservationsRemoved: 5 } }, { retirement: { ...r, retiredAt: r.retryUntil - 1 } },
    { retirement: { ...r, policyRevision: 3 } }, { retirement: { ...r, authorityFingerprint: 'sha256:' + '0'.repeat(64) } },
    { retirement: { ...r, policyDigest: '0'.repeat(64) } }, { entries: [{ token: tokens[0][0] }] },
    { deniedReservations: [] }, { deniedReservations: [hash, hash] }, { deniedReservations: ['invalid'] },
  ]) {
    const state = raw(options); state.write({ ...original, ...change }); state.close(); await expect(open(options)).rejects.toThrow();
  }
  const state = raw(options); state.write(original); state.close();
  expect(() => openBlindAdmissionWalletV2({ path: join(options.directory, 'admission-wallet.json'), encryptionKey: options.encryptionKey,
    scope: profiles[0].scope, issuerPublicKey: keys[1].publicKey, mode: 'open-existing' })).toThrow();
  writeFileSync(join(options.directory, 'admission-wallet.json'), ''); await expect(open(options)).rejects.toThrow();
  rmSync(join(options.directory, 'admission-wallet.json')); await expect(open(options)).rejects.toThrow('missing');
  expect(existsSync(join(options.directory, 'admission-wallet.json'))).toBe(false);
});

it('invalidates review on legacy reservation changes, preserves normalized duplicate denials, and refuses overlapping imports', async () => {
  const options = fixture(), path = join(options.directory, 'low.json');
  let time = policy.keys[0].retryUntil;
  const wallet = openBlindAdmissionWalletV2({ path, encryptionKey: options.encryptionKey, scope: profiles[0].scope, issuerPublicKey: keys[0].publicKey, now: () => time });
  clean.push(() => wallet.close()); await wallet.importTokens(tokens[0].slice(0, 3));
  const plan = wallet.planRetirement(policy); wallet.capabilityFor(context());
  expect(() => wallet.retire(policy, plan.approvalDigest)).toThrow('review cleanup');
  // v1 stored literal URLs; the retired digest recognizes equivalent spellings.
  wallet.capabilityFor({ ...context(), relayUrl: relayUrl.slice(0, -1) });
  expect(wallet.planRetirement(policy)).toMatchObject({ reservationsRemoved: 2, denialMarkersRetained: 1 });
  const importing = wallet.importTokens([tokens[0][3]]);
  expect(() => wallet.planRetirement(policy)).toThrow('in progress'); await importing;
  const reviewed = wallet.planRetirement(policy); time = policy.keys[0].retryUntil - 1;
  expect(() => wallet.retire(policy, reviewed.approvalDigest)).toThrow('retry cutoff'); time++;
  wallet.retire(policy, reviewed.approvalDigest);
  expect(() => wallet.reservedCapabilityFor(context())).toThrow('replacement token');
  expect(() => wallet.reservedCapabilityFor({ ...context(), relayUrl: relayUrl.slice(0, -1) })).toThrow('replacement token');
});

it('checks retired denials even when an earlier wallet has a matching legacy reservation', async () => {
  const options = fixture(), wallet = await open(options);
  await wallet.configure(profiles[1]); await wallet.importTokens(tokens[1]); wallet.capabilityFor(context());
  await wallet.installPolicy(old, authority); await wallet.importTokens(tokens[0]); wallet.close();
  // A legacy/direct SDK user could reserve the same request under multiple profiles.
  const name = `admission-wallet-${ids[0].slice(7)}.json`, low = openBlindAdmissionWalletV2({ path: join(options.directory, name),
    encryptionKey: options.encryptionKey, scope: profiles[0].scope, issuerPublicKey: keys[0].publicKey, mode: 'open-existing' });
  low.capabilityFor(context()); low.close();
  const reopened = await open(options); await reopened.installPolicy(policy, authority); options.time = policy.keys[0].retryUntil;
  reopened.retire(ids[0], reopened.planRetirement(ids[0]).approvalDigest);
  expect(() => reopened.capabilityFor(context())).toThrow('replacement token');
  expect(reopened.status()).toMatchObject({ available: 3, reserved: 1 });
});

it('keeps retirement and retry denials after SIGKILL and stale-lock recovery', async () => {
  const options = fixture(), { wallet } = await prepared(options); wallet.close();
  writeFileSync(join(options.directory, 'fixture.json'), JSON.stringify({ key: options.encryptionKey.toString('hex'), issuerKey: ids[0], time: policy.keys[0].retryUntil }), { mode: 0o600 });
  const child = fork(new URL('./fixtures/admission-wallet-retirement-crash.ts', import.meta.url), [options.directory], { execArgv: ['--import','tsx'], stdio: ['ignore','ignore','inherit','ipc'] });
  const exited = once(child, 'exit');
  try {
    expect((await once(child, 'message'))[0]).toEqual({ retired: true }); child.kill('SIGKILL'); await exited;
    options.time = start; const reopened = await open(options);
    expect(reopened.status().archived[0].permanentlyRetired).toBe(true);
    expect(() => reopened.capabilityFor(context())).toThrow('replacement token'); expect(reopened.status().available).toBe(4);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
}, 15000);


it('rechecks the clock immediately before writing the retirement fence', async () => {
  const options = fixture(), path = join(options.directory, 'clock.json'); let time = policy.keys[0].retryUntil, roll = false;
  const low = openBlindAdmissionWalletV2({ path, encryptionKey: options.encryptionKey, scope: profiles[0].scope, issuerPublicKey: keys[0].publicKey,
    now: () => { const current = time; if (roll) time = start; return current; } });
  clean.push(() => low.close()); await low.importTokens(tokens[0]); low.capabilityFor(context());
  const plan = low.planRetirement(policy), before = readFileSync(path); roll = true;
  expect(() => low.retire(policy, plan.approvalDigest)).toThrow('retry cutoff');
  expect(readFileSync(path)).toEqual(before); expect(low.summary().permanentlyRetired).toBe(false);
});
