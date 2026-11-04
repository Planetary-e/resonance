import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { createAdmissionPolicyAdvance, admissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHeadRequest, createAdmissionPolicyHeadVote, parseAdmissionPolicyHeadCertificate, parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { signAdmissionPolicy } from '@resonance/core/admission-policy';
import { openAdmissionPolicyObserver } from '../admission-policy-observer.js';
import { collectAdmissionPolicyObservation } from '../admission-policy-observation.js';
import { createAdmissionPolicyObserverExchange, exchangeAdmissionPolicyObservation, listenAdmissionPolicyObserver, policyObservationFailureCategory,
  ADMISSION_POLICY_OBSERVATION_MAX_BYTES } from '../admission-policy-observation-transport.js';
import { policyObserverFixture } from './fixtures/policy-observer-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function network() {
  const n = await policyObserverFixture(); cleanup.push(n.close);
  type Handler = (frame: unknown) => Promise<unknown>;
  const handlers: Handler[] = [], online = Array(5).fill(true), received = Array(5).fill(0);
  const servers: Array<Awaited<ReturnType<typeof listenAdmissionPolicyObserver>>> = [];
  for (let i = 0; i < 5; i++) {
    const server = await listenAdmissionPolicyObserver(value => { received[i]++; if (!online[i]) throw new Error('Offline fixture'); return handlers[i](value); });
    cleanup.push(server.close); servers.push(server);
  }
  const context = parseAdmissionPolicyObservers({ ...n.context, members: n.keys.map((key, i) => ({ publicKey: Buffer.from(key.publicKey).toString('base64url'), endpoint: servers[i].endpoint })) });
  const observers: Array<Awaited<ReturnType<typeof openAdmissionPolicyObserver>>> = [];
  for (let i = 0; i < 5; i++) {
    const observer = await openAdmissionPolicyObserver({ ...n.options, context, path: `${n.options.path}.${i}`, signingKey: n.keys[i], mode: 'create-new' });
    observers.push(observer); handlers[i] = createAdmissionPolicyObserverExchange(observer, context, n.options.now);
  }
  // Listener shutdown must await admitted updates before their stores close.
  cleanup.push(async () => { await Promise.all(servers.map(server => server.close())); observers.forEach(observer => observer.close()); });
  const advance = await createAdmissionPolicyAdvance(n.first, n.second, context, n.key);
  const conflict = await createAdmissionPolicyAdvance(n.first, n.fork, context, n.key);
  const options = { context, policy: n.first, now: n.options.now, timeoutMs: 1000 };
  return { ...n, context, advance, conflict, observers, handlers, online, servers, received, options };
}

it('observes, activates on four actual sockets, refuses an old head and repairs the returning fifth observer', async () => {
  const n = await network(); n.online[4] = false;
  const first = await collectAdmissionPolicyObservation(n.options); expect(first.votes).toHaveLength(4);
  const next = await collectAdmissionPolicyObservation({ ...n.options, policy: n.second, advance: n.advance });
  expect(next.votes.every(vote => vote.head.revision === 2)).toBe(true);
  expect(n.observers.slice(0, 4).every(observer => observer.policy().revision === 2)).toBe(true);
  expect(n.observers[4].policy().revision).toBe(1);
  await expect(collectAdmissionPolicyObservation(n.options)).rejects.toThrow('four matching');
  n.online[4] = true;
  const member = n.context.members.find(member => member.endpoint === n.servers[4].endpoint)!;
  await exchangeAdmissionPolicyObservation(member, { request: createAdmissionPolicyHeadRequest(n.context, n.now), advance: n.advance }, new AbortController().signal);
  expect(n.observers[4].policy().revision).toBe(2);
  const certificate = await collectAdmissionPolicyObservation({ ...n.options, policy: n.second });
  expect(parseAdmissionPolicyHeadCertificate(certificate, certificate.votes[0].request, n.context, n.advance.commitment.next, n.now).votes).toHaveLength(4);
});

it('preserves an independently supplied caller challenge across asynchronous validation and real observer collection', async () => {
  const n = await network(), request = createAdmissionPolicyHeadRequest(n.context, n.now, 1000), expected = structuredClone(request);
  const pending = collectAdmissionPolicyObservation({ ...n.options, request });
  request.challenge = createAdmissionPolicyHeadRequest(n.context, n.now).challenge;
  const certificate = await pending;
  expect(certificate.votes).toHaveLength(4); expect(certificate.votes.every(vote => JSON.stringify(vote.request) === JSON.stringify(expected))).toBe(true);
  expect(() => parseAdmissionPolicyHeadCertificate(certificate, request, n.context, admissionPolicyHead(n.first), n.now)).toThrow();
  expect(parseAdmissionPolicyHeadCertificate(certificate, expected, n.context, admissionPolicyHead(n.first), n.now).votes).toHaveLength(4);
});

