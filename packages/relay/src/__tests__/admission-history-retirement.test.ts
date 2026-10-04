import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, fsyncSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2 } from '@resonance/core';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { admissionKeyFingerprint, openAdmissionPolicyStore, signAdmissionPolicy, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionWitnessSetId, createAdmissionWitnessRequest, createAdmissionWitnessVote, type AdmissionSpendClaim } from '@resonance/core/admission-witness';
import { createAdmissionWitness, createAdmissionQuorumGate } from '../admission-witness.js';
import { createConfiguredAdmissionVerifier } from '../configured-admission-verifier.js';
import type { AdmissionHistoryRole } from '../admission-history-retirement.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
const clean: Array<() => void> = [];
afterEach(() => { vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); for (const close of clean.splice(0).reverse()) close(); });
let f: Awaited<ReturnType<typeof witnessFixture>>, policy: SignedAdmissionPolicy, older: SignedAdmissionPolicy, start: number, oldKey: string, newKey: string;
beforeAll(async () => {
  f = await witnessFixture(); start = f.time - 60000;
  const old = { ...f.body.keys[0], notBefore: start - 1000, issueUntil: start + 10000, spendUntil: start + 20000, retryUntil: start + 30000 };
  const fresh = { ...old, issueUntil: start + 3600000, spendUntil: start + 7200000, retryUntil: start + 10800000,
    profile: { ...old.profile, scope: { ...old.profile.scope, epoch: 'new-period' },
      issuerPublicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
  oldKey = admissionKeyFingerprint(old.profile.issuerPublicKey); newKey = admissionKeyFingerprint(fresh.profile.issuerPublicKey);
  const body = { ...f.body, issuedAt: start - 1000, expiresAt: start + 86400000, keys: [old, fresh] };
  older = await signAdmissionPolicy({ ...body, activeKey: oldKey }, f.authority, f.authorityKey.secretKey);
  policy = await signAdmissionPolicy({ ...body, revision: 2, activeKey: newKey }, f.authority, f.authorityKey.secretKey);
}, 15000);
function directory() { const dir = mkdtempSync(join(tmpdir(), 'admission-retirement-')); clean.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function claim(issuerKey = oldKey): AdmissionSpendClaim {
  return { issuerKey, setId: admissionWitnessSetId(policy.keys.find(e => admissionKeyFingerprint(e.profile.issuerPublicKey) === issuerKey)!.witnesses!),
    spend: randomBytes(32).toString('base64url'), action: 'search', requestBinding: createAdmissionRequestBindingV2('search', { text: 'retirement test' }) };
}
const filename = (role: AdmissionHistoryRole) => role === 'witness' ? 'admission-witness-votes.json' : 'admission-witness-certificates.json';
const domain = (role: AdmissionHistoryRole) => `resonance:admission-witness-${role === 'witness' ? 'votes' : 'certificates'}:v1`;
const participant = (role: AdmissionHistoryRole) => role === 'witness' ? f.witnesses[0] : f.coordinators[0];
function openRole(role: AdmissionHistoryRole, dir: string, encryptionKey: Uint8Array, now: () => number, initialize = false, installed = policy, maxSpends = 2) {
  const options = { directory: dir, encryptionKey, now, initialize, policy: installed, signingKey: participant(role), maxSpends };
  const witness = role === 'witness' ? createAdmissionWitness(options) : undefined;
  const gate = role === 'coordinator' ? createAdmissionQuorumGate({ ...options, transport: async (member, request) =>
    createAdmissionWitnessVote(request, f.witnesses.find(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey)!) }) : undefined;
  const history = witness ?? gate!; clean.push(() => history.close());
  return { history, async record(c: AdmissionSpendClaim) {
    if (witness) return witness.vote(createAdmissionWitnessRequest(c, f.coordinators[0]));
    return gate!.authorize(c.issuerKey, c.spend, c);
  } };
}
function rawState(role: AdmissionHistoryRole, dir: string, key: Uint8Array) {
  return openEncryptedLocalState<Record<string, any>>({ path: join(dir, filename(role)), key, domain: domain(role),
    maxBytes: 32 * 1024 * 1024, initial: {}, mode: 'open-existing', validate: (value): value is Record<string, any> => !!value });
}

it.each(['witness','coordinator'] as const)('retires only expired non-active %s history, frees capacity, and never reactivates on clock/policy rollback', async role => {
  const dir = directory(), key = randomBytes(32); let time = start;
  let h = openRole(role, dir, key, () => time, true);
  const old = claim(), fresh = claim(newKey); await h.record(old); await h.record(fresh);
  await expect(h.record(claim(newKey))).rejects.toThrow(/full|capacity/);
  expect(() => h.history.planRetirement(oldKey)).toThrow('retry cutoff');
  time = policy.keys[0].spendUntil;
  await h.record(old); // Partial votes and exact certificates stay recoverable during retry-only retirement.
  expect(() => h.history.planRetirement(oldKey)).toThrow('retry cutoff');
  time = policy.keys[0].retryUntil;
  expect(() => h.history.planRetirement(newKey)).toThrow('active issuer');
  const plan = h.history.planRetirement(oldKey), before = readFileSync(join(dir, filename(role)));
  expect(plan).toMatchObject({ recordsBefore: 2, recordsRemoved: 1, recordsAfter: 1 });
  expect(JSON.stringify(plan)).not.toContain(old.spend);
  expect(() => h.history.retire(oldKey, 'unreviewed')).toThrow('approval');
  expect(readFileSync(join(dir, filename(role)))).toEqual(before);
  time = policy.expiresAt;
  expect(() => h.history.retire(oldKey, plan.approvalDigest)).toThrow('not current');
  expect(readFileSync(join(dir, filename(role)))).toEqual(before);
  time = policy.keys[0].retryUntil;
  h.history.retire(oldKey, plan.approvalDigest);
  await expect(h.record(old)).rejects.toThrow('permanently retired');
  await h.record(fresh); await h.record(claim(newKey));
  h.history.close();
  const state = rawState(role, dir, key);
  expect(state.read().version).toBe(2); expect(state.read().retiredIssuerKeys).toEqual([oldKey]);
  expect(JSON.stringify(state.read())).not.toContain(old.spend); state.close();
  time = start; h = openRole(role, dir, key, () => time, false, older);
  await expect(h.record(old)).rejects.toThrow('permanently retired');
  await expect(h.record({ ...old, requestBinding: createAdmissionRequestBindingV2('search', { changed: true }) })).rejects.toThrow('permanently retired');
  await h.record(fresh);
});

it.each(['witness','coordinator'] as const)('preserves legacy %s records and binds approval to the complete current history', async role => {
  const dir = directory(), key = randomBytes(32), old = claim(); let time = start;
  const legacy = role === 'witness' ? { version: 1, witness: Buffer.from(f.witnesses[0].publicKey).toString('base64url'), votes: [createAdmissionWitnessVote(old, f.witnesses[0])] }
    : { version: 1, coordinator: Buffer.from(f.coordinators[0].publicKey).toString('base64url'), certificates: [{ version: 1, votes: f.witnesses.slice(0, 4).map(k => createAdmissionWitnessVote(old, k)) }] };
  const storage = openEncryptedLocalState({ path: join(dir, filename(role)), key, domain: domain(role), maxBytes: 32 * 1024 * 1024,
    initial: legacy, mode: 'create-new', validate: (v): v is typeof legacy => !!v }); storage.close();
  const original = readFileSync(join(dir, filename(role)));
  const h = openRole(role, dir, key, () => time); await h.record(old);
  expect(readFileSync(join(dir, filename(role)))).toEqual(original);
  time = policy.keys[0].retryUntil;
  const plan = h.history.planRetirement(oldKey); await h.record(claim(newKey));
  expect(() => h.history.retire(oldKey, plan.approvalDigest)).toThrow('changed');
  const refreshed = h.history.planRetirement(oldKey); h.history.retire(oldKey, refreshed.approvalDigest);
  h.history.close();
  const raw = rawState(role, dir, key), state = raw.read();
  raw.write({ ...state, retiredIssuerKeys: [oldKey, oldKey] }); raw.close();
  expect(() => openRole(role, dir, key, () => time)).toThrow('state is invalid');
  const corrupted = rawState(role, dir, key);
  corrupted.write({ ...state, retiredIssuerKeys: [newKey] }); corrupted.close();
  // The retained fresh record and a permanent fence for its key cannot coexist.
  expect(() => openRole(role, dir, key, () => time)).toThrow('state is invalid');
});

it('blocks even a real-token locally recorded retry after certificate retirement and clock rollback', async () => {
  const dir = directory(), encryptionKey = randomBytes(32); let time = start;
  const options = { directory: dir, encryptionKey, policy, authority: f.authority, coordinatorKey: f.coordinators[0], now: () => time,
    witnessTransport: async (member: { publicKey: string }, request: Parameters<typeof createAdmissionWitnessVote>[0]) =>
      createAdmissionWitnessVote(request, f.witnesses.find(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey)!) };
  let verifier = await createConfiguredAdmissionVerifier({ ...options, initialize: true }); clean.push(() => verifier.close());
  const c = claim(), token = await f.token(), capability = presentBlindAdmissionTokenV2(token, f.scope, c.action, c.requestBinding);
  expect(await verifier.verifyAndSpend(capability, { ...c, now: time })).toEqual({ status: 'accepted' }); verifier.close();
  const spentBefore = readFileSync(join(dir, 'admission-spends-v2.jsonl'));
  time = policy.keys[0].retryUntil;
  const h = openRole('coordinator', dir, encryptionKey, () => time);
  h.history.retire(oldKey, h.history.planRetirement(oldKey).approvalDigest); h.history.close();
  time = start; verifier = await createConfiguredAdmissionVerifier(options);
  await expect(verifier.verifyAndSpend(capability, { ...c, now: time })).rejects.toThrow('permanently retired');
  expect(readFileSync(join(dir, 'admission-spends-v2.jsonl'))).toEqual(spentBefore);
});

it.each(['witness','coordinator'] as const)('keeps the %s fence and removals atomic across failed file/directory flushes', async role => {
  for (const afterRename of process.platform === 'win32' ? [false] : [false, true]) {
    const dir = directory(), key = randomBytes(32), c = claim(); let time = start;
    let h = openRole(role, dir, key, () => time, true); await h.record(c);
    time = policy.keys[0].retryUntil;
    const plan = h.history.planRetirement(oldKey);
    if (afterRename) vi.mocked(fsyncSync).mockImplementationOnce(actualFsync);
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('retirement flush failed'); });
    expect(() => h.history.retire(oldKey, plan.approvalDigest)).toThrow('retirement flush failed');
    await expect(h.record(claim(newKey))).rejects.toThrow('write failed');
    h.history.close(); vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync);
    time = start; h = openRole(role, dir, key, () => time);
    if (afterRename) await expect(h.record(c)).rejects.toThrow('permanently retired');
    else {
      await h.record(c);
      await expect(h.record({ ...c, requestBinding: createAdmissionRequestBindingV2('search', { other: true }) })).rejects.toThrow('Conflicting');
    }
  }
});

