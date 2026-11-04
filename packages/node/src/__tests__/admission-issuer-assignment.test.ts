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
import { signAdmissionIssuanceAllocation, admissionIssuanceAllocationDigest } from '@resonance/core/admission-issuance-allocation';
import { signAdmissionClaimAssignment, verifyAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadVote, parseAdmissionPolicyObservers, type AdmissionPolicyHead } from '@resonance/core/admission-policy-freshness';
import { ADMISSION_POLICY_QUERY_REPLY_TYPE } from '@resonance/core/admission-policy-query';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { openAdmissionIssuerLedger, type AdmissionIssuerLedger } from '../admission-issuer-ledger.js';
import { createAdmissionIssuanceBatch } from '../blind-admission-issuance.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
let pairs: CryptoKeyPair[], profiles: AdmissionWalletProfileV1[], authorityKey: ReturnType<typeof generateSigningKeyPair>, authority: string;
beforeAll(async () => {
  authorityKey = generateSigningKeyPair(); authority = Buffer.from(authorityKey.publicKey).toString('base64url');
  pairs = await Promise.all([0, 1].map(() => publicVerif.Issuer.generateKey(publicVerif.BlindRSAMode.PSS, { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) })));
  profiles = await Promise.all(pairs.map(async (pair, i) => ({ version: 1 as const, scope: { issuer: `assigned-issuer-${i}`, community: 'public' as const, epoch: 'one' },
    issuerPublicKey: `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64')}\n-----END PUBLIC KEY-----`, relayUrls: ['ws://127.0.0.1:45111/'] })));
});
const handle = () => randomBytes(32).toString('base64url');
async function fixture(freshness = false) {
  const directory = mkdtempSync(join(tmpdir(), 'issuer-assignment-')); let time = Date.now(); const start = time;
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const allocationBody = { version: 2 as const, kind: 'admission-issuance-allocation' as const, claimPolicy: 'authority-assigned-v1' as const,
    community: 'public' as const, epoch: 'one', notBefore: start, issueUntil: start + 10000, totalTokenBudget: 4,
    allocations: profiles.map(profile => ({ profile, batchSize: 1, maxPermits: 2 })) };
  const manifest = await signAdmissionIssuanceAllocation(allocationBody, authority, authorityKey.secretKey);
  const policyBody = { version: 1 as const, kind: 'admission-policy' as const, revision: 1, issuedAt: start - 1000, expiresAt: start + 100000,
    activeKey: admissionKeyFingerprint(profiles[0].issuerPublicKey), keys: profiles.map(profile => ({ profile, notBefore: start - 1000, issueUntil: start + 20000, spendUntil: start + 30000, retryUntil: start + 40000 })) };
  const policy = await signAdmissionPolicy(policyBody, authority, authorityKey.secretKey), observers = Array.from({ length: 5 }, generateSigningKeyPair);
  const context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority, genesis: admissionPolicyHead(policy), quorum: 4,
    members: observers.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${34001 + i}/` })) });
  const options = (i = 0) => ({ path: join(directory, `issuer-${i}.json`), expectedProfile: profiles[i], privateKey: pairs[i].privateKey, now: () => time });
  async function open(i = 0, create = true) {
    const ledger = await openAdmissionIssuerLedger({ ...options(i), ...(create ? { allocation: { manifest, authority } } : {}) }); cleanup.push(() => ledger.close());
    if (create) await ledger.installPolicy(policy, authority, freshness ? { observers: context } : {}); return ledger;
  }
  async function assign(claimHandle = handle(), i = 0) {
    return signAdmissionClaimAssignment({ version: 1, kind: 'admission-claim-assignment', authority, allocationDigest: admissionIssuanceAllocationDigest(manifest),
      community: 'public', epoch: 'one', claimHandle, issuerKeyFingerprint: admissionKeyFingerprint(profiles[i].issuerPublicKey) }, manifest, authority, authorityKey.secretKey);
  }
  const proof = (ledger: AdmissionIssuerLedger, head: AdmissionPolicyHead = context.genesis) => {
    const { query } = ledger.preparePolicyObservation();
    return { version: 1 as const, type: ADMISSION_POLICY_QUERY_REPLY_TYPE, certificate: { version: 1 as const, kind: 'admission-policy-head-certificate' as const,
      votes: observers.slice(0, 4).map(key => createAdmissionPolicyHeadVote(query.request, head, context, key, time)) } };
  };
  async function raw(i = 0) {
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pairs[i].privateKey)), key = Buffer.from(hkdfSync('sha256', der, Buffer.alloc(0), 'resonance:admission-issuer-ledger:v1', 32)); der.fill(0);
    try { return openEncryptedLocalState<Record<string, any>>({ path: options(i).path, key, domain: 'resonance:admission-issuer-ledger:v1', maxBytes: 8 * 1024 * 1024,
      mode: 'open-existing', initial: {}, validate: (value): value is Record<string, any> => !!value }); } finally { key.fill(0); }
  }
  return { directory, start, allocationBody, manifest, policy, policyBody, context, options, open, assign, proof, raw, clock(value: number) { time = value; } };
}
it('requires signed assignments, serializes async verification, snapshots inputs and recovers one exact permit across restart', async () => {
  const n = await fixture(), ledger = await n.open(), assignment = await n.assign();
  expect(() => ledger.grant()).toThrow('claim required'); expect(() => ledger.grantForClaim(assignment.claimHandle)).toThrow('Signed authority assignment');
  const mutable = structuredClone(assignment), pending = ledger.grantForAssignment(mutable);
  mutable.claimHandle = handle(); mutable.authority = Buffer.alloc(32).toString('base64url');
  expect(() => ledger.grant()).toThrow('in progress'); expect(() => ledger.preparePolicyObservation()).toThrow('in progress');
  expect(() => ledger.planRetirement(authority)).toThrow('in progress'); expect(() => ledger.retire(authority, 'sha256:' + '0'.repeat(64))).toThrow('in progress');
  await expect(ledger.installPolicy(n.policy, authority)).rejects.toThrow('in progress'); await expect(ledger.grantForAssignment(assignment)).rejects.toThrow('in progress');
  const permit = await pending;
  for (let i = 0; i < 100; i++) expect(await ledger.grantForAssignment(assignment)).toEqual(permit);
  expect(ledger.status()).toMatchObject({ allocatedPermits: 1, remainingPermits: 1 }); ledger.close();
  const raw = await n.raw(); expect(raw.read().version).toBe(8); expect(raw.read().entries[0].assignment).toEqual(assignment); raw.close();
  const reopened = await n.open(0, false); expect(await reopened.grantForAssignment(assignment)).toEqual(permit); expect(() => reopened.grantForClaim(assignment.claimHandle)).toThrow('Signed authority assignment');
  await reopened.grantForAssignment(await n.assign()); await expect(reopened.grantForAssignment(await n.assign())).rejects.toThrow('exhausted');
});
it('rejects cross-issuer, unsigned, wrong authority/digest/scope/signature evidence without consuming quota', async () => {
  const n = await fixture(), first = await n.open(), second = await n.open(1), assignment = await n.assign();
  await expect(second.grantForAssignment(assignment)).rejects.toThrow('another issuer');
  const { signature, ...unsigned } = assignment;
  for (const invalid of [unsigned, { ...assignment, authority: Buffer.alloc(32).toString('base64url') }, { ...assignment, allocationDigest: 'sha256:' + 'f'.repeat(64) },
    { ...assignment, epoch: 'other' }, { ...assignment, community: 'private' }, { ...assignment, signature: Buffer.alloc(64).toString('base64url') }]) await expect(first.grantForAssignment(invalid)).rejects.toThrow();
  expect(first.status().allocatedPermits).toBe(0); expect(second.status().allocatedPermits).toBe(0);
  const pending = first.grantForAssignment(assignment); first.close(); await expect(pending).rejects.toThrow('closed');
});
it('rejects retained mode downgrades and tampered assignment/claim bindings on reopen', async () => {
  const n = await fixture(), ledger = await n.open(), assignment = await n.assign(); await ledger.grantForAssignment(assignment); ledger.close();
  let raw = await n.raw(); const saved = raw.read(); raw.write({ ...saved, version: 6, claimMode: 'operator-claim-required-v1', entries: [] }); raw.close();
  await expect(n.open(0, false)).rejects.toThrow('mode');
  raw = await n.raw(); raw.write({ ...saved, entries: saved.entries.map((entry: any) => ({ ...entry, assignment: { ...entry.assignment, claimHandle: handle() } })) }); raw.close();
  await expect(n.open(0, false)).rejects.toThrow();
  const otherIssuerAssignment = await n.assign(assignment.claimHandle, 1);
  raw = await n.raw(); raw.write({ ...saved, entries: saved.entries.map((entry: any) => ({ ...entry, assignment: otherIssuerAssignment })) }); raw.close();
  await expect(n.open(0, false)).rejects.toThrow('claim binding');
  raw = await n.raw(); raw.write({ ...saved, entries: saved.entries.map((entry: any) => ({ ...entry, claim: { ...entry.claim, digest: 'f'.repeat(64) } })) }); raw.close();
  await expect(n.open(0, false)).rejects.toThrow('claim binding');
  for (const field of ['secret', 'binding']) {
    raw = await n.raw(); raw.write({ ...saved, entries: saved.entries.map((entry: any) => ({ ...entry, claim: { ...entry.claim, [field]: field === 'secret' ? handle() : 'f'.repeat(64) } })) }); raw.close();
    await expect(n.open(0, false)).rejects.toThrow('invalid');
  }
});
it('never returns a permit after failed persistence and preserves assignment evidence through exact batch recovery', async () => {
  const n = await fixture(), assignment = await n.assign(); let ledger = await n.open();
  vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('assignment disk failure'); });
  await expect(ledger.grantForAssignment(assignment)).rejects.toThrow('assignment disk failure'); ledger.close(); ledger = await n.open(0, false);
  expect(ledger.status().allocatedPermits).toBe(0); const permit = await ledger.grantForAssignment(assignment), batch = await createAdmissionIssuanceBatch(profiles[0], 1);
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(renameSync).mockImplementationOnce(actual.renameSync).mockImplementationOnce(() => { throw new Error('response disk failure'); });
  await expect(ledger.approve(permit, batch.request)).rejects.toThrow('response disk failure'); ledger.close(); ledger = await n.open(0, false);
  expect(await ledger.grantForAssignment(assignment)).toEqual(permit);
  const changed = await createAdmissionIssuanceBatch(profiles[0], 1); await expect(ledger.approve(permit, changed.request)).rejects.toThrow('already bound');
  const response = await ledger.approve(permit, batch.request); ledger.close(); ledger = await n.open(0, false); expect(await ledger.approve(permit, batch.request)).toEqual(response);
  const tokens = await batch.finalize(response), binding = createAdmissionRequestBindingV2('search', { operation: 'assignment' }), capability = presentBlindAdmissionTokenV2(tokens[0], profiles[0].scope, 'search', binding);
  for (const object of [permit, batch.request, response, capability, ledger.status()]) {
    const wire = JSON.stringify(object); for (const secret of [assignment.claimHandle, assignment.signature, assignment.allocationDigest]) expect(wire).not.toContain(secret); expect(wire).not.toContain('claimHandle');
  }
});
it('retains prepared assignments through expiry/restart while freshness and policy recovery cutoffs remain authoritative', async () => {
  const n = await fixture(true), ledger = await n.open(), doneAssignment = await n.assign(), preparedAssignment = await n.assign();
  await expect(ledger.grantForAssignment(doneAssignment)).rejects.toThrow('new issuer policy observation');
  const proof = n.proof(ledger), callerProof = structuredClone(proof), granting = ledger.grantForAssignment(doneAssignment, callerProof);
  callerProof.certificate.votes[0].signature = Buffer.alloc(64).toString('base64url'); const done = await granting;
  const prepared = await ledger.grantForAssignment(preparedAssignment, n.proof(ledger)), doneBatch = await createAdmissionIssuanceBatch(profiles[0], 1), preparedBatch = await createAdmissionIssuanceBatch(profiles[0], 1);
  const response = await ledger.approve(done, doneBatch.request, n.proof(ledger)), expiring = n.proof(ledger);
  const operation = ledger.approve(prepared, preparedBatch.request, expiring); n.clock(expiring.certificate.votes[0].request.expiresAt);
  await expect(operation).rejects.toThrow('observation expired'); ledger.close(); let reopened = await n.open(0, false);
  n.clock(n.manifest.issueUntil); expect(await reopened.grantForAssignment(preparedAssignment, n.proof(reopened))).toEqual(prepared);
  const crypto = vi.spyOn(publicVerif.Issuer.prototype, 'issue'); await expect(reopened.approve(prepared, preparedBatch.request, n.proof(reopened))).rejects.toThrow('not current'); expect(crypto).not.toHaveBeenCalled();
  expect(await reopened.approve(done, doneBatch.request, n.proof(reopened))).toEqual(response); expect(reopened.status()).toMatchObject({ preparedPermits: 1, completedPermits: 1, allocatedPermits: 2 });
  await expect(reopened.grantForAssignment(doneAssignment, n.proof(reopened, { ...n.context.genesis, revision: 2, transition: 'a'.repeat(64) }))).rejects.toThrow('newer');
  reopened.close(); reopened = await n.open(0, false); await expect(reopened.grantForAssignment(doneAssignment, n.proof(reopened))).rejects.toThrow('older');
});
it('retains the v2 manifest and lifetime totals after permanent v9 retirement', async () => {
  const n = await fixture(), ledger = await n.open(), assignment = await n.assign(); await ledger.grantForAssignment(assignment);
  const successor = await signAdmissionPolicy({ ...n.policyBody, revision: 2, activeKey: admissionKeyFingerprint(profiles[1].issuerPublicKey) }, authority, authorityKey.secretKey);
  await ledger.installPolicy(successor, authority); n.clock(n.policyBody.keys[0].retryUntil); const plan = ledger.planRetirement(authority); ledger.retire(authority, plan.approvalDigest); ledger.close();
  const raw = await n.raw(); expect(raw.read().version).toBe(9); expect(raw.read().allocation.manifest).toEqual(n.manifest); expect(raw.read().entries).toEqual([]); raw.close();
  n.clock(n.start); const reopened = await n.open(0, false); expect(reopened.status()).toMatchObject({ permanentlyRetired: true, allocatedPermits: 1, remainingPermits: 0, unallocatedPermitsCancelled: 1 });
  expect(() => reopened.grantForClaim(assignment.claimHandle)).toThrow('permanently retired'); await expect(reopened.grantForAssignment(assignment)).rejects.toThrow('permanently retired');
});

it('runs v2 authority allocation and assignment through real issuer CLI issuance and exact output-loss recovery', async () => {
  const n = await fixture(), root = fileURLToPath(new URL('../../../../', import.meta.url)), authorityScript = join(root, 'scripts/admission-allocation.ts'), issuerScript = join(root, 'scripts/issue-admission-tokens.ts');
  const pub = join(n.directory, 'authority.pub'), privateAuthority = join(n.directory, 'authority.json'), journal = join(n.directory, 'authority-journal.json'), plan = join(n.directory, 'plan.json'), signed = join(n.directory, 'signed.json');
  writeFileSync(pub, authority); writeFileSync(privateAuthority, JSON.stringify({ publicKey: authority, secretKey: Buffer.from(authorityKey.secretKey).toString('base64url') }), { mode: 0o600 });
  writeFileSync(plan, JSON.stringify({ ...n.allocationBody, issueUntil: n.start + 600000 }));
  const run = (script: string, ...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8', timeout: 15000 });
  const logs: string[] = [];
  const check = (result: ReturnType<typeof run>) => { logs.push(result.stdout + result.stderr); expect(result.status, result.stderr).toBe(0); return result; };
  check(run(authorityScript, 'init', pub, privateAuthority, journal));
  const reviewed = JSON.parse(check(run(authorityScript, 'review', pub, plan)).stdout);
  check(run(authorityScript, 'sign', '--approve', reviewed.approvalDigest, pub, privateAuthority, journal, plan, signed));
  const requestFile = join(n.directory, 'claim-request.json'), assignmentFile = join(n.directory, 'assignment.json'), claimHandle = handle();
  writeFileSync(requestFile, JSON.stringify({ community: 'public', epoch: 'one', claimHandle, issuerKeyFingerprint: admissionKeyFingerprint(profiles[0].issuerPublicKey) }), { mode: 0o600 });
  const claimReview = JSON.parse(check(run(authorityScript, 'assignment-review', pub, privateAuthority, journal, requestFile)).stdout);
  check(run(authorityScript, 'assign', '--approve', claimReview.approvalDigest, pub, privateAuthority, journal, requestFile, assignmentFile));
  const assignment = await verifyAdmissionClaimAssignment(JSON.parse(readFileSync(assignmentFile, 'utf8')), JSON.parse(readFileSync(signed, 'utf8')), authority);
  const profileFile = join(n.directory, 'profile.json'), keyFile = join(n.directory, 'issuer.pem'), ledgerFile = join(n.directory, 'cli-ledger.json'), policyFile = join(n.directory, 'policy.json');
  writeFileSync(profileFile, JSON.stringify(profiles[0])); const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pairs[0].privateKey));
  try { writeFileSync(keyFile, `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----\n`, { mode: 0o600 }); } finally { der.fill(0); }
  const policy = await signAdmissionPolicy({ ...n.policyBody, expiresAt: n.start + 3600000,
    keys: n.policyBody.keys.map(entry => ({ ...entry, issueUntil: n.start + 900000, spendUntil: n.start + 1200000, retryUntil: n.start + 1800000 })) }, authority, authorityKey.secretKey);
  writeFileSync(policyFile, JSON.stringify(policy)); const args = [profileFile, keyFile, ledgerFile];
  check(run(issuerScript, 'init-allocation', '--authority-file', pub, '--allocation-file', signed, ...args)); check(run(issuerScript, 'policy', '--approve', ...args, pub, policyFile));
  const unsigned = join(n.directory, 'unsigned.json'); writeFileSync(unsigned, JSON.stringify({ version: 1, kind: 'admission-operator-claim', handle: claimHandle }), { mode: 0o600 });
  expect(run(issuerScript, 'grant', '--approve', ...args, join(n.directory, 'unbound.json')).status).toBe(1);
  expect(run(issuerScript, 'grant', '--approve', '--claim-file', unsigned, ...args, join(n.directory, 'unsigned-permit.json')).status).toBe(1);
  expect(run(issuerScript, 'grant', '--approve', '--claim-file', unsigned, '--assignment-file', assignmentFile, ...args, join(n.directory, 'ambiguous.json')).status).toBe(1);
  const oversized = join(n.directory, 'oversized.json'); writeFileSync(oversized, 'x'.repeat(4097), { mode: 0o600 });
  expect(run(issuerScript, 'grant', '--approve', '--assignment-file', oversized, ...args, join(n.directory, 'oversized-permit.json')).status).toBe(1);
  const grant = (...tail: string[]) => run(issuerScript, 'grant', '--approve', '--assignment-file', assignmentFile, ...args, ...tail);
  expect(grant(join(n.directory, 'missing', 'permit.json')).status).toBe(1);
  const permitFile = join(n.directory, 'permit.json'), recovered = join(n.directory, 'permit-recovered.json');
  check(grant(permitFile)); check(grant(recovered)); expect(readFileSync(permitFile, 'utf8')).toBe(readFileSync(recovered, 'utf8'));
  const batch = await createAdmissionIssuanceBatch(profiles[0], 1), batchFile = join(n.directory, 'batch.json'), responseFile = join(n.directory, 'response.json'), retryFile = join(n.directory, 'response-retry.json');
  writeFileSync(batchFile, JSON.stringify(batch.request));
  const issue = (output: string) => run(issuerScript, 'issue', '--approve', ...args, permitFile, batchFile, output);
  expect(issue(join(n.directory, 'missing', 'response.json')).status).toBe(1); check(issue(responseFile)); check(issue(retryFile));
  expect(readFileSync(responseFile, 'utf8')).toBe(readFileSync(retryFile, 'utf8'));
  const response = JSON.parse(readFileSync(responseFile, 'utf8')), tokens = await batch.finalize(response), binding = createAdmissionRequestBindingV2('search', { example: 'cli' });
  const capability = presentBlindAdmissionTokenV2(tokens[0], profiles[0].scope, 'search', binding); expect(await verifyBlindAdmissionTokenV2(capability, profiles[0].scope, 'search', binding, pairs[0].publicKey)).toBeTruthy();
  const status = JSON.parse(check(run(issuerScript, 'status', ...args)).stdout); expect(status).toMatchObject({ allocatedPermits: 1, completedPermits: 1, boundPermits: 1, remainingPermits: 1 });
  for (const object of [JSON.parse(readFileSync(permitFile, 'utf8')), batch.request, response, capability, status]) {
    const wire = JSON.stringify(object); for (const secret of [assignment.claimHandle, assignment.signature, assignment.allocationDigest]) expect(wire).not.toContain(secret);
  }
  expect(logs.join('\n')).not.toContain(claimHandle); expect(logs.join('\n')).not.toContain(assignment.signature);
}, 60000);
