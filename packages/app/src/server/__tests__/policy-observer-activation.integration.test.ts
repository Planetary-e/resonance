import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { EmbeddingEngine, generateIdentity } from '@resonance/core';
import { policyObserverSetupFixture } from '../../../../relay/src/__tests__/fixtures/policy-observer-setup-fixture.js';
import { historyVolunteerCollectionFixture } from '../../../../relay/src/__tests__/fixtures/history-volunteer-collection-fixture.js';
import { openConfiguredPolicyObserver, readPolicyObserverConfigurationFile } from '../../../../relay/src/policy-observer-config.js';
import * as observerConfiguration from '../../../../relay/src/policy-observer-config.js';
import { fencePolicyObserverRecoverySource } from '../../../../relay/src/protected-policy-observer.js';
import { createAppServer } from '../server.js';
import { lockSession, loadRelayConfig } from '../session.js';
import { installRelayService, relayServiceStats, relayServiceRuntime, validateRelayServicePaths } from '../relay-supervisor.js';
import { policyObserverActivationServiceFiles, withRelayPolicyObserverActivation } from '../policy-observer-activation.js';
import { relayStorageDirectories } from '../history-storage.js';

vi.mock('../relay-supervisor.js', async original => ({ ...await original<typeof import('../relay-supervisor.js')>(),
  installRelayService: vi.fn(), uninstallRelayService: vi.fn(), relayServiceStats: vi.fn(async () => null) }));
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  lockSession(); const errors: unknown[] = [];
  try { for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } } }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); vi.mocked(relayServiceStats).mockResolvedValue(null); }
  if (errors.length) throw new AggregateError(errors, 'Observer selection cleanup failed');
});
async function fixture() {
  const n = await policyObserverSetupFixture(close => cleanup.push(close)); await n.prepare();
  for (let i = 0; i < 5; i++) { await n.enroll(i); await n.start(i); }
  await n.initialize();
  const desktop = join(n.directory, 'desktop'), runtimeDirectory = join(desktop, 'relay-data'); mkdirSync(runtimeDirectory, { recursive: true });
  vi.stubEnv('RESONANCE_DATA_DIR', desktop); vi.stubEnv('RESONANCE_RELAY_ENTRY', fileURLToPath(new URL('../../../../relay/src/main.ts', import.meta.url)));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const settings = join(desktop, 'relay-config.json'); writeFileSync(settings, JSON.stringify({ enabled: false, port }));
  vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
  const app = createAppServer({ port: 0, relayUrl: `ws://127.0.0.1:${port}/` }), base = `http://127.0.0.1:${await app.start()}`;
  cleanup.push(() => app.stop()); let token = '';
  const request = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() };
  };
  const unlock = async () => { const response = await request('/api/unlock', { password: 'observer selection test' }); expect(response.status).toBe(200); token = response.body.token; };
  const init = async () => { expect((await request('/api/init', { password: 'observer selection test' })).status).toBe(200); await unlock(); };
  const input = { configurationFile: n.configPath, linksFile: '' };
  const review = () => request('/api/relay/history/policy-observer/review', { input });
  const apply = (approvalDigest: string) => request('/api/relay/history/policy-observer/apply', { input, approvalDigest });
  const open = () => openConfiguredPolicyObserver(readPolicyObserverConfigurationFile(n.configPath));
  const pause = async () => { expect((await request('/api/relay/maintenance', {})).status).toBe(200); };
  return { ...n, desktop, runtimeDirectory, settings, request, unlock, init, input, review, apply, open, pause };
}

it('requires authentication and maintenance, saves reviewed history, and retains selection across unlock and service updates', async () => {
  const n = await fixture(); expect((await n.review()).status).toBe(401); await n.init(); expect((await n.review()).status).toBe(409); await n.pause();
  const review = await n.review(); expect(review.status, JSON.stringify(review.body)).toBe(200);
  expect(review.body).toMatchObject({ head: { revision: 1 }, pending: false, blocked: false, fenced: false, startsService: false, readiness: 'unverified' });
  expect(review.body.members).toHaveLength(5); expect((await n.apply('sha256:' + '0'.repeat(64))).status).toBe(409);
  expect((await n.apply(review.body.approvalDigest)).body).toMatchObject({ result: 'policy-observer-selected', startsService: false, maintenanceActive: true });
  expect(installRelayService).not.toHaveBeenCalled(); const saved = loadRelayConfig(); expect(saved.enabled).toBe(false);
  expect(saved.historyStorageDirectories).toContain(realpathSync(n.ownerDirectory));
  await n.request('/api/lock', {}); await n.unlock(); expect((await n.request('/api/relay/history/policy-observer')).body.input).toEqual(n.input);
  vi.stubEnv('RESONANCE_RELAY_POLICY_OBSERVER_FILE', '/obsolete/config.json'); vi.stubEnv('RESONANCE_RELAY_POLICY_OBSERVER_LINKS_FILE', '/obsolete/links.json');
  expect(relayServiceRuntime(saved.runtime, policyObserverActivationServiceFiles(saved))).toMatchObject({ policyObserverFile: n.configPath, policyObserverLinksFile: '' });
  expect((await n.request('/api/relay/maintenance', undefined, 'DELETE')).status).toBe(200);
  vi.mocked(relayServiceStats).mockResolvedValue({});
  expect((await n.request('/api/relay/start', {})).status).toBe(200);
  expect(installRelayService).toHaveBeenCalledTimes(1); expect(loadRelayConfig().policyObserverBinding).toEqual(saved.policyObserverBinding);
}, 15000);

