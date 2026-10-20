import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { EmbeddingEngine, createAdmissionRequestBindingV2, presentBlindAdmissionTokenV2 } from '@resonance/core';
import { createConfiguredAdmissionVerifier, listenHistoryAgreementReplica } from '@resonance/relay';
import { admissionActivationFixture } from '../../../../relay/src/__tests__/fixtures/admission-activation-fixture.js';
import { createAppServer } from '../server.js';
import { lockSession, loadRelayConfig } from '../session.js';
import { installRelayService } from '../relay-supervisor.js';
import type { RelayHistoryRecoveryAction, RelayHistoryRecoveryInput } from '../history-recovery.js';

vi.mock('../relay-supervisor.js', async original => ({ ...await original<typeof import('../relay-supervisor.js')>(), installRelayService: vi.fn(), uninstallRelayService: vi.fn() }));
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { lockSession(); for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
async function setup() {
  const n = await admissionActivationFixture({ recovery: true }); cleanup.push(n.close);
  vi.stubEnv('RESONANCE_DATA_DIR', n.desktopDirectory);
  vi.stubEnv('RESONANCE_RELAY_ENTRY', fileURLToPath(new URL('../../../../relay/src/main.ts', import.meta.url)));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
  writeFileSync(join(n.desktopDirectory, 'relay-config.json'), JSON.stringify({ enabled: false, port }));
  vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
  const app = createAppServer({ port: 0, relayUrl: `ws://127.0.0.1:${port}/` });
  const base = `http://127.0.0.1:${await app.start()}`; cleanup.push(() => app.stop());
  let token = '';
  const request = async (path: string, body?: unknown, auth = token, signal?: AbortSignal) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', signal,
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const unlock = async () => { const response = await request('/api/unlock', { password: 'recovery test password' }); expect(response.status).toBe(200); token = response.body.token; };
  const init = async () => { expect((await request('/api/init', { password: 'recovery test password' })).status).toBe(200); await unlock(); };
  const input: RelayHistoryRecoveryInput = { historyConfigFile: n.input.historyConfigFile, enrollmentFile: n.input.enrollmentFile,
    storageKeyFile: n.input.storageKeyFile, workspaceDirectory: join(n.directory, 'recovery-work'), policyFile: n.input.policyFile,
    historyDirectory: join(n.directory, 'restored-owner'), operatorTransportFile: '', view: 1 };
  const run = (action: RelayHistoryRecoveryAction, approvalDigest?: string, signal?: AbortSignal) => request('/api/relay/history/recovery',
    { action, input, ...(approvalDigest ? { approvalDigest } : {}) }, token, signal);
  return { ...n, input, activation: n.input, spendRequest: n.request, request, init, unlock, run };
}

it('recovers lost owner history through authenticated reviewed desktop phases, resumes after locking and activates without implicit initialization', async () => {
  const n = await setup(); rmSync(n.historyDirectory, { recursive: true });
  expect((await n.run('plan')).status).toBe(401); expect((await n.request('/api/relay/history/recovery')).status).toBe(401);
  await n.init(); expect((await n.run('plan')).status).toBe(409);
  expect((await n.request('/api/relay/maintenance', {})).body.active).toBe(true);
  const plan = await n.run('plan'); expect(plan.status, JSON.stringify(plan.body)).toBe(200);
  expect(plan.body).toMatchObject({ kind: 'admission-recovery-freeze', generation: 0, nextGeneration: 1, view: 1 });
  expect(existsSync(n.input.workspaceDirectory)).toBe(false);
  const snapshots = n.services.map(service => service.describe());
  expect((await n.run('start', 'sha256:' + '0'.repeat(64))).status).toBe(409);
  expect(n.services.map(service => service.describe())).toEqual(snapshots); expect(existsSync(n.input.workspaceDirectory)).toBe(false);
  const selected = n.input.historyDirectory; n.input.historyDirectory = join(n.directory, 'changed-destination');
  expect((await n.run('start', plan.body.approvalDigest)).status).toBe(409); n.input.historyDirectory = selected;
  expect((await n.run('start', plan.body.approvalDigest)).body.phase).toBe('freeze');
  expect(loadRelayConfig().historyRecoveryInput).toEqual(n.input);
  const before = n.exchanges(); expect((await n.run('status')).body.phase).toBe('freeze'); expect(n.exchanges()).toBe(before);
  await n.listeners[3].close(); await n.listeners[4].close();
  expect((await n.run('step')).status).toBe(409); expect((await n.run('status')).body.phase).toBe('freeze');
  const listener = await listenHistoryAgreementReplica(n.services[3], { port: Number(new URL(n.listeners[3].endpoint).port) }); cleanup.push(listener.close);
  expect((await n.run('step')).body.phase).toBe('select');
  expect((await n.request('/api/lock', {})).status).toBe(200); await n.unlock();
  expect((await n.request('/api/relay/history/recovery')).body.input).toEqual(n.input);
  let status = await n.run('status'); expect(status.body.phase).toBe('select');
  for (let step = 0; step < 8 && !status.body.complete; step++) {
    status = await n.run('step'); expect(status.status, JSON.stringify(status.body)).toBe(200);
  }
  expect(status.body).toMatchObject({ complete: true, phase: 'review' });
  const prior = n.exchanges(), review = await n.run('review'); expect(review.status, JSON.stringify(review.body)).toBe(200);
  expect(review.body.spends).toBe(1); expect(n.exchanges()).toBe(prior); expect(existsSync(n.input.historyDirectory)).toBe(false);
  expect((await n.run('restore', 'sha256:' + '0'.repeat(64))).status).toBe(409); expect(n.exchanges()).toBe(prior);
  await listener.close();
  expect((await n.run('restore', review.body.approvalDigest)).status).toBe(409);
  expect(existsSync(join(n.input.historyDirectory, 'admission-spends-v2.jsonl'))).toBe(true);
  const afterRestore = n.exchanges(), readiness = await n.run('readiness-plan');
  expect(readiness.status, JSON.stringify(readiness.body)).toBe(200);
  expect(readiness.body).toMatchObject({ kind: 'admission-restoration-readiness', appliedSpends: 1, pending: true });
  expect(n.exchanges()).toBe(afterRestore);
  expect((await n.run('ready', 'sha256:' + '0'.repeat(64))).status).toBe(409); expect(n.exchanges()).toBe(afterRestore);
  expect((await n.run('ready', readiness.body.approvalDigest)).status).toBe(409);
  const returned = await listenHistoryAgreementReplica(n.services[3], { port: Number(new URL(n.listeners[3].endpoint).port) }); cleanup.push(returned.close);
  const readyAgain = await n.run('readiness-plan'); expect(readyAgain.status).toBe(200);
  expect((await n.run('ready', readyAgain.body.approvalDigest)).body).toMatchObject({ result: 'history-ready', generation: 1, readiness: 'confirmed', startsService: false });
  expect(existsSync(join(n.runtimeDirectory, 'admission-community-policy.json'))).toBe(false);
  const activation = { ...n.activation, historyDirectory: n.input.historyDirectory };
  const activate = await n.request('/api/relay/history/activation/review', { input: activation }); expect(activate.status).toBe(200);
  expect((await n.request('/api/relay/history/activation/apply', { input: activation, approvalDigest: activate.body.approvalDigest })).status).toBe(200);
  expect(loadRelayConfig().historyRecoveryInput).toEqual(n.input); expect(loadRelayConfig().enabled).toBe(false);
  expect((await n.run('status')).body).toMatchObject({ complete: true, phase: 'review', destinationOccupied: true });
  expect((await n.request('/api/relay/maintenance')).body.active).toBe(true); expect(installRelayService).not.toHaveBeenCalled();
  const verifier = await createConfiguredAdmissionVerifier({ ...n.verifierOptions, directory: n.runtimeDirectory, historyDirectory: n.input.historyDirectory });
  try {
    expect(await verifier.verifyAndSpend(n.capability, n.spendRequest)).toEqual({ status: 'replay' });
    const binding = createAdmissionRequestBindingV2('search', { query: 'different restored request' });
    expect(await verifier.verifyAndSpend(presentBlindAdmissionTokenV2(n.token, n.issuer.scope, 'search', binding), { action: 'search', requestBinding: binding, now: Date.now() }))
      .toEqual({ status: 'rejected', reason: 'double_spend' });
  } finally { verifier.close(); }
}, 60000);

it('refuses arbitrary commands, extra fields, bad views, occupied destinations and overlapping folders before contacting volunteers', async () => {
  const n = await setup(); await n.init(); await n.request('/api/relay/maintenance', {});
  const before = n.exchanges(), saved = readFileSync(join(n.desktopDirectory, 'relay-config.json'));
  expect((await n.request('/api/relay/history/recovery', { action: 'owner-prepare', input: n.input })).status).toBe(409);
  expect((await n.request('/api/relay/history/recovery', { action: 'plan', input: n.input, args: [] })).status).toBe(409);
  const inputs = [{ ...n.input, view: 0 }, { ...n.input, view: 1000001 }, { ...n.input, view: 1.5 },
    { ...n.input, workspaceDirectory: 'relative' }, { ...n.input, historyDirectory: n.historyDirectory },
    { ...n.input, historyDirectory: n.input.workspaceDirectory }, { ...n.input, workspaceDirectory: join(n.runtimeDirectory, 'work') }];
  if (process.platform !== 'win32') {
    const alias = join(n.directory, 'runtime-alias'); symlinkSync(n.runtimeDirectory, alias);
    inputs.push({ ...n.input, workspaceDirectory: join(alias, 'work') });
  }
  for (const input of inputs) expect((await n.request('/api/relay/history/recovery', { action: 'plan', input })).status).toBe(409);
  expect(n.exchanges()).toBe(before); expect(readFileSync(join(n.desktopDirectory, 'relay-config.json'))).toEqual(saved);
});

it('retains the created workspace when saving the selection fails and resumes it without another freeze approval', async () => {
  const n = await setup(); await n.init(); await n.request('/api/relay/maintenance', {});
  const plan = await n.run('plan'); expect(plan.status).toBe(200);
  const path = join(n.desktopDirectory, 'relay-config.json'), previous = readFileSync(path);
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (String(to) === path) throw new Error('Injected recovery settings failure'); actualFs.renameSync(from, to);
  });
  try { expect((await n.run('start', plan.body.approvalDigest)).body.error).toContain('Injected recovery settings failure'); }
  finally { vi.mocked(renameSync).mockImplementation(actualFs.renameSync); }
  expect(readFileSync(path)).toEqual(previous); expect(existsSync(join(n.input.workspaceDirectory, 'admission-recovery.json'))).toBe(true);
  expect((await n.run('plan')).status).toBe(409);
  expect((await n.run('status')).body.phase).toBe('freeze'); expect(loadRelayConfig().historyRecoveryInput).toEqual(n.input);
  expect((await n.request('/api/relay/maintenance')).body.active).toBe(true); expect(installRelayService).not.toHaveBeenCalled();
});

