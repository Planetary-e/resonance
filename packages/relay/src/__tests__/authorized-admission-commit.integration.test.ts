import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2, verifyBlindAdmissionTokenV2 } from '@resonance/core';
import { admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadVote, parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import type { AdmissionSpendLedger, AdmissionSpendRecord } from '../admission-spend-history.js';
import { createLocalBlindAdmissionVerifierV2 } from '../blind-admission-verifier.js';
import { createAdmissionDecisionQueue } from '../admission-decision-queue.js';
import { createProtectedAdmissionRoles } from '../protected-admission-roles.js';
import { createConfiguredAdmissionVerifier } from '../configured-admission-verifier.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';
import { protectedRoleFixture } from './fixtures/protected-role-fixture.js';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
let f: Awaited<ReturnType<typeof witnessFixture>>;
beforeAll(async () => { f = await witnessFixture(); });
function hold() {
  let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); cleanup.push(release);
  return { promise, release };
}
async function request(token?: Awaited<ReturnType<typeof f.token>>, query = 'atomic protected admission') {
  token ??= await f.token();
  const binding = createAdmissionRequestBindingV2('search', { query });
  return { token, capability: presentBlindAdmissionTokenV2(token, f.scope, 'search', binding),
    context: { action: 'search' as const, requestBinding: binding, now: f.time } };
}
function memory() {
  const rows = new Map<string, AdmissionSpendRecord>(); let writes = 0;
  const history: AdmissionSpendLedger = {
    size: () => rows.size, get: spend => rows.get(spend), isRetired: () => false,
    write(row) { writes++; rows.set(row.spend, structuredClone(row)); }, close() {},
  };
  return { rows, history, get writes() { return writes; },
    options: { directory: '.', scope: f.scope, issuerPublicKey: f.keys.publicKey, history } };
}
async function protectedFixture() {
  const n = await protectedRoleFixture(f); cleanup.push(n.close);
  const capture = await n.capture();
  try { await capture.apply((await capture.review()).approvalDigest); } finally { capture.close(); }
  return n;
}

it('keeps accepted/replay dispositions and invokes an authorization override even for an attributed replay', async () => {
  const n = memory(), input = await request(); let commits = 0;
  const verifier = createLocalBlindAdmissionVerifierV2({ ...n.options,
    async withSpendCommit(_spend, _context, _key, finish) {
      return finish(async row => { commits++; await n.history.write(row); });
    } }); cleanup.push(verifier.close);
  expect(await verifier.verifyAndSpend(input.capability, input.context)).toEqual({ status: 'accepted' });
  expect(await verifier.verifyAndSpend(input.capability, input.context)).toEqual({ status: 'replay' });
  expect(n.rows.size).toBe(1); expect(commits).toBe(2);
  const conflicting = await request(input.token, 'conflicting binding');
  expect(await verifier.verifyAndSpend(conflicting.capability, conflicting.context)).toEqual({ status: 'rejected', reason: 'double_spend' });
  expect(commits).toBe(2);
});

it('preserves the ordinary beforeSpend path and refuses ambiguous hook configuration', async () => {
  const n = memory(), input = await request(); let hooks = 0;
  const beforeSpend = async () => { hooks++; };
  const verifier = createLocalBlindAdmissionVerifierV2({ ...n.options, beforeSpend }); cleanup.push(verifier.close);
  expect(await verifier.verifyAndSpend(input.capability, input.context)).toEqual({ status: 'accepted' });
  expect(await verifier.verifyAndSpend(input.capability, input.context)).toEqual({ status: 'replay' });
  expect(hooks).toBe(2); expect(n.writes).toBe(1);
  expect(() => createLocalBlindAdmissionVerifierV2({ ...n.options, beforeSpend,
    withSpendCommit: (_spend, _context, _key, finish) => finish() })).toThrow('mutually exclusive');
});

it.each(['expired', 'cancelled'] as const)('does not begin the final override after the original decision is %s', async failure => {
  const n = memory(), input = await request(), queue = createAdmissionDecisionQueue(), blocked = hold(), entered = hold();
  cleanup.push(() => queue.close());
  const clock = performance.now.bind(performance); let offset = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock() + offset);
  const verifier = createLocalBlindAdmissionVerifierV2({ ...n.options, withDecision: queue.run,
    async withSpendCommit(_spend, _context, _key, finish) {
      entered.release(); await blocked.promise; return finish(row => n.history.write(row));
    } }); cleanup.push(verifier.close);
  const operation = verifier.verifyAndSpend(input.capability, input.context);
  const refused = expect(operation).rejects.toThrow('cancelled or timed out'); await entered.promise;
  let closing: Promise<void> | undefined;
  if (failure === 'expired') offset = 4000; else closing = queue.close();
  blocked.release(); await refused; await closing; await nextTurn();
  expect(n.writes).toBe(0); expect(n.rows.size).toBe(0); expect(queue.health().operations).toBe(0);
});

