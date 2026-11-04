import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { connect } from 'node:net';
import WebSocket from 'ws';
import { generateSigningKeyPair } from '@resonance/core';
import { createAdmissionPolicyHeadRequest, createAdmissionPolicyHeadVote, parseAdmissionPolicyHeadVote,
  parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { createAdmissionPolicyObserverExchange, listenAdmissionPolicyObserver,
  ADMISSION_POLICY_OBSERVATION_MAX_BYTES } from '../admission-policy-observation-transport.js';

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); vi.restoreAllMocks(); });
function hold() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); cleanup.push(release); return { promise, release }; }
async function fixture(options: Parameters<typeof listenAdmissionPolicyObserver>[1] = {}) {
  const keys = Array.from({ length: 5 }, generateSigningKeyPair); cleanup.push(() => keys.forEach(key => key.secretKey.fill(0)));
  const received: unknown[] = [], observed: string[] = []; let current = 0, peak = 0;
  let intercept: ((value: unknown) => Promise<void>) | undefined;
  let exchange!: (value: unknown) => Promise<unknown>;
  const listener = await listenAdmissionPolicyObserver(async value => {
    received.push(value); await intercept?.(value); return exchange(value);
  }, { allowSequentialRequests: true, ...options, onSocket(socket) {
    peak = Math.max(peak, ++current); socket.once('close', () => { current--; }); options.onSocket?.(socket);
  } }); cleanup.push(listener.close);
  const context = parseAdmissionPolicyObservers({ version: 1, kind: 'admission-policy-observers', quorum: 4,
    authority: Buffer.from(keys[0].publicKey).toString('base64url'),
    genesis: { revision: 1, digest: 'a'.repeat(64), transition: 'a'.repeat(64) },
    members: keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'),
      endpoint: i ? `ws://127.0.0.1:${30000 + i}/policy-head` : listener.endpoint })) });
  exchange = createAdmissionPolicyObserverExchange({ async advance() { throw new Error('No updates in listener fixture'); }, observe(value) {
    const vote = createAdmissionPolicyHeadVote(value, context.genesis, context, keys[0]); observed.push(vote.request.challenge); return vote;
  } }, context);
  return { listener, context, received, observed, current: () => current, peak: () => peak,
    frame: () => ({ request: createAdmissionPolicyHeadRequest(context), advance: null }),
    intercept(value: (frame: unknown) => Promise<void>) { intercept = value; } };
}
async function open(endpoint: string) {
  const socket = new WebSocket(endpoint); socket.on('error', () => {}); cleanup.push(() => socket.terminate());
  await once(socket, 'open'); return socket;
}
async function reply(socket: WebSocket, frame: unknown) {
  const received = once(socket, 'message'); socket.send(JSON.stringify(frame));
  const [data, binary] = await received; expect(binary).toBe(false); return JSON.parse(data.toString());
}

it('opts in locally and returns separately authenticated fresh challenges through sequential frames on one socket', async () => {
  const n = await fixture(), socket = await open(n.listener.endpoint), first = n.frame(), second = n.frame();
  const a = await reply(socket, first), b = await reply(socket, second);
  expect(parseAdmissionPolicyHeadVote(a, first.request, n.context, Date.now()).request).toEqual(first.request);
  expect(parseAdmissionPolicyHeadVote(b, second.request, n.context, Date.now()).request).toEqual(second.request);
  expect(() => parseAdmissionPolicyHeadVote(a, second.request, n.context, Date.now())).toThrow();
  expect(n.observed).toEqual([first.request.challenge, second.request.challenge]); expect(n.peak()).toBe(1);
  expect(socket.readyState).toBe(WebSocket.OPEN);
});

it('preserves the default one-use connection behavior', async () => {
  const n = await fixture({ allowSequentialRequests: false }), socket = await open(n.listener.endpoint), closed = once(socket, 'close');
  await reply(socket, n.frame()); const [code] = await closed;
  expect(code).toBe(1000); expect(n.received).toHaveLength(1);
});

it('refuses busy pipelining without starting another exchange and drains the admitted work on shutdown', async () => {
  const n = await fixture(), blocked = hold(), entered = hold();
  n.intercept(async () => { entered.release(); await blocked.promise; });
  const socket = await open(n.listener.endpoint); socket.send(JSON.stringify(n.frame())); await entered.promise;
  const closed = once(socket, 'close'); socket.send(JSON.stringify(n.frame())); await closed;
  expect(n.received).toHaveLength(1); expect(n.observed).toHaveLength(0);
  let drained = false; const closing = n.listener.close().then(() => { drained = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); expect(drained).toBe(false);
  blocked.release(); await closing; expect(n.observed).toHaveLength(1);
});

it('keeps the original absolute connection lifetime after successive replies', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const n = await fixture({ connectionTimeoutMs: 1000 }), socket = await open(n.listener.endpoint);
  await vi.advanceTimersByTimeAsync(600); await reply(socket, n.frame());
  await vi.advanceTimersByTimeAsync(350); await reply(socket, n.frame());
  const closed = once(socket, 'close'); await vi.advanceTimersByTimeAsync(51); await closed;
  expect(n.received).toHaveLength(2);
});

