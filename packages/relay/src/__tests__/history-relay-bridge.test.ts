import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { generateIdentity } from '@resonance/core';
import { HistoryLinkBudget, HistoryRelayLink, type HistoryRoleHandler } from '../history-relay-link.js';
import { HistoryRelayRouter } from '../history-relay-router.js';
import { parseHistoryBridgeFrame } from '../history-relay-bridge.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function until(test: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!test()) { if (Date.now() >= deadline) throw new Error('History bridge did not settle'); await new Promise(r => setTimeout(r, 5)); }
}
async function wire(local: HistoryRelayRouter, remote: HistoryRelayRouter, localId: string, remoteId: string, raw = false) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  cleanup.push(async () => { for (const s of server.clients) s.terminate(); await new Promise<void>(r => server.close(() => r())); });
  const connection = once(server, 'connection'), socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  socket.on('error', () => {}); cleanup.push(() => socket.terminate());
  const [other] = await connection as [WebSocket]; await once(socket, 'open');
  const peer = raw ? new HistoryRelayLink(socket, remoteId, { allowedRelayIds: [remoteId], budget: new HistoryLinkBudget(), maxOutgoing: 4 }) : undefined;
  cleanup.push(() => peer?.close());
  socket.on('message', bytes => peer ? peer.handle(bytes.toString()) : local.handle(bytes.toString(), remoteId, socket));
  other.on('message', bytes => remote.handle(bytes.toString(), localId, other));
  if (!raw) local.attach(remoteId, socket); remote.attach(localId, other);
  return { peer, socket, other };
}
async function fixture(options: { count?: number; raw?: boolean; handler?: HistoryRoleHandler; accept?: (bytes: number) => boolean; targetsFirst?: boolean } = {}) {
  const count = options.count ?? 1, ownerId = generateIdentity().did, bridgeId = generateIdentity().did;
  const ids = Array.from({ length: count }, () => generateIdentity().did);
  const members = ids.map((_, i) => ({ publicKey: Buffer.alloc(32, i + 1).toString('base64url'), endpoint: `wss://never-dial-${i}.invalid/history-checkpoint` }));
  const owner = new HistoryRelayRouter({ members: members.map((m, i) => ({ publicKey: m.publicKey, relayId: ids[i], viaRelayId: bridgeId })) });
  const bridge = new HistoryRelayRouter({ bridgeRoutes: ids.map(targetRelayId => ({ controllerRelayId: ownerId, targetRelayId })),
    waitForConnection: true, acceptForward: options.accept });
  const calls: Array<{ member: number; method: string; value: unknown }> = [];
  const roles = ids.map((_, i) => new HistoryRelayRouter({ acceptedRelayIds: [bridgeId], handler(method, value, context) {
    calls.push({ member: i, method, value }); return options.handler ? options.handler(method, value, context) : { ok: method };
  } }));
  cleanup.push(() => { owner.close(); bridge.close(); roles.forEach(r => r.close()); });
  let ownerWire = options.targetsFirst ? undefined : await wire(owner, bridge, ownerId, bridgeId, options.raw);
  for (let i = 0; i < count; i++) await wire(roles[i], bridge, ids[i], bridgeId);
  ownerWire ??= await wire(owner, bridge, ownerId, bridgeId, options.raw);
  const frame = (i = 0) => ({ request: { replica: members[i].publicKey, action: 'head' } } as Parameters<typeof owner.checkpoint>[1]);
  return { owner, bridge, roles, ownerWire, ownerId, bridgeId, members, ids, calls, frame };
}

it('forwards only the original four protocols to an explicitly authorized target with their response caps', async () => {
  const n = await fixture({ raw: true }), peer = n.ownerWire.peer!;
  for (const method of ['checkpoint', 'agreement', 'transfer', 'provision'] as const) {
    expect(await peer.request('bridge', { version: 1, targetRelayId: n.ids[0], method, frame: n.frame() }, new AbortController().signal)).toEqual({ ok: method });
  }
  expect(n.calls.map(c => c.method)).toEqual(['checkpoint', 'agreement', 'transfer', 'provision']);
  expect(n.calls.every(c => JSON.stringify(c.value) === JSON.stringify(n.frame()))).toBe(true);
  await until(() => n.bridge.usage().operations === 0); expect(n.bridge.usage().bytes).toBe(0);
});

it('reports aggregate transport observations without claiming bridged members are current durable copies', async () => {
  const n = await fixture({ count: 5 });
  const owner = n.owner.health(), bridge = n.bridge.health();
  expect(owner).toMatchObject({ configuredMembers: 5, connectedDirectMembers: 0, configuredOwnerBridges: 1,
    connectedOwnerBridges: 1, operations: 0, bufferBytes: 0 });
  expect(bridge).toMatchObject({ configuredMembers: 0, configuredBridgeRoutes: 5, connectedBridgeTargets: 5,
    configuredControllers: 1, connectedControllers: 1, maximumOperations: 8, maximumBufferBytes: 64 * 1024 * 1024 });
  expect(n.calls).toHaveLength(0);
  for (const id of [n.ownerId, n.bridgeId, ...n.ids]) expect(JSON.stringify([owner, bridge])).not.toContain(id);
  const closed = once(n.ownerWire.socket, 'close'); n.ownerWire.socket.close(); await closed;
  expect(n.owner.health().connectedOwnerBridges).toBe(0);
  n.owner.close(); expect(() => n.owner.health()).toThrow(/closed/);
});