it('invalidates approval after an accepted policy update and preserves evidence/inventory through a settings failure', async () => {
  const n = await fixture(); await n.init(); await n.pause(); const review = await n.review();
  const observer = await n.open(); try { await observer.ready(); await observer.advance(n.advance); } finally { observer.close(); }
  expect((await n.apply(review.body.approvalDigest)).status).toBe(409); const updated = await n.review(); expect(updated.body.head.revision).toBe(2);
  const previous = readFileSync(n.settings);
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === n.settings) throw new Error('Injected observer settings failure'); actualFs.renameSync(from, to); });
  try { expect((await n.apply(updated.body.approvalDigest)).body.error).toContain('Injected observer settings failure'); }
  finally { vi.mocked(renameSync).mockImplementation(actualFs.renameSync); }
  expect(readFileSync(n.settings)).toEqual(previous);
  expect(relayStorageDirectories(loadRelayConfig(), n.runtimeDirectory)).toContain(realpathSync(n.ownerDirectory));
  const retained = await n.open(); try { expect(retained.status().head.revision).toBe(2); } finally { retained.close(); }
  const retry = await n.review(); expect((await n.apply(retry.body.approvalDigest)).status).toBe(200); expect(installRelayService).not.toHaveBeenCalled();
}, 15000);

it('requires a new review for changed files, refuses invalid routing and prevents activation-time replacement of retained history', async () => {
  const n = await fixture(); await n.init(); await n.pause(); const first = await n.review();
  writeFileSync(n.keyFiles[0], readFileSync(n.keyFiles[0], 'utf8') + '\n'); expect((await n.apply(first.body.approvalDigest)).status).toBe(409);
  const second = await n.review(); expect((await n.apply(second.body.approvalDigest)).status).toBe(200);
  const original = readFileSync(n.configPath), config = JSON.parse(original.toString());
  writeFileSync(n.configPath, JSON.stringify({ ...config, listen: { ...config.listen, maxConnections: 2 } }));
  expect(() => policyObserverActivationServiceFiles(loadRelayConfig())).toThrow('changed');
  const changed = await n.review(); expect(changed.status).toBe(200); expect((await n.apply(changed.body.approvalDigest)).status).toBe(200);
  const linksFile = join(n.directory, 'invalid-links.json'); writeFileSync(linksFile, '{"version":1}');
  expect((await n.request('/api/relay/history/policy-observer/review', { input: { ...n.input, linksFile } })).status).toBe(409);
  writeFileSync(n.configPath, JSON.stringify({ ...config, directory: join(n.directory, 'replacement') }));
  const refused = await n.review(); expect(refused.status).toBe(409); expect(refused.body.error).toContain('retain its history');
  writeFileSync(n.configPath, original); expect(installRelayService).not.toHaveBeenCalled();
}, 15000);

describe.each(['conflict', 'fence'] as const)('observer with retained %s evidence', kind => {
  let n: Awaited<ReturnType<typeof fixture>>;
  // Persist genuine evidence before measuring activation's refusal to select it.
  beforeEach(async () => {
    n = await fixture(); await n.init(); await n.pause(); const observer = await n.open();
    try {
      if (kind === 'fence') await fencePolicyObserverRecoverySource(observer.reviewRecoverySource());
      else {
        await observer.ready(); await observer.advance(n.advance);
        await expect(observer.advance(n.conflict)).rejects.toThrow('Community policy authority equivocated; retain evidence and stop observations');
      }
    } finally { observer.close(); }
  }, 30000);

  it(`retains ${kind} evidence and refuses to activate that observer`, async () => {
    const review = await n.review(); expect(review.status).toBe(200); expect(review.body[kind === 'fence' ? 'fenced' : 'blocked']).toBe(true);
    expect((await n.apply(review.body.approvalDigest)).status).toBe(409); expect(installRelayService).not.toHaveBeenCalled();
    const retained = await n.open(); try { expect(retained.status()[kind === 'fence' ? 'fenced' : 'blocked']).toBe(true); } finally { retained.close(); }
  }, 15000);
});

it('excludes competing owners and releases ownership after cancellation and changed configuration during approval', async () => {
  const n = await fixture(); await n.init(); await n.pause(); const held = await n.open();
  try { expect((await n.review()).status).toBe(409); } finally { held.close(); }
  const controller = new AbortController(), previous = loadRelayConfig();
  await expect(withRelayPolicyObserverActivation(n.input, previous, n.runtimeDirectory, controller.signal, {}, async prepared => {
    controller.abort(); return prepared.apply(String(prepared.review.approvalDigest));
  })).rejects.toThrow();
  const original = readFileSync(n.configPath);
  await expect(withRelayPolicyObserverActivation(n.input, previous, n.runtimeDirectory, new AbortController().signal, {}, async prepared => {
    const config = JSON.parse(original.toString()); config.listen.maxConnections = 2; writeFileSync(n.configPath, JSON.stringify(config));
    return prepared.apply(String(prepared.review.approvalDigest));
  })).rejects.toThrow('changed');
  writeFileSync(n.configPath, original); expect((await n.review()).status).toBe(200);
}, 15000);

