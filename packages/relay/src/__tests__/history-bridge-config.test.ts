import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentity } from '@resonance/core';
import { readHistoryBridgeConfigurationFile } from '../history-bridge-config.js';
import { readAdmissionHistoryLinksFile } from '../admission-history-config.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function file() { const dir = mkdtempSync(join(tmpdir(), 'history-bridge-config-')); directories.push(dir); return { dir, path: join(dir, 'config.json') }; }
it('loads only bounded, distinct, explicit controller-to-target permissions', () => {
  const n = file(), routes = Array.from({ length: 5 }, () => ({ controllerRelayId: generateIdentity().did, targetRelayId: generateIdentity().did }));
  writeFileSync(n.path, JSON.stringify({ version: 1, routes })); expect(readHistoryBridgeConfigurationFile(n.path)).toEqual({ routes });
  const invalid = [{ version: 1, routes: [] }, { version: 1, routes, initialize: true }, { version: 2, routes },
    { version: 1, routes: [routes[0], routes[0]] }, { version: 1, routes: [{ ...routes[0], targetRelayId: routes[0].controllerRelayId }] },
    { version: 1, routes: [{ ...routes[0], targetRelayId: 'unknown' }] },
    { version: 1, routes: [{ ...routes[0], endpoint: 'wss://implicit.invalid/' }] },
    { version: 1, routes: Array.from({ length: 33 }, () => ({ controllerRelayId: generateIdentity().did, targetRelayId: generateIdentity().did })) },
    { version: 1, routes: Array.from({ length: 17 }, () => ({ controllerRelayId: generateIdentity().did, targetRelayId: generateIdentity().did })) }];
  for (const value of invalid) { writeFileSync(n.path, JSON.stringify(value)); expect(() => readHistoryBridgeConfigurationFile(n.path)).toThrow(); }
  writeFileSync(n.path, ' '.repeat(65537)); expect(() => readHistoryBridgeConfigurationFile(n.path)).toThrow('regular file');
  expect(() => readHistoryBridgeConfigurationFile(n.dir)).toThrow('regular file');
});
it('retains all five history and infrastructure pins while selecting one explicit secure bridge contact', () => {
  const n = file(), h = historyCheckpointFixture();
  const members = h.context.members.map(publicKey => ({ publicKey, relayId: generateIdentity().did }));
  const bridge = { relayId: generateIdentity().did, endpoint: 'wss://volunteer.example/relay' };
  const value = { version: 2, members, bridge }; writeFileSync(n.path, JSON.stringify(value));
  const parsed = readAdmissionHistoryLinksFile(n.path, h.context);
  expect(parsed.members).toEqual(members.map(m => ({ ...m, viaRelayId: bridge.relayId })));
  expect(parsed.contacts).toMatchObject([{ endpoint: bridge.endpoint, expectedRelayId: bridge.relayId, source: 'configured' }]);
  const invalid = [{ ...value, version: 1 }, { ...value, bridge: { ...bridge, endpoint: 'ws://public.example/' } },
    { ...value, bridge: { ...bridge, relayId: members[0].relayId } }, { ...value, bridge: { ...bridge, endpoint: 'wss://' + 'x'.repeat(2048) } },
    { ...value, bridge: { ...bridge, fallback: true } }, { ...value, members: members.slice(1) },
    { ...value, members: members.map(m => ({ ...m, viaRelayId: bridge.relayId })) },
    { ...value, members: members.map(m => ({ ...m, relayId: members[0].relayId })) },
    { ...value, members: members.map((m, i) => i === 4 ? { ...m, publicKey: h.context.owner } : m) }];
  for (const raw of invalid) { writeFileSync(n.path, JSON.stringify(raw)); expect(() => readAdmissionHistoryLinksFile(n.path, h.context)).toThrow(); }
});
