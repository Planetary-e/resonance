import { afterEach, expect, it, vi } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import WebSocket from 'ws';
import { generateSigningKeyPair } from '@resonance/core';
import { createAdmissionPolicyHeadRequest, createAdmissionPolicyHeadVote, parseAdmissionPolicyHeadVote,
  parseAdmissionPolicyObservers, type AdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { listenAdmissionPolicyObserver, type AdmissionPolicyObservationFrame } from '../admission-policy-observation-transport.js';
import { createAdmissionPolicyObservationPool } from '../admission-policy-observation-pool.js';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
function hold() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); cleanup.push(release); return { promise, release }; }
async function fixture(options: { accountingFails?: boolean; lifetime?: number } = {}) {
  const keys = Array.from({ length: 5 }, generateSigningKeyPair), authority = generateSigningKeyPair();
  let context!: AdmissionPolicyObservers, calls = 0, sockets = 0, time = Date.now();
  let intercept: ((frame: AdmissionPolicyObservationFrame) => Promise<unknown>) | undefined;
  const listener = await listenAdmissionPolicyObserver(async value => {
    calls++; const frame = value as AdmissionPolicyObservationFrame;
    return intercept ? intercept(frame) : vote(frame);
  }, { allowSequentialRequests: true }); cleanup.push(listener.close);
  context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', authority: Buffer.from(authority.publicKey).toString('base64url'),
    genesis: { revision: 1, digest: 'a'.repeat(64), transition: 'a'.repeat(64) }, quorum: 4,
    members: keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: i ? `ws://127.0.0.1:${i}/policy-head` : listener.endpoint })) });
  const member = context.members.find(member => member.endpoint === listener.endpoint)!;
  const pool = createAdmissionPolicyObservationPool(context, { now: () => time, connectionLifetimeMs: options.lifetime,
    onSocket() { sockets++; if (options.accountingFails) throw new Error('Accounting unavailable'); } }); cleanup.push(pool.close);
  const vote = (frame: AdmissionPolicyObservationFrame, index = 0) => createAdmissionPolicyHeadVote(frame.request, context.genesis, context, keys[index], time);
  const request = (duration = 3000) => ({ request: createAdmissionPolicyHeadRequest(context, time, duration), advance: null });
  return { pool, context, member, request, vote, calls: () => calls, sockets: () => sockets,
    setTime(value: number) { time = value; }, intercept(value: typeof intercept) { intercept = value; } };
}

it('reuses one accounted connection while authenticating a distinct fresh challenge for every call', async () => {
  const n = await fixture(), first = n.request(), second = n.request(), signal = new AbortController().signal;
  const a = await n.pool.exchange(n.member, first, signal), b = await n.pool.exchange(n.member, second, signal);
  expect(first.request.challenge).not.toBe(second.request.challenge);
  expect(parseAdmissionPolicyHeadVote(a, first.request, n.context, first.request.issuedAt).observer).toBe(n.member.publicKey);
  expect(parseAdmissionPolicyHeadVote(b, second.request, n.context, second.request.issuedAt).observer).toBe(n.member.publicKey);
  expect(n.calls()).toBe(2); expect(n.sockets()).toBe(1); expect(n.pool.health()).toMatchObject({ connections: 1, busy: 0, maximumConnections: 10 });
  await n.pool.close(); expect(n.pool.health().connections).toBe(0);
});

it('keeps a busy primary independent from a bounded overflow and refuses a third connection', async () => {
  const n = await fixture(), first = hold(), second = hold(), entered = hold(); let calls = 0;
  n.intercept(async frame => { const index = calls++; if (calls === 2) entered.release(); await (index ? second : first).promise; return n.vote(frame); });
  const a = n.pool.exchange(n.member, n.request(), new AbortController().signal);
  const b = n.pool.exchange(n.member, n.request(), new AbortController().signal);
  await entered.promise;
  await expect(n.pool.exchange(n.member, n.request(), new AbortController().signal)).rejects.toThrow('capacity');
  expect(n.pool.health()).toMatchObject({ connections: 2, busy: 2 });
  second.release(); await b; expect(n.pool.health()).toMatchObject({ connections: 1, busy: 1 });
  first.release(); await a; expect(n.pool.health()).toMatchObject({ connections: 1, busy: 0 });
});

it('cancels one real socket without cancelling the other call and drains owned connections on close', async () => {
  const n = await fixture(), first = hold(), entered = hold(); let calls = 0;
  n.intercept(async frame => { if (++calls === 1) { entered.release(); await first.promise; } return n.vote(frame); });
  const abort = new AbortController(), a = n.pool.exchange(n.member, n.request(), abort.signal);
  const refusal = expect(a).rejects.toThrow('cancelled'); await entered.promise;
  const b = n.pool.exchange(n.member, n.request(), new AbortController().signal); abort.abort();
  await refusal; expect(await b).toBeTruthy(); expect(n.pool.health().connections).toBe(0);
  first.release(); await n.pool.close();
  await expect(n.pool.exchange(n.member, n.request(), new AbortController().signal)).rejects.toThrow('closed');
});