it.each(['cancel', 'lock', 'disconnect'] as const)('cancels a partially frozen desktop recovery on %s while retaining the workspace and exclusion until settled', async action => {
  const n = await setup(); await n.init(); await n.request('/api/relay/maintenance', {});
  const plan = await n.run('plan'); expect(plan.status).toBe(200); expect((await n.run('start', plan.body.approvalDigest)).status).toBe(200);
  await n.listeners[3].close(); await n.listeners[4].close();
  const silent = new WebSocketServer({ port: Number(new URL(n.listeners[3].endpoint).port), host: '127.0.0.1' });
  await once(silent, 'listening'); cleanup.push(async () => {
    for (const socket of silent.clients) socket.terminate(); await new Promise<void>(r => silent.close(() => r()));
  });
  const controller = new AbortController(), connected = once(silent, 'connection');
  const pending = n.run('step', undefined, controller.signal).catch(error => ({ status: 0, body: { error: String(error) } }));
  await connected;
  if (action === 'cancel') expect((await n.request('/api/relay/history/cancel', {})).body.active).toBe(true);
  else if (action === 'lock') expect((await n.request('/api/lock', {})).status).toBe(200);
  else controller.abort();
  expect((await pending).status).toBe(action === 'disconnect' ? 0 : action === 'lock' ? 401 : 409);
  if (action === 'lock') await n.unlock();
  const deadline = performance.now() + 5000;
  while (true) {
    const status = await n.run('status');
    if (status.status === 200 && silent.clients.size === 0) { expect(status.body.phase).toBe('freeze'); break; }
    if (performance.now() >= deadline) throw new Error('Recovery did not release its sockets and exclusion');
    await new Promise(r => setTimeout(r, 20));
  }
  expect(existsSync(join(n.input.workspaceDirectory, 'admission-recovery.json'))).toBe(true);
  expect(existsSync(join(n.input.workspaceDirectory, 'freeze'))).toBe(true);
  expect((await n.request('/api/relay/maintenance')).body.active).toBe(true);
  expect(installRelayService).not.toHaveBeenCalled();
}, 20000);
