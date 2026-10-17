import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { HISTORY_LINK_CHUNK_BYTES, HISTORY_LINK_FRAME_TYPE, HISTORY_LINK_MAX_FRAME_BYTES,
  HistoryLinkBudget, HistoryRelayLink, type HistoryLinkHandler } from '../history-relay-link.js';
import { HistoryRelayRouter } from '../history-relay-router.js';
import { generateIdentity } from '@resonance/core';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function waitFor(test: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!test()) { if (performance.now() >= deadline) throw new Error('History link did not settle'); await new Promise(r => setTimeout(r, 5)); }
}
async function pair(options: { handler?: HistoryLinkHandler; clientHandler?: HistoryLinkHandler; rawServer?: boolean;
  timeoutMs?: number; serverBudget?: HistoryLinkBudget; clientBudget?: HistoryLinkBudget } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: HISTORY_LINK_MAX_FRAME_BYTES, perMessageDeflate: false });
  await once(server, 'listening');
  cleanup.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(r => server.close(() => r())); });
  const connection = once(server, 'connection'), client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  client.on('error', () => {}); cleanup.push(() => client.terminate());
  const [remote] = await connection as [WebSocket]; await once(client, 'open'); remote.on('error', () => {});
  const aBudget = options.clientBudget ?? new HistoryLinkBudget(), bBudget = options.serverBudget ?? new HistoryLinkBudget();
  const a = new HistoryRelayLink(client, 'pinned-server', { allowedRelayIds: ['pinned-server'], budget: aBudget,
    handler: options.clientHandler, timeoutMs: options.timeoutMs });
  const b = new HistoryRelayLink(remote, 'pinned-client', { allowedRelayIds: ['pinned-client'], budget: bBudget,
    handler: options.handler ?? ((_method, value) => value), timeoutMs: options.timeoutMs });
  cleanup.push(() => { a.close(); b.close(); });
  const received: Record<string, unknown>[] = [], sizes: number[] = [];
  client.on('message', raw => { sizes.push(Buffer.byteLength(raw.toString())); a.handle(raw.toString()); });
  remote.on('message', raw => { sizes.push(Buffer.byteLength(raw.toString())); received.push(JSON.parse(raw.toString())); if (!options.rawServer) b.handle(raw.toString()); });
  return { a, b, client, remote, aBudget, bBudget, received, sizes };
}
const signal = () => new AbortController().signal;

it('transfers large UTF-8 payloads with acknowledged bounded chunks in both directions', async () => {
  const n = await pair({ clientHandler: (_method, value) => value });
  const value = { ciphertext: 'mañana 🌏'.repeat(200000) };
  expect(await n.a.request('checkpoint', value, signal())).toEqual(value);
  expect(await n.b.request('checkpoint', value, signal())).toEqual(value);
  for (const method of ['agreement', 'transfer', 'provision'] as const) expect(await n.a.request(method, { method }, signal())).toEqual({ method });
  await waitFor(() => n.bBudget.usage().operations === 0);
  expect(n.aBudget.usage()).toEqual({ bytes: 0, operations: 0 }); expect(n.bBudget.usage()).toEqual({ bytes: 0, operations: 0 });
  expect(Math.max(...n.sizes)).toBeLessThanOrEqual(HISTORY_LINK_MAX_FRAME_BYTES);
  expect(n.received.filter(f => f.kind === 'data').length).toBeGreaterThan(10);
});

it('refuses unpinned peers, duplicate concurrent work and shared resource exhaustion', async () => {
  const budget = new HistoryLinkBudget(4096, 1), n = await pair({ rawServer: true, clientBudget: budget });
  expect(() => new HistoryRelayLink(n.client, 'untrusted', { allowedRelayIds: ['pinned-server'], budget })).toThrow('authorized');
  const controller = new AbortController(), pending = n.a.request('checkpoint', { value: 1 }, controller.signal);
  const rejected = expect(pending).rejects.toThrow('cancelled');
  await expect(n.a.request('checkpoint', {}, signal())).rejects.toThrow('busy');
  const other = await pair({ rawServer: true, clientBudget: budget });
  await expect(other.a.request('checkpoint', {}, signal())).rejects.toThrow('capacity');
  expect(budget.usage().operations).toBe(1);
  controller.abort(); await rejected; expect(budget.usage()).toEqual({ bytes: 0, operations: 0 });
});

