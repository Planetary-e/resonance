import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { hkdfSync } from 'node:crypto';
import { existsSync, fsyncSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { createAdmissionRequestBindingV2, generateSigningKeyPair, presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2 } from '@resonance/core';
import { admissionKeyFingerprint, parseAdmissionWalletProfile, signAdmissionPolicy, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { openAdmissionIssuerLedger } from '../admission-issuer-ledger.js';
import { createAdmissionIssuanceBatch } from '../blind-admission-issuance.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
const clean: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); for (const close of clean.splice(0).reverse()) close(); });
type Profile = Awaited<ReturnType<typeof parseAdmissionWalletProfile>>['profile'];
let keys: CryptoKeyPair, freshKeys: CryptoKeyPair, profile: Profile, freshProfile: Profile, old: SignedAdmissionPolicy, policy: SignedAdmissionPolicy;
let start: number, authority: string, authorityKey: ReturnType<typeof generateSigningKeyPair>, privatePem: string, storageKey: Buffer;
const DOMAIN = 'resonance:admission-issuer-ledger:v1';
beforeAll(async () => {
  [keys, freshKeys] = await Promise.all([0, 1].map(() => publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS,
    { modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]) })));
  async function makeProfile(pair: CryptoKeyPair, epoch: string) {
    return (await parseAdmissionWalletProfile({ version: 1, scope: { issuer: 'retirement-issuer', community: 'public', epoch },
      issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----`,
      relayUrls: ['ws://127.0.0.1:45111/'] })).profile;
  }
  profile = await makeProfile(keys, 'old'); freshProfile = await makeProfile(freshKeys, 'fresh');
  authorityKey = generateSigningKeyPair(); authority = Buffer.from(authorityKey.publicKey).toString('base64url'); start = Date.now() - 60000;
  const entry = { profile, notBefore: start - 1000, issueUntil: start + 10000, spendUntil: start + 20000, retryUntil: start + 30000 };
  const body = { version: 1, kind: 'admission-policy', revision: 1, issuedAt: start - 1000, expiresAt: start + 86400000,
    activeKey: admissionKeyFingerprint(profile.issuerPublicKey), keys: [entry, { ...entry, profile: freshProfile,
      issueUntil: start + 3600000, spendUntil: start + 7200000, retryUntil: start + 10800000 }] };
  old = await signAdmissionPolicy(body, authority, authorityKey.secretKey);
  policy = await signAdmissionPolicy({ ...body, revision: 2, activeKey: admissionKeyFingerprint(freshProfile.issuerPublicKey) }, authority, authorityKey.secretKey);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  try {
    storageKey = Buffer.from(hkdfSync('sha256', der, Buffer.alloc(0), DOMAIN, 32));
    privatePem = `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----\n`;
  } finally { der.fill(0); }
}, 15000);
function directory() { const dir = mkdtempSync(join(tmpdir(), 'issuer-retirement-')); clean.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const file = (dir: string) => join(dir, 'issuer.json');
async function open(dir: string, now: () => number, create = false, maxPermits = 4) {
  const ledger = await openAdmissionIssuerLedger({ path: file(dir), expectedProfile: profile, privateKey: keys.privateKey, now,
    ...(create ? { create: { batchSize: 2, maxPermits } } : {}) }); clean.push(() => ledger.close()); return ledger;
}
function raw(dir: string) {
  return openEncryptedLocalState<Record<string, any>>({ path: file(dir), key: storageKey, domain: DOMAIN, maxBytes: 8 * 1024 * 1024,
    initial: {}, mode: 'open-existing', validate: (v): v is Record<string, any> => !!v });
}

it('seals unused, interrupted and completed permits without refund, preserves lifetime totals and prevents clock/policy reactivation', async () => {
  const dir = directory(); let time = start, ledger = await open(dir, () => time, true);
  await ledger.installPolicy(old, authority);
  const completed = ledger.grant(), interrupted = ledger.grant(), unused = ledger.grant();
  const batch = await createAdmissionIssuanceBatch(profile, 2), partial = await createAdmissionIssuanceBatch(profile, 2);
  const response = await ledger.approve(completed, batch.request), tokens = await batch.finalize(response);
  const binding = createAdmissionRequestBindingV2('search', { real: true });
  expect(await verifyBlindAdmissionTokenV2(presentBlindAdmissionTokenV2(tokens[0], profile.scope, 'search', binding), profile.scope, 'search', binding, keys.publicKey)).toBeTruthy();
  const sign = vi.spyOn(publicVerif.Issuer.prototype, 'issue').mockRejectedValueOnce(new Error('interrupted signature'));
  await expect(ledger.approve(interrupted, partial.request)).rejects.toThrow('interrupted signature'); sign.mockRestore();
  await ledger.installPolicy(policy, authority); time = policy.keys[0].spendUntil - 1;
  expect(await ledger.approve(completed, batch.request)).toEqual(response);
  expect(() => ledger.planRetirement(authority)).toThrow('retry cutoff'); time++;
  await expect(ledger.approve(completed, batch.request)).rejects.toThrow('retired');
  expect(() => ledger.planRetirement(authority)).toThrow('retry cutoff'); time = policy.keys[0].retryUntil;
  const before = readFileSync(file(dir)), plan = ledger.planRetirement(authority);
  expect(plan).toMatchObject({ recordsBefore: 3, recordsRemoved: 3, allocatedPermits: 3, boundPermits: 2, completedPermits: 1, unallocatedPermitsCancelled: 1 });
  expect(readFileSync(file(dir))).toEqual(before);
  expect(JSON.stringify(plan)).not.toContain(completed.secret); expect(JSON.stringify(plan)).not.toContain(batch.request.batchId);
  ledger.retire(authority, plan.approvalDigest);
  const expected = { permanentlyRetired: true, retainedEntries: 0, allocatedPermits: 3, allocatedTokens: 6,
    boundPermits: 2, boundTokens: 4, completedPermits: 1, remainingPermits: 0, unallocatedPermitsCancelled: 1 };
  expect(ledger.status()).toMatchObject(expected); ledger.close();
  const state = raw(dir); expect(state.read().version).toBe(2); expect(state.read().entries).toEqual([]);
  expect(JSON.stringify(state.read())).not.toContain(batch.request.batchId); expect(JSON.stringify(state.read())).not.toContain(response.responses[0]); state.close();
  expect(readFileSync(file(dir)).length).toBeLessThan(before.length);
  time = start; ledger = await open(dir, () => time);
  const signing = vi.spyOn(publicVerif.Issuer.prototype, 'issue');
  expect(() => ledger.grant()).toThrow('permanently retired');
  for (const [permit, request] of [[completed, batch.request], [interrupted, partial.request], [unused, batch.request]] as const) {
    await expect(ledger.approve(permit, request)).rejects.toThrow('permanently retired');
  }
  await expect(ledger.installPolicy(old, authority)).rejects.toThrow('permanently retired');
  const { signature: _signature, authority: _authority, ...body } = old;
  const reactivated = await signAdmissionPolicy({ ...body, revision: 3 }, authority, authorityKey.secretKey);
  await expect(ledger.installPolicy(reactivated, authority)).rejects.toThrow('permanently retired');
  expect(signing).not.toHaveBeenCalled(); expect(ledger.status()).toMatchObject(expected); ledger.close();
  time = policy.expiresAt; ledger = await open(dir, () => time); expect(ledger.status()).toMatchObject(expected); ledger.close();
  await expect(open(dir, () => start, true)).rejects.toThrow('already exists');
  // A different issuer has its own explicitly initialized allowance, with no transfer from the retired ledger.
  const fresh = await openAdmissionIssuerLedger({ path: join(dir, 'fresh.json'), expectedProfile: freshProfile, privateKey: freshKeys.privateKey,
    now: () => start + 60000, create: { batchSize: 1, maxPermits: 1 } }); clean.push(() => fresh.close());
  await fresh.installPolicy(policy, authority);
  const freshBatch = await createAdmissionIssuanceBatch(freshProfile, 1);
  expect(await freshBatch.finalize(await fresh.approve(fresh.grant(), freshBatch.request))).toHaveLength(1);
  expect(fresh.status().remainingPermits).toBe(0);
});

it('requires installed current policy, independent authority, non-active key and exact reviewed approval, including for empty ledgers', async () => {
  const dir = directory(); let time = policy.keys[0].retryUntil;
  const ledger = await open(dir, () => time, true);
  expect(() => ledger.planRetirement(authority)).toThrow('installed signed');
  await ledger.installPolicy(old, authority); expect(() => ledger.planRetirement(authority)).toThrow('active issuer');
  await ledger.installPolicy(policy, authority);
  expect(() => ledger.planRetirement(Buffer.alloc(32).toString('base64url'))).toThrow('authority');
  const plan = ledger.planRetirement(authority), before = readFileSync(file(dir));
  expect(plan).toMatchObject({ recordsRemoved: 0, unallocatedPermitsCancelled: 4 });
  expect(() => ledger.retire(authority, 'wrong')).toThrow('approval');
  time = policy.expiresAt; expect(() => ledger.retire(authority, plan.approvalDigest)).toThrow('not current');
  expect(readFileSync(file(dir))).toEqual(before); time = policy.keys[0].retryUntil;
  ledger.retire(authority, plan.approvalDigest);
  expect(ledger.status()).toMatchObject({ allocatedPermits: 0, remainingPermits: 0, unallocatedPermitsCancelled: 4, permanentlyRetired: true });
  expect(() => ledger.planRetirement(authority)).toThrow('permanently retired');
});

it('binds a review to the installed policy and ledger path, and refuses simultaneous writers', async () => {
  const dir = directory(), time = policy.keys[0].retryUntil;
  const ledger = await open(dir, () => time, true); await ledger.installPolicy(policy, authority);
  const plan = ledger.planRetirement(authority);
  await expect(open(dir, () => time)).rejects.toThrow('already open');
  const copy = directory(); writeFileSync(file(copy), readFileSync(file(dir)));
  const cloned = await open(copy, () => time);
  expect(() => cloned.retire(authority, plan.approvalDigest)).toThrow('changed');
  const { signature: _signature, authority: _authority, ...body } = policy;
  await ledger.installPolicy(await signAdmissionPolicy({ ...body, revision: 3 }, authority, authorityKey.secretKey), authority);
  expect(() => ledger.retire(authority, plan.approvalDigest)).toThrow('changed');
});

it('refuses retirement during signing or policy installation and preserves the interrupted batch until eligible retirement', async () => {
  const dir = directory(); let time = start;
  const ledger = await open(dir, () => time, true); await ledger.installPolicy(old, authority);
  const permit = ledger.grant(), batch = await createAdmissionIssuanceBatch(profile, 2);
  let entered!: () => void, release!: () => void;
  const called = new Promise<void>(resolve => { entered = resolve; }), resumed = new Promise<void>(resolve => { release = resolve; });
  const original = publicVerif.Issuer.prototype.issue;
  vi.spyOn(publicVerif.Issuer.prototype, 'issue').mockImplementation(async function (this: InstanceType<typeof publicVerif.Issuer>, ...args) {
    entered(); await resumed; return original.apply(this, args);
  });
  const pending = ledger.approve(permit, batch.request); await called; time = policy.keys[0].retryUntil;
  expect(() => ledger.planRetirement(authority)).toThrow('in progress');
  expect(() => ledger.retire(authority, 'unreviewed')).toThrow('in progress');
  await expect(ledger.installPolicy(policy, authority)).rejects.toThrow('in progress');
  const rejected = expect(pending).rejects.toThrow('retired'); release(); await rejected;
  const updating = ledger.installPolicy(policy, authority);
  expect(() => ledger.planRetirement(authority)).toThrow('in progress'); await updating;
  expect(ledger.status()).toMatchObject({ allocatedPermits: 1, boundPermits: 1, completedPermits: 0 });
  ledger.retire(authority, ledger.planRetirement(authority).approvalDigest);
  expect(ledger.status()).toMatchObject({ permanentlyRetired: true, boundPermits: 1, completedPermits: 0 });
});

it.each(process.platform === 'win32' ? [false] : [false, true])('recovers original response evidence or permanent retirement after a failed flush (after rename=%s)', async afterRename => {
  const dir = directory(); let time = start, ledger = await open(dir, () => time, true);
  const permit = ledger.grant(), batch = await createAdmissionIssuanceBatch(profile, 2), response = await ledger.approve(permit, batch.request);
  await ledger.installPolicy(policy, authority); time = policy.keys[0].retryUntil;
  const plan = ledger.planRetirement(authority);
  if (afterRename) vi.mocked(fsyncSync).mockImplementationOnce(actualFsync);
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('issuer retirement flush failed'); });
  expect(() => ledger.retire(authority, plan.approvalDigest)).toThrow('issuer retirement flush failed');
  expect(() => ledger.status()).toThrow('write failed'); expect(() => ledger.grant()).toThrow('write failed'); ledger.close();
  vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); time = start; ledger = await open(dir, () => time);
  expect(ledger.status()).toMatchObject({ permanentlyRetired: afterRename, allocatedPermits: 1, boundPermits: 1, completedPermits: 1 });
  if (afterRename) await expect(ledger.approve(permit, batch.request)).rejects.toThrow('permanently retired');
  else expect(await ledger.approve(permit, batch.request)).toEqual(response);
});

it('rechecks the clock before committing retirement', async () => {
  const dir = directory(); let next = policy.keys[0].retryUntil, roll = false;
  const ledger = await open(dir, () => { const time = next; if (roll) next = start; return time; }, true);
  await ledger.installPolicy(policy, authority); const plan = ledger.planRetirement(authority), before = readFileSync(file(dir));
  roll = true; expect(() => ledger.retire(authority, plan.approvalDigest)).toThrow('retry cutoff');
  expect(readFileSync(file(dir))).toEqual(before); expect(ledger.status().permanentlyRetired).toBe(false);
});

it('rejects malformed retirement counters, retained entries, missing/forged policy and invalid retirement times', async () => {
  const dir = directory(), ledger = await open(dir, () => policy.keys[0].retryUntil, true);
  await ledger.installPolicy(policy, authority); ledger.retire(authority, ledger.planRetirement(authority).approvalDigest); ledger.close();
  const store = raw(dir), original = store.read(); store.close();
  const changed = [
    { retirement: { ...original.retirement, allocatedPermits: 5 } }, { retirement: { ...original.retirement, boundPermits: -1 } },
    { retirement: { ...original.retirement, completedPermits: 1 } }, { retirement: { ...original.retirement, retiredAt: start } },
    { retirement: { ...original.retirement, retiredAt: policy.expiresAt } }, { retirement: null },
    { entries: [{ permitHash: '0'.repeat(64) }] }, { communityPolicy: null }, { communityPolicy: old },
    { communityPolicy: { ...policy, signature: Buffer.alloc(64).toString('base64url') } },
  ];
  for (const change of changed) {
    const rawState = raw(dir); rawState.write({ ...original, ...change }); rawState.close();
    await expect(open(dir, () => start)).rejects.toThrow();
  }
  writeFileSync(file(dir), ''); await expect(open(dir, () => start)).rejects.toThrow();
  rmSync(file(dir)); await expect(open(dir, () => start)).rejects.toThrow('missing'); expect(existsSync(file(dir))).toBe(false);
});

it('runs digest-approved offline issuer retirement against the installed policy without exposing per-permit details', async () => {
  const dir = directory(); let time = start;
  const ledger = await open(dir, () => time, true), permit = ledger.grant(), batch = await createAdmissionIssuanceBatch(profile, 2);
  const response = await ledger.approve(permit, batch.request); await ledger.installPolicy(policy, authority);
  time = policy.keys[0].retryUntil; ledger.close();
  const profilePath = join(dir, 'profile.json'), keyPath = join(dir, 'private.pem'), authorityPath = join(dir, 'authority.pub');
  writeFileSync(profilePath, JSON.stringify(profile)); writeFileSync(keyPath, privatePem, { mode: 0o600 }); writeFileSync(authorityPath, authority);
  const script = fileURLToPath(new URL('../../../../scripts/issue-admission-tokens.ts', import.meta.url));
  const args = [profilePath, keyPath, file(dir), authorityPath];
  const run = (...input: string[]) => spawnSync(process.execPath, ['--import','tsx',script,...input], { encoding: 'utf8', timeout: 15000 });
  const before = readFileSync(file(dir)), planned = run('plan-retirement', ...args); expect(planned.status, planned.stderr).toBe(0);
  const report = JSON.parse(planned.stdout); expect(report).toMatchObject({ recordsRemoved: 1, allocatedPermits: 1, boundPermits: 1, completedPermits: 1 });
  for (const secret of [permit.secret, batch.request.batchId, response.responses[0], privatePem]) expect(planned.stdout + planned.stderr).not.toContain(secret);
  expect(run('retire', ...args).status).toBe(1); expect(run('retire','--approve','sha256:' + '0'.repeat(64),...args).status).toBe(1);
  writeFileSync(authorityPath, Buffer.alloc(32).toString('base64url')); expect(run('plan-retirement',...args).status).toBe(1); writeFileSync(authorityPath, authority);
  expect(readFileSync(file(dir))).toEqual(before);
  const retired = run('retire','--approve',report.approvalDigest,...args); expect(retired.status, retired.stderr).toBe(0);
  const status = run('status', ...args.slice(0, 3)); expect(status.status, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ permanentlyRetired: true, remainingPermits: 0, allocatedPermits: 1, retainedEntries: 0 });
  expect(run('grant','--approve',...args.slice(0, 3),join(dir, 'forbidden-permit.json')).status).toBe(1);
  expect(existsSync(join(dir, 'forbidden-permit.json'))).toBe(false);
  rmSync(file(dir)); expect(run('plan-retirement', ...args).status).toBe(1); expect(existsSync(file(dir))).toBe(false);
}, 30000);

it('keeps the issuer sealed after SIGKILL and stale-lock recovery', async () => {
  const dir = directory(), ledger = await open(dir, () => start, true), permit = ledger.grant(), batch = await createAdmissionIssuanceBatch(profile, 2);
  await ledger.approve(permit, batch.request); await ledger.installPolicy(policy, authority); ledger.close();
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ profile, privateKey: Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64'),
    authority, time: policy.keys[0].retryUntil }), { mode: 0o600 });
  const child = fork(new URL('./fixtures/admission-issuer-retirement-crash.ts', import.meta.url), [dir], { execArgv: ['--import','tsx'], stdio: ['ignore','ignore','inherit','ipc'] });
  const exited = once(child, 'exit');
  try {
    expect((await once(child, 'message'))[0]).toEqual({ retired: true }); child.kill('SIGKILL'); await exited;
    const reopened = await open(dir, () => start);
    expect(reopened.status()).toMatchObject({ permanentlyRetired: true, retainedEntries: 0, allocatedPermits: 1, completedPermits: 1, remainingPermits: 0 });
    expect(() => reopened.grant()).toThrow('permanently retired'); await expect(reopened.approve(permit, batch.request)).rejects.toThrow('permanently retired');
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
}, 15000);
