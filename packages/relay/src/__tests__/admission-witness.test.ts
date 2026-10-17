import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createAdmissionRequestBindingV2, generateSigningKeyPair, presentBlindAdmissionTokenV2 } from '@resonance/core';
import { signAdmissionPolicy, assertAdmissionPolicySuccessor } from '@resonance/core/admission-policy';
import { admissionWitnessSetId, createAdmissionWitnessRequest, createAdmissionWitnessVote, parseAdmissionWitnessSet, verifyAdmissionSpendCertificate } from '@resonance/core/admission-witness';
import { createAdmissionWitness, createAdmissionQuorumGate, type AdmissionWitnessTransport } from '../admission-witness.js';
import { createConfiguredAdmissionVerifier } from '../configured-admission-verifier.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
let f: Awaited<ReturnType<typeof witnessFixture>>;
beforeAll(async () => { f = await witnessFixture(); });
const clean: Array<() => void> = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
function directory() { const path = mkdtempSync(join(tmpdir(), 'admission-quorum-')); clean.push(() => rmSync(path, { recursive: true, force: true })); return path; }
function claim(spend = randomBytes(32).toString('base64url'), text = 'first') {
  return { setId: admissionWitnessSetId(f.policy.keys[0].witnesses!), issuerKey: f.policy.activeKey, spend,
    action: 'search' as const, requestBinding: createAdmissionRequestBindingV2('search', { text }) };
}
function network() {
  const dir = directory(), encryptionKey = randomBytes(32);
  const witnesses = f.witnesses.map((signingKey, i) => createAdmissionWitness({ directory: join(dir, String(i)), encryptionKey, policy: f.policy, signingKey, initialize: true }));
  witnesses.forEach(w => clean.push(() => w.close()));
  const map = new Map(f.witnesses.map((key, i) => [Buffer.from(key.publicKey).toString('base64url'), witnesses[i]]));
  const transport: AdmissionWitnessTransport = async (member, req) => map.get(member.publicKey)!.vote(req);
  return { dir, encryptionKey, witnesses, map, transport };
}

it('pins five distinct members and refuses membership replacement or downgrade under an existing issuer key', async () => {
  const set = f.policy.keys[0].witnesses!;
  expect(() => parseAdmissionWitnessSet({ ...set, members: [set.members[0], ...set.members.slice(0, 4)] })).toThrow('distinct');
  expect(() => parseAdmissionWitnessSet({ ...set, quorum: 3 })).toThrow();
  expect(() => parseAdmissionWitnessSet({ ...set, members: set.members.map((m, i) => i ? m : { ...m, endpoint: 'ws://example.com' }) })).toThrow('wss');
  const { witnesses: _, ...plain } = f.body.keys[0];
  const downgrade = await signAdmissionPolicy({ ...f.body, revision: 2, keys: [plain] }, f.authority, f.authorityKey.secretKey);
  expect(() => assertAdmissionPolicySuccessor(f.policy, downgrade)).toThrow('prior keys');
  const changed = await signAdmissionPolicy({ ...f.body, revision: 2, keys: [{ ...f.body.keys[0], witnesses: { ...set, coordinators: [Buffer.from(generateSigningKeyPair().publicKey).toString('base64url')] } }] }, f.authority, f.authorityKey.secretKey);
  expect(() => assertAdmissionPolicySuccessor(f.policy, changed)).toThrow('prior keys');
  expect(() => assertAdmissionPolicySuccessor(downgrade, { ...f.policy, revision: 3 })).toThrow('prior keys');
});

it('requires four different valid votes for the exact set, issuer, token, action and binding', () => {
  const request = claim(), set = f.policy.keys[0].witnesses!;
  const votes = f.witnesses.map(key => createAdmissionWitnessVote(request, key));
  expect(verifyAdmissionSpendCertificate({ version: 1, votes: votes.slice(0, 4) }, request, set)).toBe(true);
  for (const invalid of [votes.slice(0, 3), [votes[0], votes[0], votes[1], votes[2]],
    [...votes.slice(0, 3), { ...votes[3], signature: votes[4].signature }],
    [...votes.slice(0, 3), createAdmissionWitnessVote(request, generateSigningKeyPair())]]) {
    expect(verifyAdmissionSpendCertificate({ version: 1, votes: invalid }, request, set)).toBe(false);
  }
  for (const changed of [{ ...request, spend: randomBytes(32).toString('base64url') }, { ...request, action: 'publication-write' as const },
    { ...request, setId: 'sha256:' + '0'.repeat(64) }, { ...request, issuerKey: 'sha256:' + '0'.repeat(64) }, claim(request.spend, 'changed')]) {
    expect(verifyAdmissionSpendCertificate({ version: 1, votes }, changed, set)).toBe(false);
  }
});