it('refuses unknown targets, loops, nesting, extra fields, malformed payloads and per-method excess before forwarding', async () => {
  const n = await fixture({ raw: true }), base = { version: 1, targetRelayId: n.ids[0], method: 'checkpoint', frame: n.frame() };
  const invalid = [{ ...base, targetRelayId: generateIdentity().did }, { ...base, targetRelayId: n.ownerId },
    { ...base, method: 'bridge' }, { ...base, endpoint: 'wss://arbitrary.invalid/' }, { ...base, frame: [] },
    { ...base, method: 'provision', frame: { content: 'x'.repeat(41 * 1024) } }, { ...base, targetRelayId: n.bridgeId }];
  for (const frame of invalid) await expect(n.ownerWire.peer!.request('bridge', frame, new AbortController().signal)).rejects.toThrow('refused');
  expect(n.calls).toHaveLength(0); await until(() => n.bridge.usage().operations === 0);
  expect(n.bridge.usage().bytes).toBe(0);
  expect(() => parseHistoryBridgeFrame({ ...base, version: 2 })).toThrow();
});

it('honors the bridge resource refusal without invoking a target role or adding a fallback route', async () => {
  let charged = 0; const n = await fixture({ accept: bytes => { charged += bytes; return false; } });
  await expect(n.owner.checkpoint(n.members[0], n.frame(), new AbortController().signal)).rejects.toThrow('refused');
  expect(charged).toBeGreaterThan(0); expect(n.calls).toHaveLength(0);
});

it('rejects a controller not in the pinned route table, even when its socket is attached as a permitted target', async () => {
  const n = await fixture();
  const outsider = new HistoryRelayRouter({ members: [{ publicKey: n.members[0].publicKey, relayId: n.ids[0], viaRelayId: n.bridgeId }] });
  cleanup.push(() => outsider.close());
  const attached = await wire(outsider, n.bridge, n.ids[0], n.bridgeId, true);
  await expect(attached.peer!.request('bridge', { version: 1, targetRelayId: n.ids[0], method: 'checkpoint', frame: n.frame() },
    new AbortController().signal)).rejects.toThrow('refused');
  expect(n.calls).toHaveLength(0);
});

it('permits four live targets to complete while the first selected target remains silent', async () => {
  let stalled = 0;
  const n = await fixture({ count: 5, handler(_method, value, context) {
    if ((value as ReturnType<typeof n.frame>).request.replica !== Buffer.alloc(32, 1).toString('base64url')) return { ok: true };
    stalled++;
    return new Promise(resolve => context.signal.addEventListener('abort', () => resolve({ late: true }), { once: true }));
  } });
  const controller = new AbortController();
  const first = n.owner.checkpoint(n.members[0], n.frame(), controller.signal), refused = expect(first).rejects.toThrow();
  const live = n.members.slice(1).map((m, i) => n.owner.checkpoint(m, n.frame(i + 1), controller.signal));
  expect(await Promise.all(live)).toEqual(Array.from({ length: 4 }, () => ({ ok: true }))); expect(stalled).toBe(1);
  controller.abort(); await refused;
  await until(() => n.owner.usage().operations === 0 && n.bridge.usage().operations === 0 && n.roles.every(r => r.usage().operations === 0));
  expect(n.bridge.usage().bytes).toBe(0);
});

it.each(['cancel', 'disconnect', 'bridge-close'])('propagates %s through the bridge and fences late role responses', async reason => {
  let signal: AbortSignal | undefined, reply: (() => void) | undefined;
  const n = await fixture({ targetsFirst: reason === 'bridge-close', handler(_method, _value, context) {
    signal = context.signal; return new Promise(resolve => { reply = () => resolve({ late: true }); });
  } });
  const controller = new AbortController(), pending = n.owner.checkpoint(n.members[0], n.frame(), controller.signal);
  const refused = expect(pending).rejects.toThrow(); await until(() => !!reply);
  if (reason === 'cancel') controller.abort();
  else if (reason === 'disconnect') n.ownerWire.socket.terminate();
  else { n.bridge.close(); n.ownerWire.socket.terminate(); }
  await refused; await until(() => signal!.aborted && n.bridge.usage().operations === 0);
  expect(n.roles[0].usage().operations).toBe(1); // The ignoring role remains charged until it actually finishes.
  reply!(); await until(() => n.roles[0].usage().operations === 0);
  expect(n.owner.usage()).toEqual({ bytes: 0, operations: 0 }); expect(n.bridge.usage()).toEqual({ bytes: 0, operations: 0 });
});

it('bounds and cancels forwarding-credit waits while retaining existing operation charges', async () => {
  const shared = new HistoryLinkBudget(1024, 2), controller = new AbortController();
  const first = shared.acquire(), second = shared.acquire();
  const pending = shared.acquireForward(controller.signal), refused = expect(pending).rejects.toThrow('cancelled');
  expect(shared.usage().operations).toBe(2); controller.abort(); await refused;
  const waiting = shared.acquireForward(new AbortController().signal); second(); const acquired = await waiting;
  expect(shared.usage().operations).toBe(2); acquired(); first(); expect(shared.usage().operations).toBe(0);
});
