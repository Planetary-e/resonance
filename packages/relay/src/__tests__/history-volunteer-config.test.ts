import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { generateIdentity } from '@resonance/core';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, parseHistoryExchangeResponse, type HistoryExchangeRequest } from '@resonance/core/history-exchange';
import { openHistoryVolunteerService } from '../history-volunteer-service.js';
import { openConfiguredHistoryVolunteer, readHistoryVolunteerConfigurationFile } from '../history-volunteer-config.js';
import { HistoryRelayRouter } from '../history-relay-router.js';
import { createRelayServer } from '../server.js';
import { loadOrCreateRelayIdentity } from '../relay-identity-store.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function waitFor(test: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!test()) { if (Date.now() > deadline) throw new Error('Volunteer process did not connect'); await new Promise(r => setTimeout(r, 10)); }
}
function fixture() {
  const h = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'history-runtime-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const value = { version: 1, context: h.context, genesisId: historyCheckpointEnvelopeId(h.root), directory: 'enrolled',
    signingKeyFile: 'member.json', storageKeyFile: 'storage.hex',
    controllers: [{ relayId: generateIdentity().did, endpoint: 'wss://controller.example/' }],
    limits: { bytesPerGeneration: 16 * 1024 * 1024, blocksPerGeneration: 100, generations: 8 } };
  const path = join(directory, 'volunteer.json'), key = h.memberKeys[0];
  writeFileSync(path, JSON.stringify(value)); writeFileSync(join(directory, 'member.json'), JSON.stringify({
    publicKey: Buffer.from(key.publicKey).toString('base64url'), secretKey: Buffer.from(key.secretKey).toString('base64url'),
  }), { mode: 0o600 }); writeFileSync(join(directory, 'storage.hex'), h.localKey.toString('hex'), { mode: 0o600 });
  const enrolled = join(directory, value.directory);
  const service = openHistoryVolunteerService({ directory: enrolled, context: h.context, localKey: h.localKey,
    signingKey: key, genesisId: value.genesisId, initialize: h.root }); service.close();
  return { ...h, directory, enrolled, path, value, config: () => readHistoryVolunteerConfigurationFile(path) };
}

it('reopens only existing enrollment with relative paths, explicit capacity and pinned contacts', () => {
  const n = fixture(), config = n.config();
  expect(config.directory).toBe(n.enrolled); expect(config.contacts[0].expectedRelayId).toBe(n.value.controllers[0].relayId);
  const runtime = openConfiguredHistoryVolunteer(config);
  expect(runtime.describe()).toMatchObject({ generations: 1, maximumGenerations: 8, latest: { sequence: 0, rootId: n.value.genesisId } });
  const health = runtime.health();
  expect(health).toMatchObject({ generations: 1, maximumGenerations: 8, retainedBlocks: 1, stagedBlocks: 0,
    retainedCiphertextBytes: Buffer.byteLength(JSON.stringify(n.root)), manifestReserveBytes: 4 * 1024 * 1024,
    maximumGenerationBytes: 16 * 1024 * 1024, maximumGenerationBlocks: 100 });
  expect(health.reservedBytes).toBe(health.retainedCiphertextBytes + health.manifestReserveBytes);
  expect(JSON.stringify(health)).not.toContain(n.value.genesisId);
  runtime.close(); runtime.close();
  expect(() => runtime.health()).toThrow();
  const missing = { ...config, directory: join(n.directory, 'missing') };
  expect(() => openConfiguredHistoryVolunteer(missing)).toThrow(); expect(existsSync(missing.directory)).toBe(false);
});

it('refuses malformed, duplicate, insecure, oversized and initialization configuration', () => {
  const n = fixture();
  const invalid = [{ ...n.value, initialize: true }, { ...n.value, controllers: [] },
    { ...n.value, controllers: [n.value.controllers[0], n.value.controllers[0]] },
    { ...n.value, controllers: [{ ...n.value.controllers[0], endpoint: 'ws://public.example/' }] },
    { ...n.value, controllers: [{ ...n.value.controllers[0], relayId: 'not-a-key' }] },
    { ...n.value, limits: { ...n.value.limits, generations: 66 } },
    { ...n.value, limits: { ...n.value.limits, bytesPerGeneration: 0 } }, { ...n.value, directory: '' },
    { ...n.value, limits: { ...n.value.limits, bytesPerGeneration: 4 * 1024 * 1024 } },
    { ...n.value, limits: { ...n.value.limits, bytesPerGeneration: 256 * 1024 * 1024 + 1 } },
    { ...n.value, genesisId: 'untrusted' }];
  for (const value of invalid) { writeFileSync(n.path, JSON.stringify(value)); expect(() => n.config()).toThrow(); }
  writeFileSync(n.path, ' '.repeat(65537)); expect(() => n.config()).toThrow('regular file');
  expect(() => readHistoryVolunteerConfigurationFile(n.directory)).toThrow('regular file');
});

it('preserves enrollment after a wrong key or corrupt private input instead of initializing replacement state', () => {
  const n = fixture(), manifest = join(n.enrolled, 'genesis', 'history-manifest.json'), bytes = readFileSync(manifest);
  const first = openConfiguredHistoryVolunteer(n.config()), before = first.describe(); first.close();
  const keyPath = join(n.directory, 'storage.hex'); writeFileSync(keyPath, randomBytes(32).toString('hex'));
  expect(() => openConfiguredHistoryVolunteer(n.config())).toThrow();
  expect(readFileSync(manifest)).toEqual(bytes);
  writeFileSync(keyPath, n.localKey.toString('hex'));
  const restored = openConfiguredHistoryVolunteer(n.config()); expect(restored.describe()).toEqual(before); restored.close();
  writeFileSync(join(n.directory, 'member.json'), '{"secretKey":"private-fragment');
  expect(() => openConfiguredHistoryVolunteer(n.config())).toThrow('not valid JSON');
  try { openConfiguredHistoryVolunteer(n.config()); } catch (error) { expect(String(error)).not.toContain('private-fragment'); }
  expect(readFileSync(manifest)).toEqual(bytes);
});

