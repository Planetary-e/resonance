import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { EmbeddingEngine } from '@resonance/core';
import { policyObserverSetupFixture } from '../../../../relay/src/__tests__/fixtures/policy-observer-setup-fixture.js';
import { openConfiguredPolicyObserver, readPolicyObserverConfigurationFile } from '../../../../relay/src/policy-observer-config.js';
import { createAppServer } from '../server.js';
import { lockSession, loadRelayConfig } from '../session.js';
import { installRelayService } from '../relay-supervisor.js';
import { runDesktopPolicyObserverRecovery, type RelayPolicyObserverRecoveryAction, type RelayPolicyObserverRecoveryInput } from '../policy-observer-recovery.js';
import { readRelayStorageLocations } from '../history-storage-registry.js';
import { policyObserverActivationServiceFiles } from '../policy-observer-activation.js';

vi.mock('../relay-supervisor.js', async original => ({ ...await original<typeof import('../relay-supervisor.js')>(),
  installRelayService: vi.fn(), uninstallRelayService: vi.fn(), relayServiceStats: vi.fn(async () => null) }));
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  lockSession(); const errors: unknown[] = [];
  try { for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } } }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); }
  if (errors.length) throw new AggregateError(errors, 'Observer recovery cleanup failed');
});
async function fixture() {
  const n = await policyObserverSetupFixture(close => cleanup.push(close)); await n.prepare();
  const volunteers: Array<Awaited<ReturnType<typeof n.start>>> = [];
  for (let i = 0; i < 5; i++) { await n.enroll(i); volunteers.push(await n.start(i)); } await n.initialize();
  const original = await openConfiguredPolicyObserver(readPolicyObserverConfigurationFile(n.configPath));
  try { await original.ready(); await original.advance(n.advance); } finally { original.close(); }
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
  const unlock = async () => { const response = await request('/api/unlock', { password: 'observer recovery test' }); expect(response.status).toBe(200); token = response.body.token; };
  const init = async () => { expect((await request('/api/init', { password: 'observer recovery test' })).status).toBe(200); await unlock(); };
  const pause = async () => { expect((await request('/api/relay/maintenance', {})).status).toBe(200); };
  const input: RelayPolicyObserverRecoveryInput = { configurationFile: n.configPath, workspaceDirectory: join(n.directory, 'recovery'),
    restoredDirectory: join(n.directory, 'restored'), outputFile: join(n.directory, 'restored-config.json'), operatorTransportFile: '', source: 'available', view: 1 };
  const call = (action: RelayPolicyObserverRecoveryAction, approvalDigest?: string, selection = input) =>
    request('/api/relay/history/policy-observer/recovery', { action, input: selection, ...(['start', 'restore', 'resume', 'export'].includes(action) ? { approvalDigest } : {}) });
  const run = async (action: RelayPolicyObserverRecoveryAction, approval?: string, selection = input) => {
    const result = await call(action, approval, selection); expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body.result;
  };
  const finish = async () => {
    let status = await run('status');
    for (let steps = 0; !status.complete && steps < 10; steps++) status = await run('step');
    expect(status.complete).toBe(true); return status;
  };
  const restore = async () => { const review = await run('review'); await run('restore', review.approvalDigest); return review; };
  return { ...n, input, volunteers, desktop, runtime, settings, request, init, unlock, pause, call, run, finish, restore };
}