it.each(['foreign', 'replay', 'forged'] as const)('does not cache or return a %s response as fresh evidence', async invalid => {
  const n = await fixture(), previous = n.request(), old = n.vote(previous);
  await n.pool.exchange(n.member, previous, new AbortController().signal);
  n.intercept(async frame => invalid === 'foreign' ? n.vote(frame, 1) : invalid === 'replay' ? old : { ...n.vote(frame), signature: Buffer.alloc(64).toString('base64url') });
  await expect(n.pool.exchange(n.member, n.request(), new AbortController().signal)).rejects.toThrow();
  expect(n.pool.health()).toMatchObject({ connections: 0, busy: 0 });
});

it.each(['monotonic', 'wall-before', 'wall-after'] as const)('enforces the original %s request budget even before the timer callback', async expired => {
  const n = await fixture(), blocked = hold(), entered = hold(), frame = n.request();
  const clock = performance.now.bind(performance); let offset = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock() + offset);
  const signed = n.vote(frame); n.intercept(async () => { entered.release(); await blocked.promise; return signed; });
  const operation = n.pool.exchange(n.member, frame, new AbortController().signal), refusal = expect(operation).rejects.toThrow('expired');
  await entered.promise;
  if (expired === 'monotonic') offset = 3001;
  else n.setTime(expired === 'wall-before' ? frame.request.issuedAt - 1 : frame.request.expiresAt);
  blocked.release(); await refusal; expect(n.pool.health().connections).toBe(0);
});

it('refuses unpinned endpoints and update frames before creating a connection', async () => {
  const n = await fixture(), signal = new AbortController().signal;
  await expect(n.pool.exchange({ ...n.member, endpoint: 'ws://127.0.0.1:9/policy-head' }, n.request(), signal)).rejects.toThrow('pinned');
  await expect(n.pool.exchange(n.member, { ...n.request(), advance: {} } as AdmissionPolicyObservationFrame, signal)).rejects.toThrow('read-only');
  expect(n.sockets()).toBe(0); expect(n.calls()).toBe(0);
});

it('contains accounting failure before sending and drains the actual failed connection', async () => {
  const n = await fixture({ accountingFails: true });
  await expect(n.pool.exchange(n.member, n.request(), new AbortController().signal)).rejects.toThrow('accounting');
  expect(n.sockets()).toBe(1); expect(n.calls()).toBe(0); expect(n.pool.health().connections).toBe(0);
});

it('does not extend a reused connection lifetime and replaces an idle socket lacking the next request budget', async () => {
  const n = await fixture(), clock = performance.now.bind(performance); let offset = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock() + offset);
  await n.pool.exchange(n.member, n.request(), new AbortController().signal);
  offset = 8000;
  await n.pool.exchange(n.member, n.request(), new AbortController().signal);
  await nextTurn(); expect(n.sockets()).toBe(2); expect(n.pool.health().connections).toBe(1);
});

it.each(['cancel', 'monotonic', 'close'] as const)('rechecks successful overflow evidence after real close drainage when %s happens during it', async invalidation => {
  const n = await fixture(), first = hold(), entered = hold(), closingEvent = hold(); let calls = 0;
  n.intercept(async frame => { if (++calls === 1) { entered.release(); await first.promise; } return n.vote(frame); });
  const originalEmit = WebSocket.prototype.emit; let releaseClose: (() => void) | undefined;
  vi.spyOn(WebSocket.prototype, 'emit').mockImplementation(function (this: WebSocket, event: string | symbol, ...args: unknown[]) {
    if (event === 'close' && this.url === n.member.endpoint && !releaseClose) {
      releaseClose = () => { originalEmit.call(this, event, ...args); }; closingEvent.release(); return true;
    }
    return originalEmit.call(this, event, ...args);
  });
  const a = n.pool.exchange(n.member, n.request(), new AbortController().signal).then(() => 'accepted', () => 'refused');
  await entered.promise;
  const controller = new AbortController(), b = n.pool.exchange(n.member, n.request(), controller.signal);
  const refusal = expect(b).rejects.toThrow(/expired|cancelled/); await closingEvent.promise;
  expect(n.pool.health().connections).toBe(2); // A real close event is still needed to release the overflow slot.
  let closing: Promise<void> | undefined;
  if (invalidation === 'cancel') controller.abort();
  if (invalidation === 'monotonic') {
    const clock = performance.now.bind(performance); vi.spyOn(performance, 'now').mockImplementation(() => clock() + 3001);
  }
  if (invalidation === 'close') closing = n.pool.close();
  releaseClose!(); await refusal; first.release(); await a; await closing;
});
