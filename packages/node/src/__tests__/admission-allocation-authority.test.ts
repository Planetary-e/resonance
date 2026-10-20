import { beforeAll, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSigningKeyPair } from '@resonance/core';
import { verifyAdmissionIssuanceAllocation, type AdmissionIssuanceAllocationBody } from '@resonance/core/admission-issuance-allocation';
import { MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES, openAdmissionAllocationAuthority, reviewAdmissionAllocationPlan } from '../admission-allocation-authority.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const key = generateSigningKeyPair(), authority = Buffer.from(key.publicKey).toString('base64url');
let template: AdmissionIssuanceAllocationBody;
beforeAll(() => {
  template = { version: 1, kind: 'admission-issuance-allocation', community: 'public', epoch: 'period-one', notBefore: 100, issueUntil: 200,
    totalTokenBudget: 2, allocations: [{ batchSize: 1, maxPermits: 2, profile: { version: 1,
      scope: { issuer: 'issuer', community: 'public', epoch: 'period-one' },
      issuerPublicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(), relayUrls: ['ws://127.0.0.1:44010/'] } }] };
});
function plan(epoch = 'period-one') { const body = structuredClone(template); body.epoch = epoch; body.allocations[0].profile.scope.epoch = epoch; return body; }
function setup() { const directory = mkdtempSync(join(tmpdir(), 'allocation-authority-')); return { directory, options: { path: join(directory, 'journal.json'), authority, secretKey: key.secretKey, now: () => 150 } }; }
it('pins the authority before initialization, requires explicit create/open, and retains single-writer ownership', async () => {
  const { directory, options } = setup();
  try {
    await expect(openAdmissionAllocationAuthority({ ...options, mode: 'open-existing' })).rejects.toThrow('missing');
    await expect(openAdmissionAllocationAuthority({ ...options, secretKey: generateSigningKeyPair().secretKey, mode: 'create-new' })).rejects.toThrow('does not match');
    expect(existsSync(options.path)).toBe(false);
    const journal = await openAdmissionAllocationAuthority({ ...options, mode: 'create-new' });
    try { await expect(openAdmissionAllocationAuthority({ ...options, mode: 'open-existing' })).rejects.toThrow('already open'); }
    finally { journal.close(); }
    await expect(openAdmissionAllocationAuthority({ ...options, mode: 'create-new' })).rejects.toThrow('already exists');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it('durably caches one immutable signed manifest per period across restart, output loss, and expiry', async () => {
  const { directory, options } = setup();
  let journal = await openAdmissionAllocationAuthority({ ...options, mode: 'create-new' });
  try {
    const reviewed = await journal.review(plan());
    await expect(journal.sign(plan(), 'unreviewed')).rejects.toThrow('Approval');
    const signed = await journal.sign(plan(), reviewed.approvalDigest);
    expect(await verifyAdmissionIssuanceAllocation(signed, authority)).toEqual(signed);
    signed.allocations[0].maxPermits = 1;
    const retained = journal.current('public', 'period-one')!;
    expect(retained.allocations[0].maxPermits).toBe(2); journal.close();
    journal = await openAdmissionAllocationAuthority({ ...options, now: () => 300, mode: 'open-existing' });
    expect(await journal.sign(plan(), reviewed.approvalDigest)).toEqual(retained);
    const conflicting = plan(); conflicting.totalTokenBudget = 3;
    const conflictReview = await journal.review(conflicting);
    await expect(journal.sign(conflicting, conflictReview.approvalDigest)).rejects.toThrow('Conflicting');
    const fresh = plan('period-two'), freshReview = await journal.review(fresh);
    await expect(journal.sign(fresh, freshReview.approvalDigest)).rejects.toThrow('not current');
    expect(readFileSync(options.path, 'utf8')).not.toContain('issuerPublicKey');
    expect(readFileSync(options.path, 'utf8')).not.toContain(Buffer.from(key.secretKey).toString('base64url'));
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
it('rejects concurrent signing, snapshots caller input and secret, and closes safely during pending signing', async () => {
  const { directory, options } = setup(), secret = Uint8Array.from(key.secretKey);
  const journal = await openAdmissionAllocationAuthority({ ...options, secretKey: secret, mode: 'create-new' }); secret.fill(0);
  try {
    const input = plan(), reviewed = await journal.review(input), pending = journal.sign(input, reviewed.approvalDigest);
    input.totalTokenBudget = 100;
    await expect(journal.sign(plan('other'), 'unknown')).rejects.toThrow('in progress');
    expect((await pending).totalTokenBudget).toBe(2);
    const other = plan('other'), next = await journal.review(other), closing = journal.sign(other, next.approvalDigest);
    journal.close(); await expect(closing).rejects.toThrow('closed');
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
it('releases no signature on a failed journal commit and fails closed until reopening', async () => {
  const { directory, options } = setup();
  let journal = await openAdmissionAllocationAuthority({ ...options, mode: 'create-new' });
  try {
    const reviewed = await journal.review(plan());
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('injected journal commit failure'); });
    await expect(journal.sign(plan(), reviewed.approvalDigest)).rejects.toThrow('commit failure');
    expect(() => journal.current('public', 'period-one')).toThrow('write failed'); journal.close();
    journal = await openAdmissionAllocationAuthority({ ...options, mode: 'open-existing' });
    expect(journal.current('public', 'period-one')).toBeUndefined();
    expect((await journal.sign(plan(), reviewed.approvalDigest)).epoch).toBe('period-one');
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
it('rechecks the issuance window after asynchronous signing before making a durable allocation', async () => {
  const { directory, options } = setup(); let clockReads = 0;
  const journal = await openAdmissionAllocationAuthority({ ...options, now: () => ++clockReads === 1 ? 150 : 200, mode: 'create-new' });
  try {
    const reviewed = await journal.review(plan());
    await expect(journal.sign(plan(), reviewed.approvalDigest)).rejects.toThrow('not current');
    expect(journal.current('public', 'period-one')).toBeUndefined();
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
it('refuses corrupt journals and exhausts bounded history without pruning or refund', async () => {
  const { directory, options } = setup();
  const journal = await openAdmissionAllocationAuthority({ ...options, mode: 'create-new' });
  try {
    for (let index = 0; index < MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES; index++) {
      const value = plan(`period-${index}`), reviewed = await journal.review(value); await journal.sign(value, reviewed.approvalDigest);
    }
    const value = plan('extra'), reviewed = await journal.review(value);
    await expect(journal.sign(value, reviewed.approvalDigest)).rejects.toThrow('full');
    const old = plan('period-0'), oldReview = await journal.review(old);
    expect((await journal.sign(old, oldReview.approvalDigest)).epoch).toBe('period-0');
    expect(journal.current('public', 'period-0')).toBeDefined(); journal.close();
    writeFileSync(options.path, 'corrupt ciphertext');
    await expect(openAdmissionAllocationAuthority({ ...options, mode: 'open-existing' })).rejects.toThrow('invalid');
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);
it('CLI initializes, reviews, approves, recovers failed export, and reexports exact bytes with private permissions', async () => {
  const { directory, options } = setup();
  const script = fileURLToPath(new URL('../../../../scripts/admission-allocation.ts', import.meta.url));
  const pub = join(directory, 'authority.pub'), privatePath = join(directory, 'private.json'), planPath = join(directory, 'plan.json');
  const output = join(directory, 'signed.json'), reexport = join(directory, 'reexport.json');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8', timeout: 15000 });
  try {
    const value = plan(); value.notBefore = Date.now() - 1000; value.issueUntil = Date.now() + 60000;
    writeFileSync(pub, authority); writeFileSync(privatePath, JSON.stringify({ publicKey: authority, secretKey: Buffer.from(key.secretKey).toString('base64url') })); writeFileSync(planPath, JSON.stringify(value));
    const init = run('init', pub, privatePath, options.path); expect(init.status, init.stderr).toBe(0);
    expect(run('init', pub, privatePath, options.path).status).toBe(1);
    const review = run('review', pub, planPath); expect(review.status, review.stderr).toBe(0);
    const digest = JSON.parse(review.stdout).approvalDigest;
    const wrong = run('sign', '--approve', 'wrong', pub, privatePath, options.path, planPath, output); expect(wrong.status).toBe(1); expect(existsSync(output)).toBe(false);
    const lost = run('sign', '--approve', digest, pub, privatePath, options.path, planPath, join(directory, 'missing', 'lost.json')); expect(lost.status).toBe(1);
    const recover = run('sign', '--approve', digest, pub, privatePath, options.path, planPath, output); expect(recover.status, recover.stderr).toBe(0);
    const exported = run('reexport', pub, privatePath, options.path, value.epoch, reexport); expect(exported.status, exported.stderr).toBe(0);
    expect(readFileSync(output)).toEqual(readFileSync(reexport));
    expect(await verifyAdmissionIssuanceAllocation(JSON.parse(readFileSync(output, 'utf8')), authority)).toMatchObject(value);
    if (process.platform !== 'win32') expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(run('reexport', pub, privatePath, options.path, value.epoch, output).status).toBe(1);
    const secretText = Buffer.from(key.secretKey).toString('base64url');
    for (const result of [init, review, wrong, lost, recover, exported]) expect(result.stdout + result.stderr).not.toContain(secretText);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30000);
it('CLI bounds reads, suppresses malformed secret contents, requires retained journals, and refuses symlink exports', async () => {
  const { directory, options } = setup();
  const script = fileURLToPath(new URL('../../../../scripts/admission-allocation.ts', import.meta.url));
  const pub = join(directory, 'authority.pub'), privatePath = join(directory, 'private.json'), planPath = join(directory, 'plan.json'), output = join(directory, 'output.json');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8', timeout: 15000 });
  try {
    writeFileSync(pub, authority); writeFileSync(planPath, ' '.repeat(65537));
    expect(run('review', pub, planPath).stderr).toContain('size limit');
    writeFileSync(privatePath, 'PRIVATE_MATERIAL_MUST_NOT_APPEAR');
    const malformed = run('init', pub, privatePath, options.path); expect(malformed.status).toBe(1); expect(malformed.stderr).not.toContain('PRIVATE_MATERIAL');
    writeFileSync(privatePath, JSON.stringify({ publicKey: authority, secretKey: Buffer.from(key.secretKey).toString('base64url') }));
    const value = plan(); value.notBefore = Date.now() - 1000; value.issueUntil = Date.now() + 60000; writeFileSync(planPath, JSON.stringify(value));
    const reviewed = await reviewAdmissionAllocationPlan(value, authority);
    expect(run('sign', '--approve', reviewed.approvalDigest, pub, privatePath, options.path, planPath, output).stderr).toContain('missing');
    expect(existsSync(options.path)).toBe(false);
    expect(run('init', pub, privatePath, options.path).status).toBe(0);
    if (process.platform !== 'win32') {
      const target = join(directory, 'target'); writeFileSync(target, 'preserved'); symlinkSync(target, output);
      expect(run('sign', '--approve', reviewed.approvalDigest, pub, privatePath, options.path, planPath, output).status).toBe(1);
      expect(readFileSync(target, 'utf8')).toBe('preserved');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30000);