it('rechecks the freshness validator inside finish before an authorization override can write', async () => {
  const n = memory(), input = await request(); let expired = false;
  const verifier = createLocalBlindAdmissionVerifierV2({ ...n.options,
    withCurrentPolicy: operation => operation(() => { if (expired) throw new Error('Original policy evidence expired'); }),
    async withSpendCommit(_spend, _context, _key, finish) { expired = true; return finish(row => n.history.write(row)); },
  }); cleanup.push(verifier.close);
  await expect(verifier.verifyAndSpend(input.capability, input.context)).rejects.toThrow('Original policy evidence expired');
  expect(n.writes).toBe(0);
});

it('keeps authorize durable and holds the coordinator guard until the certificate callback has settled', async () => {
  const n = await protectedFixture();
  const roles = createProtectedAdmissionRoles({ history: n.history, coordinatorKey: f.coordinators[0], now: () => f.time,
    transport: async (member, value) => {
      const i = f.witnesses.findIndex(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey);
      if (!i) throw new Error('self offline'); return n.witnesses[i].vote(value);
    } }); cleanup.push(roles.close);
  const first = n.claim(), before = n.history.read().applied!.sequence;
  await roles.quorum!.authorize(first.issuerKey, first.spend, first);
  expect(n.history.read().applied!.sequence).toBe(before + 1);
  expect(n.history.roleState().coordinator!.certificates).toHaveLength(2);
  const blocked = hold(), entered = hold(), second = n.claim();
  const operation = roles.quorum!.withCertificate(second.issuerKey, second.spend, second, async certificate => {
    expect(certificate.votes[0].spend).toBe(second.spend); entered.release(); await blocked.promise; return 'late';
  });
  const refused = expect(operation).rejects.toThrow('closed'); await entered.promise;
  await expect(roles.quorum!.authorize(second.issuerKey, second.spend, second)).rejects.toThrow('in progress');
  roles.close(); blocked.release(); await refused;
  expect(n.history.read().applied!.sequence).toBe(before + 1);
  expect(n.history.roleState().coordinator!.certificates).toHaveLength(2);
});

it('waits for its own durable witness vote before entering the combined commit', async () => {
  const n = await protectedFixture();
  const roles = createProtectedAdmissionRoles({ history: n.history, witnessKey: f.witnesses[0], coordinatorKey: f.coordinators[0], now: () => f.time,
    transport: async (member, value) => {
      const i = f.witnesses.findIndex(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey);
      return i ? n.witnesses[i].vote(value) : roles.witness!.vote(value);
    } }); cleanup.push(roles.close);
  const blocked = hold(), entered = hold(), claim = n.claim(), before = n.history.read().applied!.sequence;
  n.gate(async () => { entered.release(); await blocked.promise; });
  let committing = false;
  const operation = roles.quorum!.withCertificate(claim.issuerKey, claim.spend, claim, async certificate => {
    committing = true;
    expect(n.history.roleState().witness!.votes).toHaveLength(2);
    expect(n.history.read().applied!.sequence).toBe(before + 1);
    await n.history.writeAuthorizedSpend({ spend: claim.spend, action: claim.action, binding: claim.requestBinding, issuerKey: claim.issuerKey }, certificate);
  });
  await entered.promise; await nextTurn(); expect(committing).toBe(false);
  blocked.release(); await operation;
  expect(committing).toBe(true); expect(n.history.read().applied!.sequence).toBe(before + 2);
  expect(n.history.read().image.state.spends).toHaveLength(1);
  expect(n.history.roleState().coordinator!.certificates).toHaveLength(2);
});