it('refuses maintenance during quorum attempts and refuses a vote after reentrant owner maintenance', async () => {
  const dir = directory(), key = randomBytes(32); let time = start;
  const gate = createAdmissionQuorumGate({ directory: join(dir, 'c'), encryptionKey: key, policy, signingKey: f.coordinators[0], now: () => time,
    initialize: true, timeoutMs: 50, transport: () => new Promise(() => {}) }); clean.push(() => gate.close());
  const c = claim(), pending = gate.authorize(c.issuerKey, c.spend, c); const refusal = expect(pending).rejects.toThrow('Four');
  time = policy.keys[0].retryUntil;
  expect(() => gate.planRetirement(oldKey)).toThrow('in progress'); await refusal;
  gate.retire(oldKey, gate.planRetirement(oldKey).approvalDigest);
  const witness = createAdmissionWitness({ directory: join(dir, 'w'), encryptionKey: key, policy, signingKey: f.witnesses[0], now: () => time, initialize: true });
  clean.push(() => witness.close()); time = start;
  expect(() => witness.vote(createAdmissionWitnessRequest(c, f.coordinators[0]), () => {
    time = policy.keys[0].retryUntil; witness.retire(oldKey, witness.planRetirement(oldKey).approvalDigest); return true;
  })).toThrow('permanently retired');
});

