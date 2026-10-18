import { afterEach, beforeAll, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { admissionKeyFingerprint, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2 } from '@resonance/core';
import { createAdmissionWitnessRequest } from '@resonance/core/admission-witness';
import { createAdmissionPolicyAdvance, admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadVote, parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { createAdmissionWitness, createAdmissionQuorumGate } from '../admission-witness.js';
import { createProtectedAdmissionRoles } from '../protected-admission-roles.js';
import { createConfiguredAdmissionVerifier } from '../configured-admission-verifier.js';
import { createRelayServer } from '../server.js';
import { requestAdmissionWitnessVote } from '../admission-witness-transport.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';
import { protectedRoleFixture } from './fixtures/protected-role-fixture.js';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
let f: Awaited<ReturnType<typeof witnessFixture>>;
beforeAll(async () => { f = await witnessFixture(); });
async function fixture(captured = true, maxArchiveBlocks?: number) {
  const n = await protectedRoleFixture(f, maxArchiveBlocks); cleanup.push(n.close);
  if (captured) { const capture = await n.capture(); await capture.apply((await capture.review()).approvalDigest); capture.close(); }
  function roles(includeSelf = false) {
    const value = createProtectedAdmissionRoles({ history: n.history, witnessKey: f.witnesses[0], coordinatorKey: f.coordinators[0], now: () => f.time,
      transport: async (member, request) => {
        const i = f.witnesses.findIndex(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey);
        if (!i) { if (includeSelf) return value.witness!.vote(request); throw new Error('fifth witness offline'); }
        return n.witnesses[i].vote(request);
      } });
    cleanup.push(value.close); return value;
  }
  return { n, roles };
}

it('captures both intact local roles, fences old writers and retains their exact decisions through restart', async () => {
  const { n, roles } = await fixture(), role = roles(), request = createAdmissionWitnessRequest(n.initial, f.coordinators[0]);
  const before = n.history.read().applied;
  expect((await role.witness!.vote(request)).spend).toBe(n.initial.spend);
  await role.quorum!.authorize(n.initial.issuerKey, n.initial.spend, n.initial);
  expect(n.history.read().applied).toEqual(before);
  expect(() => createAdmissionWitness({ ...n.localOptions, signingKey: f.witnesses[0] })).toThrow(/invalid/);
  expect(() => createAdmissionQuorumGate({ ...n.localOptions, signingKey: f.coordinators[0] })).toThrow(/invalid/);
  expect(readFileSync(join(n.options.directory, 'admission-witness-votes.json'), 'utf8')).not.toContain(n.initial.spend);
  role.close(); await n.reopen(); await n.history.ready();
  const restored = roles();
  await expect(restored.witness!.vote(createAdmissionWitnessRequest({ ...n.initial, requestBinding: `admreq_${'b'.repeat(86)}` }, f.coordinators[1]))).rejects.toThrow(/Conflicting/);
  await expect(restored.quorum!.authorize(n.initial.issuerKey, n.initial.spend, { ...n.initial, requestBinding: `admreq_${'b'.repeat(86)}` })).rejects.toThrow(/Conflicting/);
});

it('refuses unfunded checkpoint headroom before fencing either intact local role', async () => {
  const { n } = await fixture(false, 2), capture = await n.capture();
  const files = ['admission-witness-votes.json', 'admission-witness-certificates.json'].map(name => join(n.options.directory, name));
  const before = files.map(file => readFileSync(file)), review = await capture.review();
  expect(review).toMatchObject({ fits: false, requiredBlocks: 2, availableBlocks: 1, fencedRoles: 0 });
  await expect(capture.apply(review.approvalDigest)).rejects.toThrow(/headroom before fencing/); capture.close();
  files.forEach((file, i) => expect(readFileSync(file)).toEqual(before[i])); expect(n.history.read().pending).toBeNull();
  const local = createAdmissionWitness({ ...n.localOptions, signingKey: f.witnesses[0] }); cleanup.push(local.close);
  expect(local.vote(createAdmissionWitnessRequest(n.initial, f.coordinators[0])).spend).toBe(n.initial.spend);
});

it('coordinates through its own protected witness without racing the shared history writer', async () => {
  const { n, roles } = await fixture(), role = roles(true), c = n.claim();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  cleanup.push(() => release()); n.gate(async () => { enter(); await gate; });
  let settled = false;
  const operation = role.quorum!.authorize(c.issuerKey, c.spend, c).then(() => { settled = true; return null; }, error => { settled = true; return error; });
  await entered; await new Promise<void>(resolve => setImmediate(resolve));
  expect(settled).toBe(false); release(); expect(await operation).toBeNull();
  expect(n.history.roleState().witness!.votes).toHaveLength(2); expect(n.history.roleState().coordinator!.certificates).toHaveLength(2);
});

it('refuses an uncaptured protected role and missing legacy state instead of creating a blank witness', async () => {
  const { n, roles } = await fixture(false); expect(roles).toThrow(/captured or restored/);
  n.history.close();
  await expect(createConfiguredAdmissionVerifier({ ...n.options, historyProtection: n.options.protection,
    initialize: true, initializeSpendHistory: false, initializeWitnessState: true, witnessKey: f.witnesses[0] })).rejects.toThrow(/captured or restored/);
  await n.reopen(); rmSync(join(n.options.directory, 'admission-witness-votes.json'));
  await expect(n.capture()).rejects.toThrow(/missing/); expect(existsSync(join(n.options.directory, 'admission-witness-votes.json'))).toBe(false);
});

it('keeps the exact uncertain vote with only three copies, then publishes it after the fourth returns', async () => {
  const { n, roles } = await fixture(), role = roles(), c = n.claim(), request = createAdmissionWitnessRequest(c, f.coordinators[0]);
  n.online(3); await expect(role.witness!.vote(request)).rejects.toThrow(/Four/);
  const pending = n.history.read().pending; expect(pending).not.toBeNull();
  expect(n.history.read().image.version).toBe(2); expect(n.history.roleState().witness!.votes).toHaveLength(1);
  await expect(role.witness!.vote(createAdmissionWitnessRequest({ ...c, requestBinding: `admreq_${'b'.repeat(86)}` }, f.coordinators[0]))).rejects.toThrow(/Conflicting/);
  expect(n.history.read().pending).toEqual(pending);
  n.online(4); expect((await role.witness!.vote(request)).spend).toBe(c.spend);
  expect(n.history.read().pending).toBeNull(); expect(n.history.roleState().witness!.votes).toHaveLength(2);
  const head = n.history.read().applied;
  expect(n.stores.slice(0, 4).every(store => store.read().envelopes.length === head!.sequence + 1)).toBe(true);
});

it('retains coordinator certificates before authorizing and resumes the exact pending certificate after response loss', async () => {
  const { n, roles } = await fixture(), role = roles(), c = n.claim(); n.loseReplies(true);
  await expect(role.quorum!.authorize(c.issuerKey, c.spend, c)).rejects.toThrow(/Four/);
  const pending = n.history.read().pending; expect(n.history.pendingRoleDecision()?.kind).toBe('coordinator-certificate');
  n.loseReplies(false); await role.quorum!.authorize(c.issuerKey, c.spend, c);
  expect(n.history.read().pending).toBeNull(); expect(n.history.roleState().coordinator!.certificates).toHaveLength(2);
  expect(n.history.read().applied!.sequence).toBe(pending!.sequence);
});

it('routes configured blind-token admission through protected coordinator evidence before the protected spend', async () => {
  const { n } = await fixture(); n.history.close();
  const observers = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority: f.authority,
    genesis: admissionPolicyHead(f.policy), quorum: 4, members: f.body.keys[0].witnesses!.members });
  let observed = observers.genesis; const challenges = new Set<string>();
  const verifier = await createConfiguredAdmissionVerifier({ ...n.options, historyProtection: n.options.protection,
    initialize: true, initializeSpendHistory: false, initializeWitnessState: true,
    policyObservers: observers, policyObservationTransport: async (member, frame) => {
      challenges.add(frame.request.challenge);
      return createAdmissionPolicyHeadVote(frame.request, observed, observers,
        f.witnesses.find(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey)!, f.time);
    },
    witnessKey: f.witnesses[0], coordinatorKey: f.coordinators[0], witnessTransport: async (member, request) => {
      const i = f.witnesses.findIndex(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey);
      if (!i) throw new Error('fifth witness offline'); return n.witnesses[i].vote(request);
    } });
  cleanup.push(verifier.close);
  const binding = createAdmissionRequestBindingV2('search', { query: 'protected roles' });
  const token = await f.token(), capability = presentBlindAdmissionTokenV2(token, f.scope, 'search', binding);
  const context = { action: 'search' as const, requestBinding: binding, now: f.time };
  expect(await verifier.verifyAndSpend(capability, context)).toEqual({ status: 'accepted' });
  const sequences = n.stores.map(store => store.describe().sequence);
  expect(await verifier.verifyAndSpend(capability, context)).toEqual({ status: 'replay' });
  expect(challenges.size).toBe(2);
  expect(n.stores.map(store => store.describe().sequence)).toEqual(sequences);
  const second = await signAdmissionPolicy({ ...f.body, revision: 2 }, f.authority, f.authorityKey.secretKey);
  observed = (await createAdmissionPolicyAdvance(f.policy, second, observers, f.authorityKey)).commitment.next;
  await expect(verifier.verifyAndSpend(capability, context)).rejects.toThrow('newer');
  expect(n.stores.map(store => store.describe().sequence)).toEqual(sequences);
  verifier.close(); await n.reopen(); await n.history.ready();
  expect(n.history.read().image.state.spends).toHaveLength(1); expect(n.history.roleState().coordinator!.certificates).toHaveLength(2);
});