function start(env: NodeJS.ProcessEnv) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('RELAY_')));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../main.ts', import.meta.url))],
    { env: { ...inherited, RELAY_HOST: '127.0.0.1', RELAY_PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let output = '';
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Volunteer runtime startup timed out')); }, 20000);
    const read = (b: Buffer) => { output += b.toString(); if (output.includes('"event":"started"')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', read); child.stderr.on('data', read);
    exited.then(() => { clearTimeout(timer); if (!output.includes('"event":"started"')) reject(new Error('Volunteer runtime refused startup')); });
  }); started.catch(() => {});
  async function close() {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  cleanup.push(close); return { started, exited, close, output: () => output };
}

it('runs the enrolled role in the real relay process, survives restart and honors owner limits without losing readable evidence', async () => {
  const n = fixture(), dataDir = join(n.directory, 'relay-data'), volunteerId = loadOrCreateRelayIdentity(dataDir).did;
  const router = new HistoryRelayRouter({ members: [{ publicKey: n.context.members[0], relayId: volunteerId }] }); cleanup.push(() => router.close());
  const controller = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: join(n.directory, 'controller'), historyLinks: router,
    relayDiscovery: { endpoints: ['ws://127.0.0.1:0/'], reachability: 'direct', supportedGroups: ['public'],
      storage: { capacityBytes: 1000000, availableBytes: 1000000 } } });
  await controller.start(); cleanup.push(() => controller.stop({ graceful: false }));
  const descriptor = controller.getRelayDescriptor()!, value = { ...n.value, controllers: [{ relayId: descriptor.relayId, endpoint: descriptor.endpoints[0] }] };
  writeFileSync(n.path, JSON.stringify(value));
  const env = { RELAY_DATA_DIR: dataDir, RELAY_HISTORY_VOLUNTEER_FILE: n.path };
  async function exchange(action: HistoryExchangeRequest['action'], envelope: typeof n.root | ReturnType<typeof n.next> | null) {
    const issuedAt = Date.now(), request = createHistoryExchangeRequest({ action, replica: n.context.members[0], rootId: n.value.genesisId,
      generation: 0, sequence: envelope?.sequence ?? 0, envelopeId: envelope ? historyCheckpointEnvelopeId(envelope) : null,
      issuedAt, expiresAt: issuedAt + 30000, challenge: randomBytes(32).toString('base64url') }, n.context, n.owner);
    return parseHistoryExchangeResponse(await router.checkpoint({ publicKey: request.replica, endpoint: 'ws://127.0.0.1:9/history-checkpoint' },
      { request, envelope }, new AbortController().signal), request, n.context);
  }
  let child = start(env); await child.started; await waitFor(() => controller.getRelayLinkStatus().inboundRelayIds.includes(volunteerId));
  expect((await exchange('head', null)).head.sequence).toBe(0);
  const delta = n.next(n.root); expect((await exchange('append', delta)).status).toBe('stored');
  await child.close(); expect((await child.exited)[0]).toBe(0);
  await waitFor(() => !controller.getRelayLinkStatus().inboundRelayIds.includes(volunteerId));
  child = start({ ...env, RELAY_NEW_WORK_BANDWIDTH_BYTES_PER_HOUR: '0' }); await child.started;
  await waitFor(() => controller.getRelayLinkStatus().inboundRelayIds.includes(volunteerId));
  expect((await exchange('head', null)).head.sequence).toBe(1);
  expect((await exchange('append', delta)).status).toBe('stored'); // Existing obligation remains available.
  await expect(exchange('append', n.next(delta))).rejects.toThrow('refused');
  expect((await exchange('head', null)).head.sequence).toBe(1);
  await child.close(); expect((await child.exited)[0]).toBe(0);
  writeFileSync(n.path, JSON.stringify({ ...value, directory: 'missing' })); child = start(env);
  expect((await child.exited)[0]).not.toBe(0); expect(child.output()).not.toContain('"event":"started"');
  expect(existsSync(join(n.directory, 'missing'))).toBe(false);
}, 60000);

it('closes enrollment gracefully while a configured contact remains silent during startup discovery', async () => {
  const n = fixture(), silent = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(silent, 'listening');
  cleanup.push(async () => { for (const client of silent.clients) client.terminate(); await new Promise<void>(r => silent.close(() => r())); });
  writeFileSync(n.path, JSON.stringify({ ...n.value, controllers: [{ ...n.value.controllers[0],
    endpoint: `ws://127.0.0.1:${(silent.address() as AddressInfo).port}/` }] }));
  const child = start({ RELAY_DATA_DIR: join(n.directory, 'relay'), RELAY_HISTORY_VOLUNTEER_FILE: n.path });
  await child.started; await waitFor(() => silent.clients.size > 0); await child.close();
  expect((await child.exited)[0]).toBe(0);
  const reopened = openConfiguredHistoryVolunteer(n.config()); expect(reopened.describe().latest.sequence).toBe(0); reopened.close();
}, 30000);
