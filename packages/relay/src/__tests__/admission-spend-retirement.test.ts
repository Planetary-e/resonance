import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, fsyncSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { createAdmissionRequestBindingV2, createBlindAdmissionRequestV2, issueBlindAdmissionRequestV2,
  presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2 } from '@resonance/core';
import { admissionKeyFingerprint, openAdmissionPolicyStore, signAdmissionPolicy, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { openAdmissionSpendHistory } from '../admission-spend-history.js';
import { createConfiguredAdmissionVerifier } from '../configured-admission-verifier.js';
import { createLocalBlindAdmissionVerifierV2 } from '../blind-admission-verifier.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
const clean: Array<() => void> = [];
afterEach(() => { vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); for (const close of clean.splice(0).reverse()) close(); });
let f: Awaited<ReturnType<typeof witnessFixture>>, fresh: Awaited<ReturnType<typeof witnessFixture>>;
let policy: SignedAdmissionPolicy, older: SignedAdmissionPolicy, start: number, oldKey: string, newKey: string;
beforeAll(async () => {
  f = await witnessFixture(); fresh = await witnessFixture(); fresh.scope.epoch = 'new-spend-period'; start = f.time - 60000;
  const { witnesses: _oldWitnesses, ...oldProfile } = f.body.keys[0];
  const old = { ...oldProfile, notBefore: start - 1000, issueUntil: start + 10000, spendUntil: start + 20000, retryUntil: start + 30000 };
  const next = { ...old, profile: { ...fresh.body.keys[0].profile, scope: fresh.scope },
    issueUntil: start + 3600000, spendUntil: start + 7200000, retryUntil: start + 10800000 };
  oldKey = admissionKeyFingerprint(old.profile.issuerPublicKey); newKey = admissionKeyFingerprint(next.profile.issuerPublicKey);
  const body = { ...f.body, issuedAt: start - 1000, expiresAt: start + 86400000, keys: [old, next] };
  older = await signAdmissionPolicy({ ...body, activeKey: oldKey }, f.authority, f.authorityKey.secretKey);
  policy = await signAdmissionPolicy({ ...body, revision: 2, activeKey: newKey }, f.authority, f.authorityKey.secretKey);
}, 15000);
function directory() { const dir = mkdtempSync(join(tmpdir(), 'admission-spends-')); clean.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const path = (dir: string) => join(dir, 'admission-spends-v2.jsonl');
function history(dir: string, key: Uint8Array, now: () => number, initialize = false, installed = policy, maxSpends = 2) {
  const h = openAdmissionSpendHistory({ directory: dir, encryptionKey: key, policy: installed, now, initialize, maxSpends });
  clean.push(() => h.close()); return h;
}
async function configured(dir: string, key: Uint8Array, now: () => number, initialize = false) {
  const v = await createConfiguredAdmissionVerifier({ directory: dir, encryptionKey: key, policy, authority: f.authority, now, initialize, maxSpends: 2 });
  clean.push(() => v.close()); return v;
}
async function request(source = f, text = 'original') {
  const issuer = new publicVerif.Issuer(publicVerif.BlindRSAMode.PSS, source.scope.issuer, source.keys.privateKey, source.keys.publicKey);
  const blinded = await createBlindAdmissionRequestV2(source.scope, source.keys.publicKey);
  const token = await blinded.finalize(await issueBlindAdmissionRequestV2(issuer, blinded.request));
  const context = { action: 'search' as const, requestBinding: createAdmissionRequestBindingV2('search', { text }), now: start };
  const cap = presentBlindAdmissionTokenV2(token, source.scope, context.action, context.requestBinding);
  const spend = (await verifyBlindAdmissionTokenV2(cap, source.scope, context.action, context.requestBinding, source.keys.publicKey))!;
  return { cap, context, token, row: { spend, action: context.action, binding: context.requestBinding,
    issuerKey: source === f ? oldKey : newKey }, source };
}
const legacy = (r: Awaited<ReturnType<typeof request>>) => JSON.stringify({ version: 1, spend: r.row.spend, action: r.row.action, binding: r.row.binding }) + '\n';
async function install(dir: string, key: Uint8Array) {
  const store = await openAdmissionPolicyStore({ path: join(dir, 'admission-community-policy.json'), encryptionKey: key, mode: 'create-new' });
  await store.install(policy, f.authority); store.close();
}
function raw(dir: string, key: Uint8Array) {
  return openEncryptedLocalState<Record<string, any>>({ path: path(dir), key, domain: 'resonance:admission-local-spends:v2',
    maxBytes: 8 * 1024 * 1024, initial: {}, mode: 'open-existing', validate: (v): v is Record<string, any> => !!v });
}

it('frees only retired-key capacity, preserves fresh retries, and blocks real old tokens after restart and clock rollback', async () => {
  const dir = directory(), key = randomBytes(32), old = await request(), current = await request(fresh), next = await request(fresh, 'next'); let time = start;
  let v = await configured(dir, key, () => time, true);
  expect(await v.verifyAndSpend(old.cap, old.context)).toEqual({ status: 'accepted' });
  expect(await v.verifyAndSpend(current.cap, current.context)).toEqual({ status: 'accepted' });
  expect(await v.verifyAndSpend(next.cap, next.context)).toEqual({ status: 'rejected', reason: 'capacity_exhausted' });
  time = policy.keys[0].spendUntil;
  expect(await v.verifyAndSpend(old.cap, old.context)).toEqual({ status: 'replay' }); v.close();
  const h = history(dir, key, () => time);
  expect(() => h.planRetirement(oldKey)).toThrow('retry cutoff'); time = policy.keys[0].retryUntil;
  expect(() => h.planRetirement(newKey)).toThrow('active issuer');
  const planned = h.planRetirement(oldKey), before = readFileSync(path(dir));
  expect(planned).toMatchObject({ recordsBefore: 2, recordsRemoved: 1, recordsAfter: 1, unattributedRecordsRetained: 0 });
  expect(() => h.retire(oldKey, 'wrong')).toThrow('approval');
  time = policy.expiresAt; expect(() => h.retire(oldKey, planned.approvalDigest)).toThrow('not current');
  expect(readFileSync(path(dir))).toEqual(before); time = policy.keys[0].retryUntil;
  h.retire(oldKey, planned.approvalDigest); h.close();
  const state = raw(dir, key); expect(state.read().retiredIssuerKeys).toEqual([oldKey]);
  expect(JSON.stringify(state.read())).not.toContain(old.row.spend); state.close();
  expect(readFileSync(path(dir), 'utf8')).not.toContain(current.row.spend);
  // The old manual reader must not fall back to an empty log after same-path migration.
  expect(() => createLocalBlindAdmissionVerifierV2({ directory: dir, scope: f.scope, issuerPublicKey: f.keys.publicKey })).toThrow();
  time = start; v = await configured(dir, key, () => time);
  expect(await v.verifyAndSpend(old.cap, old.context)).toEqual({ status: 'rejected', reason: 'key_retired' });
  const changed = { ...old.context, requestBinding: createAdmissionRequestBindingV2('search', { changed: true }) };
  expect(await v.verifyAndSpend(presentBlindAdmissionTokenV2(old.token, f.scope, 'search', changed.requestBinding), changed)).toEqual({ status: 'rejected', reason: 'key_retired' });
  expect(await v.verifyAndSpend(current.cap, current.context)).toEqual({ status: 'replay' });
  expect(await v.verifyAndSpend(next.cap, next.context)).toEqual({ status: 'accepted' }); v.close();
  const rollback = history(dir, key, () => start, false, older); expect(rollback.isRetired(oldKey)).toBe(true); rollback.close();
  rmSync(path(dir)); await expect(configured(dir, key, () => time)).rejects.toThrow('missing');
  expect(existsSync(path(dir))).toBe(false);
});

it('preserves unattributed legacy records and attributes only an authenticated exact retry before freeing its slot', async () => {
  const dir = directory(), key = randomBytes(32), old = await request(), untouched = await request(fresh); let time = start;
  const original = legacy(old) + legacy(untouched); writeFileSync(path(dir), original); await install(dir, key);
  const review = history(dir, key, () => policy.keys[0].retryUntil);
  expect(review.planRetirement(oldKey)).toMatchObject({ recordsRemoved: 0, unattributedRecordsRetained: 2 }); review.close();
  expect(readFileSync(path(dir), 'utf8')).toBe(original);
  let v = await configured(dir, key, () => time);
  const changed = { ...old.context, requestBinding: createAdmissionRequestBindingV2('search', { changed: true }) };
  expect(await v.verifyAndSpend(presentBlindAdmissionTokenV2(old.token, f.scope, 'search', changed.requestBinding), changed)).toEqual({ status: 'rejected', reason: 'double_spend' });
  expect(readFileSync(path(dir), 'utf8')).toBe(original);
  time = policy.keys[0].spendUntil;
  expect(await v.verifyAndSpend(old.cap, old.context)).toEqual({ status: 'replay' }); v.close();
  const h = history(dir, key, () => policy.keys[0].retryUntil);
  expect(h.get(old.row.spend)?.issuerKey).toBe(oldKey); expect(h.get(untouched.row.spend)?.issuerKey).toBeNull();
  const plan = h.planRetirement(oldKey);
  expect(plan).toMatchObject({ recordsRemoved: 1, recordsAfter: 1, unattributedRecordsRetained: 1 });
  h.retire(oldKey, plan.approvalDigest); h.close();
  time = start; v = await configured(dir, key, () => time);
  expect(await v.verifyAndSpend(untouched.cap, untouched.context)).toEqual({ status: 'replay' });
  expect(await v.verifyAndSpend(old.cap, old.context)).toEqual({ status: 'rejected', reason: 'key_retired' });
  const next = await request(fresh); expect(await v.verifyAndSpend(next.cap, next.context)).toEqual({ status: 'accepted' });
});

it('binds approval to history, policy and local directory, and refuses a concurrent writer', async () => {
  const dir = directory(), key = randomBytes(32), old = await request(), current = await request(fresh);
  let h = history(dir, key, () => policy.keys[0].retryUntil, true); h.write(old.row);
  const plan = h.planRetirement(oldKey);
  expect(() => history(dir, key, () => start)).toThrow('already open');
  h.write(current.row); expect(() => h.retire(oldKey, plan.approvalDigest)).toThrow('changed');
  const updated = h.planRetirement(oldKey); h.close();
  const copy = directory(); writeFileSync(path(copy), readFileSync(path(dir)));
  const other = history(copy, key, () => policy.keys[0].retryUntil);
  expect(() => other.retire(oldKey, updated.approvalDigest)).toThrow('changed');
  const { authority: _authority, signature: _signature, ...body } = policy;
  const successor = await signAdmissionPolicy({ ...body, revision: 3 }, f.authority, f.authorityKey.secretKey);
  h = history(dir, key, () => policy.keys[0].retryUntil, false, successor);
  expect(() => h.retire(oldKey, updated.approvalDigest)).toThrow('changed');
});

it.each([false, true])('rejects a pending real-token spend after retirement during the quorum hook (legacy=%s)', async fromLegacy => {
  const dir = directory(), key = randomBytes(32), old = await request(); let time = start;
  if (fromLegacy) writeFileSync(path(dir), legacy(old));
  const h = history(dir, key, () => time, !fromLegacy);
  let entered!: () => void, release!: () => void;
  const called = new Promise<void>(resolve => { entered = resolve; }), resumed = new Promise<void>(resolve => { release = resolve; });
  const v = createLocalBlindAdmissionVerifierV2({ directory: dir, scope: f.scope, issuerPublicKey: f.keys.publicKey, history: h,
    beforeSpend: async () => { entered(); await resumed; } }); clean.push(() => v.close());
  const pending = v.verifyAndSpend(old.cap, old.context); await called;
  time = policy.keys[0].retryUntil; h.retire(oldKey, h.planRetirement(oldKey).approvalDigest);
  const before = readFileSync(path(dir)); time = start; release();
  expect(await pending).toEqual({ status: 'rejected', reason: 'key_retired' });
  expect(readFileSync(path(dir))).toEqual(before);
  if (fromLegacy) expect(h.get(old.row.spend)?.issuerKey).toBeNull();
});

it.each([false, true])('recovers either original evidence or the complete retirement after flush failure (legacy=%s)', async fromLegacy => {
  for (const afterRename of process.platform === 'win32' ? [false] : [false, true]) {
    const dir = directory(), key = randomBytes(32), old = await request();
    if (fromLegacy) writeFileSync(path(dir), legacy(old));
    let h = history(dir, key, () => policy.keys[0].retryUntil, !fromLegacy);
    if (!fromLegacy) h.write(old.row);
    const plan = h.planRetirement(oldKey);
    if (afterRename) vi.mocked(fsyncSync).mockImplementationOnce(actualFsync);
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('spend flush failed'); });
    expect(() => h.retire(oldKey, plan.approvalDigest)).toThrow('spend flush failed');
    expect(() => h.get(old.row.spend)).toThrow('write failed'); h.close();
    vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync);
    h = history(dir, key, () => start);
    expect(h.isRetired(oldKey)).toBe(afterRename);
    expect(h.get(old.row.spend) !== undefined).toBe(!afterRename || fromLegacy);
    const v = createLocalBlindAdmissionVerifierV2({ directory: dir, scope: f.scope, issuerPublicKey: f.keys.publicKey, history: h }); clean.push(() => v.close());
    expect(await v.verifyAndSpend(old.cap, old.context)).toEqual(afterRename ? { status: 'rejected', reason: 'key_retired' } : { status: 'replay' });
  }
});

