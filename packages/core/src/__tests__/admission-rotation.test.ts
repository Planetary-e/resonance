import { beforeAll, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateSigningKeyPair } from '../crypto.js';
import { admissionKeyFingerprint, signAdmissionPolicy, verifyAdmissionPolicy, assertAdmissionPolicySuccessor,
  type AdmissionPolicyBody, type AdmissionPolicyKey, type SignedAdmissionPolicy } from '../admission-policy.js';
import { prepareAdmissionRotation, checkAdmissionRotation, signAdmissionRotation, type AdmissionRotationRequest } from '../admission-rotation.js';

const authorityKey = generateSigningKeyPair(), authority = Buffer.from(authorityKey.publicKey).toString('base64url');
let time: number, entries: AdmissionPolicyKey[], previous: SignedAdmissionPolicy;
beforeAll(async () => {
  time = Date.now();
  const witnesses = Array.from({ length: 5 }, (_, i) => ({ publicKey: Buffer.from(generateSigningKeyPair().publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${44000 + i}/` }));
  const coordinator = Buffer.from(generateSigningKeyPair().publicKey).toString('base64url');
  entries = Array.from({ length: 8 }, (_, i) => ({
    profile: { version: 1, scope: { issuer: 'rotation-community', community: 'public', epoch: `period-${i}` },
      issuerPublicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      relayUrls: ['ws://127.0.0.1:44010/'] },
    notBefore: time - 1000, issueUntil: time + 3600000, spendUntil: time + 7200000, retryUntil: time + 10800000,
    witnesses: { version: 1, quorum: 4, members: witnesses, coordinators: [coordinator] },
  }));
  previous = await signAdmissionPolicy(body(1), authority, authorityKey.secretKey);
}, 30000);
function body(count: number): AdmissionPolicyBody {
  return { version: 1, kind: 'admission-policy', revision: 1, issuedAt: time - 1000, expiresAt: time + 14400000,
    activeKey: admissionKeyFingerprint(entries[0].profile.issuerPublicKey), keys: entries.slice(0, count) };
}
function request(index = 1): AdmissionRotationRequest {
  return structuredClone({ version: 1, kind: 'admission-rotation-request', issuedAt: time, expiresAt: time + 14400000,
    newKey: entries[index], retire: [{ issuerKey: previous.activeKey, issueUntil: time + 1000, spendUntil: time + 2000, retryUntil: time + 3000 }] });
}
const prepare = () => prepareAdmissionRotation(previous, request(), authority, () => time);

it('prepares a reviewed successor with unchanged pins, explicit earlier cutoffs and exact output capacity', async () => {
  const original = structuredClone(previous), input = request();
  const { plan, summary } = await prepareAdmissionRotation(previous, input, authority, () => time);
  expect(previous).toEqual(original);
  expect(plan.body.keys[0].witnesses).toEqual(previous.keys[0].witnesses);
  expect(plan.body.keys[0].profile).toEqual(previous.keys[0].profile);
  expect(plan.body.keys[0].spendUntil).toBe(time + 2000);
  expect(summary.retained[0].before.spendUntil).toBe(time + 7200000);
  expect(summary.historyCapacity).toMatchObject({ inspected: false, reset: false });
  expect(summary.policyCapacity.remainingKeySlots).toBe(6);
  const signed = await signAdmissionRotation(previous, plan, authority, authorityKey.secretKey, summary.approvalDigest, () => time);
  expect(await verifyAdmissionPolicy(signed.policy, authority)).toEqual(signed.policy);
  expect(() => assertAdmissionPolicySuccessor(previous, signed.policy)).not.toThrow();
  expect(Buffer.byteLength(JSON.stringify(signed.policy) + '\n')).toBe(summary.policyCapacity.signedFileBytes);
  expect(JSON.stringify(summary)).not.toContain(Buffer.from(authorityKey.secretKey).toString('base64url'));
});

it('rejects untrusted predecessors, a stale predecessor reference, and mutations while crypto is pending', async () => {
  const { plan } = await prepare();
  const stranger = Buffer.from(generateSigningKeyPair().publicKey).toString('base64url');
  await expect(prepareAdmissionRotation(previous, request(), stranger)).rejects.toThrow('pinned');
  await expect(prepareAdmissionRotation({ ...previous, revision: 9 }, request(), authority)).rejects.toThrow('signature');
  const otherPredecessor = await signAdmissionPolicy({ ...body(1), expiresAt: previous.expiresAt - 1 }, authority, authorityKey.secretKey);
  await expect(checkAdmissionRotation(otherPredecessor, plan, authority)).rejects.toThrow('predecessor');
  const snapshot = structuredClone(plan), pending = checkAdmissionRotation(previous, plan, authority, () => time);
  plan.body.keys[0].witnesses!.members[0].endpoint = 'ws://127.0.0.1:45000/';
  expect((await pending).plan).toEqual(snapshot);
});

it('rejects edits to retained membership, profiles, cutoffs, revision, and fresh-key rules', async () => {
  const { plan } = await prepare();
  const edits: Array<(value: typeof plan) => void> = [
    p => { p.body.keys[0].witnesses!.members[0].endpoint = 'ws://127.0.0.1:45000/'; },
    p => { p.body.keys[0].witnesses!.coordinators = [Buffer.from(generateSigningKeyPair().publicKey).toString('base64url')]; },
    p => { delete p.body.keys[0].witnesses; },
    p => { p.body.keys[0].profile.scope.epoch = 'rebound'; },
    p => { p.body.keys[0].retryUntil = previous.keys[0].retryUntil + 1; },
    p => { p.body.keys.shift(); },
    p => { p.body.revision++; },
    p => { p.body.activeKey = previous.activeKey; },
    p => { delete p.body.keys[1].witnesses; },
    p => { p.body.keys[1].profile.scope.epoch = previous.keys[0].profile.scope.epoch; },
    p => { p.body.keys[1].profile.scope.issuer = 'other-issuer'; },
    p => { p.body.keys.push(structuredClone(entries[2])); },
  ];
  for (const edit of edits) {
    const changed = structuredClone(plan); edit(changed);
    await expect(checkAdmissionRotation(previous, changed, authority, () => time)).rejects.toThrow();
  }
  const reuse = request(); reuse.newKey = structuredClone(entries[0]);
  await expect(prepareAdmissionRotation(previous, reuse, authority)).rejects.toThrow();
  await expect(checkAdmissionRotation(previous, { ...plan, refund: true }, authority)).rejects.toThrow();
  const duplicate = request(); duplicate.retire.push(duplicate.retire[0]);
  await expect(prepareAdmissionRotation(previous, duplicate, authority)).rejects.toThrow('duplicate');
});

it('binds approval to the normalized plan and rechecks dates after signing', async () => {
  const { plan, summary } = await prepare();
  await expect(signAdmissionRotation(previous, plan, authority, authorityKey.secretKey, 'unreviewed', () => time)).rejects.toThrow('Approval');
  await expect(signAdmissionRotation(previous, plan, authority, generateSigningKeyPair().secretKey, summary.approvalDigest, () => time)).rejects.toThrow('private key does not match');
  const edited = structuredClone(plan); edited.body.keys[0].spendUntil--;
  await expect(signAdmissionRotation(previous, edited, authority, authorityKey.secretKey, summary.approvalDigest, () => time)).rejects.toThrow('Approval');
  let calls = 0;
  await expect(signAdmissionRotation(previous, plan, authority, authorityKey.secretKey, summary.approvalDigest,
    () => ++calls === 1 ? time : plan.body.expiresAt)).rejects.toThrow('not current');
  const unavailable = request(); unavailable.newKey.notBefore = unavailable.expiresAt;
  unavailable.newKey.issueUntil = unavailable.expiresAt + 1000; unavailable.newKey.spendUntil = unavailable.expiresAt + 2000;
  unavailable.newKey.retryUntil = unavailable.expiresAt + 3000;
  await expect(prepareAdmissionRotation(previous, unavailable, authority, () => time)).rejects.toThrow('issuance window');
});

it('allows an expired signed predecessor to be refreshed without extending its key cutoffs', async () => {
  const expired = await signAdmissionPolicy({ ...body(1), expiresAt: time - 1 }, authority, authorityKey.secretKey);
  const { summary } = await prepareAdmissionRotation(expired, request(), authority, () => time);
  expect(summary.notices.some(notice => notice.includes('predecessor has expired'))).toBe(true);
  expect(summary.retained[0].before.effectiveRetryUntil).toBe(time - 1);
  expect(summary.retained[0].after.retryUntil).toBe(time + 3000);
});

it('reports the final retained-key slot and refuses another rotation instead of deleting history', async () => {
  const seven = await signAdmissionPolicy(body(7), authority, authorityKey.secretKey);
  const { plan, summary } = await prepareAdmissionRotation(seven, request(7), authority, () => time);
  expect(summary.policyCapacity).toMatchObject({ retainedKeys: 8, remainingKeySlots: 0 });
  expect(summary.notices.some(notice => notice.includes('No further'))).toBe(true);
  const eight = await signAdmissionPolicy(plan.body, authority, authorityKey.secretKey);
  await expect(prepareAdmissionRotation(eight, request(), authority, () => time)).rejects.toThrow('capacity exhausted');
});

it('runs prepare/check/approved-sign offline, never overwrites files, and produces an installable signed policy', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'resonance-rotation-command-'));
  const script = fileURLToPath(new URL('../../../../scripts/rotate-admission-policy.ts', import.meta.url));
  const pub = join(directory, 'authority.pub'), key = join(directory, 'private.json'), prev = join(directory, 'previous.json');
  const input = join(directory, 'request.json'), plan = join(directory, 'plan.json'), output = join(directory, 'signed.json');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8', timeout: 10000 });
  try {
    writeFileSync(pub, authority); writeFileSync(key, JSON.stringify({ publicKey: authority, secretKey: Buffer.from(authorityKey.secretKey).toString('base64url') }), { mode: 0o600 });
    writeFileSync(prev, JSON.stringify(previous)); writeFileSync(input, JSON.stringify(request()));
    const prepared = run('prepare', pub, prev, input, plan); expect(prepared.status, prepared.stderr).toBe(0);
    const digest = JSON.parse(prepared.stdout).approvalDigest;
    expect(JSON.parse(readFileSync(plan, 'utf8'))).not.toHaveProperty('signature');
    const checked = run('check', pub, prev, plan); expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout).approvalDigest).toBe(digest);
    expect(run('sign', pub, key, prev, plan, output).status).toBe(1);
    expect(existsSync(output)).toBe(false);
    const signed = run('sign', '--approve', digest, pub, key, prev, plan, output); expect(signed.status, signed.stderr).toBe(0);
    const verified = await verifyAdmissionPolicy(JSON.parse(readFileSync(output, 'utf8')), authority);
    expect(() => assertAdmissionPolicySuccessor(previous, verified)).not.toThrow();
    expect(statSync(output).size).toBe(JSON.parse(checked.stdout).policyCapacity.signedFileBytes);
    if (process.platform !== 'win32') expect(statSync(output).mode & 0o777).toBe(0o600);
    const saved = readFileSync(output), savedPlan = readFileSync(plan);
    expect(run('prepare', pub, prev, input, plan).status).toBe(1);
    expect(run('sign', '--approve', digest, pub, key, prev, plan, output).status).toBe(1);
    expect(readFileSync(output)).toEqual(saved); expect(readFileSync(plan)).toEqual(savedPlan);
    const changed = JSON.parse(savedPlan.toString()); changed.body.keys[0].spendUntil--;
    writeFileSync(plan, JSON.stringify(changed));
    const stale = run('sign', '--approve', digest, pub, key, prev, plan, join(directory, 'changed.json'));
    expect(stale.status).toBe(1); expect(stale.stderr).toContain('Approval digest');
    expect(existsSync(join(directory, 'changed.json'))).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it('bounds command inputs, refuses existing symlink outputs, and hides malformed private-key contents', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'resonance-rotation-refusals-'));
  const script = fileURLToPath(new URL('../../../../scripts/rotate-admission-policy.ts', import.meta.url));
  const pub = join(directory, 'authority.pub'), key = join(directory, 'private.json'), prev = join(directory, 'previous.json');
  const input = join(directory, 'request.json'), plan = join(directory, 'plan.json'), output = join(directory, 'signed.json');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8', timeout: 10000 });
  try {
    writeFileSync(pub, authority); writeFileSync(prev, JSON.stringify(previous));
    writeFileSync(input, ' '.repeat(65537));
    const oversized = run('prepare', pub, prev, input, plan);
    expect(oversized.status).toBe(1); expect(oversized.stderr).toContain('size limit'); expect(existsSync(plan)).toBe(false);
    const checked = await prepare(); writeFileSync(plan, JSON.stringify(checked.plan));
    writeFileSync(key, 'PRIVATE_KEY_CONTENT_MUST_NOT_APPEAR_IN_ERRORS');
    const malformed = run('sign', '--approve', checked.summary.approvalDigest, pub, key, prev, plan, output);
    expect(malformed.status).toBe(1); expect(malformed.stderr).toContain('not valid JSON');
    expect(malformed.stdout + malformed.stderr).not.toContain('PRIVATE_KEY_CONTENT'); expect(existsSync(output)).toBe(false);
    if (process.platform !== 'win32') {
      const target = join(directory, 'target'); writeFileSync(target, 'preserved'); symlinkSync(target, output);
      writeFileSync(key, JSON.stringify({ publicKey: authority, secretKey: Buffer.from(authorityKey.secretKey).toString('base64url') }));
      expect(run('sign', '--approve', checked.summary.approvalDigest, pub, key, prev, plan, output).status).toBe(1);
      expect(readFileSync(target, 'utf8')).toBe('preserved');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15000);
