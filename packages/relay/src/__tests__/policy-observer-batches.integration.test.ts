import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createAdmissionPolicyHeadRequest, parseAdmissionPolicyHeadVote } from '@resonance/core/admission-policy-freshness';
import { createHistoryFreeze } from '@resonance/core/history-checkpoint';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { createAdmissionPolicyObserverExchange } from '../admission-policy-observation-transport.js';
import { openProtectedPolicyObserver } from '../protected-policy-observer.js';
import { HistoryLinkBudget } from '../history-relay-link.js';
import type { HistoryCheckpointTransport } from '../history-checkpoint-exchange.js';
import { policyObserverRestoreFixture } from './fixtures/policy-observer-restore-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
function hold() {
  let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); cleanup.push(release);
  return { promise, release };
}
async function fixture(maximumConcurrentObservations: 1 | 2 = 2) {
  const n = await policyObserverRestoreFixture(close => cleanup.push(close)); n.observer.close();
  const budget = new HistoryLinkBudget(), challenges: string[] = []; let peak = 0, refused = 0;
  let gate: Promise<void> | undefined, started!: () => void;
  const firstHead = new Promise<void>(resolve => { started = resolve; });
  const transport: HistoryCheckpointTransport = async (member, frame, signal) => {
    let release: () => void;
    try { release = budget.acquire(); } catch (error) { refused++; throw error; }
    peak = Math.max(peak, budget.usage().operations);
    try {
      if (frame.request.action === 'head') { challenges.push(frame.request.challenge); started(); if (gate) await gate; }
      return await n.transport(member, frame, signal);
    } finally { release(); }
  };
  let now = n.now;
  const observer = await openProtectedPolicyObserver({ ...n.options, transport, maximumConcurrentObservations, now: () => now, mode: 'open-existing' });
  cleanup.push(observer.close); await observer.ready(); peak = 0;
  const exchange = createAdmissionPolicyObserverExchange(observer, n.context, () => now);
  const request = (lifetime = 30000) => createAdmissionPolicyHeadRequest(n.context, now, lifetime);
  const frame = (lifetime = 30000) => ({ request: request(lifetime), advance: null });
  return { ...n, observer, exchange, request, frame, challenges, budget, firstHead,
    gate: (value?: Promise<void>) => { gate = value; }, setNow(value: number) { now = value; },
    get peak() { return peak; }, get refused() { return refused; } };
}

it('groups only pre-start callers, snapshots both nonces, and returns separately authenticated votes from one fresh quorum', async () => {
  const n = await fixture(), inputs = [n.frame(), n.frame()], originals = inputs.map(input => structuredClone(input.request));
  const pending = inputs.map(n.exchange); inputs[1].request.challenge = randomBytes(32).toString('base64url');
  const votes = await Promise.all(pending);
  votes.forEach((vote, i) => expect(parseAdmissionPolicyHeadVote(vote, originals[i], n.context, n.now).request).toEqual(originals[i]));
  expect(() => parseAdmissionPolicyHeadVote(votes[0], originals[1], n.context, n.now)).toThrow();
  expect(new Set(n.challenges).size).toBe(1); expect(n.challenges.length).toBeGreaterThanOrEqual(4); expect(n.challenges.length).toBeLessThanOrEqual(5);
  expect(n.peak).toBeLessThanOrEqual(5); expect(n.refused).toBe(0);
  expect(n.budget.usage()).toEqual({ bytes: 0, operations: 0 });
});

it('never joins a collection already started or reuses its completed result', async () => {
  const n = await fixture(), blocked = hold(); n.gate(blocked.promise);
  const first = n.exchange(n.frame()), second = n.exchange(n.frame()); await n.firstHead;
  const third = n.exchange(n.frame()); await nextTurn();
  expect(n.challenges).toHaveLength(4); expect(new Set(n.challenges).size).toBe(1);
  blocked.release(); await Promise.all([first, second, third]);
  expect(new Set(n.challenges).size).toBe(2);
  await n.exchange(n.frame()); expect(new Set(n.challenges).size).toBe(3);
});