it('recovers accepted policies through the app, resumes across lock and separately approves restoration and configuration export', async () => {
  const n = await fixture(); expect((await n.call('plan')).status).toBe(401); await n.init(); expect((await n.call('plan')).status).toBe(409); await n.pause();
  const originalInput = { configurationFile: n.configPath, linksFile: '' };
  const originalReview = await n.request('/api/relay/history/policy-observer/review', { input: originalInput }); expect(originalReview.status).toBe(200);
  expect((await n.request('/api/relay/history/policy-observer/apply', { input: originalInput, approvalDigest: originalReview.body.approvalDigest })).status).toBe(200);
  const originalBinding = loadRelayConfig().policyObserverBinding;
  const plan = await n.run('plan'); expect(plan.kind).toBe('policy-observer-recovery-freeze'); expect(plan.localStateDigest).not.toBeNull();
  expect(existsSync(n.input.workspaceDirectory)).toBe(false);
  expect((await n.call('start', 'sha256:' + '0'.repeat(64))).status).toBe(409);
  expect((await n.run('start', plan.approvalDigest)).phase).toBe('freeze');
  const source = await openConfiguredPolicyObserver(readPolicyObserverConfigurationFile(n.configPath));
  try { expect(source.status().fenced).toBe(true); await expect(source.ready()).rejects.toThrow('fenced'); } finally { source.close(); }
  await n.volunteers[3].close!(); await n.volunteers[4].close!();
  expect((await n.call('step')).status).toBe(409); expect((await n.run('status')).complete).toBe(false);
  await n.start(3); await n.start(4);
  await n.run('step'); await n.request('/api/lock', {}); await n.unlock();
  expect((await n.request('/api/relay/history/policy-observer/recovery')).body.input).toEqual(n.input);
  await n.finish(); const review = await n.restore(); expect(review).toMatchObject({ policyRevision: 2, blocked: false, generation: 1 });
  expect((await n.run('status')).destinationOccupied).toBe(true);
  const resume = await n.run('resume-plan'); expect(resume.initializeWriter).toBe(false); await n.run('resume', resume.approvalDigest);
  const exported = await n.run('export-plan'); expect(existsSync(n.input.outputFile)).toBe(false);
  expect((await n.call('export', resume.approvalDigest)).status).toBe(409);
  await n.run('export', exported.approvalDigest);
  const restoredConfig = readPolicyObserverConfigurationFile(n.input.outputFile);
  expect(restoredConfig.archiveDirectory).toBe(join(n.input.workspaceDirectory, 'download'));
  expect(restoredConfig.root.generation).toBe(1); expect(restoredConfig.genesis).toEqual(readPolicyObserverConfigurationFile(n.configPath).genesis);
  expect(loadRelayConfig().policyObserverBinding).toEqual(originalBinding);
  const nextInput = { configurationFile: n.input.outputFile, linksFile: '' };
  const baseline = join(n.input.restoredDirectory, 'policy-observer-restoration.json'); renameSync(baseline, baseline + '.retained');
  try { expect((await n.request('/api/relay/history/policy-observer/review', { input: nextInput })).status).toBe(409); }
  finally { renameSync(baseline + '.retained', baseline); }
  expect(loadRelayConfig().policyObserverBinding).toEqual(originalBinding);
  const selected = await n.request('/api/relay/history/policy-observer/review', { input: nextInput });
  expect(selected.status, JSON.stringify(selected.body)).toBe(200); expect(selected.body.replacement).toMatchObject({ generation: 1, previousRootId: originalBinding!.rootId });
  const restored = await openConfiguredPolicyObserver(restoredConfig);
  try { expect(restored.policy()).toEqual(n.second); await restored.ready(); await restored.advance(n.later); expect(restored.policy()).toEqual(n.third); } finally { restored.close(); }
  expect((await n.request('/api/relay/history/policy-observer/apply', { input: nextInput, approvalDigest: selected.body.approvalDigest })).status).toBe(409);
  const fresh = await n.request('/api/relay/history/policy-observer/review', { input: nextInput }); expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === n.settings) throw new Error('Injected replacement settings failure'); actualFs.renameSync(from, to); });
  try { expect((await n.request('/api/relay/history/policy-observer/apply', { input: nextInput, approvalDigest: fresh.body.approvalDigest })).body.error).toContain('Injected replacement settings failure'); }
  finally { vi.mocked(renameSync).mockImplementation(actualFs.renameSync); }
  expect(loadRelayConfig().policyObserverBinding).toEqual(originalBinding);
  expect((await n.request('/api/relay/history/policy-observer/apply', { input: nextInput, approvalDigest: fresh.body.approvalDigest })).status).toBe(200);
  expect(loadRelayConfig().policyObserverBinding!.rootId).toBe(selected.body.rootId);
  expect(loadRelayConfig().policyObserverBinding!.archiveDirectory).toBe(realpathSync(restoredConfig.archiveDirectory!));
  const locations = readRelayStorageLocations(n.runtime);
  expect(locations.directories).toEqual(expect.arrayContaining([realpathSync(n.ownerDirectory), realpathSync(n.input.workspaceDirectory), realpathSync(n.input.restoredDirectory), realpathSync(restoredConfig.archiveDirectory!)]));
  expect(locations.files).toContain(realpathSync(n.input.outputFile));
  expect(loadRelayConfig().enabled).toBe(false); expect(installRelayService).not.toHaveBeenCalled();
}, 60000);

