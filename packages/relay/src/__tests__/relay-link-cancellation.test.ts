import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRelayServer } from '../server.js';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { createRelayContactHintV1, createRelayDescriptorV1, generateIdentity } from '@resonance/core';
import { connectRelayLinkV1, RelayLinkManager } from '../relay-link-client.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const sockets = new Set<Socket>(); let connections = 0;
  const server = createServer(socket => {
    connections++; sockets.add(socket); socket.resume(); socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(r => server.close(() => r())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  const identity = generateIdentity(), target = createRelayContactHintV1('configured', `ws://127.0.0.1:${address.port}/`, generateIdentity().did);
  const descriptor = () => createRelayDescriptorV1({ sequence: Date.now(), endpoints: [], reachability: 'outbound-only', supportedGroups: [],
    capabilities: { storesPublications: false, storesMailboxes: false, answersQueries: false, forwardsQueries: false, replicaExchange: false },
    storage: { capacityBytes: 0, availableBytes: 0 } }, identity);
  return { server, sockets, connections: () => connections, identity, target, descriptor };
}
it('does not dial a pre-cancelled connection', async () => {
  const n = await fixture(), controller = new AbortController(); controller.abort();
  await expect(connectRelayLinkV1(n.target, n.descriptor(), n.identity, { signal: controller.signal })).rejects.toThrow('cancelled');
  expect(n.connections()).toBe(0);
});
it('stops pending handshakes and immediately restarts without reviving an old manager lifetime', async () => {
  const n = await fixture(), manager = new RelayLinkManager(n.identity, n.descriptor, { targets: [n.target], handshakeTimeoutMs: 10000,
    reconnectBaseMs: 50, reconnectMaxMs: 100 }); cleanup.push(() => manager.stop());
  const first = once(n.server, 'connection'); manager.start(); const [oldSocket] = await first;
  const oldClosed = once(oldSocket, 'close'), next = once(n.server, 'connection');
  manager.stop(); manager.start();
  const [newSocket] = await next; await oldClosed;
  expect(n.connections()).toBe(2); expect(manager.status().running).toBe(true);
  const newClosed = once(newSocket, 'close'); manager.stop(); await newClosed;
  expect(n.sockets.size).toBe(0); expect(manager.status().running).toBe(false);
});

it('repeatedly closes an authenticated link at both peers before reusing the same infrastructure identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-link-stop-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const hub = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: directory,
    relayDiscovery: { endpoints: ['ws://127.0.0.1:0/'], reachability: 'direct', supportedGroups: [], storage: { capacityBytes: 1000000, availableBytes: 1000000 } } });
  await hub.start(); cleanup.push(() => hub.stop({ graceful: false }));
  const identity = generateIdentity(), remote = hub.getRelayDescriptor()!;
  let sequence = Date.now();
  const manager = new RelayLinkManager(identity, () => createRelayDescriptorV1({ sequence: ++sequence, endpoints: [], reachability: 'outbound-only', supportedGroups: [],
    capabilities: { storesPublications: false, storesMailboxes: false, answersQueries: false, forwardsQueries: false, replicaExchange: false },
    storage: { capacityBytes: 0, availableBytes: 0 } }, identity),
    { targets: [createRelayContactHintV1('configured', remote.endpoints[0], remote.relayId)], reconnectBaseMs: 50, reconnectMaxMs: 100 });
  cleanup.push(() => manager.stop());
  async function waitFor(check: () => boolean) { const until = Date.now() + 5000; while (!check()) { if (Date.now() > until) throw new Error('Connection did not close or reconnect'); await new Promise(r => setTimeout(r, 10)); } }
  for (let i = 0; i < 3; i++) {
    manager.start(); await waitFor(() => manager.status().connectedRelayIds.length === 1);
    expect(hub.getRelayLinkStatus().inboundRelayIds).toContain(identity.did);
    manager.stop(); await waitFor(() => !hub.getRelayLinkStatus().inboundRelayIds.includes(identity.did));
  }
}, 20000);