it('validates the whole local batch before I/O and never admits peer-provided batch controls', async () => {
  const n = await fixture();
  expect(() => createAdmissionPolicyObserverExchange({ ...n.observer, maximumConcurrentObservations: 1 }, n.context)).toThrow('batch size');
  await expect(n.observer.observeBatch([n.request(), { ...n.request(), extra: true }])).rejects.toThrow();
  await expect(n.observer.observeBatch([n.request(), n.request(), n.request()])).rejects.toThrow('batch');
  await expect(n.exchange({ ...n.frame(), current: () => {} })).rejects.toThrow('frame');
  expect(n.challenges).toHaveLength(0);
  const checks = [() => {}, () => { throw new Error('local caller revoked'); }];
  const result = await n.observer.observeBatch([n.request(), n.request()], checks);
  expect(result.map(item => item.status)).toEqual(['fulfilled', 'rejected']);
  expect(new Set(n.challenges).size).toBe(1);
});

it.each([1, 2] as const)('counts logical batch callers against the existing %i-reader local cap', async maximum => {
  const n = await fixture(maximum), blocked = hold(); n.gate(blocked.promise);
  expect(n.observer.maximumObservationBatchSize).toBe(maximum);
  const requests = Array.from({ length: maximum }, () => n.request());
  const pending = n.observer.observeBatch(requests); await n.firstHead;
  await expect(n.observer.observe(n.request())).rejects.toThrow('already in progress');
  await expect(n.observer.observeBatch([n.request()])).rejects.toThrow('already in progress');
  await expect(n.observer.advance(n.advance)).rejects.toThrow('already in progress');
  await expect(n.observer.ready()).rejects.toThrow('already in progress');
  expect(() => n.observer.reviewRecoverySource()).toThrow('active');
  blocked.release(); expect((await pending).every(result => result.status === 'fulfilled')).toBe(true);
});

it('preserves a queued advance as an exclusive barrier between batches', async () => {
  const n = await fixture(), blocked = hold(); n.gate(blocked.promise);
  const before = [n.exchange(n.frame()), n.exchange(n.frame())];
  const update = n.exchange({ request: n.request(), advance: n.advance });
  const after = [n.exchange(n.frame()), n.exchange(n.frame())];
  await n.firstHead; expect(n.observer.policy().revision).toBe(1); expect(n.challenges).toHaveLength(4);
  blocked.release();
  for (const reply of await Promise.all(before)) expect((reply as any).head).toEqual(n.context.genesis);
  expect((await update as any).head).toEqual(n.advance.commitment.next);
  for (const reply of await Promise.all(after)) expect((reply as any).head).toEqual(n.advance.commitment.next);
  expect(new Set(n.challenges).size).toBe(3); // Before, update's independent observation, after.
});

it('keeps all eight callers charged during blocked work and refuses the ninth before more history traffic', async () => {
  const n = await fixture(), blocked = hold(); n.gate(blocked.promise);
  const pending = Array.from({ length: 8 }, () => n.exchange(n.frame()));
  await n.firstHead; expect(n.challenges).toHaveLength(4);
  await expect(n.exchange(n.frame())).rejects.toThrow('queue is full');
  await nextTurn(); expect(n.challenges).toHaveLength(4);
  blocked.release(); await Promise.all(pending);
  expect(new Set(n.challenges).size).toBe(4); expect(n.refused).toBe(0);
  await n.exchange(n.frame()); expect(new Set(n.challenges).size).toBe(5);
});

it('checks original monotonic queue budgets under frozen wall time without poisoning a live neighbor', async () => {
  const n = await fixture(), blocked = hold(); n.gate(blocked.promise);
  const clock = performance.now.bind(performance); let offset = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock() + offset);
  const first = n.exchange(n.frame()), second = n.exchange(n.frame()); await n.firstHead;
  const expired = expect(n.exchange(n.frame(100))).rejects.toThrow('expired in observer queue');
  const live = n.exchange(n.frame()); offset = 200;
  blocked.release(); await Promise.all([first, second, live, expired]);
  expect(new Set(n.challenges).size).toBe(2); // Expired caller caused no new collection.
});