it('restores the same witness and coordinator keys after two actual generation agreements and loss of both owner directories', async () => {
  const { n, roles } = await fixture(); let role = roles();
  const accepted = [n.initial];
  for (let generation = 1; generation <= 2; generation++) {
    const c = n.claim(); accepted.push(c);
    await role.witness!.vote(createAdmissionWitnessRequest(c, f.coordinators[0])); await role.quorum!.authorize(c.issuerKey, c.spend, c);
    role.close();
    const restored = await n.recover(); expect(restored).toMatchObject({ generation, witnessVotes: accepted.length, coordinatorCertificates: accepted.length });
    role = roles();
    for (const old of accepted) {
      expect((await role.witness!.vote(createAdmissionWitnessRequest(old, f.coordinators[0]))).spend).toBe(old.spend);
      await role.quorum!.authorize(old.issuerKey, old.spend, old);
      await expect(role.witness!.vote(createAdmissionWitnessRequest({ ...old, requestBinding: `admreq_${'c'.repeat(86)}` }, f.coordinators[1]))).rejects.toThrow(/Conflicting/);
    }
  }
}, 30000);

it('replicates permanent role retirement and retains its fences through restored ownership and a backwards local clock', async () => {
  const { n, roles } = await fixture(), other = await witnessFixture(), entry = structuredClone(f.body.keys[0]);
  entry.profile.issuerPublicKey = other.policy.keys[0].profile.issuerPublicKey;
  const policy = await signAdmissionPolicy({ ...f.body, revision: 2, activeKey: admissionKeyFingerprint(entry.profile.issuerPublicKey),
    keys: [...f.body.keys, entry] }, f.authority, f.authorityKey.secretKey);
  n.time(f.policy.keys[0].retryUntil); await n.installPolicy(policy);
  for (const role of ['witness', 'coordinator'] as const) {
    const plan = n.history.planRoleRetirement(role, f.policy.activeKey);
    await expect(n.history.retireRole(role, f.policy.activeKey, 'wrong')).rejects.toThrow(/approval/);
    await n.history.retireRole(role, f.policy.activeKey, plan.approvalDigest);
  }
  n.time(f.time); const review = await n.recover(); expect(review).toMatchObject({ witnessVotes: 0, coordinatorCertificates: 0, rolePermanentDenials: 2 });
  const restored = roles();
  await expect(restored.witness!.vote(createAdmissionWitnessRequest(n.initial, f.coordinators[0]))).rejects.toThrow(/permanently retired/);
  await expect(restored.quorum!.authorize(n.initial.issuerKey, n.initial.spend, n.initial)).rejects.toThrow(/permanently retired/);
}, 20000);

