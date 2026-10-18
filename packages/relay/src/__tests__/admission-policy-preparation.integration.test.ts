import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2 } from '@resonance/core';
import { openAdmissionPolicyStore } from '@resonance/core/admission-policy';
import { admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadVote, parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { policyTransferFixture } from '../../../core/src/__tests__/fixtures/policy-transfer-fixture.js';
import { createAdmissionPolicyFreshnessGate } from '../admission-policy-freshness-gate.js';
import type { AdmissionPolicyObservationTransport } from '../admission-policy-observation-transport.js';
import { createConfiguredAdmissionVerifier } from '../configured-admission-verifier.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';
import { protectedRoleFixture } from './fixtures/protected-role-fixture.js';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
let p: Awaited<ReturnType<typeof policyTransferFixture>>, f: Awaited<ReturnType<typeof witnessFixture>>;
beforeAll(async () => { [p, f] = await Promise.all([policyTransferFixture(), witnessFixture()]); });
afterAll(() => p.close());
function hold() {
  let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); cleanup.push(release);
  return { promise, release };
}
async function fixture(timeoutMs = 3000) {
  const directory = mkdtempSync(join(tmpdir(), 'prepared-policy-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let time = Date.now(), head = p.context.genesis;
  const key = randomBytes(32), store = await openAdmissionPolicyStore({ path: join(directory, 'policy.json'), encryptionKey: key,
    mode: 'create-new', now: () => time });
  cleanup.push(() => { store.close(); key.fill(0); }); await store.install(p.first, p.context.authority, { observers: p.context });
  const challenges: string[] = [], signals: AbortSignal[] = [];
  let intercept: AdmissionPolicyObservationTransport | undefined;
  const transport: AdmissionPolicyObservationTransport = async (member, frame, signal) => {
    challenges.push(frame.request.challenge); signals.push(signal);
    if (intercept) return intercept(member, frame, signal);
    return vote(member, frame, signal);
  };
  const vote: AdmissionPolicyObservationTransport = async (member, frame) => createAdmissionPolicyHeadVote(frame.request, head, p.context,
    p.keys.find(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey)!, time);
  const gate = createAdmissionPolicyFreshnessGate({ store, transport, timeoutMs, now: () => time }); cleanup.push(gate.close);
  return { gate, store, challenges, signals, vote, time: () => time, setTime(value: number) { time = value; },
    setHead(value: typeof head) { head = value; }, intercept(value: AdmissionPolicyObservationTransport) { intercept = value; } };
}

it('returns distinct caller evidence that remains valid after temporary collection cleanup and never reuses a query', async () => {
  const n = await fixture(), first = n.gate.prepare(), a = await first.ready; await first.drained;
  expect(n.signals.every(signal => signal.aborted)).toBe(true); expect(a).not.toThrow();
  const second = n.gate.prepare(), b = await second.ready; await second.drained;
  expect(a).not.toThrow(); expect(b).not.toThrow(); expect(a).not.toBe(b);
  expect(new Set(n.challenges).size).toBe(2);
  expect(n.gate.health()).toMatchObject({ operations: 0, observationOperations: 0, maximumOperations: 2 });
});

it.each(['monotonic', 'wall-before', 'wall-after', 'cancel', 'close', 'policy-current'] as const)(
  'checks detached evidence on every use after %s invalidation', async failure => {
    const n = await fixture(1000), controller = new AbortController(), prepared = n.gate.prepare(controller.signal);
    const check = await prepared.ready; await prepared.drained; expect(check).not.toThrow();
    if (failure === 'monotonic') {
      const clock = performance.now.bind(performance); vi.spyOn(performance, 'now').mockImplementation(() => clock() + 2000);
    }
    if (failure === 'wall-before') n.setTime(n.time() - 1000);
    if (failure === 'wall-after') n.setTime(n.time() + 1000);
    if (failure === 'cancel') controller.abort();
    if (failure === 'close') await n.gate.close();
    if (failure === 'policy-current') vi.spyOn(n.store, 'current').mockReturnValue({ ...p.first, expiresAt: n.time() });
    expect(check).toThrow();
  });

it('invalidates detached evidence when another caller durably observes a newer installed-policy floor', async () => {
  const n = await fixture(), prepared = n.gate.prepare(), check = await prepared.ready; await prepared.drained;
  n.setHead(p.advance.commitment.next);
  const next = n.gate.prepare(); await expect(next.ready).rejects.toThrow('newer'); await next.drained;
  expect(n.store.freshness()!.observed.revision).toBe(2); expect(check).toThrow();
});

it('retains a durable conflict and invalidates a prepared validator for the installed head', async () => {
  const n = await fixture();
  await n.store.install(p.second, p.context.authority, { observers: p.context, advance: p.advance }); n.setHead(p.advance.commitment.next);
  const prepared = n.gate.prepare(), check = await prepared.ready; await prepared.drained;
  n.setHead({ ...p.advance.commitment.next, digest: randomBytes(32).toString('hex') });
  const conflicting = n.gate.prepare(); await expect(conflicting.ready).rejects.toThrow(); await conflicting.drained;
  expect(n.store.freshness()!.conflict).toBeTruthy(); expect(check).toThrow();
});

it('makes four replies usable while an abort-ignoring fifth keeps its slot charged, leaving one witness run available', async () => {
  const n = await fixture(), blocked = hold(); let original: string | undefined;
  n.intercept(async (member, frame, signal) => {
    original ??= frame.request.challenge;
    if (frame.request.challenge === original && member.publicKey === p.context.members[4].publicKey) await blocked.promise;
    return n.vote(member, frame, signal);
  });
  const prepared = n.gate.prepare(), check = await prepared.ready; let drained = false;
  void prepared.drained.then(() => { drained = true; }); await nextTurn();
  expect(drained).toBe(false); expect(check).not.toThrow();
  expect(n.gate.health()).toMatchObject({ operations: 1, observationOperations: 1 });
  expect(await n.gate.run(async current => { current(); return 'witness authorized'; })).toBe('witness authorized');
  expect(n.gate.health().operations).toBe(1); expect(check).not.toThrow();
  let closed = false; const closing = n.gate.close().then(() => { closed = true; });
  await nextTurn(); expect(closed).toBe(false); expect(check).toThrow('closed');
  blocked.release(); await Promise.all([prepared.drained, closing]); expect(n.gate.health().operations).toBe(0);
});

it('shares the existing two collection slots and retains ignored cancellation until both preparations drain', async () => {
  const n = await fixture(), blocked = hold(), entered = hold(); let calls = 0;
  n.intercept(async (...args) => { if (++calls === 10) entered.release(); await blocked.promise; return n.vote(...args); });
  const a = new AbortController(), b = new AbortController(), first = n.gate.prepare(a.signal), second = n.gate.prepare(b.signal);
  const failures = Promise.all([expect(first.ready).rejects.toThrow(), expect(second.ready).rejects.toThrow()]);
  await entered.promise; a.abort(); b.abort(); await failures;
  expect(n.gate.health()).toMatchObject({ operations: 2, observationOperations: 2 });
  expect(() => n.gate.prepare()).toThrow('capacity'); await expect(n.gate.run(async () => 'forbidden')).rejects.toThrow('capacity');
  let closed = false; const closing = n.gate.close().then(() => { closed = true; }); await nextTurn(); expect(closed).toBe(false);
  blocked.release(); await Promise.all([first.drained, second.drained, closing]);
  expect(n.gate.health()).toMatchObject({ operations: 0, observationOperations: 0 });
});

it('keeps the original run slot and controller through its callback while prepared validators survive cleanup', async () => {
  const n = await fixture(), entered = hold(), callback = hold(); let oldCheck!: () => void;
  const running = n.gate.run(async check => { oldCheck = check; entered.release(); await callback.promise; check(); });
  await entered.promise; expect(oldCheck).not.toThrow(); expect(n.gate.health().operations).toBe(1);
  const prepared = n.gate.prepare(), detached = await prepared.ready; await prepared.drained;
  expect(detached).not.toThrow(); expect(oldCheck).not.toThrow(); expect(n.gate.health().operations).toBe(1);
  callback.release(); await running; expect(oldCheck).toThrow(); expect(detached).not.toThrow();
});

async function configured() {
  const n = await protectedRoleFixture(f); cleanup.push(n.close);
  const capture = await n.capture();
  try { await capture.apply((await capture.review()).approvalDigest); } finally { capture.close(); }
  n.history.close();
  const observers = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority: f.authority,
    genesis: admissionPolicyHead(f.policy), quorum: 4, members: f.body.keys[0].witnesses!.members });
  const blocked = hold(), entered = hold(), challenges = new Set<string>(); let firstSpend: string | undefined, peak = 0;
  let verifier!: Awaited<ReturnType<typeof createConfiguredAdmissionVerifier>>;
  verifier = await createConfiguredAdmissionVerifier({ ...n.options, historyProtection: n.options.protection,
    initialize: true, initializeSpendHistory: false, policyObservers: observers, witnessKey: f.witnesses[0], coordinatorKey: f.coordinators[0],
    policyObservationTransport: async (member, frame) => {
      challenges.add(frame.request.challenge); peak = Math.max(peak, verifier?.policyFreshnessHealth?.().operations ?? 0);
      return createAdmissionPolicyHeadVote(frame.request, observers.genesis, observers,
        f.witnesses.find(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey)!, f.time);
    }, witnessTransport: async (member, value) => {
      firstSpend ??= value.spend;
      const index = f.witnesses.findIndex(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey);
      if (index === 4) throw new Error('One remote witness offline; self is required');
      if (!index) return verifier.witness!.vote(value);
      if (value.spend === firstSpend) { entered.release(); await blocked.promise; }
      return n.witnesses[index].vote(value);
    } });
  cleanup.push(async () => { verifier.close(); await verifier.drainPolicyObservations(); });
  async function request(query: string) {
    const binding = createAdmissionRequestBindingV2('search', { query });
    return { capability: presentBlindAdmissionTokenV2(await f.token(), f.scope, 'search', binding),
      context: { action: 'search' as const, requestBinding: binding, now: f.time } };
  }
  return { n, verifier, challenges, request, blocked, entered, peak: () => peak };
}