it('preserves a selected observer when a separate volunteer collection is reviewed and saved', async () => {
  const n = await fixture(); await n.init(); await n.pause(); const review = await n.review(); expect((await n.apply(review.body.approvalDigest)).status).toBe(200);
  const binding = loadRelayConfig().policyObserverBinding, collection = await historyVolunteerCollectionFixture(close => cleanup.push(close));
  vi.stubEnv('RESONANCE_RELAY_POLICY_OBSERVER_FILE', '/obsolete/config.json');
  const input = { configurationFile: collection.paths[0] };
  const selected = await n.request('/api/relay/history/collection/review', { input }); expect(selected.status, JSON.stringify(selected.body)).toBe(200);
  expect((await n.request('/api/relay/history/collection/apply', { input, approvalDigest: selected.body.approvalDigest })).status).toBe(200);
  expect(loadRelayConfig().runtime?.policyObserverFile).toBe(n.configPath); expect(loadRelayConfig().policyObserverBinding).toEqual(binding);
  expect(relayStorageDirectories(loadRelayConfig(), n.runtimeDirectory)).toHaveLength(7);
}, 15000);

it('refuses a configuration edited between parsing its fields and hashing its bytes', async () => {
  const n = await fixture(); await n.init(); await n.pause();
  const readConfig = observerConfiguration.readPolicyObserverConfigurationFile;
  vi.spyOn(observerConfiguration, 'readPolicyObserverConfigurationFile').mockImplementationOnce(path => {
    const parsed = readConfig(path), changed = JSON.parse(readFileSync(path, 'utf8'));
    changed.listen.maxConnections = 2; writeFileSync(path, JSON.stringify(changed)); return parsed;
  });
  const review = await n.review(); expect(review.status).toBe(409); expect(review.body.error).toContain('changed');
  expect((await n.review()).status).toBe(200);
}, 15000);

it('refuses expiry during approval without saving or replacing retained policy', async () => {
  const n = await fixture(); await n.init(); await n.pause(); const previous = loadRelayConfig(), bytes = readFileSync(n.settings);
  await expect(withRelayPolicyObserverActivation(n.input, previous, n.runtimeDirectory, new AbortController().signal, {}, async prepared => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(n.first.expiresAt);
    try { return prepared.apply(String(prepared.review.approvalDigest)); } finally { clock.mockRestore(); }
  })).rejects.toThrow('not current');
  expect(readFileSync(n.settings)).toEqual(bytes); const observer = await n.open();
  try { expect(observer.policy()).toEqual(n.first); } finally { observer.close(); }
}, 15000);

it('rejects incompatible co-hosted routing during service preflight in either selection order', async () => {
  const n = await fixture(), config = readPolicyObserverConfigurationFile(n.configPath);
  const identity = () => { const key = generateIdentity(); key.secretKey.fill(0); return key.did; };
  const routes = config.members.map(member => ({ publicKey: member.publicKey, relayId: identity() }));
  const file = (name: string, value: unknown) => { const path = join(n.directory, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const admissionHistoryFile = file('cohosted-owner.json', { version: 1, context: { ...config.historyContext, role: 'relay-admission-spends' },
    members: config.members, ownerKeyFile: config.signingKeyFile });
  const admissionHistoryLinksFile = file('cohosted-owner-links.json', { version: 1, members: routes });
  const policyObserverLinksFile = file('observer-links.json', { version: 1, members: routes });
  const authority = join(n.directory, 'authority.pub'); writeFileSync(authority, n.authority);
  const runtime = relayServiceRuntime(undefined, { policyObserverFile: n.configPath, policyObserverLinksFile,
    admissionHistoryFile, admissionHistoryLinksFile, admissionAuthorityFile: authority,
    admissionPolicyFile: join(n.directory, 'policy.json'), admissionPolicyKeyFile: n.storagePath });
  const service = { ...runtime, dataDir: n.desktop, port: loadRelayConfig().port, contacts: [], adminKey: 'fixture' };
  expect(() => validateRelayServicePaths(service)).not.toThrow();
  const conflicting = { version: 1, members: routes.map((route, i) => i === 0 ? { ...route, relayId: identity() } : route) };
  for (const changed of [policyObserverLinksFile, admissionHistoryLinksFile]) {
    const original = readFileSync(changed); writeFileSync(changed, JSON.stringify(conflicting));
    try { expect(() => validateRelayServicePaths(service)).toThrow('identical pinned relay routes'); }
    finally { writeFileSync(changed, original); }
  }
  expect(installRelayService).not.toHaveBeenCalled();
}, 15000);
