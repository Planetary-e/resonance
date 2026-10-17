import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { EmbeddingEngine } from '@resonance/core';
import { openAdmissionPolicyStore } from '@resonance/core/admission-policy';
import { historyCheckpointContextId } from '@resonance/core/history-checkpoint';
import { admissionActivationFixture } from '../../../../relay/src/__tests__/fixtures/admission-activation-fixture.js';
import { createAppServer } from '../server.js';
import { lockSession, loadRelayConfig, runRelayHistoryOperation } from '../session.js';
import { installRelayService, uninstallRelayService, relayServiceRuntime, relayServiceEnvironment } from '../relay-supervisor.js';
import { historyActivationServiceFiles } from '../history-activation.js';

vi.mock('../relay-supervisor.js', async original => ({ ...await original<typeof import('../relay-supervisor.js')>(), installRelayService: vi.fn(), uninstallRelayService: vi.fn() }));
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  lockSession(); for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs();
});
async function setup() {
  const n = await admissionActivationFixture(); cleanup.push(n.close);
  vi.stubEnv('RESONANCE_DATA_DIR', n.desktopDirectory);
  vi.stubEnv('RESONANCE_RELAY_ENTRY', fileURLToPath(new URL('../../../../relay/src/main.ts', import.meta.url)));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
  const settingsPath = join(n.desktopDirectory, 'relay-config.json');
  writeFileSync(settingsPath, JSON.stringify({ enabled: false, port, adminKey: 'activation-test-admin' }));
  vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
  const app = createAppServer({ port: 0, relayUrl: `ws://127.0.0.1:${port}/` });
  const base = `http://127.0.0.1:${await app.start()}`; cleanup.push(() => app.stop());
  let token = '';
  const request = async (path: string, body?: unknown, auth = token, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal) => {
    const response = await fetch(base + path, { method, signal, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const unlock = async () => { const result = await request('/api/unlock', { password: 'activation test password' }); expect(result.status).toBe(200); token = result.body.token; };
  const init = async () => { expect((await request('/api/init', { password: 'activation test password' })).status).toBe(200); await unlock(); };
  const pause = async () => { expect((await request('/api/relay/maintenance', {})).body.active).toBe(true); };
  const review = () => request('/api/relay/history/activation/review', { input: n.input });
  const apply = (approvalDigest: string, signal?: AbortSignal) => request('/api/relay/history/activation/apply', { input: n.input, approvalDigest }, token, 'POST', signal);
  return { ...n, app, base, settingsPath, request, init, pause, unlock, review, apply };
}
async function waitFor(test: () => Promise<boolean>, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!await test()) { if (performance.now() > deadline) throw new Error('Activation did not settle'); await new Promise(r => setTimeout(r, 20)); }
}

it('authenticates offline review, rejects changed approval and starts the real Node relay only after explicit maintenance exit', async () => {
  const n = await setup(), before = n.exchanges(), policyPath = join(n.runtimeDirectory, 'admission-community-policy.json');
  expect((await n.review()).status).toBe(401); expect((await n.request('/api/relay/history/activation')).status).toBe(401);
  expect((await n.request('/api/relay/history/cancel', {})).status).toBe(401);
  await n.init(); expect((await n.review()).status).toBe(409); await n.pause();
  expect((await n.request('/api/relay/history/activation/review', { input: n.input }, 'wrong')).status).toBe(401);
  const reviewed = await n.review(); expect(reviewed.status).toBe(200); expect(reviewed.body.spends).toBe(1);
  expect(n.exchanges()).toBe(before); expect(existsSync(policyPath)).toBe(false);
  const saved = readFileSync(n.settingsPath);
  expect((await n.apply('sha256:' + '0'.repeat(64))).status).toBe(409); expect(n.exchanges()).toBe(before);
  const original = readFileSync(n.input.historyConfigFile); writeFileSync(n.input.historyConfigFile, Buffer.concat([original, Buffer.from('\n')]));
  expect((await n.apply(reviewed.body.approvalDigest)).status).toBe(409); expect(n.exchanges()).toBe(before);
  expect(readFileSync(n.settingsPath)).toEqual(saved); writeFileSync(n.input.historyConfigFile, original);
  const applied = await n.apply(reviewed.body.approvalDigest); expect(applied.status).toBe(200);
  expect(applied.body).toMatchObject({ result: 'owner-service-configured', maintenanceActive: true, startsService: false });
  expect(installRelayService).not.toHaveBeenCalled(); expect(uninstallRelayService).toHaveBeenCalledOnce();
  expect((await n.request('/api/relay/history/activation')).body.input).toEqual(n.input);
  const configured = loadRelayConfig(); expect(configured.enabled).toBe(false);
  vi.stubEnv('RESONANCE_RELAY_ADMISSION_HISTORY_FILE', '/obsolete/history.json');
  const runtime = relayServiceRuntime(configured.runtime, historyActivationServiceFiles(configured.historyActivationInput!));
  expect(runtime.admissionHistoryFile).toBe(n.input.historyConfigFile);
  expect((await n.request('/api/relay/maintenance', undefined, undefined, 'DELETE')).body.active).toBe(false);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RELAY_')));
  const environment = relayServiceEnvironment({ ...runtime, port: 0, dataDir: n.desktopDirectory, adminKey: 'activation-test-admin', contacts: [] });
  const child = spawn(process.execPath, ['--import', 'tsx', runtime.entryPath], { env: { ...inherited, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let output = '', port = 0;
  const read = (bytes: Buffer) => { output += bytes.toString(); for (const line of output.split('\n')) { try { const value = JSON.parse(line); if (value.event === 'started') port = value.port; } catch { /* partial line */ } } };
  child.stdout.on('data', read); child.stderr.on('data', read);
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await waitFor(async () => { if (child.exitCode !== null) throw new Error(output); return port > 0; }, 15000);
  expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
  child.kill('SIGTERM'); expect((await exited)[0]).toBe(0);
}, 30000);

it('retains prepared policy and the old service settings after an interrupted settings replacement, requiring fresh review', async () => {
  const n = await setup(); await n.init(); await n.pause(); const plan = await n.review(); expect(plan.status).toBe(200);
  const before = readFileSync(n.settingsPath);
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === n.settingsPath) throw new Error('Injected settings replacement failure'); actualFs.renameSync(from, to); });
  try { expect((await n.apply(plan.body.approvalDigest)).body.error).toContain('Injected settings replacement failure'); }
  finally { vi.mocked(renameSync).mockImplementation(actualFs.renameSync); }
  expect(readFileSync(n.settingsPath)).toEqual(before); expect((await n.request('/api/relay/maintenance')).body.active).toBe(true);
  const store = await openAdmissionPolicyStore({ path: join(n.runtimeDirectory, 'admission-community-policy.json'), encryptionKey: n.key, mode: 'open-existing' });
  try { expect(store.protectedHistoryContext()).toBe(historyCheckpointContextId(n.context)); } finally { store.close(); }
  expect((await n.apply(plan.body.approvalDigest)).status).toBe(409);
  const revised = await n.review(); expect(revised.body.approvalDigest).not.toBe(plan.body.approvalDigest);
  expect((await n.apply(revised.body.approvalDigest)).status).toBe(200); expect(installRelayService).not.toHaveBeenCalled();
});

it.each(['cancel', 'lock', 'disconnect'] as const)('cancels outstanding history sockets on %s and leaves a resumable maintenance pause', async action => {
  const n = await setup(); await n.init(); await n.pause();
  const silent = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(silent, 'listening');
  cleanup.push(async () => { for (const socket of silent.clients) socket.terminate(); await new Promise<void>(r => silent.close(() => r())); });
  const address = silent.address(); if (!address || typeof address === 'string') throw new Error('Missing silent port');
  const config = JSON.parse(readFileSync(n.input.historyConfigFile, 'utf8'));
  config.members = config.members.map((member: { publicKey: string }, i: number) => ({ ...member, endpoint: `ws://127.0.0.1:${address.port}/silent-member-${i}` }));
  writeFileSync(n.input.historyConfigFile, JSON.stringify(config));
  const review = await n.review(); expect(review.status, JSON.stringify(review.body)).toBe(200);
  const connected = once(silent, 'connection'), controller = new AbortController();
  const pending = n.apply(review.body.approvalDigest, controller.signal).catch(error => ({ status: 0, body: { error: String(error) } }));
  await connected;
  if (action === 'cancel') expect((await n.request('/api/relay/history/cancel', {})).body.active).toBe(true);
  else if (action === 'lock') expect((await n.request('/api/lock', {})).status).toBe(200);
  else controller.abort();
  expect((await pending).status).toBe(action === 'disconnect' ? 0 : 409);
  await waitFor(async () => { try { await runRelayHistoryOperation(async () => undefined); return silent.clients.size === 0; } catch { return false; } });
  if (action === 'lock') await n.unlock();
  expect((await n.request('/api/relay/maintenance')).body.active).toBe(true);
  expect(existsSync(join(n.runtimeDirectory, 'admission-community-policy.json'))).toBe(false);
  expect(loadRelayConfig().enabled).toBe(false); expect(installRelayService).not.toHaveBeenCalled();
}, 15000);
