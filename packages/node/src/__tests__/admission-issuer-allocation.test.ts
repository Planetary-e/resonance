import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hkdfSync, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { publicVerif } from '@cloudflare/privacypass-ts';
import { generateSigningKeyPair, createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2 } from '@resonance/core';
import { admissionKeyFingerprint, signAdmissionPolicy, type AdmissionWalletProfileV1 } from '@resonance/core/admission-policy';
import { signAdmissionIssuanceAllocation, admissionIssuanceAllocationDigest, verifyAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { openAdmissionIssuerLedger } from '../admission-issuer-ledger.js';
import { createAdmissionIssuanceBatch } from '../blind-admission-issuance.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
let pairs: CryptoKeyPair[], profiles: AdmissionWalletProfileV1[], authorityKey: ReturnType<typeof generateSigningKeyPair>, authority: string;
beforeAll(async () => {
  authorityKey = generateSigningKeyPair(); authority = Buffer.from(authorityKey.publicKey).toString('base64url');
  pairs = await Promise.all([0, 1, 2].map(() => publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) })));
  profiles = await Promise.all(pairs.map(async (pair, i) => ({ version: 1 as const, scope: { issuer: `allocation-issuer-${i}`, community: 'public' as const, epoch: 'period-one' },
    issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----`, relayUrls: ['ws://127.0.0.1:45111/'] })));
});
const claim = () => randomBytes(32).toString('base64url');
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'issuer-allocation-')); let time = Date.now(); const start = time;
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const body = { version: 1 as const, kind: 'admission-issuance-allocation' as const, community: 'public' as const, epoch: 'period-one',
    notBefore: start, issueUntil: start + 10000, totalTokenBudget: 5,
    allocations: [{ profile: profiles[0], batchSize: 1, maxPermits: 3 }, { profile: profiles[1], batchSize: 2, maxPermits: 1 }] };
  const manifest = await signAdmissionIssuanceAllocation(body, authority, authorityKey.secretKey);
  const policyBody = { version: 1 as const, kind: 'admission-policy' as const, revision: 1, issuedAt: start - 1000, expiresAt: start + 100000,
    activeKey: admissionKeyFingerprint(profiles[0].issuerPublicKey), keys: profiles.map(profile => ({ profile, notBefore: start - 1000, issueUntil: start + 20000, spendUntil: start + 30000, retryUntil: start + 40000 })) };
  const policy = await signAdmissionPolicy(policyBody, authority, authorityKey.secretKey);
  const options = (i = 0) => ({ path: join(directory, `issuer-${i}.json`), privateKey: pairs[i].privateKey, expectedProfile: profiles[i], now: () => time });
  async function open(i = 0, create = true) { const ledger = await openAdmissionIssuerLedger({ ...options(i), ...(create ? { allocation: { manifest, authority } } : {}) }); cleanup.push(() => ledger.close()); return ledger; }
  async function raw(i = 0) {
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pairs[i].privateKey));
    const key = Buffer.from(hkdfSync('sha256', der, Buffer.alloc(0), 'resonance:admission-issuer-ledger:v1', 32)); der.fill(0);
    try { return openEncryptedLocalState<Record<string, any>>({ path: options(i).path, key, domain: 'resonance:admission-issuer-ledger:v1', maxBytes: 8 * 1024 * 1024,
      mode: 'open-existing', initial: {}, validate: (value): value is Record<string, any> => !!value }); } finally { key.fill(0); }
  }
  return { directory, start, body, manifest, policy, policyBody, options, open, raw, clock(value: number) { time = value; } };
}
it('derives distinct issuer caps from one authenticated allocation, requires policy and never permits quota overrides', async () => {
  const n = await fixture(), first = await n.open(), second = await n.open(1);
  expect(first.status()).toMatchObject({ batchSize: 1, maxPermits: 3 }); expect(second.status()).toMatchObject({ batchSize: 2, maxPermits: 1 });
  expect(() => first.grant()).toThrow('claim required'); expect(() => first.grantForClaim(claim())).toThrow('installed signed');
  await expect(first.installPolicy(n.policy, Buffer.alloc(32).toString('base64url'))).rejects.toThrow('authority');
  await first.installPolicy(n.policy, authority);
  const handle = claim(), permit = first.grantForClaim(handle);
  for (let i = 0; i < 100; i++) expect(first.grantForClaim(handle)).toEqual(permit);
  first.grantForClaim(claim()); first.grantForClaim(claim()); expect(() => first.grantForClaim(claim())).toThrow('exhausted');
  const otherPolicy = await signAdmissionPolicy({ ...n.policyBody, revision: 2, activeKey: admissionKeyFingerprint(profiles[1].issuerPublicKey) }, authority, authorityKey.secretKey);
  await first.installPolicy(otherPolicy, authority); await second.installPolicy(otherPolicy, authority);
  expect(() => first.grantForClaim(claim())).toThrow('retired or inactive');
  second.grantForClaim(claim()); expect(() => second.grantForClaim(claim())).toThrow('exhausted');
  expect(first.status().tokenBudget + second.status().tokenBudget).toBe(5);
  await expect(n.open(2)).rejects.toThrow();
  await expect(openAdmissionIssuerLedger({ ...n.options(), allocation: { manifest: n.manifest, authority }, create: { batchSize: 32, maxPermits: 256 } })).rejects.toThrow('overrides');
  first.close(); const reopened = await n.open(0, false); expect(reopened.grantForClaim(handle)).toEqual(permit); expect(() => reopened.grant()).toThrow('claim required');
});
it('rejects wrong authority, changed signed payload/profile and retained allocation corruption or cap changes', async () => {
  const n = await fixture();
  await expect(openAdmissionIssuerLedger({ ...n.options(), allocation: { manifest: n.manifest, authority: Buffer.alloc(32).toString('base64url') } })).rejects.toThrow();
  await expect(openAdmissionIssuerLedger({ ...n.options(), allocation: { manifest: { ...n.manifest, totalTokenBudget: 6 }, authority } })).rejects.toThrow();
  const ledger = await n.open(); ledger.close();
  await expect(openAdmissionIssuerLedger({ ...n.options(), expectedAllocationAuthority: Buffer.alloc(32).toString('base64url') })).rejects.toThrow('pin');
  await expect(openAdmissionIssuerLedger({ ...n.options(), expectedProfile: { ...profiles[0], relayUrls: ['ws://127.0.0.1:45112/'] } })).rejects.toThrow('invalid');
  const raw = await n.raw(), saved = raw.read(); expect(saved.version).toBe(6); expect(saved.allocation.digest).toBe(admissionIssuanceAllocationDigest(n.manifest));
  raw.write({ ...saved, policy: { ...saved.policy, maxPermits: 4 } }); raw.close(); await expect(n.open(0, false)).rejects.toThrow('derived quota');
  const restore = await n.raw(); restore.write({ ...saved, allocation: { ...saved.allocation, manifest: { ...saved.allocation.manifest, totalTokenBudget: 6 } } }); restore.close();
  await expect(n.open(0, false)).rejects.toThrow();
});
it('blocks first signatures at allocation expiry while retaining completed exact recovery', async () => {
  const n = await fixture(), ledger = await n.open(); await ledger.installPolicy(n.policy, authority);
  const doneClaim = claim(), pendingClaim = claim();
  const done = ledger.grantForClaim(doneClaim), pending = ledger.grantForClaim(pendingClaim);
  const batch = await createAdmissionIssuanceBatch(profiles[0], 1), second = await createAdmissionIssuanceBatch(profiles[0], 1);
  const response = await ledger.approve(done, batch.request);
  const signing = vi.spyOn(publicVerif.Issuer.prototype, 'issue').mockRejectedValueOnce(new Error('interrupted before signature'));
  await expect(ledger.approve(pending, second.request)).rejects.toThrow('interrupted'); signing.mockRestore();
  n.clock(n.body.issueUntil); expect(ledger.grantForClaim(doneClaim)).toEqual(done); expect(() => ledger.grantForClaim(claim())).toThrow();
  const after = vi.spyOn(publicVerif.Issuer.prototype, 'issue');
  await expect(ledger.approve(pending, second.request)).rejects.toThrow(); expect(after).not.toHaveBeenCalled();
  expect(await ledger.approve(done, batch.request)).toEqual(response);
  const wire = JSON.stringify({ done, request: batch.request, response }); expect(wire).not.toContain(doneClaim); expect(wire).not.toContain('\"allocation\"'); expect(wire).not.toContain(admissionIssuanceAllocationDigest(n.manifest));
  ledger.close(); const reopened = await n.open(0, false); expect(reopened.grantForClaim(doneClaim)).toEqual(done); expect(await reopened.approve(done, batch.request)).toEqual(response);
  n.clock(n.policyBody.keys[0].spendUntil); await expect(reopened.approve(done, batch.request)).rejects.toThrow('retired');
});


it('snapshots the independent authority and signed allocation before asynchronous open', async () => {
  const n = await fixture(), input = { manifest: structuredClone(n.manifest), authority };
  const options = { ...n.options(), allocation: input };
  const pending = openAdmissionIssuerLedger(options);
  input.authority = Buffer.alloc(32).toString('base64url'); input.manifest.totalTokenBudget = 6;
  const ledger = await pending; cleanup.push(() => ledger.close());
  await ledger.installPolicy(n.policy, authority); ledger.grantForClaim(claim()); ledger.close();
  const reopened = await openAdmissionIssuerLedger({ ...n.options(), expectedAllocationAuthority: authority }); cleanup.push(() => reopened.close());
  expect(reopened.status()).toMatchObject({ batchSize: 1, maxPermits: 3, allocatedPermits: 1 });
});


it('preserves allocation and claim bindings through failed persistence and never refunds or returns failed output', async () => {
  const n = await fixture(), handle = claim(); let ledger = await n.open(); await ledger.installPolicy(n.policy, authority);
  vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('allocation grant disk failure'); });
  expect(() => ledger.grantForClaim(handle)).toThrow('allocation grant disk failure'); ledger.close();
  ledger = await n.open(0, false); expect(ledger.status().allocatedPermits).toBe(0);
  const permit = ledger.grantForClaim(handle), batch = await createAdmissionIssuanceBatch(profiles[0], 1);
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementationOnce(actual.renameSync).mockImplementationOnce(() => { throw new Error('allocation response disk failure'); });
  await expect(ledger.approve(permit, batch.request)).rejects.toThrow('allocation response disk failure'); ledger.close();
  ledger = await n.open(0, false); expect(ledger.status()).toMatchObject({ allocatedPermits: 1, boundPermits: 1, completedPermits: 0 });
  expect(ledger.grantForClaim(handle)).toEqual(permit);
  const different = await createAdmissionIssuanceBatch(profiles[0], 1); await expect(ledger.approve(permit, different.request)).rejects.toThrow('already bound');
  const response = await ledger.approve(permit, batch.request); expect(await batch.finalize(response)).toHaveLength(1);
});
it('enforces the not-before window and retains allocation accounting after permanent retirement and restart', async () => {
  const n = await fixture(), ledger = await n.open(), handle = claim(); await ledger.installPolicy(n.policy, authority);
  n.clock(n.body.notBefore - 1); expect(() => ledger.grantForClaim(handle)).toThrow(); n.clock(n.body.notBefore); ledger.grantForClaim(handle);
  const successor = await signAdmissionPolicy({ ...n.policyBody, revision: 2, activeKey: admissionKeyFingerprint(profiles[1].issuerPublicKey) }, authority, authorityKey.secretKey);
  await ledger.installPolicy(successor, authority); n.clock(n.policyBody.keys[0].retryUntil);
  const plan = ledger.planRetirement(authority); ledger.retire(authority, plan.approvalDigest); ledger.close();
  const state = await n.raw(); expect(state.read().version).toBe(7); expect(state.read().allocation.digest).toBe(admissionIssuanceAllocationDigest(n.manifest)); state.close();
  n.clock(n.start); const reopened = await n.open(0, false);
  expect(reopened.status()).toMatchObject({ permanentlyRetired: true, allocatedPermits: 1, remainingPermits: 0, unallocatedPermitsCancelled: 2 });
  expect(() => reopened.grant()).toThrow('permanently retired'); expect(() => reopened.grantForClaim(handle)).toThrow('permanently retired');
});
it('runs signed allocation, issuer initialization, policy, claim grant and exact blind-response recovery through the real CLIs', async () => {
  const n = await fixture(), root = fileURLToPath(new URL('../../../../', import.meta.url));
  const issuerScript = join(root, 'scripts/issue-admission-tokens.ts'), authorityScript = join(root, 'scripts/admission-allocation.ts');
  const pub = join(n.directory, 'authority.pub'), authorityPrivate = join(n.directory, 'authority.json'), journal = join(n.directory, 'authority-journal.json'), plan = join(n.directory, 'plan.json'), signed = join(n.directory, 'signed.json');
  writeFileSync(pub, authority); writeFileSync(authorityPrivate, JSON.stringify({ publicKey: authority, secretKey: Buffer.from(authorityKey.secretKey).toString('base64url') }), { mode: 0o600 });
  writeFileSync(plan, JSON.stringify({ ...n.body, issueUntil: n.start + 600000 }));
  const run = (script: string, ...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8', timeout: 15000 });
  const check = (result: ReturnType<typeof run>) => { expect(result.status, result.stderr).toBe(0); return result; };
  check(run(authorityScript, 'init', pub, authorityPrivate, journal));
  const reviewed = JSON.parse(check(run(authorityScript, 'review', pub, plan)).stdout);
  check(run(authorityScript, 'sign', '--approve', reviewed.approvalDigest, pub, authorityPrivate, journal, plan, signed));
  const signedAllocationDigest = admissionIssuanceAllocationDigest(await verifyAdmissionIssuanceAllocation(JSON.parse(readFileSync(signed, 'utf8')), authority));
  const profileFile = join(n.directory, 'profile.json'), privateFile = join(n.directory, 'issuer.pem'), ledgerFile = join(n.directory, 'cli-ledger.json'), policyFile = join(n.directory, 'policy.json');
  writeFileSync(profileFile, JSON.stringify(profiles[0]));
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pairs[0].privateKey));
  try { writeFileSync(privateFile, `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----\n`, { mode: 0o600 }); } finally { der.fill(0); }
  const policy = await signAdmissionPolicy({ ...n.policyBody, expiresAt: n.start + 3600000,
    keys: n.policyBody.keys.map(entry => ({ ...entry, issueUntil: n.start + 900000, spendUntil: n.start + 1200000, retryUntil: n.start + 1800000 })) }, authority, authorityKey.secretKey);
  writeFileSync(policyFile, JSON.stringify(policy)); const args = [profileFile, privateFile, ledgerFile];
  check(run(issuerScript, 'init-allocation', '--authority-file', pub, '--allocation-file', signed, ...args));
  const handle = claim(), claimFile = join(n.directory, 'claim.json'), permitFile = join(n.directory, 'permit.json'), recovered = join(n.directory, 'permit-recovered.json');
  writeFileSync(claimFile, JSON.stringify({ version: 1, kind: 'admission-operator-claim', handle }), { mode: 0o600 });
  expect(run(issuerScript, 'grant', '--approve', '--claim-file', claimFile, ...args, permitFile).status).toBe(1);
  check(run(issuerScript, 'policy', '--approve', ...args, pub, policyFile));
  expect(run(issuerScript, 'grant', '--approve', '--claim-file', claimFile, ...args, join(n.directory, 'missing', 'permit.json')).status).toBe(1);
  check(run(issuerScript, 'grant', '--approve', '--claim-file', claimFile, ...args, permitFile));
  check(run(issuerScript, 'grant', '--approve', '--claim-file', claimFile, ...args, recovered)); expect(readFileSync(recovered, 'utf8')).toBe(readFileSync(permitFile, 'utf8'));
  const batch = await createAdmissionIssuanceBatch(profiles[0], 1), requestFile = join(n.directory, 'request.json'), responseFile = join(n.directory, 'response.json'), retryFile = join(n.directory, 'retry.json');
  writeFileSync(requestFile, JSON.stringify(batch.request));
  expect(run(issuerScript, 'issue', '--approve', ...args, permitFile, requestFile, join(n.directory, 'missing', 'response.json')).status).toBe(1);
  check(run(issuerScript, 'issue', '--approve', ...args, permitFile, requestFile, responseFile));
  check(run(issuerScript, 'issue', '--approve', ...args, permitFile, requestFile, retryFile)); expect(readFileSync(retryFile, 'utf8')).toBe(readFileSync(responseFile, 'utf8'));
  const response = JSON.parse(readFileSync(responseFile, 'utf8')), tokens = await batch.finalize(response), binding = createAdmissionRequestBindingV2('search', { operation: 'real-cli' });
  const capability = presentBlindAdmissionTokenV2(tokens[0], profiles[0].scope, 'search', binding);
  expect(await verifyBlindAdmissionTokenV2(capability, profiles[0].scope, 'search', binding, pairs[0].publicKey)).toBeTruthy();
  const status = JSON.parse(check(run(issuerScript, 'status', ...args)).stdout); expect(status).toMatchObject({ allocatedPermits: 1, boundPermits: 1, completedPermits: 1, remainingPermits: 2 });
  for (const value of [JSON.parse(readFileSync(permitFile, 'utf8')), batch.request, response, capability, status]) {
    const wire = JSON.stringify(value); expect(wire).not.toContain(handle); expect(wire).not.toContain(signedAllocationDigest); expect(wire).not.toContain('\"allocation\"');
  }
}, 60000);