it('binds the canonical recovery archive location and invalidates a retargeted parent link before service startup', async () => {
  const n = await fixture(); await n.init(); await n.pause(); const plan = await n.run('plan');
  await n.run('start', plan.approvalDigest); await n.finish(); await n.restore();
  const exported = await n.run('export-plan'); await n.run('export', exported.approvalDigest);
  const config = readPolicyObserverConfigurationFile(n.input.outputFile), alias = join(n.directory, 'archive-parent');
  symlinkSync(n.input.workspaceDirectory, alias, 'junction');
  writeFileSync(n.input.outputFile, JSON.stringify({ ...config, archiveDirectory: join(alias, 'download') }));
  const input = { configurationFile: n.input.outputFile, linksFile: '' };
  const reviewed = await n.request('/api/relay/history/policy-observer/review', { input }); expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
  expect((await n.request('/api/relay/history/policy-observer/apply', { input, approvalDigest: reviewed.body.approvalDigest })).status).toBe(200);
  const saved = loadRelayConfig(); expect(saved.policyObserverBinding!.archiveDirectory).toBe(realpathSync(config.archiveDirectory!));
  expect(policyObserverActivationServiceFiles(saved).policyObserverFile).toBe(n.input.outputFile);
  const other = join(n.directory, 'different-archive'); mkdirSync(join(other, 'download'), { recursive: true });
  unlinkSync(alias); symlinkSync(other, alias, 'junction');
  expect(() => policyObserverActivationServiceFiles(saved)).toThrow('changed');
  expect(installRelayService).not.toHaveBeenCalled();
}, 60000);

it('keeps the fenced source and recovery journal after settings failure and resumes without silently treating source errors as loss', async () => {
  const n = await fixture(); await n.init(); await n.pause(); const plan = await n.run('plan'), before = readFileSync(n.settings);
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === n.settings) throw new Error('Injected recovery settings failure'); actualFs.renameSync(from, to); });
  try { expect((await n.call('start', plan.approvalDigest)).body.error).toContain('Injected recovery settings failure'); }
  finally { vi.mocked(renameSync).mockImplementation(actualFs.renameSync); }
  expect(readFileSync(n.settings)).toEqual(before); expect((await n.run('status')).phase).toBe('freeze');
  expect(readRelayStorageLocations(n.runtime).directories).toContain(realpathSync(n.input.workspaceDirectory));
  await n.finish(); await n.restore();
  expect((await n.call('review')).status).toBe(409); expect((await n.run('status')).destinationOccupied).toBe(true);
  const retained = await n.run('resume-plan'); expect(retained.policyRevision).toBe(2);
}, 60000);

it('requires an explicit unavailable-source declaration and still restores the volunteer-retained policy', async () => {
  const n = await fixture(); await n.init(); await n.pause(); renameSync(n.ownerDirectory, n.ownerDirectory + '.lost');
  expect((await n.call('plan')).status).toBe(409); expect(existsSync(n.input.workspaceDirectory)).toBe(false);
  n.input.source = 'unavailable'; const plan = await n.run('plan'); expect(plan.localStateDigest).toBeNull();
  await n.run('start', plan.approvalDigest); await n.finish(); expect((await n.restore()).policyRevision).toBe(2);
}, 60000);

it('invalidates changed approvals, rejects overlapping folders, and cancels before fencing or creating a recovery', async () => {
  const n = await fixture(); await n.init(); await n.pause(); const plan = await n.run('plan');
  writeFileSync(n.keyFiles[0], readFileSync(n.keyFiles[0], 'utf8') + '\n');
  expect((await n.call('start', plan.approvalDigest)).status).toBe(409); expect(existsSync(n.input.workspaceDirectory)).toBe(false);
  expect((await n.call('plan', undefined, { ...n.input, workspaceDirectory: n.ownerDirectory })).status).toBe(409);
  const controller = new AbortController();
  const review = await runDesktopPolicyObserverRecovery('plan', n.input, undefined, controller.signal, n.runtime, () => {});
  await expect(runDesktopPolicyObserverRecovery('start', n.input, review.result.approvalDigest, controller.signal, n.runtime, () => controller.abort())).rejects.toThrow();
  const original = await openConfiguredPolicyObserver(readPolicyObserverConfigurationFile(n.configPath));
  try { expect(original.status().fenced).toBe(false); expect(original.policy()).toEqual(n.second); } finally { original.close(); }
  expect(existsSync(n.input.workspaceDirectory)).toBe(false);
}, 30000);

it('preserves terminal authority conflict across desktop recovery and refuses restored observation', async () => {
  const n = await fixture(); await n.init(); await n.pause();
  const original = await openConfiguredPolicyObserver(readPolicyObserverConfigurationFile(n.configPath));
  try { await expect(original.advance(n.conflict)).rejects.toThrow('equivocated'); } finally { original.close(); }
  const plan = await n.run('plan'); await n.run('start', plan.approvalDigest); await n.finish();
  expect((await n.restore()).blocked).toBe(true);
  const exportPlan = await n.run('export-plan'); await n.run('export', exportPlan.approvalDigest);
  const restored = await openConfiguredPolicyObserver(readPolicyObserverConfigurationFile(n.input.outputFile));
  try { expect(restored.status().blocked).toBe(true); expect(restored.status().evidence).toHaveLength(2); await expect(restored.ready()).rejects.toThrow('equivocated'); }
  finally { restored.close(); }
  expect(installRelayService).not.toHaveBeenCalled();
}, 60000);