it('refuses declared buffer exhaustion before invoking the history role and leaves the link usable', async () => {
  let calls = 0;
  const n = await pair({ serverBudget: new HistoryLinkBudget(32), handler: (_method, value) => { calls++; return value; } });
  await expect(n.a.request('checkpoint', { large: 'x'.repeat(1000) }, signal())).rejects.toThrow('refused');
  expect(calls).toBe(0); expect(n.bBudget.usage()).toEqual({ bytes: 0, operations: 0 });
  expect(await n.a.request('checkpoint', { small: 1 }, signal())).toEqual({ small: 1 }); expect(calls).toBe(1);
});

it('bounds a silent peer with one whole-exchange deadline and ignores its late payload', async () => {
  const n = await pair({ rawServer: true, timeoutMs: 70 });
  await expect(n.a.request('checkpoint', {}, signal())).rejects.toThrow('timed out');
  const start = n.received.find(f => f.kind === 'open')!;
  n.remote.send(JSON.stringify({ type: HISTORY_LINK_FRAME_TYPE, id: start.id, kind: 'open', side: 'response', bytes: 1024 }));
  await new Promise(r => setTimeout(r, 10));
  expect(n.aBudget.usage()).toEqual({ bytes: 0, operations: 0 }); expect(n.client.readyState).toBe(WebSocket.OPEN);
});

it('cancels after dispatch without sending a delayed service response or accepting new work after close', async () => {
  let reply!: (value: unknown) => void, invoked = false;
  const n = await pair({ serverBudget: new HistoryLinkBudget(4096, 1), handler: () => {
    if (invoked) return {}; invoked = true; return new Promise(resolve => { reply = resolve; });
  } });
  const controller = new AbortController(), promise = n.a.request('checkpoint', {}, controller.signal);
  const rejected = expect(promise).rejects.toThrow('cancelled'); await waitFor(() => invoked);
  controller.abort(); await rejected; await waitFor(() => n.received.some(f => f.kind === 'cancel'));
  expect(n.bBudget.usage()).toEqual({ bytes: 0, operations: 1 }); // A running service cannot evade the cap by cancellation.
  await expect(n.a.request('checkpoint', {}, signal())).rejects.toThrow('refused');
  const before = n.sizes.length; reply({ secret: 'late reply' }); await waitFor(() => n.bBudget.usage().operations === 0);
  expect(n.sizes).toHaveLength(before); expect(n.aBudget.usage()).toEqual({ bytes: 0, operations: 0 });
  expect(await n.a.request('checkpoint', {}, signal())).toEqual({});
  n.a.close(); await expect(n.a.request('checkpoint', {}, signal())).rejects.toThrow('refused');
});

it.each(['offset', 'truncated', 'noncanonical', 'extra-field', 'oversize', 'duplicate-open'])(
  'closes and releases a malicious %s stream before calling the role', async fault => {
    let calls = 0; const n = await pair({ rawServer: true, handler: () => { calls++; return {}; } });
    const id = 'a'.repeat(32), open = { type: HISTORY_LINK_FRAME_TYPE, id, kind: 'open', side: 'request',
      method: 'checkpoint', bytes: 2, maxResponse: 4096 };
    // Feed the authenticated-side decoder directly so the test can control malformed frames.
    n.b.handle(JSON.stringify(fault === 'oversize' ? { ...open, bytes: 100 * 1024 * 1024 } : open));
    if (fault === 'duplicate-open') n.b.handle(JSON.stringify(open));
    else if (fault !== 'oversize') n.b.handle(JSON.stringify({ type: HISTORY_LINK_FRAME_TYPE, id, kind: 'data', side: 'request',
      offset: fault === 'offset' ? 1 : 0, data: fault === 'truncated' ? 'ew' : fault === 'noncanonical' ? 'e31' : 'e30',
      ...(fault === 'extra-field' ? { extra: true } : {}) }));
    expect(calls).toBe(0); expect(n.bBudget.usage()).toEqual({ bytes: 0, operations: 0 });
    expect(n.remote.readyState).not.toBe(WebSocket.OPEN);
  });

it('refuses responses exceeding the requested action cap without leaking service details', async () => {
  const n = await pair({ handler: () => ({ private: 'x'.repeat(HISTORY_LINK_CHUNK_BYTES) }) });
  await expect(n.a.request('checkpoint', {}, signal(), 4096)).rejects.toThrow('refused');
  expect(n.aBudget.usage()).toEqual({ bytes: 0, operations: 0 }); expect(n.bBudget.usage()).toEqual({ bytes: 0, operations: 0 });
});

