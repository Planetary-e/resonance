import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createMailboxEnvelopeId, generateRelationshipKeyMaterial } from '@resonance/core';
import { createRelayServer } from '@resonance/relay';
import { createRelayClient } from '../relay-client.js';

it('shares one deadline across queued mailbox destinations and keeps replies validated before expiry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'resonance-mailbox-deadline-'));
  const basePort = 51_000 + Math.floor(Math.random() * 1_000);
  const endpoints = [`ws://127.0.0.1:${basePort}/`, `ws://[::1]:${basePort + 1}/`, `ws://[::1]:${basePort + 2}/`];
  const relays = endpoints.map((endpoint, index) => createRelayServer({
    port: basePort + index, host: index === 0 ? '127.0.0.1' : '::1', persistDir: join(directory, String(index)),
    relayDiscovery: {
      endpoints: [endpoint], reachability: 'direct', supportedGroups: ['public'],
      storage: { capacityBytes: 1_000_000, availableBytes: 900_000 }, maxKnownRelays: 8,
    },
  }));
  const clients = [0, 1].map(() => createRelayClient({
    relayUrl: endpoints[1], fallbackUrls: [endpoints[2]], privateEntryUrls: [endpoints[0]],
    privateTraffic: { maxConcurrent: 1, maxQueueWaitMs: 10_000 },
  }));
  const blockedIds = new Set<string>();
  const requestSockets = new Map<string, WebSocket>();
  const originalEmit = WebSocket.prototype.emit;
  const originalSend = WebSocket.prototype.send;
  try {
    for (const relay of relays) await relay.start();
    for (const relay of relays.slice(1)) expect(relays[0].observeRelayDescriptor(relay.getRelayDescriptor()!)).toBe('accepted');
    vi.spyOn(WebSocket.prototype, 'emit').mockImplementation(function (this: WebSocket, event, ...args) {
      if (event === 'message' && this.url === endpoints[2]) {
        const frame = JSON.parse(String(args[0]));
        if (frame.type === 'private_response') blockedIds.add(frame.requestId);
      }
      return Reflect.apply(originalEmit, this, [event, ...args]);
    });
    vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data, ...args) {
      if (typeof data === 'string') {
        const frame = JSON.parse(data);
        if (this.url === endpoints[0] && frame.stage === 'entry') requestSockets.set(frame.requestId, this);
        if (frame.type === 'private_response' && blockedIds.has(frame.requestId)) return; // Withhold the final reply if it is attempted.
      }
      return Reflect.apply(originalSend, this, [data, ...args]);
    });
    const keys = generateRelationshipKeyMaterial();
    const started = performance.now();
    const [fetched, acknowledged] = await Promise.all([
      clients[0].fetchRelationshipMailbox(keys),
      clients[1].acknowledgeRelationshipMailbox(keys, [createMailboxEnvelopeId('deadline-test', keys.mailboxId)]),
    ]);
    expect(fetched.envelopes).toEqual([]);
    expect(acknowledged.status).toBe('ok');
    // Each second destination started only after the first completed; it gets the remaining budget.
    expect(performance.now() - started).toBeGreaterThanOrEqual(9_950);
    expect(performance.now() - started).toBeLessThan(11_000);
    expect(blockedIds.size).toBe(2);
    // A slower host may hit the deadline during validation/mixing, before the final
    // write. Assert cancellation of the actual client requests, not that a late write ran.
    const heldSockets = [...blockedIds].map(id => requestSockets.get(id)!);
    expect(heldSockets).toHaveLength(2); expect(heldSockets.every(Boolean)).toBe(true);
    await expect.poll(() => heldSockets.every(socket => socket.readyState === WebSocket.CLOSED)).toBe(true);
  } finally {
    clients.forEach(client => client.disconnect());
    vi.restoreAllMocks();
    for (const relay of [...relays].reverse()) await relay.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