it('prepares the next configured caller during the previous writer turn without starving its required self witness or repeating collection', async () => {
  const n = await configured(), [a, b] = await Promise.all([n.request('first'), n.request('second')]);
  expect(await n.verifier.verifyAndSpend({ ...a.capability, token: 'invalid' }, a.context)).toEqual({ status: 'rejected', reason: 'invalid_token' });
  expect(n.challenges.size).toBe(0); expect(n.verifier.admissionDecisionHealth!().operations).toBe(0);
  const first = n.verifier.verifyAndSpend(a.capability, a.context); await n.entered.promise;
  const second = n.verifier.verifyAndSpend(b.capability, b.context);
  await vi.waitFor(() => expect(n.challenges.size).toBe(3));
  expect(n.verifier.admissionDecisionHealth!().operations).toBe(2);
  n.blocked.release(); expect(await Promise.all([first, second])).toEqual([{ status: 'accepted' }, { status: 'accepted' }]);
  expect(n.challenges.size).toBe(4); expect(n.peak()).toBeLessThanOrEqual(2);
  n.verifier.close(); await n.verifier.drainPolicyObservations(); await n.n.reopen(); await n.n.history.ready();
  expect(n.n.history.read().image.state.spends).toHaveLength(2);
  expect(n.n.history.roleState().witness!.votes).toHaveLength(3);
  expect(n.n.history.roleState().coordinator!.certificates).toHaveLength(3);
}, 20000); // Includes role capture, two callers and durable reopening; observation deadlines stay at three seconds.

it.each(['expired', 'cancelled'] as const)('never commits a configured certificate or spend after the original caller is %s', async failure => {
  const n = await configured(), input = await n.request('no late compound commit');
  const clock = performance.now.bind(performance); let offset = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock() + offset);
  const operation = n.verifier.verifyAndSpend(input.capability, input.context), refused = expect(operation).rejects.toThrow();
  await n.entered.promise;
  // Ensure the required local witness has finished its existing durable vote;
  // only the later certificate/spend transaction is forbidden after cancellation.
  await vi.waitFor(() => expect(n.verifier.policyFreshnessHealth!().operations).toBe(0));
  let closing: Promise<void> | undefined;
  if (failure === 'expired') offset = 4000; else closing = n.verifier.drainPolicyObservations();
  n.blocked.release(); await refused; await closing;
  n.verifier.close(); await n.verifier.drainPolicyObservations(); await n.n.reopen(); await n.n.history.ready();
  expect(n.n.history.read().image.state.spends).toHaveLength(0);
  expect(n.n.history.roleState().coordinator!.certificates).toHaveLength(1);
  expect(n.n.history.roleState().witness!.votes).toHaveLength(2);
}, 15000); // Fixture/reopening allowance; the explicit four-second expiry jump remains unchanged.
