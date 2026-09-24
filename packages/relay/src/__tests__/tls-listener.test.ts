import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import WebSocket from 'ws';
import {
  createRelayPeerRequestFrameV1,
  createRelayPeerRequestV1,
  parseRelayPeerResponseFrameV1,
  serializeRelayPeerRequestFrameV1,
  verifyRelayPeerResponseV1,
} from '@resonance/core';
import { createRelayServer, type RelayServer } from '../server.js';

const cert = readFileSync(new URL('./fixtures/localhost-test.crt', import.meta.url));
const key = readFileSync(new URL('./fixtures/localhost-test.key', import.meta.url));
const port = 41_000 + Math.floor(Math.random() * 1_000);
const persistDir = `/tmp/resonance-tls-listener-${Date.now()}-${port}`;
let server: RelayServer | undefined;

afterEach(async () => {
  await server?.stop({ graceful: false });
  server = undefined;
  rmSync(persistDir, { recursive: true, force: true });
});

describe('direct TLS relay listener', () => {
  it('serves signed discovery over WSS with a trusted certificate', async () => {
    server = createRelayServer({
      port, host: '127.0.0.1', persistDir,
      tls: { cert, key },
      relayDiscovery: {
        endpoints: [`wss://127.0.0.1:${port}/`],
        reachability: 'direct', supportedGroups: ['public'],
        storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      },
    });
    await server.start();

    const socket = new WebSocket(`wss://127.0.0.1:${port}/`, { ca: cert });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const now = Date.now();
    const request = createRelayPeerRequestV1({
      supportedGroups: ['public'], maxPeers: 1,
      createdAt: now, expiresAt: now + 30_000,
    });
    const response = new Promise<string>((resolve, reject) => {
      socket.once('message', data => resolve(data.toString()));
      socket.once('error', reject);
    });
    socket.send(serializeRelayPeerRequestFrameV1(createRelayPeerRequestFrameV1(request)));
    const frame = parseRelayPeerResponseFrameV1(await response);
    expect(verifyRelayPeerResponseV1(frame.response, request)).toBe(true);
    socket.close();
    await new Promise<void>(resolve => socket.once('close', resolve));

    const untrusted = new WebSocket(`wss://127.0.0.1:${port}/`);
    await expect(new Promise<void>((resolve, reject) => {
      untrusted.once('open', resolve);
      untrusted.once('error', reject);
    })).rejects.toBeInstanceOf(Error);
  }, 15_000);

  it('requires a loopback backend when WSS is supplied by a TLS proxy', () => {
    expect(() => createRelayServer({
      host: '0.0.0.0',
      relayDiscovery: {
        endpoints: ['wss://relay.example.org/'],
        reachability: 'direct', supportedGroups: ['public'],
        storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      },
    })).toThrow('must bind its cleartext backend to loopback');
  });

  it('does not advertise cleartext endpoints from a TLS listener', () => {
    expect(() => createRelayServer({
      tls: { cert, key },
      relayDiscovery: {
        endpoints: ['ws://127.0.0.1:9090/'],
        reachability: 'direct', supportedGroups: ['public'],
        storage: { capacityBytes: 1_000_000, availableBytes: 800_000 },
      },
    })).toThrow('can advertise only wss://');
  });
});