it('persists immutable votes before returning, refuses foreign coordinators and fails closed on uncertain flush or missing history', () => {
  const dir = directory(), encryptionKey = randomBytes(32);
  const options = { directory: dir, encryptionKey, policy: f.policy, signingKey: f.witnesses[0], maxSpends: 1 };
  let witness = createAdmissionWitness({ ...options, initialize: true }); clean.push(() => witness.close());
  const first = claim(), request = createAdmissionWitnessRequest(first, f.coordinators[0]);
  expect(() => witness.vote(request, () => false)).toThrow('owner paused');
  expect(() => witness.vote(createAdmissionWitnessRequest(first, generateSigningKeyPair()))).toThrow('Unauthenticated');
  expect(() => witness.vote({ ...request, spend: randomBytes(32).toString('base64url') })).toThrow('Unauthenticated');
  // File flush succeeds and replacement lands; directory flush fails. Return no signature,
  // poison this handle, and recover the SAME decision from the persisted snapshot.
  vi.mocked(fsyncSync).mockImplementationOnce(actualFsync).mockImplementationOnce(() => { throw new Error('flush failed'); });
  expect(() => witness.vote(request)).toThrow('flush failed');
  expect(() => witness.vote(request)).toThrow('write failed');
  witness.close(); witness = createAdmissionWitness(options);
  const vote = witness.vote(request); expect(vote.spend).toBe(first.spend);
  expect(witness.vote(request, () => false)).toEqual(vote);
  expect(() => witness.vote(createAdmissionWitnessRequest(claim(first.spend, 'other'), f.coordinators[1]))).toThrow('Conflicting');
  expect(() => witness.vote(createAdmissionWitnessRequest(claim(), f.coordinators[0]))).toThrow('full');
  expect(readFileSync(join(dir, 'admission-witness-votes.json'), 'utf8')).not.toContain(first.spend);
  expect(() => createAdmissionWitness(options)).toThrow('already open');
  witness.close(); rmSync(join(dir, 'admission-witness-votes.json'));
  expect(() => createAdmissionWitness(options)).toThrow('missing');
});

it('prevents conflicting certificates under concurrent attempts even when one witness equivocates', async () => {
  const n = network(); const malicious = Buffer.from(f.witnesses[4].publicKey).toString('base64url');
  const transport: AdmissionWitnessTransport = async (member, req) => member.publicKey === malicious ? createAdmissionWitnessVote(req, f.witnesses[4]) : n.transport(member, req, new AbortController().signal);
  const gates = f.coordinators.map((signingKey, i) => createAdmissionQuorumGate({ directory: join(n.dir, `c${i}`), encryptionKey: n.encryptionKey, policy: f.policy, signingKey, transport, initialize: true }));
  gates.forEach(g => clean.push(() => g.close()));
  const a = claim(), b = claim(a.spend, 'conflict');
  const result = await Promise.allSettled(gates.map((gate, i) => gate.authorize(a.issuerKey, a.spend, i ? b : a)));
  expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
});

it('refuses both sides of a three-versus-two split; four reunited witnesses recover only the original binding', async () => {
  const n = network(), a = claim(), b = claim(a.spend, 'conflict');
  const members = f.policy.keys[0].witnesses!;
  let connected = new Set(members.members.slice(0, 3).map(m => m.publicKey));
  const transport: AdmissionWitnessTransport = (member, req, signal) => connected.has(member.publicKey) ? n.transport(member, req, signal) : Promise.reject(new Error('partition'));
  const options = { directory: join(n.dir, 'coordinator'), encryptionKey: n.encryptionKey, policy: f.policy, signingKey: f.coordinators[0], transport };
  let gate = createAdmissionQuorumGate({ ...options, initialize: true }); clean.push(() => gate.close());
  await expect(gate.authorize(a.issuerKey, a.spend, a)).rejects.toThrow('Four');
  connected = new Set(members.members.slice(3).map(m => m.publicKey));
  // Use another token on the isolated two so rejoining can recover a; conflicting
  // minority votes on a would permanently strand it, which is tested below.
  const other = claim(); await expect(gate.authorize(other.issuerKey, other.spend, other)).rejects.toThrow('Four');
  connected = new Set(members.members.slice(0, 4).map(m => m.publicKey));
  await expect(gate.authorize(a.issuerKey, a.spend, a)).resolves.toBeUndefined();
  await expect(gate.authorize(b.issuerKey, b.spend, b)).rejects.toThrow('Conflicting');
  gate.close(); connected.clear(); gate = createAdmissionQuorumGate(options);
  await expect(gate.authorize(a.issuerKey, a.spend, a)).resolves.toBeUndefined();
});

