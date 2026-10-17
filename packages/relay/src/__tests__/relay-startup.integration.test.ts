import { expect, it } from 'vitest';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayServer } from '../server.js';

it('settles repeated shutdown before startup and preserves the original bind error during group cleanup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-group-startup-'));
  const started = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: join(directory, 'started') });
  const neverStarted = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: join(directory, 'unstarted') });
  let colliding: ReturnType<typeof createRelayServer> | undefined;
  try {
    await neverStarted.stop(); await neverStarted.stop({ graceful: false });
    await started.start();
    colliding = createRelayServer({ port: started.getListeningPort()!, host: '127.0.0.1', persistDir: join(directory, 'colliding') });
    const group = async () => {
      try { await colliding!.start(); await neverStarted.start(); }
      finally { for (const relay of [neverStarted, colliding!, started]) await relay.stop({ graceful: false }); }
    };
    await expect(group()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(started.getListeningPort()).toBeNull(); expect(neverStarted.getListeningPort()).toBeNull();
    await neverStarted.start(); expect(neverStarted.getListeningPort()).toBeGreaterThan(0); await neverStarted.stop();
  } finally {
    for (const relay of [neverStarted, colliding, started]) if (relay) await relay.stop({ graceful: false });
    rmSync(directory, { recursive: true, force: true });
  }
}, 5000);

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