it('checks each original monotonic deadline before signing a batched vote even when wall time is frozen', async () => {
  const n = await fixture(), blocked = hold(); n.gate(blocked.promise);
  const clock = performance.now.bind(performance); let offset = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock() + offset);
  const expired = expect(n.exchange(n.frame(100))).rejects.toThrow('expired in observer queue');
  const live = n.exchange(n.frame()); await n.firstHead; offset = 200; blocked.release();
  await expired; expect((await live as any).head).toEqual(n.context.genesis);
  expect(new Set(n.challenges).size).toBe(1);
});

it.each(['close', 'freeze', 'quorum-loss', 'policy-expiry', 'fence', 'conflict'] as const)('cannot obtain a usable batch after %s', async failure => {
  const n = await fixture();
  if (failure === 'fence') await (await import('../protected-policy-observer.js')).fencePolicyObserverRecoverySource(n.observer.reviewRecoverySource());
  if (failure === 'conflict') {
    await n.observer.advance(n.advance);
    await expect(n.observer.advance(n.conflict)).rejects.toThrow('equivocated');
  }
  if (failure === 'freeze') {
    const frozen = createHistoryFreeze(n.enrolled.context, 0, 1, randomBytes(32).toString('base64url'), n.owner);
    n.stores.slice(0, 4).forEach(store => store.freeze(frozen));
  }
  if (failure === 'quorum-loss') n.online(3);
  if (failure === 'policy-expiry') n.setNow(n.first.expiresAt);
  if (failure === 'close') {
    const blocked = hold(); n.gate(blocked.promise);
    const pending = [n.exchange(n.frame()), n.exchange(n.frame())].map(promise => expect(promise).rejects.toThrow());
    await n.firstHead; await nextTurn(); expect(n.budget.usage().operations).toBe(4);
    n.observer.close(); await Promise.all(pending);
    expect(n.budget.usage().operations).toBe(4); // Ignoring Abort cannot release a running adapter's reservation.
    blocked.release(); await nextTurn(); expect(n.budget.usage().operations).toBe(0); return;
  }
  const requests = [n.frame(), n.frame()];
  await Promise.all(requests.map(request => expect(n.exchange(request)).rejects.toThrow()));
});

it('refuses a coherent stale owner backup for both callers despite its retained old write receipt', async () => {
  const n = await fixture(), directory = join(n.directory, 'stale-owner');
  n.observer.close(); cpSync(n.options.directory, directory, { recursive: true });
  const current = await openProtectedPolicyObserver({ ...n.options, mode: 'open-existing' }); cleanup.push(current.close);
  await current.ready(); await current.advance(n.advance); current.close();
  const stale = await openProtectedPolicyObserver({ ...n.options, directory, mode: 'open-existing' }); cleanup.push(stale.close);
  await expect(stale.observeBatch([n.request(), n.request()])).rejects.toThrow('Four');
});

it('refuses both batched callers while a durable update remains pending without confirmed write receipts', async () => {
  const n = await fixture(); n.loseReplies(true);
  await expect(n.observer.advance(n.advance)).rejects.toThrow('Four');
  await nextTurn();
  expect(n.observer.status().pending).toBe(true);
  expect(n.budget.usage().operations).toBe(0);
  const heads = n.challenges.length;
  const outcomes = await Promise.allSettled([n.exchange(n.frame()), n.exchange(n.frame())]);
  expect(outcomes.every(result => result.status === 'rejected' && /pending/.test(String(result.reason)))).toBe(true);
  expect(n.observer.status().pending).toBe(true);
  expect(n.challenges).toHaveLength(heads);
});