it('never releases split provisional votes, including lost replies and retry-only key retirement', async () => {
  const n = network(), a = claim(), b = claim(a.spend, 'conflict');
  n.witnesses.slice(0, 3).forEach(w => w.vote(createAdmissionWitnessRequest(a, f.coordinators[0])));
  n.witnesses.slice(3).forEach(w => w.vote(createAdmissionWitnessRequest(b, f.coordinators[1])));
  const gate = createAdmissionQuorumGate({ directory: join(n.dir, 'coord'), encryptionKey: n.encryptionKey, policy: f.policy, signingKey: f.coordinators[0], transport: n.transport, initialize: true }); clean.push(() => gate.close());
  await expect(gate.authorize(a.issuerKey, a.spend, a)).rejects.toThrow('Four');
  await expect(gate.authorize(b.issuerKey, b.spend, b)).rejects.toThrow('Four');
  const options = { directory: join(n.dir, '0'), encryptionKey: n.encryptionKey, policy: f.policy, signingKey: f.witnesses[0], now: () => f.policy.keys[0].spendUntil };
  n.witnesses[0].close(); const retired = createAdmissionWitness(options); clean.push(() => retired.close());
  expect(retired.vote(createAdmissionWitnessRequest(a, f.coordinators[0])).spend).toBe(a.spend);
  expect(() => retired.vote(createAdmissionWitnessRequest(claim(), f.coordinators[0]))).toThrow('retired');
});

it('bounds unavailable witnesses and refuses late votes after timeout or close without applying a local spend', async () => {
  const n = network(); const requests: Array<() => void> = [];
  const transport: AdmissionWitnessTransport = (member, req) => new Promise(resolve => { requests.push(() => resolve(n.map.get(member.publicKey)!.vote(req))); });
  const options = { directory: join(n.dir, 'destination'), encryptionKey: n.encryptionKey, policy: f.policy, authority: f.authority,
    coordinatorKey: f.coordinators[0], witnessTransport: transport, witnessTimeoutMs: 50 };
  let verifier = await createConfiguredAdmissionVerifier({ ...options, initialize: true }); clean.push(() => verifier.close());
  const spentBefore = readFileSync(join(options.directory, 'admission-spends-v2.jsonl'));
  const token = await f.token(), c = claim(), cap = presentBlindAdmissionTokenV2(token, f.scope, c.action, c.requestBinding);
  await expect(verifier.verifyAndSpend(cap, { ...c, now: f.time })).rejects.toThrow('Four');
  requests.splice(0).forEach(resolve => resolve());
  await Promise.resolve();
  expect(readFileSync(join(options.directory, 'admission-spends-v2.jsonl'))).toEqual(spentBefore);
  verifier.close(); verifier = await createConfiguredAdmissionVerifier({ ...options, witnessTransport: n.transport });
  expect(await verifier.verifyAndSpend(cap, { ...c, now: f.time })).toEqual({ status: 'accepted' });
  const second = claim(), cap2 = presentBlindAdmissionTokenV2(await f.token(), f.scope, second.action, second.requestBinding);
  verifier.close(); verifier = await createConfiguredAdmissionVerifier(options);
  const pending = verifier.verifyAndSpend(cap2, { ...second, now: f.time }); verifier.close();
  await expect(pending).rejects.toThrow();
});

it('never accepts an unflushed certificate and recovers the same binding without requiring the silent fifth witness', async () => {
  const n = network(), c = claim(), request = createAdmissionWitnessRequest(c, f.coordinators[0]);
  n.witnesses.forEach(w => w.vote(request));
  const options = { directory: join(n.dir, 'certificate'), encryptionKey: n.encryptionKey, policy: f.policy, signingKey: f.coordinators[0], transport: n.transport };
  let gate = createAdmissionQuorumGate({ ...options, initialize: true }); clean.push(() => gate.close());
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('certificate flush failed'); });
  await expect(gate.authorize(c.issuerKey, c.spend, c)).rejects.toThrow('certificate flush failed');
  await expect(gate.authorize(c.issuerKey, c.spend, c)).rejects.toThrow('write failed');
  gate.close();
  const silentKey = f.policy.keys[0].witnesses!.members[4].publicKey; let cancelled = false;
  const transport: AdmissionWitnessTransport = (member, req, signal) => {
    if (member.publicKey !== silentKey) return n.transport(member, req, signal);
    return new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true }));
  };
  gate = createAdmissionQuorumGate({ ...options, transport });
  await expect(gate.authorize(c.issuerKey, c.spend, c)).resolves.toBeUndefined();
  expect(cancelled).toBe(true);
});

it('bounds simultaneous quorum attempts, cancels them on close and ignores their late signed replies', async () => {
  const n = network(), replies: Array<() => void> = [];
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const transport: AdmissionWitnessTransport = (member, request) => new Promise(resolve => {
    replies.push(() => resolve(n.map.get(member.publicKey)!.vote(request))); if (replies.length === 160) started();
  });
  const gate = createAdmissionQuorumGate({ directory: join(n.dir, 'pending'), encryptionKey: n.encryptionKey, policy: f.policy, signingKey: f.coordinators[0], transport, initialize: true });
  clean.push(() => gate.close());
  const pending = Array.from({ length: 32 }, () => { const c = claim(); return gate.authorize(c.issuerKey, c.spend, c); });
  const settled = Promise.allSettled(pending);
  const extra = claim(); await expect(gate.authorize(extra.issuerKey, extra.spend, extra)).rejects.toThrow('capacity');
  await ready; gate.close();
  expect((await settled).every(r => r.status === 'rejected')).toBe(true);
  // Deliver one late vote per socket group. Closed attempts must not write certificates.
  replies.slice(0, 5).forEach(reply => reply()); await Promise.resolve();
});
