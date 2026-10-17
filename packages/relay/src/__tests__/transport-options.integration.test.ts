import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import { createRelayClient } from '@resonance/node';
import { createRelayServer } from '../server.js';
import { RelayTrafficMeter } from '../relay-resource-meter.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const search = { groupId: 'public', fingerprintEpoch: 'pilot-static-v1', fingerprint: new Uint8Array(64),
  itemType: 'need' as const, k: 5, threshold: 0.9 };

it('keeps actual direct, private discovery, private operation and forward handshakes uncompressed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'transport-options-')), handshakes: string[] = [];
  cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
  class Meter extends RelayTrafficMeter {
    override observe(socket: Socket) {
      super.observe(socket);
      // The fixture uses cleartext loopback only; record received HTTP upgrades.
      let header = '';
      const receive = (chunk: Buffer) => {
        header += chunk.toString();
        if (header.includes('\r\n\r\n')) {
          socket.off('data', receive);
          if (header.startsWith('GET ')) handshakes.push(header.slice(0, header.indexOf('\r\n\r\n')));
        }
      };
      socket.on('data', receive);
    }
  }
  async function start(host: string, id: string) {
    const bracket = host === '::1' ? '[::1]' : host;
    const server = createRelayServer({ port: 0, host, persistDir: join(directory, id), resourceMeter: new Meter(),
      privateEntryMix: false, privateReplyMix: false,
      relayDiscovery: { endpoints: [`ws://${bracket}:0/`], reachability: 'direct', supportedGroups: ['public'],
        storage: { capacityBytes: 1000000, availableBytes: 1000000 } } });
    cleanup.push(() => server.stop({ graceful: false })); await server.start();
    return { endpoint: `ws://${bracket}:${server.getListeningPort()}/`, server };
  }
  const entry = await start('127.0.0.1', 'entry'), destination = await start('::1', 'destination');
  expect(entry.server.observeRelayDescriptor(destination.server.getRelayDescriptor())).toBe('accepted');
  const direct = createRelayClient({ relayUrl: destination.endpoint });
  const privateClient = createRelayClient({ relayUrl: destination.endpoint, privateEntryUrls: [entry.endpoint],
    privateTraffic: { batchWindowMs: 10, jitterMs: 0 } });
  cleanup.push(async () => { direct.disconnect(); privateClient.disconnect(); });
  expect((await direct.searchV2(search)).results).toEqual([]);
  const directCount = handshakes.length; expect(directCount).toBe(1);
  expect((await privateClient.searchV2(search)).results).toEqual([]);
  // Entry discovery, indirect discovery, destination discovery, encrypted
  // operation and forwarding all perform separate actual HTTP upgrades.
  expect(handshakes.length - directCount).toBeGreaterThanOrEqual(5);
  for (const headers of handshakes) expect(headers.toLowerCase()).not.toContain('sec-websocket-extensions:');
}, 15000);

it('refuses a redirect without contacting its destination', async () => {
  const destination = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: true }); let contacts = 0;
  cleanup.push(async () => { for (const client of destination.clients) client.terminate(); await new Promise<void>(resolve => destination.close(() => resolve())); });
  destination.on('connection', socket => { contacts++; socket.close(); }); await once(destination, 'listening');
  const redirect = createServer();
  redirect.on('upgrade', (_request, socket) => socket.end(`HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:${(destination.address() as AddressInfo).port}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`));
  cleanup.push(async () => { await new Promise<void>(resolve => redirect.close(() => resolve())); });
  redirect.listen(0, '127.0.0.1'); await once(redirect, 'listening');
  const client = createRelayClient({ relayUrl: `ws://127.0.0.1:${(redirect.address() as AddressInfo).port}/` });
  cleanup.push(async () => client.disconnect());
  await expect(client.searchV2(search)).rejects.toThrow(); expect(contacts).toBe(0);
});