it('fails closed on malformed legacy records, invalid fences, wrong encryption keys and mismatched authorities', async () => {
  const old = await request(), key = randomBytes(32);
  for (const bytes of ['', '\n', 'incomplete', legacy(old) + legacy(old), legacy(old).replace('"version":1','"version":2'), '\n'.repeat(1025)]) {
    const dir = directory(); writeFileSync(path(dir), bytes);
    expect(() => history(dir, key, () => start)).toThrow(); expect(readFileSync(path(dir), 'utf8')).toBe(bytes);
  }
  const dir = directory(), h = history(dir, key, () => start, true); h.write(old.row); h.close();
  expect(() => history(dir, randomBytes(32), () => start)).toThrow();
  const original = raw(dir, key); const state = original.read(); original.close();
  for (const change of [ { retiredIssuerKeys: [oldKey] }, { retiredIssuerKeys: [newKey, newKey] },
    { retiredIssuerKeys: ['sha256:' + '0'.repeat(64)] }, { spends: [state.spends[0], state.spends[0]] }, { authority: fresh.authority } ]) {
    const store = raw(dir, key); store.write({ ...state, ...change }); store.close();
    expect(() => history(dir, key, () => start)).toThrow('state is invalid');
  }
  writeFileSync(path(dir), ''); expect(() => history(dir, key, () => start)).toThrow('Empty admission');
});

