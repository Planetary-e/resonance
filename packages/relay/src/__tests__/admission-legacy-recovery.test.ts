import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, fsyncSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2 } from '@resonance/core';
import { admissionKeyFingerprint, openAdmissionPolicyStore, signAdmissionPolicy, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { openAdmissionSpendHistory } from '../admission-spend-history.js';
import { createLocalBlindAdmissionVerifierV2 } from '../blind-admission-verifier.js';
import type { AdmissionLegacySpendProof } from '../admission-legacy-recovery.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
const clean: Array<() => void> = [];
afterEach(() => { vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); for (const close of clean.splice(0).reverse()) close(); });
let old: Awaited<ReturnType<typeof witnessFixture>>, fresh: Awaited<ReturnType<typeof witnessFixture>>;
let policy: SignedAdmissionPolicy, currentPolicy: SignedAdmissionPolicy, start: number, oldKey: string, freshKey: string;
beforeAll(async () => {
  old = await witnessFixture(); fresh = await witnessFixture(); fresh.scope.epoch = 'legacy-recovery-new-period'; start = old.time - 60000;
  const prior = { ...old.body.keys[0], notBefore: start - 1000, issueUntil: start + 10000, spendUntil: start + 20000, retryUntil: start + 30000 };
  const next = { ...fresh.body.keys[0], notBefore: start, issueUntil: start + 3600000, spendUntil: start + 7200000, retryUntil: start + 10800000 };
  oldKey = admissionKeyFingerprint(prior.profile.issuerPublicKey); freshKey = admissionKeyFingerprint(next.profile.issuerPublicKey);
  const common = { kind: 'admission-policy', expiresAt: start + 86400000, activeKey: freshKey };
  currentPolicy = await signAdmissionPolicy({ ...common, version: 1, revision: 1, issuedAt: start - 1000, keys: [prior, next] }, old.authority, old.authorityKey.secretKey);
  policy = await signAdmissionPolicy({ ...common, version: 2, revision: 2, issuedAt: start + 30000, keys: [next], archivedKeys: [prior] }, old.authority, old.authorityKey.secretKey);
}, 15000);
function directory() { const dir = mkdtempSync(join(tmpdir(), 'admission-legacy-recovery-')); clean.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const file = (dir: string) => join(dir, 'admission-spends-v2.jsonl');
function history(dir: string, key: Uint8Array, installed = policy, now = () => start + 30000, initialize = false, maxSpends = 10000) {
  const h = openAdmissionSpendHistory({ directory: dir, encryptionKey: key, policy: installed, now, initialize, maxSpends });
  clean.push(() => h.close()); return h;
}
async function proof(source = old, text = 'original') {
  const token = await source.token();
  const action = 'search' as const, requestBinding = createAdmissionRequestBindingV2(action, { text });
  const capability = presentBlindAdmissionTokenV2(token, source.scope, action, requestBinding);
  const spend = (await verifyBlindAdmissionTokenV2(capability, source.scope, action, requestBinding, source.keys.publicKey))!;
  const value: AdmissionLegacySpendProof = { version: 1, kind: 'admission-legacy-spend-proof', issuerKey: source === old ? oldKey : freshKey, capability, action, requestBinding };
  const row = { spend, action, binding: requestBinding, issuerKey: value.issuerKey };
  const legacy = JSON.stringify({ version: 1, spend, action, binding: requestBinding }) + '\n';
  return { value, row, legacy };
}
async function install(dir: string, key: Uint8Array) {
  const store = await openAdmissionPolicyStore({ path: join(dir, 'admission-community-policy.json'), encryptionKey: key, mode: 'create-new' });
  await store.install(policy, old.authority); store.close();
}

it('recovers proven legacy capacity and preserves other evidence and key denials after restart and clock rollback', async () => {
  const dir = directory(), key = randomBytes(32), a = await proof(), b = await proof(old, 'unproven'), c = await proof(fresh), d = await proof(old, 'attributed'), next = await proof(fresh, 'new');
  writeFileSync(file(dir), a.legacy + b.legacy);
  let h = history(dir, key, currentPolicy, () => start + 30000, false, 4); h.write(c.row); h.write(d.row);
  const before = readFileSync(file(dir)), plan = await h.planLegacyRecovery([a.value]);
  expect(plan).toMatchObject({ recordsBefore: 4, recordsRemoved: 2, recordsAfter: 2, provenLegacyRecords: 1, unattributedRecordsRetained: 1,
    keys: [{ issuerKey: oldKey, alreadyRetired: false, attributedRecordsRemoved: 1 }] });
  expect(readFileSync(file(dir))).toEqual(before);
  for (const secret of [a.value.capability.token, a.row.spend, a.row.binding]) expect(JSON.stringify(plan)).not.toContain(secret);
  await expect(h.recoverLegacy([a.value], 'wrong')).rejects.toThrow('approval');
  await h.recoverLegacy([a.value], plan.approvalDigest); h.close();
  h = history(dir, key, currentPolicy, () => start, false, 4);
  expect(h.size()).toBe(2); expect(h.get(a.row.spend)).toBeUndefined(); expect(h.get(d.row.spend)).toBeUndefined();
  expect(h.get(b.row.spend)?.issuerKey).toBeNull(); expect(h.get(c.row.spend)).toEqual(c.row); expect(h.isRetired(oldKey)).toBe(true);
  const verifyOld = createLocalBlindAdmissionVerifierV2({ directory: dir, scope: old.scope, issuerPublicKey: old.keys.publicKey, history: h });
  expect(await verifyOld.verifyAndSpend(a.value.capability, { action: a.value.action, requestBinding: a.value.requestBinding, now: start })).toEqual({ status: 'rejected', reason: 'key_retired' });
  verifyOld.close();
  h = history(dir, key, policy);
  const remaining = await h.planLegacyRecovery([b.value]); expect(remaining.keys[0].alreadyRetired).toBe(true);
  await h.recoverLegacy([b.value], remaining.approvalDigest);
  const verifyFresh = createLocalBlindAdmissionVerifierV2({ directory: dir, scope: fresh.scope, issuerPublicKey: fresh.keys.publicKey, history: h });
  expect(await verifyFresh.verifyAndSpend(c.value.capability, { action: c.value.action, requestBinding: c.value.requestBinding, now: start })).toEqual({ status: 'replay' });
  expect(await verifyFresh.verifyAndSpend(next.value.capability, { action: next.value.action, requestBinding: next.value.requestBinding, now: start })).toEqual({ status: 'accepted' });
  verifyFresh.close();
  const raw = openEncryptedLocalState<Record<string, unknown>>({ path: file(dir), key, domain: 'resonance:admission-local-spends:v2', maxBytes: 8388608, initial: {}, mode: 'open-existing', validate: (v): v is Record<string, unknown> => !!v });
  expect(raw.read().retiredIssuerKeys).toEqual([oldKey]); expect(JSON.stringify(raw.read())).not.toContain(a.value.capability.token); raw.close();
});

it('rejects forged, wrong-key, wrong-binding, absent, repeated, oversized and mixed-validity proofs without mutation', async () => {
  const dir = directory(), key = randomBytes(32), a = await proof(), b = await proof(old, 'missing'), different = await proof(fresh);
  writeFileSync(file(dir), a.legacy); const h = history(dir, key), before = readFileSync(file(dir));
  const changedBinding = createAdmissionRequestBindingV2('search', { changed: true });
  const changed = { ...a.value, requestBinding: changedBinding, capability: presentBlindAdmissionTokenV2(a.value.capability.token, old.scope, 'search', changedBinding) };
  const wrongKey = { ...a.value, capability: different.value.capability };
  const corrupt = structuredClone(a.value); corrupt.capability.token = 'A'.repeat(472);
  for (const input of [null, [], [a.value, a.value], [b.value], [changed], [wrongKey], [corrupt], [a.value, b.value],
    [{ ...a.value, extra: true }], [{ ...a.value, issuerKey: 'sha256:' + '0'.repeat(64) }],
    Array(33).fill(a.value), [{ ...a.value, capability: { ...a.value.capability, token: 'A'.repeat(65536) } }]]) {
    await expect(h.planLegacyRecovery(input)).rejects.toThrow(); expect(readFileSync(file(dir))).toEqual(before);
  }
  // Changing both token and hash is not evidence of the saved row; all matching is cryptographic.
  await expect(h.recoverLegacy([a.value], undefined as unknown as string)).rejects.toThrow('approval');
  expect(h.size()).toBe(1);
});

it('requires a current policy and an inactive key past its final cutoff, even when evidence is already fenced', async () => {
  const dir = directory(), key = randomBytes(32), a = await proof(), current = await proof(fresh); writeFileSync(file(dir), a.legacy + current.legacy);
  let time = start + 29999;
  const h = history(dir, key, currentPolicy, () => time);
  await expect(h.planLegacyRecovery([a.value])).rejects.toThrow('final retry cutoff');
  time++; await expect(h.planLegacyRecovery([current.value])).rejects.toThrow('active issuer');
  const plan = await h.planLegacyRecovery([a.value]); time = currentPolicy.expiresAt;
  await expect(h.recoverLegacy([a.value], plan.approvalDigest)).rejects.toThrow('not current');
  time = start + 30000; h.retire(oldKey, h.planRetirement(oldKey).approvalDigest); time--;
  await expect(h.planLegacyRecovery([a.value])).rejects.toThrow('final retry cutoff');
});

it('binds approval to the exact proof selection, local history, directory and signed policy', async () => {
  const dir = directory(), key = randomBytes(32), a = await proof(), b = await proof(old, 'other'), current = await proof(fresh);
  writeFileSync(file(dir), a.legacy + b.legacy); let h = history(dir, key);
  const plan = await h.planLegacyRecovery([a.value]);
  await expect(h.recoverLegacy([b.value], plan.approvalDigest)).rejects.toThrow('approval');
  h.write(current.row); await expect(h.recoverLegacy([a.value], plan.approvalDigest)).rejects.toThrow('approval');
  const updated = await h.planLegacyRecovery([a.value]); h.close();
  const copied = directory(); writeFileSync(file(copied), readFileSync(file(dir))); const other = history(copied, key);
  await expect(other.recoverLegacy([a.value], updated.approvalDigest)).rejects.toThrow('approval');
  const { authority: _, signature: __, ...body } = policy;
  const successor = await signAdmissionPolicy({ ...body, revision: 3 }, old.authority, old.authorityKey.secretKey);
  h = history(dir, key, successor); await expect(h.recoverLegacy([a.value], updated.approvalDigest)).rejects.toThrow('approval');
});

it('recovers a bounded batch under two expired issuer keys and retains every unproven row', async () => {
  const future = await witnessFixture(); future.scope.epoch = 'legacy-recovery-future-period';
  const nextKey = admissionKeyFingerprint(future.body.keys[0].profile.issuerPublicKey);
  const { authority: _, signature: __, ...body } = policy;
  const installed = await signAdmissionPolicy({ ...body, revision: 3, activeKey: nextKey, keys: [
    { ...policy.keys[0], issueUntil: start + 10000, spendUntil: start + 20000, retryUntil: start + 30000 },
    { ...future.body.keys[0], notBefore: start, issueUntil: start + 3600000, spendUntil: start + 7200000, retryUntil: start + 10800000 },
  ] }, old.authority, old.authorityKey.secretKey);
  const dir = directory(), key = randomBytes(32);
  const records = await Promise.all(Array.from({ length: 32 }, (_, i) => proof(i % 2 ? fresh : old, `row-${i}`)));
  const untouched = await proof(); writeFileSync(file(dir), [...records, untouched].map(p => p.legacy).join(''));
  const h = history(dir, key, installed), input = records.map(p => p.value), plan = await h.planLegacyRecovery(input);
  expect(plan).toMatchObject({ provenLegacyRecords: 32, recordsRemoved: 32, recordsAfter: 1, retirementFencesAfter: 2, unattributedRecordsRetained: 1 });
  expect(plan.keys).toHaveLength(2);
  expect((await h.planLegacyRecovery([...input].reverse())).approvalDigest).toBe(plan.approvalDigest);
  await h.recoverLegacy(input, plan.approvalDigest);
  expect(h.isRetired(oldKey)).toBe(true); expect(h.isRetired(freshKey)).toBe(true); expect(h.isRetired(nextKey)).toBe(false);
  expect(h.get(untouched.row.spend)?.issuerKey).toBeNull();
}, 30000); // Includes real Blind RSA issuance of 33 distinct tokens; this is not a latency benchmark.

it('snapshots proof inputs, excludes concurrent mutations and refuses a close during verification', async () => {
  const dir = directory(), key = randomBytes(32), a = await proof(), current = await proof(fresh); writeFileSync(file(dir), a.legacy);
  let h = history(dir, key); const input = [structuredClone(a.value)], pending = h.planLegacyRecovery(input);
  input[0].capability.token = 'mutated';
  expect(() => h.write(current.row)).toThrow('in progress');
  expect(() => h.retire(oldKey, 'approval')).toThrow('in progress');
  await expect(h.planLegacyRecovery([a.value])).rejects.toThrow('in progress');
  const plan = await pending; expect(plan.provenLegacyRecords).toBe(1);
  const saving = h.recoverLegacy([a.value], plan.approvalDigest); h.close();
  await expect(saving).rejects.toThrow('closed'); h = history(dir, key); expect(h.size()).toBe(1); expect(h.isRetired(oldKey)).toBe(true); // Policy archive is independent of local cleanup.
});

it('rechecks clock changes at the commit boundary without removing evidence', async () => {
  const dir = directory(), key = randomBytes(32), a = await proof(); writeFileSync(file(dir), a.legacy);
  let calls = 0, commitClock = false;
  const h = history(dir, key, currentPolicy, () => commitClock && ++calls === 4 ? start + 29999 : start + 30000);
  const plan = await h.planLegacyRecovery([a.value]), before = readFileSync(file(dir)); commitClock = true;
  await expect(h.recoverLegacy([a.value], plan.approvalDigest)).rejects.toThrow('final retry cutoff');
  expect(readFileSync(file(dir))).toEqual(before); expect(h.size()).toBe(1);
});

it.each([false, true])('recovers only complete evidence or a complete fence after a failed flush (encrypted=%s)', async encrypted => {
  for (const afterRename of process.platform === 'win32' ? [false] : [false, true]) {
    const dir = directory(), key = randomBytes(32), a = await proof(), current = await proof(fresh); writeFileSync(file(dir), a.legacy);
    let h = history(dir, key, currentPolicy); if (encrypted) h.write(current.row);
    const plan = await h.planLegacyRecovery([a.value]);
    if (afterRename) vi.mocked(fsyncSync).mockImplementationOnce(actualFsync);
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('recovery flush failed'); });
    await expect(h.recoverLegacy([a.value], plan.approvalDigest)).rejects.toThrow('recovery flush failed');
    expect(() => h.size()).toThrow('write failed'); h.close();
    vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync);
    h = history(dir, key, currentPolicy); expect(h.get(a.row.spend) !== undefined).toBe(!afterRename); expect(h.isRetired(oldKey)).toBe(afterRename);
    if (encrypted) expect(h.get(current.row.spend)).toEqual(current.row);
  }
});