it('checks acceptNewWork for every reusable frame', async () => {
  let checks = 0; const n = await fixture({ acceptNewWork: () => ++checks === 1 }), socket = await open(n.listener.endpoint);
  await reply(socket, n.frame()); const closed = once(socket, 'close'); socket.send(JSON.stringify(n.frame())); await closed;
  expect(checks).toBe(2); expect(n.received).toHaveLength(1);
});

it.each(['binary', 'malformed', 'oversized'] as const)('preserves the %s frame boundary after a successful reusable reply', async fault => {
  const n = await fixture(), socket = await open(n.listener.endpoint); await reply(socket, n.frame());
  const closed = once(socket, 'close');
  socket.send(fault === 'binary' ? Buffer.from('{}') : fault === 'malformed' ? '{' : 'x'.repeat(ADMISSION_POLICY_OBSERVATION_MAX_BYTES + 1));
  await closed; expect(n.observed).toHaveLength(1);
});

it('retires the oldest of seven idle sockets so a new owner progresses within the physical eight-connection cap', async () => {
  const n = await fixture(), sockets: WebSocket[] = [];
  for (let i = 0; i < 7; i++) { const socket = await open(n.listener.endpoint); await reply(socket, n.frame()); sockets.push(socket); }
  expect(sockets.every(socket => socket.readyState === WebSocket.OPEN)).toBe(true);
  const oldestClosed = once(sockets[0], 'close'), incoming = await open(n.listener.endpoint);
  await reply(incoming, n.frame()); await oldestClosed;
  expect(sockets.slice(1).every(socket => socket.readyState === WebSocket.OPEN)).toBe(true);
  expect(incoming.readyState).toBe(WebSocket.OPEN); expect(n.observed).toHaveLength(8);
  expect(n.peak()).toBeLessThanOrEqual(8); expect(n.current()).toBe(7);
});

it('evicts only completed idle sockets among active work and refuses a ninth when all eight are active', async () => {
  const n = await fixture(), idle = await open(n.listener.endpoint); await reply(idle, n.frame());
  const idleClosed = once(idle, 'close'), blocked = hold(); n.intercept(async () => { await blocked.promise; });
  const active: WebSocket[] = [];
  for (let i = 0; i < 7; i++) { const socket = await open(n.listener.endpoint); socket.send(JSON.stringify(n.frame())); active.push(socket); }
  await idleClosed;
  const eighth = await open(n.listener.endpoint); eighth.send(JSON.stringify(n.frame())); active.push(eighth);
  await vi.waitFor(() => expect(n.received).toHaveLength(9)); // One completed idle plus eight active requests.
  const extra = new WebSocket(n.listener.endpoint); extra.on('error', () => {}); cleanup.push(() => extra.terminate());
  await expect(once(extra, 'open')).rejects.toThrow();
  expect(active.every(socket => socket.readyState === WebSocket.OPEN)).toBe(true);
  expect(n.peak()).toBeLessThanOrEqual(8); expect(n.received).toHaveLength(9);
  const replies = active.map(socket => once(socket, 'message')); blocked.release(); await Promise.all(replies);
});

it('never evicts raw sockets and retains the original raw connection limit', async () => {
  const n = await fixture(), port = Number(new URL(n.listener.endpoint).port), raw = [];
  for (let i = 0; i < 8; i++) {
    const socket = connect({ host: '127.0.0.1', port }); socket.on('error', () => {}); cleanup.push(() => socket.destroy());
    await once(socket, 'connect'); raw.push(socket);
  }
  const extra = new WebSocket(n.listener.endpoint); extra.on('error', () => {}); cleanup.push(() => extra.terminate());
  await expect(once(extra, 'open')).rejects.toThrow();
  expect(raw.every(socket => !socket.destroyed)).toBe(true); expect(n.peak()).toBe(8); expect(n.received).toHaveLength(0);
});

it('never evicts an upgraded socket that has not completed a request', async () => {
  const n = await fixture(), unused: WebSocket[] = [];
  for (let i = 0; i < 8; i++) unused.push(await open(n.listener.endpoint));
  const extra = new WebSocket(n.listener.endpoint); extra.on('error', () => {}); cleanup.push(() => extra.terminate());
  await expect(once(extra, 'open')).rejects.toThrow();
  expect(unused.every(socket => socket.readyState === WebSocket.OPEN)).toBe(true);
  expect(n.peak()).toBe(8); expect(n.received).toHaveLength(0);
});

it('keeps limit one effectively one-use and drains idle and active sockets during idempotent shutdown', async () => {
  const one = await fixture({ maxConnections: 1 }), single = await open(one.listener.endpoint), singleClosed = once(single, 'close');
  await reply(single, one.frame()); await singleClosed; expect(one.observed).toHaveLength(1);
  const n = await fixture(), idle = await open(n.listener.endpoint); await reply(idle, n.frame());
  const blocked = hold(), entered = hold(); n.intercept(async () => { entered.release(); await blocked.promise; });
  const active = await open(n.listener.endpoint); active.send(JSON.stringify(n.frame())); await entered.promise;
  const idleClosed = once(idle, 'close'), activeClosed = once(active, 'close'); let drained = false;
  const closing = n.listener.close(); expect(n.listener.close()).toBe(closing); void closing.then(() => { drained = true; });
  await Promise.all([idleClosed, activeClosed]); expect(drained).toBe(false);
  blocked.release(); await closing; expect(n.current()).toBe(0); expect(n.observed).toHaveLength(2);
});