it('releases both directions on socket loss and requires a new explicitly attached link', async () => {
  const n = await pair({ rawServer: true }), pending = n.a.request('checkpoint', { body: 'x'.repeat(200000) }, signal());
  const rejected = expect(pending).rejects.toThrow('closed');
  await waitFor(() => n.received.length > 0); n.remote.terminate(); await rejected;
  expect(n.aBudget.usage()).toEqual({ bytes: 0, operations: 0 });
  await expect(n.a.request('checkpoint', {}, signal())).rejects.toThrow('refused');
});

it('does not renew the deadline for each acknowledged chunk', async () => {
  const n = await pair({ rawServer: true, timeoutMs: 90 });
  const promise = n.a.request('checkpoint', { body: 'x'.repeat(HISTORY_LINK_CHUNK_BYTES * 3) }, signal());
  const refusal = expect(promise).rejects.toThrow('timed out');
  await waitFor(() => n.received.length > 0);
  const id = n.received[0].id;
  n.remote.send(JSON.stringify({ type: HISTORY_LINK_FRAME_TYPE, id, kind: 'ack', side: 'request', offset: 0 }));
  await waitFor(() => n.received.some(f => f.kind === 'data'));
  await new Promise(r => setTimeout(r, 45));
  n.remote.send(JSON.stringify({ type: HISTORY_LINK_FRAME_TYPE, id, kind: 'ack', side: 'request', offset: HISTORY_LINK_CHUNK_BYTES }));
  await refusal; expect(n.aBudget.usage()).toEqual({ bytes: 0, operations: 0 });
  const chunks = n.received.filter(f => f.kind === 'data').length;
  n.remote.send(JSON.stringify({ type: HISTORY_LINK_FRAME_TYPE, id, kind: 'ack', side: 'request', offset: HISTORY_LINK_CHUNK_BYTES * 2 }));
  await new Promise(r => setTimeout(r, 10)); expect(n.received.filter(f => f.kind === 'data')).toHaveLength(chunks);
});

it('requires distinct explicit member routes and never dials an endpoint as fallback', async () => {
  const relayId = generateIdentity().did, publicKey = Buffer.alloc(32, 1).toString('base64url');
  expect(() => new HistoryRelayRouter({ members: [{ publicKey, relayId }, { publicKey: Buffer.alloc(32, 2).toString('base64url'), relayId }] })).toThrow('configuration');
  expect(() => new HistoryRelayRouter({ acceptedRelayIds: [relayId] })).toThrow('configuration');
  const router = new HistoryRelayRouter({ members: [{ publicKey, relayId }] }); cleanup.push(() => router.close());
  // The router rejects before parsing signed payloads or attempting the supplied URL.
  await expect(router.checkpoint({ publicKey, endpoint: 'wss://unreachable.invalid/history-checkpoint' },
    { request: { replica: publicKey } } as Parameters<typeof router.checkpoint>[1], signal())).rejects.toThrow('unavailable');
  expect(router.usage()).toEqual({ bytes: 0, operations: 0 });
});

it.each(['cancel', 'deadline', 'disconnect', 'role-close'])('propagates %s to asynchronous history handlers and releases their retained slot after completion', async reason => {
  let context: { signal: AbortSignal; deadline: number } | undefined, aborted = 0;
  const n = await pair({ timeoutMs: reason === 'deadline' ? 500 : 30000,
    handler: (_method, _value, current) => {
      context = current;
      return new Promise(resolve => current.signal.addEventListener('abort', () => { aborted++; resolve({ late: true }); }, { once: true }));
    } });
  const controller = new AbortController(), pending = n.a.request('checkpoint', {}, controller.signal);
  const rejected = expect(pending).rejects.toThrow(); await waitFor(() => context !== undefined);
  expect(context!.signal.aborted).toBe(false); expect(context!.deadline).toBeGreaterThan(performance.now());
  if (reason === 'cancel') controller.abort();
  else if (reason === 'disconnect') n.remote.terminate();
  else if (reason === 'role-close') { n.b.close(); n.a.close(); }
  await rejected; await waitFor(() => aborted === 1 && n.bBudget.usage().operations === 0);
  expect(context!.signal.aborted).toBe(true); expect(n.aBudget.usage()).toEqual({ bytes: 0, operations: 0 });
  expect(n.bBudget.usage()).toEqual({ bytes: 0, operations: 0 });
});