it('runs actual offline review/recovery, redacts malformed proofs, and refuses missing, empty or corrupt histories', async () => {
  const dir = directory(), key = randomBytes(32), a = await proof(); await install(dir, key); writeFileSync(file(dir), a.legacy);
  const authority = join(dir, 'authority.pub'), storageKey = join(dir, 'storage.hex'), proofs = join(dir, 'proofs.json');
  writeFileSync(authority, old.authority); writeFileSync(storageKey, key.toString('hex'), { mode: 0o600 }); writeFileSync(proofs, JSON.stringify([a.value]), { mode: 0o600 });
  const script = fileURLToPath(new URL('../../../../scripts/recover-admission-spends.ts', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args, dir, authority, storageKey, proofs], { encoding: 'utf8', timeout: 10000 });
  const before = readFileSync(file(dir)), reviewed = run('plan'); expect(reviewed.status, reviewed.stderr).toBe(0);
  const plan = JSON.parse(reviewed.stdout); expect(plan).toMatchObject({ recordsRemoved: 1, result: 'review-required' }); expect(readFileSync(file(dir))).toEqual(before);
  for (const secret of [a.value.capability.token, a.row.spend, a.row.binding, key.toString('hex')]) expect(reviewed.stdout + reviewed.stderr).not.toContain(secret);
  expect(run('recover').status).toBe(1); expect(run('recover', '--approve', 'wrong').status).toBe(1);
  const applied = run('recover', '--approve', plan.approvalDigest); expect(applied.status, applied.stderr).toBe(0);
  const recovered = history(dir, key); expect(recovered.get(a.row.spend)).toBeUndefined(); recovered.close();
  writeFileSync(authority, fresh.authority); expect(run('plan').stderr).toContain('pinned'); writeFileSync(authority, old.authority);
  writeFileSync(proofs, 'SECRET_BEARER_MUST_NOT_APPEAR'); const malformed = run('plan'); expect(malformed.status).toBe(1);
  expect(malformed.stderr).toContain('not valid JSON'); expect(malformed.stdout + malformed.stderr).not.toContain('SECRET_BEARER');
  writeFileSync(proofs, ' '.repeat(65537)); expect(run('plan').stderr).toContain('size limit');
  writeFileSync(proofs, JSON.stringify([a.value]));
  for (const content of ['', '\n', a.legacy.slice(0, -1), 'corrupt']) {
    writeFileSync(file(dir), content); expect(run('plan').status).toBe(1); expect(readFileSync(file(dir), 'utf8')).toBe(content);
  }
  rmSync(file(dir)); expect(run('plan').status).toBe(1); expect(existsSync(file(dir))).toBe(false);
}, 30000);

it('retains a proven recovery across SIGKILL and stale-lock recovery', async () => {
  const dir = directory(), key = randomBytes(32), a = await proof(); writeFileSync(file(dir), a.legacy);
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ policy: currentPolicy, proofs: [a.value], time: start + 30000, encryptionKey: key.toString('base64url') }), { mode: 0o600 });
  const child = fork(new URL('./fixtures/admission-legacy-recovery-crash.ts', import.meta.url), [dir], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    expect((await once(child, 'message'))[0]).toEqual({ recovered: true }); child.kill('SIGKILL'); await exited;
    const h = history(dir, key, currentPolicy, () => start); expect(h.size()).toBe(0); expect(h.isRetired(oldKey)).toBe(true);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
}, 15000);
