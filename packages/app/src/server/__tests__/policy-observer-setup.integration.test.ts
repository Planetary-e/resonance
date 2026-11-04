import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { EmbeddingEngine } from '@resonance/core';
import { policyObserverSetupFixture } from '../../../../relay/src/__tests__/fixtures/policy-observer-setup-fixture.js';
import { openConfiguredPolicyObserver, readPolicyObserverConfigurationFile } from '../../../../relay/src/policy-observer-config.js';
import * as operatorFiles from '../../../../relay/src/admission-operator-files.js';
import { POLICY_OBSERVER_ROOT_SUFFIX } from '../../../../relay/src/policy-observer-setup.js';
import { createAppServer } from '../server.js';
import { lockSession, loadRelayConfig } from '../session.js';
import { installRelayService } from '../relay-supervisor.js';
import { runDesktopPolicyObserverSetup, type RelayPolicyObserverSetupInput } from '../policy-observer-setup.js';
import { readRelayStorageLocations } from '../history-storage-registry.js';

vi.mock('../relay-supervisor.js', async original => ({ ...await original<typeof import('../relay-supervisor.js')>(),
  installRelayService: vi.fn(), uninstallRelayService: vi.fn(), relayServiceStats: vi.fn(async () => null) }));
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  lockSession(); const errors: unknown[] = [];
  try { for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } } }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); }
  if (errors.length) throw new AggregateError(errors, 'Observer setup cleanup failed');
});
async function fixture() {
  const n = await policyObserverSetupFixture(close => cleanup.push(close));
  const desktop = join(n.directory, 'desktop'), runtime = join(desktop, 'relay-data'); mkdirSync(runtime, { recursive: true });
  vi.stubEnv('RESONANCE_DATA_DIR', desktop); vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
  vi.stubEnv('RESONANCE_RELAY_ENTRY', fileURLToPath(new URL('../../../../relay/src/main.ts', import.meta.url)));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const settings = join(desktop, 'relay-config.json'); writeFileSync(settings, JSON.stringify({ enabled: false, port }));
  const app = createAppServer({ port: 0, relayUrl: `ws://127.0.0.1:${port}/` }), base = `http://127.0.0.1:${await app.start()}`;
  cleanup.push(() => app.stop()); let token = '';
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const unlock = async () => { const response = await request('/api/unlock', { password: 'observer setup test' }); expect(response.status).toBe(200); token = response.body.token; };
  const init = async () => { expect((await request('/api/init', { password: 'observer setup test' })).status).toBe(200); await unlock(); };
  const pause = async () => { expect((await request('/api/relay/maintenance', {})).status).toBe(200); };
  const setup = (action: 'review' | 'apply', input: RelayPolicyObserverSetupInput, approvalDigest?: string) =>
    request('/api/relay/history/policy-observer/setup', { action, input, ...(action === 'apply' ? { approvalDigest } : {}) });
  const perform = async (input: RelayPolicyObserverSetupInput) => {
    const plan = await setup('review', input); expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const result = await setup('apply', input, plan.body.result.approvalDigest); expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body.result;
  };
  const prepare: RelayPolicyObserverSetupInput = { role: 'prepare', setupFile: n.setupFile, output: n.configPath };
  const enrollment: RelayPolicyObserverSetupInput = { role: 'enrollment-export', configurationFile: n.configPath, output: n.enrollmentPath };
  const volunteer = (i: number): Extract<RelayPolicyObserverSetupInput, { role: 'enroll' }> => ({ role: 'enroll', enrollmentFile: n.enrollmentPath,
    signingKeyFile: n.keyFiles[i], storageKeyFile: n.storageFiles[i], directory: join(n.directory, `replica-${i}`) });
  const initialize: RelayPolicyObserverSetupInput = { role: 'initialize', configurationFile: n.configPath, operatorTransportFile: '' };
  return { ...n, desktop, runtime, settings, request, init, unlock, pause, setup, perform, prepare, enrollment, volunteer, initialize,
    anchor: realpathSync(n.keyFiles[0]) + POLICY_OBSERVER_ROOT_SUFFIX };
}

it('prepares, exports, enrolls five volunteers and initializes through authenticated maintenance without starting services', async () => {
  const n = await fixture(); expect((await n.setup('review', n.prepare)).status).toBe(401);
  await n.init(); expect((await n.setup('review', n.prepare)).status).toBe(409); await n.pause();
  const plan = await n.setup('review', n.prepare); expect(plan.status).toBe(200);
  expect(existsSync(n.configPath)).toBe(false); expect(existsSync(n.anchor)).toBe(false);
  expect((await n.setup('apply', n.prepare, 'sha256:' + '0'.repeat(64))).status).toBe(409);
  expect((await n.setup('apply', n.prepare, plan.body.result.approvalDigest)).body.result).toMatchObject({ result: 'policy-observer-prepared', readiness: 'unverified', startsService: false });
  await n.perform(n.enrollment);
  const publicFile = readFileSync(n.enrollmentPath, 'utf8');
  expect(publicFile).not.toContain(n.directory); expect(publicFile).not.toContain('secretKey'); expect(publicFile).not.toContain('storageKey');
  for (let i = 0; i < 5; i++) { await n.perform(n.volunteer(i)); await n.start(i); }
  await n.perform(n.initialize);
  const observer = await openConfiguredPolicyObserver(readPolicyObserverConfigurationFile(n.configPath));
  try { await observer.ready(); expect(observer.policy()).toEqual(n.first); } finally { observer.close(); }
  const inventory = readRelayStorageLocations(n.runtime);
  expect(inventory.directories).toContain(realpathSync(n.ownerDirectory)); expect(inventory.files).toEqual(expect.arrayContaining([n.anchor, realpathSync(n.configPath), realpathSync(n.enrollmentPath)]));
  const selected = await n.request('/api/relay/history/policy-observer/review', { input: { configurationFile: n.configPath, linksFile: '' } });
  expect(selected.status, JSON.stringify(selected.body)).toBe(200); expect(selected.body.head.revision).toBe(1);
  await n.request('/api/lock', {}); await n.unlock();
  expect((await n.request('/api/relay/history/policy-observer/setup')).body.input).toEqual(n.initialize);
  expect(loadRelayConfig().enabled).toBe(false); expect(installRelayService).not.toHaveBeenCalled();
}, 30000);