it('rejects invalid or expired caller challenges before dialing and honors a shorter caller lifetime', async () => {
  const n = await network(), request = createAdmissionPolicyHeadRequest(n.context, n.now, 100);
  for (const changed of [{ ...request, expiresAt: n.now }, { ...request, contextId: 'sha256:' + '0'.repeat(64) },
    { ...request, challenge: 'invalid' }, { ...request, extra: true }]) {
    await expect(collectAdmissionPolicyObservation({ ...n.options, request: changed })).rejects.toThrow();
  }
  expect(n.received).toEqual([0, 0, 0, 0, 0]);
  let aborted = 0; const started = performance.now();
  await expect(collectAdmissionPolicyObservation({ ...n.options, request, timeoutMs: 1000, transport: (_member, _frame, signal) => {
    signal.addEventListener('abort', () => { aborted++; }, { once: true }); return new Promise(() => {});
  } })).rejects.toThrow('timed out');
  expect(performance.now() - started).toBeLessThan(800); expect(aborted).toBe(5);
});

it('accounts an observation socket before sending and contains accounting callback failures', async () => {
  const n = await network(), member = n.context.members[0], request = createAdmissionPolicyHeadRequest(n.context, n.now); let sockets = 0;
  await expect(exchangeAdmissionPolicyObservation(member, { request, advance: null }, new AbortController().signal,
    () => { sockets++; throw new Error('Meter unavailable'); })).rejects.toThrow('accounting');
  expect(sockets).toBe(1); expect(n.received.reduce((sum, value) => sum + value, 0)).toBe(0);
  await exchangeAdmissionPolicyObservation(member, { request, advance: null }, new AbortController().signal, socket => { expect(socket.bytesRead).toBeGreaterThan(0); });
  expect(n.received.reduce((sum, value) => sum + value, 0)).toBe(1);
});

it('keeps accepted partial updates through a partition and an unknown outcome, then completes with a returning fourth', async () => {
  const n = await network(); n.online[3] = n.online[4] = false;
  await expect(collectAdmissionPolicyObservation({ ...n.options, policy: n.second, advance: n.advance })).rejects.toThrow('four matching');
  expect(n.observers.slice(0, 3).every(observer => observer.policy().revision === 2)).toBe(true);
  n.online[3] = true; const original = n.handlers[3];
  n.handlers[3] = async frame => { await original(frame); throw new Error('Lost reply after durable update'); };
  await expect(collectAdmissionPolicyObservation({ ...n.options, policy: n.second, advance: n.advance })).rejects.toThrow('four matching');
  expect(n.observers[3].policy().revision).toBe(2);
  n.handlers[3] = original;
  expect((await collectAdmissionPolicyObservation({ ...n.options, policy: n.second, advance: n.advance })).votes).toHaveLength(4);
});

it('never counts an observation returned on another member connection or a forged/replayed response', async () => {
  const n = await network(); n.online[4] = false;
  const original = n.handlers[0]; n.handlers[0] = n.handlers[1];
  await expect(collectAdmissionPolicyObservation(n.options)).rejects.toThrow('four matching');
  n.handlers[0] = async frame => ({ ...(await original(frame) as object), signature: Buffer.alloc(64).toString('base64url') });
  await expect(collectAdmissionPolicyObservation(n.options)).rejects.toThrow('four matching');
  const old = n.observers[0].observe(createAdmissionPolicyHeadRequest(n.context, n.now)); n.handlers[0] = async () => old;
  await expect(collectAdmissionPolicyObservation(n.options)).rejects.toThrow('four matching');
});

it('rejects conflicting activation and leaves durable equivocation fences on the observers that saw both', async () => {
  const n = await network(); n.online[4] = false;
  await collectAdmissionPolicyObservation({ ...n.options, policy: n.second, advance: n.advance });
  await expect(collectAdmissionPolicyObservation({ ...n.options, policy: n.fork, advance: n.conflict })).rejects.toThrow('four matching');
  expect(n.observers.slice(0, 4).every(observer => observer.status().blocked)).toBe(true);
  await expect(collectAdmissionPolicyObservation({ ...n.options, policy: n.second })).rejects.toThrow('four matching');
});