it.each(['witness','coordinator'] as const)('runs the offline %s review/retire command against installed policy, with missing-state and stale-approval refusals', async role => {
  const dir = directory(), key = randomBytes(32), c = claim();
  const store = await openAdmissionPolicyStore({ path: join(dir, 'admission-community-policy.json'), encryptionKey: key, mode: 'create-new' });
  await store.install(policy, f.authority); store.close();
  const h = openRole(role, dir, key, () => start, true); await h.record(c); h.history.close();
  const pub = join(dir, 'authority.pub'), storageKey = join(dir, 'storage.hex'), privateFile = join(dir, 'private.json');
  writeFileSync(pub, f.authority); writeFileSync(storageKey, key.toString('hex'), { mode: 0o600 });
  const p = participant(role); writeFileSync(privateFile, JSON.stringify({ publicKey: Buffer.from(p.publicKey).toString('base64url'), secretKey: Buffer.from(p.secretKey).toString('base64url') }), { mode: 0o600 });
  const script = fileURLToPath(new URL('../../../../scripts/retire-admission-history.ts', import.meta.url));
  const args = [role, dir, pub, storageKey, privateFile, oldKey];
  const run = (...input: string[]) => spawnSync(process.execPath, ['--import','tsx',script,...input], { encoding: 'utf8', timeout: 15000 });
  const original = readFileSync(join(dir, filename(role)));
  const planned = run('plan', ...args); expect(planned.status, planned.stderr).toBe(0);
  expect(readFileSync(join(dir, filename(role)))).toEqual(original);
  expect(planned.stdout).not.toContain(c.spend); expect(planned.stdout).not.toContain(Buffer.from(p.secretKey).toString('base64url'));
  expect(run('retire', ...args).status).toBe(1);
  expect(run('retire','--approve','wrong',...args).status).toBe(1);
  expect(readFileSync(join(dir, filename(role)))).toEqual(original);
  const applied = run('retire','--approve',JSON.parse(planned.stdout).approvalDigest,...args);
  expect(applied.status, applied.stderr).toBe(0); expect(JSON.parse(applied.stdout).recordsRemoved).toBe(1);
  const reopened = openRole(role, dir, key, () => start, false, older); await expect(reopened.record(c)).rejects.toThrow('permanently retired'); reopened.history.close();
  rmSync(join(dir, filename(role)));
  expect(run('plan',...args).status).toBe(1); expect(existsSync(join(dir, filename(role)))).toBe(false);
}, 30000);

it('retains the permanent witness fence after SIGKILL and stale-lock recovery', async () => {
  const dir = directory(), key = randomBytes(32), c = claim();
  const input = { policy, claim: c, time: start, encryptionKey: key.toString('base64url'),
    publicKey: Buffer.from(f.witnesses[0].publicKey).toString('base64url'), secretKey: Buffer.from(f.witnesses[0].secretKey).toString('base64url'),
    request: createAdmissionWitnessRequest(c, f.coordinators[0]) };
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify(input), { mode: 0o600 });
  const child = fork(new URL('./fixtures/admission-retirement-crash.ts', import.meta.url), [dir], { execArgv: ['--import','tsx'], stdio: ['ignore','ignore','inherit','ipc'] });
  const exited = once(child, 'exit');
  try {
    expect((await once(child, 'message'))[0]).toEqual({ retired: true }); child.kill('SIGKILL'); await exited;
    const h = openRole('witness', dir, key, () => start, false, older);
    await expect(h.record(c)).rejects.toThrow('permanently retired'); await h.record(claim(newKey));
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
}, 15000);
