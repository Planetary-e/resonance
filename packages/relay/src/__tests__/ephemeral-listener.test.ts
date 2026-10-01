import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayContactHintV1 } from '@resonance/core';
import { createRelayServer } from '../server.js';
import { discoverRelayContactV1 } from '../relay-discovery-client.js';

it('advertises the OS-assigned listener after start and restart while retaining fixed external endpoints', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'resonance-ephemeral-listener-'));
  const fixed = 'wss://volunteer.example.org:8443/';
  const relay = createRelayServer({ host: '127.0.0.1', port: 0, persistDir: directory, identityPassphrase: 'ephemeral-listener-test-only',
    relayDiscovery: { endpoints: ['ws://127.0.0.1:0/', fixed], reachability: 'direct', supportedGroups: ['public'],
      storage: { capacityBytes: 1000000, availableBytes: 900000 } } });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await relay.start();
      const descriptor = relay.getRelayDescriptor()!;
      expect(descriptor.endpoints).toContain(fixed);
      const local = descriptor.endpoints.find(endpoint => endpoint.startsWith('ws:'))!;
      expect(Number(new URL(local).port)).toBeGreaterThan(0);
      const discovered = await discoverRelayContactV1(createRelayContactHintV1('invitation', local, descriptor.relayId));
      expect(discovered.responder.endpoints).toEqual(descriptor.endpoints);
      await relay.stop();
    }
  } finally { await relay.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 10000);