it('does not combine converged policy contents reached through contradictory predecessor branches', async () => {
  const n = await network(); n.online[4] = false;
  await Promise.all(n.observers.slice(0, 2).map(observer => observer.advance(n.advance)));
  await Promise.all(n.observers.slice(2, 4).map(observer => observer.advance(n.conflict)));
  const left = await createAdmissionPolicyAdvance(n.second, n.third, n.context, n.key, n.advance.commitment.next);
  const right = await createAdmissionPolicyAdvance(n.fork, n.third, n.context, n.key, n.conflict.commitment.next);
  await Promise.all(n.observers.slice(0, 2).map(observer => observer.advance(left)));
  await Promise.all(n.observers.slice(2, 4).map(observer => observer.advance(right)));
  expect(n.observers.slice(0, 4).every(observer => JSON.stringify(observer.policy()) === JSON.stringify(n.third))).toBe(true);
  expect(left.commitment.next.digest).toBe(right.commitment.next.digest);
  expect(left.commitment.next.transition).not.toBe(right.commitment.next.transition);
  await expect(collectAdmissionPolicyObservation({ ...n.options, policy: n.third })).rejects.toThrow('four matching');
});

it('enforces its own deadline even when a custom transport ignores cancellation', async () => {
  const n = await network(), signals: AbortSignal[] = [], start = performance.now();
  await expect(collectAdmissionPolicyObservation({ ...n.options, timeoutMs: 100, transport: async (_member, _frame, signal) => {
    signals.push(signal); return new Promise(() => {});
  } })).rejects.toThrow('timed out');
  expect(performance.now() - start).toBeLessThan(1000); expect(signals).toHaveLength(5); expect(signals.every(signal => signal.aborted)).toBe(true);
});

it('does not let four fresh signed observations extend the underlying policy expiry', async () => {
  const n = await network(); let time = n.now, replies = 0;
  const policy = await signAdmissionPolicy({ ...n.body, revision: 2, expiresAt: n.now + 50 }, n.authority, n.key.secretKey);
  const advance = await createAdmissionPolicyAdvance(n.first, policy, n.context, n.key);
  await expect(collectAdmissionPolicyObservation({ ...n.options, policy, now: () => time, transport: async (member, frame) => {
    const key = n.keys.find(key => Buffer.from(key.publicKey).toString('base64url') === member.publicKey)!;
    const vote = createAdmissionPolicyHeadVote(frame.request, advance.commitment.next, n.context, key, n.now);
    if (++replies >= 4) time = n.now + 100;
    return vote;
  } })).rejects.toThrow('not current');
});

it('cancels the whole collection and refuses invalid activation input before opening sockets', async () => {
  const n = await network(), controller = new AbortController(); controller.abort();
  await expect(collectAdmissionPolicyObservation({ ...n.options, signal: controller.signal })).rejects.toThrow();
  await expect(collectAdmissionPolicyObservation({ ...n.options, policy: n.first, advance: n.advance })).rejects.toThrow('differs');
  expect(n.received).toEqual([0, 0, 0, 0, 0]);
});

it('cancels real outstanding sockets while preserving an already admitted update whose reply was lost', async () => {
  const n = await network(), controller = new AbortController(); n.online[4] = false;
  let release!: () => void, started!: () => void, finished!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  const completed = new Promise<void>(resolve => { finished = resolve; }), original = n.handlers[0];
  n.handlers[0] = async frame => { started(); await gate; try { return await original(frame); } finally { finished(); } };
  const pending = collectAdmissionPolicyObservation({ ...n.options, policy: n.second, advance: n.advance, signal: controller.signal });
  const refused = expect(pending).rejects.toThrow('cancelled'); await entered; controller.abort();
  await refused; release(); await completed; expect(n.observers[0].policy().revision).toBe(2);
});

it('refuses expired challenges, malformed frames and false updates before changing the retained head', async () => {
  const n = await network(), request = createAdmissionPolicyHeadRequest(n.context, n.now), member = n.context.members[0];
  for (const frame of [{ request: { ...request, expiresAt: n.now }, advance: n.advance },
    { request, advance: n.advance, extra: true },
    { request, advance: { ...n.advance, commitment: { ...n.advance.commitment, signature: Buffer.alloc(64).toString('base64url') } } }]) {
    await expect(exchangeAdmissionPolicyObservation(member, frame as any, new AbortController().signal)).rejects.toThrow();
  }
  expect(n.observers.every(observer => observer.policy().revision === 1)).toBe(true);
});