it('retains the original preparation and inventory after settings failure and re-exports its exact genesis', async () => {
  const n = await fixture(); await n.init(); await n.pause(); const plan = await n.setup('review', n.prepare), before = readFileSync(n.settings);
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === n.settings) throw new Error('Injected setup settings failure'); actualFs.renameSync(from, to); });
  try { expect((await n.setup('apply', n.prepare, plan.body.result.approvalDigest)).body.error).toContain('Injected setup settings failure'); }
  finally { vi.mocked(renameSync).mockImplementation(actualFs.renameSync); }
  expect(readFileSync(n.settings)).toEqual(before); const retained = readPolicyObserverConfigurationFile(n.configPath);
  expect(readRelayStorageLocations(n.runtime).files).toEqual(expect.arrayContaining([n.anchor, realpathSync(n.configPath)]));
  expect((await n.setup('review', { ...n.prepare, output: join(n.directory, 'second-root.json') })).status).toBe(409);
  const output = join(n.directory, 're-export.json');
  await n.perform({ role: 'export-prepared', setupFile: n.setupFile, output });
  expect(readPolicyObserverConfigurationFile(output)).toEqual(retained);
  expect(readRelayStorageLocations(n.runtime).files).toContain(realpathSync(output)); expect(installRelayService).not.toHaveBeenCalled();
}, 15000);

it('invalidates changed inputs and cancels before mutation while retaining any earlier preparation', async () => {
  const n = await fixture(); await n.init(); await n.pause(); const plan = await n.setup('review', n.prepare);
  writeFileSync(n.keyFiles[0], readFileSync(n.keyFiles[0], 'utf8') + '\n');
  expect((await n.setup('apply', n.prepare, plan.body.result.approvalDigest)).status).toBe(409); expect(existsSync(n.anchor)).toBe(false);
  const controller = new AbortController();
  const current = await runDesktopPolicyObserverSetup('review', n.prepare, undefined, controller.signal, n.runtime, () => {});
  await expect(runDesktopPolicyObserverSetup('apply', n.prepare, current.result.approvalDigest, controller.signal, n.runtime, () => controller.abort())).rejects.toThrow();
  expect(existsSync(n.anchor)).toBe(false); await n.perform(n.prepare); await n.perform(n.enrollment);
  const initial = await n.setup('review', n.initialize); expect(initial.status).toBe(200);
  const failed = await n.setup('apply', n.initialize, initial.body.result.approvalDigest); expect(failed.status).toBe(409);
  expect(existsSync(join(n.ownerDirectory, 'history-writer.json'))).toBe(false);
  expect(readPolicyObserverConfigurationFile(n.configPath).genesis).toEqual(readPolicyObserverConfigurationFile(n.anchor).genesis);
}, 15000);

it('resumes retained enrollment and refuses overlapping runtime locations or arbitrary actions', async () => {
  const n = await fixture(); await n.init(); await n.pause(); await n.perform(n.prepare); await n.perform(n.enrollment);
  const input = n.volunteer(0); await n.perform(input);
  await n.perform({ ...input, role: 'resume-enrollment' });
  expect((await n.setup('review', { ...input, directory: n.runtime })).status).toBe(409);
  expect((await n.request('/api/relay/history/policy-observer/setup', { action: 'serve', input })).status).toBe(409);
  expect((await n.request('/api/relay/history/policy-observer/setup', { action: 'review', input: { ...input, command: 'shell' } })).status).toBe(409);
  await n.start(0); expect(installRelayService).not.toHaveBeenCalled();
}, 15000);

it('rejects a setup file changed between parsing and fingerprint capture', async () => {
  const n = await fixture(); await n.init(); await n.pause(); const read = operatorFiles.readOperatorFile; let calls = 0;
  const original = readFileSync(n.setupFile);
  const spy = vi.spyOn(operatorFiles, 'readOperatorFile').mockImplementation((path, maximum) => {
    if (String(path) === n.setupFile && ++calls === 2) {
      const changed = JSON.parse(original.toString()); changed.listen.maxConnections = 2; writeFileSync(n.setupFile, JSON.stringify(changed));
    }
    return read(path, maximum);
  });
  try { const result = await n.setup('review', n.prepare); expect(result.status).toBe(409); expect(result.body.error).toContain('changed'); }
  finally { spy.mockRestore(); }
  expect(existsSync(n.anchor)).toBe(false); expect((await n.setup('review', n.prepare)).status).toBe(200);
}, 15000);