it('runs the real offline local-spends CLI without a participant private key and preserves unclassified legacy rows', async () => {
  const dir = directory(), key = randomBytes(32), old = await request(); await install(dir, key); writeFileSync(path(dir), legacy(old));
  const authority = join(dir, 'authority.pub'), storageKey = join(dir, 'storage.hex');
  writeFileSync(authority, f.authority); writeFileSync(storageKey, key.toString('hex'), { mode: 0o600 });
  const script = fileURLToPath(new URL('../../../../scripts/retire-admission-history.ts', import.meta.url));
  const args = ['local-spends', dir, authority, storageKey, oldKey];
  const run = (...input: string[]) => spawnSync(process.execPath, ['--import','tsx',script,...input], { encoding: 'utf8', timeout: 15000 });
  const before = readFileSync(path(dir));
  const planned = run('plan', ...args); expect(planned.status, planned.stderr).toBe(0);
  const plan = JSON.parse(planned.stdout); expect(plan).toMatchObject({ recordsRemoved: 0, unattributedRecordsRetained: 1 });
  expect(planned.stdout).not.toContain(old.row.spend); expect(planned.stdout).not.toContain(old.row.binding);
  expect(readFileSync(path(dir))).toEqual(before);
  expect(run('retire', ...args).status).toBe(1); expect(run('retire','--approve','wrong',...args).status).toBe(1);
  expect(readFileSync(path(dir))).toEqual(before);
  const applied = run('retire','--approve',plan.approvalDigest,...args); expect(applied.status, applied.stderr).toBe(0);
  const h = history(dir, key, () => start); expect(h.isRetired(oldKey)).toBe(true); expect(h.get(old.row.spend)?.issuerKey).toBeNull(); h.close();
  expect(run('plan',...args).status).toBe(1);
  rmSync(path(dir)); expect(run('plan',...args).status).toBe(1); expect(existsSync(path(dir))).toBe(false);
}, 30000);

it('retains local spend retirement after SIGKILL and stale-lock recovery', async () => {
  const dir = directory(), key = randomBytes(32), old = await request();
  const v = await configured(dir, key, () => start, true); await v.verifyAndSpend(old.cap, old.context); v.close();
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ policy, issuerKey: oldKey, time: policy.keys[0].retryUntil, encryptionKey: key.toString('base64url') }), { mode: 0o600 });
  const child = fork(new URL('./fixtures/admission-spend-retirement-crash.ts', import.meta.url), [dir], { execArgv: ['--import','tsx'], stdio: ['ignore','ignore','inherit','ipc'] });
  const exited = once(child, 'exit');
  try {
    expect((await once(child, 'message'))[0]).toEqual({ retired: true }); child.kill('SIGKILL'); await exited;
    const reopened = await configured(dir, key, () => start);
    expect(await reopened.verifyAndSpend(old.cap, old.context)).toEqual({ status: 'rejected', reason: 'key_retired' });
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
}, 15000);