it.each(['binary', 'malformed', 'oversized'])('rejects a malicious %s transport reply', async kind => {
  const n = await network(), server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  cleanup.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await once(server, 'listening'); server.on('connection', socket => { socket.on('error', () => {}); socket.once('message', () => {
    socket.send(kind === 'binary' ? Buffer.from('{}') : kind === 'malformed' ? '{' : 'x'.repeat(8193));
  }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing socket address');
  const member = { ...n.context.members[0], endpoint: `ws://127.0.0.1:${address.port}/` };
  await expect(exchangeAdmissionPolicyObservation(member, { request: createAdmissionPolicyHeadRequest(n.context, n.now), advance: null }, new AbortController().signal)).rejects.toThrow();
});

it('awaits admitted asynchronous work before idempotent listener shutdown completes', async () => {
  let release!: () => void, started!: () => void, completed = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  const server = await listenAdmissionPolicyObserver(async () => { started(); await gate; completed = true; return {}; }); cleanup.push(server.close);
  const socket = new WebSocket(server.endpoint); socket.on('error', () => {}); cleanup.push(() => socket.terminate());
  await once(socket, 'open'); socket.send('{}'); await entered;
  const stopping = server.close(); expect(server.close()).toBe(stopping); expect(completed).toBe(false);
  release(); await stopping; expect(completed).toBe(true);
});

it('bounds raw connections and rejects binary, oversized and repeated request frames', async () => {
  let calls = 0;
  const server = await listenAdmissionPolicyObserver(async () => { calls++; return {}; }, { maxConnections: 1, connectionTimeoutMs: 200 }); cleanup.push(server.close);
  const port = Number(new URL(server.endpoint).port), raw: Socket = connect({ host: '127.0.0.1', port }); raw.on('error', () => {});
  cleanup.push(() => { raw.destroy(); }); await once(raw, 'connect'); const rawClosed = once(raw, 'close');
  const extra = new WebSocket(server.endpoint); cleanup.push(() => extra.terminate());
  await expect(once(extra, 'open')).rejects.toThrow();
  // Client-side close is not proof that the server has released its only raw
  // slot. Await this server's shutdown before testing a different frame boundary.
  await rawClosed; await server.close();
  for (const payload of [Buffer.from('{}'), 'x'.repeat(ADMISSION_POLICY_OBSERVATION_MAX_BYTES + 1)]) {
    const isolated = await listenAdmissionPolicyObserver(async () => { calls++; return {}; }, { maxConnections: 1 }); cleanup.push(isolated.close);
    const socket = new WebSocket(isolated.endpoint); socket.on('error', () => {}); await once(socket, 'open');
    const closed = once(socket, 'close'); socket.send(payload); await closed;
    await isolated.close();
  }
  expect(calls).toBe(0);
  const repeated = await listenAdmissionPolicyObserver(async () => { calls++; return {}; }, { maxConnections: 1 }); cleanup.push(repeated.close);
  const socket = new WebSocket(repeated.endpoint); socket.on('error', () => {}); await once(socket, 'open'); const closed = once(socket, 'close');
  socket.send('{}'); socket.send('{}'); await closed; expect(calls).toBe(1);
});

it('reports finite local handler categories, ignores callback failures, and retains only numeric client close codes', async () => {
  const diagnostics: unknown[] = [];
  for (const throws of [false, true]) {
    const listener = await listenAdmissionPolicyObserver(async () => { throw new Error('private did:key:secret https://private.invalid /private/key'); }, {
      onHandlerFailure(value) { diagnostics.push(value); if (throws) throw new Error('private callback failure'); },
    }); cleanup.push(listener.close);
    const error = await exchangeAdmissionPolicyObservation({ publicKey: '', endpoint: listener.endpoint }, {} as never,
      new AbortController().signal).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe('Policy observation connection closed (4003)');
    expect(diagnostics.at(-1)).toEqual({ phase: 'observation-handler', category: 'unspecified' });
    expect(JSON.stringify(diagnostics)).not.toMatch(/private|secret|did:key/);
    await listener.close();
  }
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => { for (const socket of server.clients) socket.terminate(); server.close(() => resolve()); }));
  server.on('connection', socket => socket.on('message', () => socket.close(4003, 'private reason /private/key')));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test address');
  await expect(exchangeAdmissionPolicyObservation({ publicKey: '', endpoint: `ws://127.0.0.1:${address.port}/policy-head` }, {} as never,
    new AbortController().signal)).rejects.toThrow('Policy observation connection closed (4003)');
});


it('classifies only exact local expiry and quorum messages without substring injection', () => {
  const cases = [
    ['Policy observation expired in observer queue', 'queue-expired'],
    ['Invalid or expired admission policy head request', 'request-invalid-or-expired'],
    ['Policy observation completed too late', 'observation-too-late'],
    ['Four current history heads unavailable', 'history-quorum-unavailable'],
    ['Current history observation completed too late', 'history-observation-too-late'],
    ['Four durable history acknowledgements unavailable', 'history-write-quorum-unavailable'],
  ];
  for (const [message, category] of cases) {
    expect(policyObservationFailureCategory(new Error(message))).toBe(category);
    expect(policyObservationFailureCategory(new Error(message + ' /private/key'))).toBe('unspecified');
  }
});