it('runs real offline review and approved role capture commands without exposing private decisions', async () => {
  const { n } = await fixture(false); n.history.close();
  const privateFile = join(n.directory, 'owner-key.json'), keyFile = join(n.directory, 'storage.hex'), policyFile = join(n.directory, 'policy.json'), configFile = join(n.directory, 'owner-config.json');
  writeFileSync(privateFile, JSON.stringify({ publicKey: Buffer.from(n.owner.publicKey).toString('base64url'), secretKey: Buffer.from(n.owner.secretKey).toString('base64url') }), { mode: 0o600 });
  writeFileSync(keyFile, n.key.toString('hex'), { mode: 0o600 }); writeFileSync(policyFile, JSON.stringify(f.policy));
  writeFileSync(configFile, JSON.stringify({ version: 1, context: n.context, members: n.members, ownerKeyFile: privateFile }));
  const args = [configFile, policyFile, keyFile, n.options.directory, n.options.directory, 'both'];
  const script = fileURLToPath(new URL('../../../../scripts/admission-history.ts', import.meta.url));
  const childEnv = { ...process.env }; delete childEnv.RESONANCE_RELAY_STORAGE_SELECTION_FILE; delete childEnv.RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE;
  const cli = async (command: string, prefix: string[] = []) => {
    const output = await promisify(execFile)(process.execPath, ['--import', 'tsx', script, command, ...prefix, ...args], {
      timeout: 15000, maxBuffer: 1024 * 1024,
      env: childEnv });
    expect(output.stdout).not.toContain(n.initial.spend); expect(output.stdout).not.toContain(Buffer.from(n.owner.secretKey).toString('base64url'));
    return JSON.parse(output.stdout);
  };
  const before = readFileSync(join(n.options.directory, 'admission-witness-votes.json')), review = await cli('owner-role-capture-plan');
  expect(review).toMatchObject({ result: 'review-required', witnessVotes: 1, coordinatorCertificates: 1, fencedRoles: 0 });
  expect(readFileSync(join(n.options.directory, 'admission-witness-votes.json'))).toEqual(before);
  await expect(cli('owner-role-capture', ['--approve', 'wrong'])).rejects.toThrow();
  expect(readFileSync(join(n.options.directory, 'admission-witness-votes.json'))).toEqual(before);
  expect(await cli('owner-role-capture', ['--approve', review.approvalDigest])).toMatchObject({ result: 'admission-roles-protected', durableCopies: 4 });
  await n.reopen(); await n.history.ready(); expect(n.history.roleState().witness!.votes).toHaveLength(1);
}, 20000);