it('reuses the exact pending composite certificate through the protected coordinator callback', async () => {
  const n = await protectedFixture(), claim = n.claim();
  const roles = createProtectedAdmissionRoles({ history: n.history, coordinatorKey: f.coordinators[0], now: () => f.time,
    transport: async (member, value) => {
      const i = f.witnesses.findIndex(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey);
      if (!i) throw new Error('self offline'); return n.witnesses[i].vote(value);
    } }); cleanup.push(roles.close);
  const row = { spend: claim.spend, action: claim.action, binding: claim.requestBinding, issuerKey: claim.issuerKey };
  n.loseReplies(true);
  await expect(roles.quorum!.withCertificate(claim.issuerKey, claim.spend, claim,
    certificate => n.history.writeAuthorizedSpend(row, certificate))).rejects.toThrow('Four');
  const pending = n.history.read().pending!, retained = n.history.pendingRoleDecision();
  expect(retained?.kind).toBe('coordinator-certificate');
  if (retained?.kind !== 'coordinator-certificate') throw new Error('Missing pending certificate');
  n.loseReplies(false);
  await roles.quorum!.withCertificate(claim.issuerKey, claim.spend, claim, certificate => {
    expect(certificate).toEqual(retained.certificate); return n.history.writeAuthorizedSpend(row, certificate);
  });
  expect(n.history.read().pending).toBeNull(); expect(n.history.read().applied!.sequence).toBe(pending.sequence);
  expect(n.history.read().image.state.spends).toHaveLength(1);
});

it.each(['new', 'historical'] as const)('persists one configured protected delta for a %s spend and keeps retries and conflicts correct', async mode => {
  const n = await protectedFixture(), input = await request();
  if (mode === 'historical') {
    const spend = await verifyBlindAdmissionTokenV2(input.capability, f.scope, 'search', input.context.requestBinding, f.keys.publicKey);
    expect(spend).toBeTruthy();
    await n.history.write({ spend: spend!, action: 'search', binding: input.context.requestBinding, issuerKey: f.policy.activeKey });
    expect(n.history.roleState().coordinator!.certificates).toHaveLength(1); // No certificate for this historical attributed spend.
  }
  const before = n.history.read().applied!.sequence; n.history.close();
  const observers = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority: f.authority,
    genesis: admissionPolicyHead(f.policy), quorum: 4, members: f.body.keys[0].witnesses!.members });
  const challenges = new Set<string>(); let witnessRequests = 0;
  const verifier = await createConfiguredAdmissionVerifier({ ...n.options, historyProtection: n.options.protection,
    initialize: true, initializeSpendHistory: false, policyObservers: observers, coordinatorKey: f.coordinators[0],
    policyObservationTransport: async (member, frame) => {
      challenges.add(frame.request.challenge);
      return createAdmissionPolicyHeadVote(frame.request, observers.genesis, observers,
        f.witnesses.find(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey)!, f.time);
    }, witnessTransport: async (member, value) => {
      witnessRequests++;
      const i = f.witnesses.findIndex(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey);
      if (!i) throw new Error('self offline'); return n.witnesses[i].vote(value);
    } });
  cleanup.push(async () => { verifier.close(); await verifier.drainPolicyObservations(); });
  expect(await verifier.verifyAndSpend({ ...input.capability, token: 'invalid' }, input.context)).toEqual({ status: 'rejected', reason: 'invalid_token' });
  expect(challenges.size).toBe(0); expect(witnessRequests).toBe(0);
  expect(await verifier.verifyAndSpend(input.capability, input.context)).toEqual({ status: mode === 'new' ? 'accepted' : 'replay' });
  expect(Math.max(...n.stores.map(store => store.describe().sequence))).toBe(before + 1);
  expect(await verifier.verifyAndSpend(input.capability, input.context)).toEqual({ status: 'replay' });
  expect(Math.max(...n.stores.map(store => store.describe().sequence))).toBe(before + 1);
  const beforeConflict = witnessRequests;
  const conflicting = await request(input.token, 'configured conflicting spend');
  expect(await verifier.verifyAndSpend(conflicting.capability, conflicting.context)).toEqual({ status: 'rejected', reason: 'double_spend' });
  expect(challenges.size).toBe(3); // Each valid token gets a fresh preflight before the serialized conflict lookup.
  expect(witnessRequests).toBe(beforeConflict);
  expect(Math.max(...n.stores.map(store => store.describe().sequence))).toBe(before + 1);
  verifier.close(); await verifier.drainPolicyObservations(); await n.reopen(); await n.history.ready();
  expect(n.history.read().applied!.sequence).toBe(before + 1);
  expect(n.history.read().image.state.spends).toHaveLength(1);
  expect(n.history.roleState().coordinator!.certificates).toHaveLength(2);
});
