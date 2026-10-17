import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { generateIdentity } from '@resonance/core';
import { HistoryLinkBudget, HistoryRelayLink } from '../history-relay-link.js';
import { HistoryRelayRouter } from '../history-relay-router.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(timeoutMs = 30000) {
  const relayId = generateIdentity().did, publicKey = Buffer.alloc(32, 1).toString('base64url');
  const router = new HistoryRelayRouter({ members: [{ publicKey, relayId }], waitForConnection: true, timeoutMs });
  cleanup.push(() => router.close());
  const member = { publicKey, endpoint: 'wss://never-dial.invalid/history-checkpoint' };
  const frame = { request: { replica: publicKey, action: 'head' } } as Parameters<typeof router.checkpoint>[1];
  return { router, member, relayId, frame };
}
async function connect(n: ReturnType<typeof fixture>, handler: (value: unknown) => unknown = value => value) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  cleanup.push(async () => { for (const s of server.clients) s.terminate(); await new Promise<void>(r => server.close(() => r())); });
  const connection = once(server, 'connection'), socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  socket.on('error', () => {}); cleanup.push(() => socket.terminate());
  const [remote] = await connection as [WebSocket]; await once(socket, 'open');
  const role = new HistoryRelayLink(remote, 'controller', { allowedRelayIds: ['controller'], budget: new HistoryLinkBudget(),
    handler: (_method, value) => handler(value) }); cleanup.push(() => role.close());
  const frames: Record<string, unknown>[] = [];
  socket.on('message', raw => n.router.handle(raw.toString(), n.relayId, socket));
  remote.on('message', raw => { frames.push(JSON.parse(raw.toString())); role.handle(raw.toString()); });
  return { socket, frames, attach: () => n.router.attach(n.relayId, socket) };
}

it('waits only for its explicit pin and releases the waiting lease before a real exchange', async () => {
  const n = fixture(), signal = new AbortController().signal;
  const pending = n.router.checkpoint(n.member, n.frame, signal);
  expect(n.router.usage()).toEqual({ bytes: 0, operations: 1 });
  const link = await connect(n);
  n.router.attach(generateIdentity().did, link.socket); expect(n.router.usage().operations).toBe(1);
  link.attach(); expect(await pending).toEqual(n.frame);
  expect(n.router.usage()).toEqual({ bytes: 0, operations: 0 });
});

it.each(['abort', 'close', 'timeout'])('bounds connection waiting and releases all slots on %s', async reason => {
  const n = fixture(reason === 'timeout' ? 50 : 30000), controller = new AbortController();
  const pending = Array.from({ length: 8 }, () => n.router.checkpoint(n.member, n.frame, controller.signal));
  const results = Promise.allSettled(pending);
  expect(n.router.usage().operations).toBe(8);
  await expect(n.router.checkpoint(n.member, n.frame, controller.signal)).rejects.toThrow('capacity');
  if (reason === 'abort') controller.abort(); if (reason === 'close') n.router.close();
  expect((await results).every(r => r.status === 'rejected')).toBe(true);
  expect(n.router.usage()).toEqual({ bytes: 0, operations: 0 });
  const link = await connect(n); link.attach();
  await new Promise(r => setTimeout(r, 10)); expect(link.frames).toHaveLength(0);
});

it('includes waiting and serialization in the original deadline, sending no late request after attach', async () => {
  const n = fixture(), link = await connect(n), base = performance.now(); let elapsed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => base + elapsed);
  const frame = { ...n.frame, toJSON() { elapsed = 31000; return n.frame; } };
  const pending = n.router.checkpoint(n.member, frame, new AbortController().signal);
  const refused = expect(pending).rejects.toThrow();
  elapsed = 20000; link.attach(); await refused;
  await new Promise(r => setTimeout(r, 10));
  expect(link.frames.filter(f => f.kind === 'open')).toHaveLength(0);
  expect(n.router.usage()).toEqual({ bytes: 0, operations: 0 });
});