it('resumes a role capture after local fences and remote acceptance but before any reply, without re-enabling local votes', async () => {
  const { n } = await fixture(false), capture = await n.capture(), review = await capture.review();
  n.loseReplies(true, 1); await expect(capture.apply(review.approvalDigest)).rejects.toThrow(/Four/); capture.close();
  expect(n.history.read().pending).not.toBeNull();
  expect(() => createAdmissionWitness({ ...n.localOptions, signingKey: f.witnesses[0] })).toThrow(/invalid/);
  n.loseReplies(false); await n.reopen(); await n.history.ready();
  const retry = await n.capture(), current = await retry.review(); expect(current).toMatchObject({ fencedRoles: 2, alreadyCaptured: true });
  const head = n.history.read().applied; await retry.apply(current.approvalDigest); expect(n.history.read().applied).toEqual(head);
});

it('awaits four durable copies before a real relay socket sends the witness signature', async () => {
  const { n, roles } = await fixture(), role = roles();
  const server = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: join(n.directory, 'server'), admissionWitness: role.witness });
  await server.start(); cleanup.push(() => server.stop());
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  n.gate(async () => { enter(); await gate; });
  const c = n.claim(), controller = new AbortController(); cleanup.push(() => { release(); controller.abort(); });
  let replied = false;
  const response = requestAdmissionWitnessVote({ publicKey: Buffer.from(f.witnesses[0].publicKey).toString('base64url'), endpoint: `ws://127.0.0.1:${server.getListeningPort()}/` },
    createAdmissionWitnessRequest(c, f.coordinators[0]), controller.signal).then(value => { replied = true; return value; });
  await entered; expect(replied).toBe(false); expect(n.history.read().pending).not.toBeNull();
  release(); const vote = await response; expect(vote).toMatchObject({ spend: c.spend }); expect(n.history.read().pending).toBeNull();
}, 15000);
