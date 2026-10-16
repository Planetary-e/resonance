import { expect, it } from 'vitest';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayServer } from '../server.js';

it('rejects an occupied listener port without an uncaught WebSocket error and can restart after the port is released', async () => {
  const occupied = createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  const address = occupied.address(); if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  const directory = mkdtempSync(join(tmpdir(), 'relay-startup-'));
  const relay = createRelayServer({ port: address.port, host: '127.0.0.1', persistDir: directory });
  try {
    await expect(relay.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(relay.getListeningPort()).toBeNull();
    expect(occupied.listening).toBe(true); // Failure cleanup must not disturb the other service.
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    await relay.start(); expect(relay.getListeningPort()).toBe(address.port);
    await relay.stop(); expect(relay.getListeningPort()).toBeNull();
  } finally {
    await relay.stop({ graceful: false });
    if (occupied.listening) await new Promise<void>(resolve => occupied.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
