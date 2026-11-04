import { beforeAll, expect, it, vi } from 'vitest';
import { generateKeyPairSync, hkdfSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSigningKeyPair } from '@resonance/core';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { admissionIssuanceAllocationDigest, signAdmissionIssuanceAllocation, type AdmissionIssuanceAllocationBody } from '@resonance/core/admission-issuance-allocation';
import { signAdmissionClaimAssignment, verifyAdmissionClaimAssignment, type SignedAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { admissionKeyFingerprint } from '../admission-wallet-profile.js';
import { MAX_ADMISSION_ALLOCATION_ASSIGNMENTS, openAdmissionAllocationAuthority } from '../admission-allocation-authority.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const key = generateSigningKeyPair(), authority = Buffer.from(key.publicKey).toString('base64url');
let template: AdmissionIssuanceAllocationBody;
beforeAll(() => {
  template = { version: 2, claimPolicy: 'authority-assigned-v1', kind: 'admission-issuance-allocation', community: 'public', epoch: 'assignment-one', notBefore: 100, issueUntil: 200,
    totalTokenBudget: 4, allocations: [0, 1].map(index => ({ batchSize: 1, maxPermits: 2, profile: { version: 1,
      scope: { issuer: `issuer-${index}`, community: 'public', epoch: 'assignment-one' },
      issuerPublicKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString(), relayUrls: ['ws://127.0.0.1:44010/'] } })) };
});
function plan(epoch = 'assignment-one') { const body = structuredClone(template); body.epoch = epoch; for (const entry of body.allocations) entry.profile.scope.epoch = epoch; return body; }
const handle = (n = 1) => { const bytes = Buffer.alloc(32); bytes.writeUInt32BE(n); return bytes.toString('base64url'); };
function request(issuer = 0, n = 1, epoch = 'assignment-one') { return { community: 'public' as const, epoch, claimHandle: handle(n), issuerKeyFingerprint: admissionKeyFingerprint(template.allocations[issuer].profile.issuerPublicKey) }; }
function setup() { const directory = mkdtempSync(join(tmpdir(), 'claim-authority-')); return { directory, options: { path: join(directory, 'journal.json'), authority, secretKey: key.secretKey, now: () => 150 } }; }
async function signPlan(journal: Awaited<ReturnType<typeof openAdmissionAllocationAuthority>>, value = plan()) { return journal.sign(value, (await journal.review(value)).approvalDigest); }
async function assign(journal: Awaited<ReturnType<typeof openAdmissionAllocationAuthority>>, value = request()) { return journal.assignClaim(value, (await journal.reviewAssignment(value)).approvalDigest); }
function raw(path: string) {
  const domain = 'resonance:admission-allocation-authority-journal:v1';
  const encryptionKey = Buffer.from(hkdfSync('sha256', key.secretKey, Buffer.from(authority, 'base64url'), Buffer.from(domain), 32));
  try { return openEncryptedLocalState<any>({ path, key: encryptionKey, domain, mode: 'open-existing', maxBytes: 8 * 1024 * 1024, initial: {}, validate: (value): value is any => !!value }); }
  finally { encryptionKey.fill(0); }
}
it('pins a reviewed allocation, caches 100 exact retries, and refuses reassignment across concurrency, restart and expiry', async () => {
  const { directory, options } = setup(); let journal = await openAdmissionAllocationAuthority({ ...options, mode: 'create-new' });
  try {
    await expect(journal.reviewAssignment(request())).rejects.toThrow('retained');
    const manifest = await signPlan(journal), reviewed = await journal.reviewAssignment(request());
    await expect(journal.assignClaim(request(), 'wrong')).rejects.toThrow('Approval');
    const input = request(), pending = journal.assignClaim(input, reviewed.approvalDigest); input.claimHandle = handle(9);
    const alternate = await journal.reviewAssignment(request(1));
    await expect(journal.assignClaim(request(1), alternate.approvalDigest)).rejects.toThrow('in progress');
    const original = await pending;
    for (let index = 0; index < 100; index++) expect(await assign(journal)).toEqual(original);
    await expect(assign(journal, request(1))).rejects.toThrow('different issuer');
    expect(await verifyAdmissionClaimAssignment(original, manifest, authority)).toEqual(original);
    const cached = journal.currentAssignment('public', 'assignment-one', handle())!; cached.claimHandle = handle(99);
    expect(journal.currentAssignment('public', 'assignment-one', handle())).toEqual(original);
    expect(readFileSync(options.path, 'utf8')).not.toContain(handle()); journal.close();
    journal = await openAdmissionAllocationAuthority({ ...options, mode: 'open-existing', now: () => 300 });
    expect(await assign(journal)).toEqual(original);
    await expect(assign(journal, request(1))).rejects.toThrow('different issuer');
    await expect(assign(journal, request(0, 2))).rejects.toThrow('not current');
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
it('reserves one permit per new claim, never refunds it, and checks time before signing and persisting', async () => {
  const { directory, options } = setup(); let journal = await openAdmissionAllocationAuthority({ ...options, mode: 'create-new' });
  try {
    await signPlan(journal); const first = await assign(journal); await assign(journal, request(0, 2));
    await expect(assign(journal, request(0, 3))).rejects.toThrow('capacity');
    expect(await assign(journal)).toEqual(first); await assign(journal, request(1, 3)); journal.close();
    journal = await openAdmissionAllocationAuthority({ ...options, mode: 'open-existing', now: () => 300 });
    expect(await assign(journal)).toEqual(first);
    await expect(assign(journal, request(0, 5))).rejects.toThrow('capacity'); journal.close();
    let reads = 0; journal = await openAdmissionAllocationAuthority({ ...options, mode: 'open-existing', now: () => ++reads === 1 ? 150 : 200 });
    await expect(assign(journal, request(1, 4))).rejects.toThrow('not current');
    expect(journal.currentAssignment('public', 'assignment-one', handle(4))).toBeUndefined(); journal.close();
    journal = await openAdmissionAllocationAuthority({ ...options, mode: 'open-existing', now: () => 99 });
    await expect(assign(journal, request(1, 4))).rejects.toThrow('not current');
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
it('preserves legacy manifest journals and prevents assignment against v1 or an unlisted issuer', async () => {
  const { directory, options } = setup(); let journal = await openAdmissionAllocationAuthority({ ...options, mode: 'create-new' });
  try {
    const { claimPolicy: _, ...value } = plan() as AdmissionIssuanceAllocationBody & { claimPolicy: string };
    const old = await signPlan(journal, { ...value, version: 1 }); journal.close();
    const before = raw(options.path); expect(before.read().version).toBe(1); before.close();
    journal = await openAdmissionAllocationAuthority({ ...options, mode: 'open-existing' });
    expect(journal.current('public', old.epoch)).toEqual(old);
    await expect(assign(journal)).rejects.toThrow('v2');
    const manifest = await signPlan(journal, plan('new-epoch'));
    await expect(journal.reviewAssignment({ ...request(0, 1, 'new-epoch'), issuerKeyFingerprint: `sha256:${'0'.repeat(64)}` })).rejects.toThrow('absent');
    await expect(journal.reviewAssignment({ ...request(), extra: true })).rejects.toThrow('Invalid');
    const signed = await assign(journal, request(0, 1, 'new-epoch'));
    const later = await signPlan(journal, plan('later-epoch'));
    expect(journal.currentAssignment('public', 'new-epoch', handle())).toEqual(signed); journal.close();
    const after = raw(options.path); const state = after.read(); after.close();
    expect(state.version).toBe(2); expect(state.manifests).toEqual([old, manifest, later]); expect(state.assignments).toEqual([signed]);
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
it('releases no assignment after failed persistence and safely refuses closed or overlapping manifest mutation', async () => {
  const { directory, options } = setup(); let journal = await openAdmissionAllocationAuthority({ ...options, mode: 'create-new' });
  try {
    await signPlan(journal); const reviewed = await journal.reviewAssignment(request());
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('injected assignment persistence failure'); });
    await expect(journal.assignClaim(request(), reviewed.approvalDigest)).rejects.toThrow('persistence failure');
    expect(() => journal.currentAssignment('public', 'assignment-one', handle())).toThrow('write failed'); journal.close();
    journal = await openAdmissionAllocationAuthority({ ...options, mode: 'open-existing' });
    expect(journal.currentAssignment('public', 'assignment-one', handle())).toBeUndefined();
    const pending = journal.assignClaim(request(), reviewed.approvalDigest);
    await expect(journal.sign(plan('overlap'), 'wrong')).rejects.toThrow('in progress'); await pending;
    const next = await journal.reviewAssignment(request(0, 2)), closing = journal.assignClaim(request(0, 2), next.approvalDigest);
    journal.close(); await expect(closing).rejects.toThrow('closed');
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
it('authenticates retained signatures, binding, uniqueness and reservations when reopening', async () => {
  const { directory, options } = setup(); const journal = await openAdmissionAllocationAuthority({ ...options, mode: 'create-new' });
  try {
    const manifest = await signPlan(journal), assignment = await assign(journal); journal.close();
    const backing = raw(options.path), original = structuredClone(backing.read()); backing.close();
    // Each corruption is encrypted with the correct local key; wire signatures and accounting must still reject it.
    const extra: SignedAdmissionClaimAssignment[] = [];
    for (const n of [2, 3]) { const { signature: _, ...body } = assignment; extra.push(await signAdmissionClaimAssignment({ ...body, claimHandle: handle(n) }, manifest, authority, key.secretKey)); }
    for (const change of [
      (state: any) => { state.assignments[0].signature = Buffer.alloc(64).toString('base64url'); },
      (state: any) => { state.assignments[0].allocationDigest = `sha256:${'0'.repeat(64)}`; },
      (state: any) => { state.assignments.push(state.assignments[0]); },
      (state: any) => { state.assignments.push(...extra); },
      (state: any) => { state.manifests = []; },
      (state: any) => { state.assignments[0].claimHandle += '='; },
    ]) {
      const store = raw(options.path), changed = structuredClone(original); change(changed); store.write(changed); store.close();
      await expect(openAdmissionAllocationAuthority({ ...options, mode: 'open-existing' })).rejects.toThrow();
    }
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
it('enforces the global 2048 retained assignment bound without pruning and preserves cached assignments at that bound', async () => {
  const { directory, options } = setup(); let journal = await openAdmissionAllocationAuthority({ ...options, mode: 'create-new' });
  try {
    journal.close(); const manifests = [], assignments = [];
    // Eight periods with 256 permanent reservations each exercise the global bound independently of issuer caps.
    for (let period = 0; period < 8; period++) {
      const value = plan(`period-${period}`); value.allocations = [value.allocations[0]]; value.allocations[0].maxPermits = 256; value.totalTokenBudget = 256;
      const manifest = await signAdmissionIssuanceAllocation(value, authority, key.secretKey); manifests.push(manifest);
      for (let n = 0; n < 256; n++) assignments.push(await signAdmissionClaimAssignment({ version: 1, kind: 'admission-claim-assignment', authority,
        allocationDigest: admissionIssuanceAllocationDigest(manifest), community: 'public', epoch: manifest.epoch, claimHandle: handle(n),
        issuerKeyFingerprint: admissionKeyFingerprint(manifest.allocations[0].profile.issuerPublicKey) }, manifest, authority, key.secretKey));
    }
    expect(assignments).toHaveLength(MAX_ADMISSION_ALLOCATION_ASSIGNMENTS);
    const next = await signAdmissionIssuanceAllocation(plan('extra'), authority, key.secretKey); manifests.push(next);
    const store = raw(options.path); store.write({ version: 2, authority, manifests, assignments }); store.close();
    journal = await openAdmissionAllocationAuthority({ ...options, mode: 'open-existing' });
    expect(await assign(journal, request(0, 0, 'period-0'))).toEqual(assignments[0]);
    await expect(assign(journal, request(0, 999, 'extra'))).rejects.toThrow('full');
    expect(journal.currentAssignment('public', 'period-0', handle(0))).toEqual(assignments[0]); journal.close();
    const corrupt = raw(options.path), state = corrupt.read(); state.assignments.push(assignments[0]); corrupt.write(state); corrupt.close();
    await expect(openAdmissionAllocationAuthority({ ...options, mode: 'open-existing' })).rejects.toThrow();
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);
it('CLI privately reviews and assigns with approval, recovers failed export, and reexports identical evidence without claim disclosure', async () => {
  const { directory, options } = setup(), script = fileURLToPath(new URL('../../../../scripts/admission-allocation.ts', import.meta.url));
  const pub = join(directory, 'authority.pub'), privatePath = join(directory, 'private.json'), planPath = join(directory, 'plan.json'), requestPath = join(directory, 'request.json');
  const output = join(directory, 'assignment.json'), reexport = join(directory, 'reexport.json');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8', timeout: 15000 });
  try {
    const value = plan(); value.notBefore = Date.now() - 1000; value.issueUntil = Date.now() + 60000;
    writeFileSync(pub, authority); writeFileSync(privatePath, JSON.stringify({ publicKey: authority, secretKey: Buffer.from(key.secretKey).toString('base64url') }));
    writeFileSync(planPath, JSON.stringify(value)); writeFileSync(requestPath, JSON.stringify(request()), { mode: 0o600 });
    const outputs = [];
    for (const result of [run('init', pub, privatePath, options.path), run('review', pub, planPath)]) { expect(result.status, result.stderr).toBe(0); outputs.push(result); }
    const planDigest = JSON.parse(outputs[1].stdout).approvalDigest;
    const signedManifest = join(directory, 'manifest.json'); expect(run('sign', '--approve', planDigest, pub, privatePath, options.path, planPath, signedManifest).status).toBe(0);
    const reviewed = run('assignment-review', pub, privatePath, options.path, requestPath); expect(reviewed.status, reviewed.stderr).toBe(0); outputs.push(reviewed);
    const digest = JSON.parse(reviewed.stdout).approvalDigest;
    const wrong = run('assign', '--approve', 'wrong', pub, privatePath, options.path, requestPath, output); expect(wrong.status).toBe(1); expect(existsSync(output)).toBe(false); outputs.push(wrong);
    const lost = run('assign', '--approve', digest, pub, privatePath, options.path, requestPath, join(directory, 'missing', 'lost.json')); expect(lost.status).toBe(1); outputs.push(lost);
    for (const result of [run('assign', '--approve', digest, pub, privatePath, options.path, requestPath, output), run('assignment-reexport', pub, privatePath, options.path, requestPath, reexport)]) { expect(result.status, result.stderr).toBe(0); outputs.push(result); }
    expect(readFileSync(output)).toEqual(readFileSync(reexport));
    expect(await verifyAdmissionClaimAssignment(JSON.parse(readFileSync(output, 'utf8')), JSON.parse(readFileSync(signedManifest, 'utf8')), authority)).toMatchObject(request());
    if (process.platform !== 'win32') expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(run('assignment-reexport', pub, privatePath, options.path, requestPath, output).status).toBe(1);
    writeFileSync(requestPath, JSON.stringify(request(1)));
    const different = run('assignment-reexport', pub, privatePath, options.path, requestPath, join(directory, 'other.json')); expect(different.status).toBe(1); outputs.push(different);
    if (process.platform !== 'win32') {
      const target = join(directory, 'target'), link = join(directory, 'link'); writeFileSync(target, 'preserved'); symlinkSync(target, link); writeFileSync(requestPath, JSON.stringify(request()));
      expect(run('assignment-reexport', pub, privatePath, options.path, requestPath, link).status).toBe(1); expect(readFileSync(target, 'utf8')).toBe('preserved');
      const publicRequest = join(directory, 'public-request.json'); writeFileSync(publicRequest, JSON.stringify(request()), { mode: 0o644 });
      expect(run('assignment-review', pub, privatePath, options.path, publicRequest).stderr).toContain('private file permissions');
    }
    writeFileSync(requestPath, ' '.repeat(4097)); expect(run('assignment-review', pub, privatePath, options.path, requestPath).stderr).toContain('size limit');
    for (const result of outputs) { expect(result.stdout + result.stderr).not.toContain(handle()); expect(result.stdout + result.stderr).not.toContain(Buffer.from(key.secretKey).toString('base64url')); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30000);
