import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { EmbeddingEngine } from '@resonance/core';
import { historyCheckpointEnvelopeId, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { historyVolunteerCollectionFixture } from '../../../../relay/src/__tests__/fixtures/history-volunteer-collection-fixture.js';
import { readHistoryVolunteerCollectionFile, openConfiguredHistoryVolunteerCollection } from '../../../../relay/src/history-volunteer-collection.js';
import { openHistoryCheckpointStore } from '../../../../relay/src/history-checkpoint-store.js';
import { createAppServer } from '../server.js';
import { lockSession, loadRelayConfig } from '../session.js';
import { installRelayService, uninstallRelayService, relayServiceRuntime, relayServiceEnvironment } from '../relay-supervisor.js';
import { volunteerActivationServiceFiles } from '../history-volunteer-activation.js';
import { historyCollectionActivationServiceFiles, withRelayHistoryCollectionActivation } from '../history-collection-activation.js';

vi.mock('../relay-supervisor.js', async original => ({ ...await original<typeof import('../relay-supervisor.js')>(), installRelayService: vi.fn(), uninstallRelayService: vi.fn() }));
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  lockSession(); const errors: unknown[] = [];
  try { for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } } }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); }
  if (errors.length) throw new AggregateError(errors, 'Collection activation cleanup failed');
});
async function fixture() {
  const n = await historyVolunteerCollectionFixture(close => cleanup.push(close));
  n.configs[0].controllers[0].endpoint = 'ws://127.0.0.1:9/'; writeFileSync(n.paths[0], JSON.stringify(n.configs[0]));
  const desktop = join(n.directory, 'desktop'), runtimeDirectory = join(desktop, 'relay-data'); mkdirSync(runtimeDirectory, { recursive: true });
  vi.stubEnv('RESONANCE_DATA_DIR', desktop); vi.stubEnv('RESONANCE_RELAY_ENTRY', fileURLToPath(new URL('../../../../relay/src/main.ts', import.meta.url)));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const settings = join(desktop, 'relay-config.json'); writeFileSync(settings, JSON.stringify({ enabled: false, port }));
  vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
  const app = createAppServer({ port: 0, relayUrl: `ws://127.0.0.1:${port}/` }), base = `http://127.0.0.1:${await app.start()}`; cleanup.push(() => app.stop()); let token = '';
  const request = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const unlock = async () => { const response = await request('/api/unlock', { password: 'collection activation test' }); expect(response.status).toBe(200); token = response.body.token; };
  const init = async () => { expect((await request('/api/init', { password: 'collection activation test' })).status).toBe(200); await unlock(); };
  const input = { configurationFile: n.paths[0] };
  const review = () => request('/api/relay/history/collection/review', { input });
  const apply = (approvalDigest: string) => request('/api/relay/history/collection/apply', { input, approvalDigest });
  const append = () => {
    const h = n.roots[0], config = readHistoryVolunteerCollectionFile(n.paths[0]).histories[0];
    const localKey = Buffer.from(readFileSync(config.storageKeyFile, 'utf8'), 'hex');
    const store = openHistoryCheckpointStore({ directory: join(config.directory, 'genesis'), context: h.context, rootId: historyCheckpointEnvelopeId(h.root),
      generation: 0, replica: Buffer.from(n.keys[0].publicKey).toString('base64url'), localKey });
    try { store.append(sealHistoryCheckpoint({ context: h.context, header: { kind: 'checkpoint', generation: 0, sequence: 1, previous: historyCheckpointEnvelopeId(h.root) },
      plaintext: Buffer.from('opaque retained test payload'), encryptionKey: h.encryptionKey, signingKey: h.signingKey })); }
    finally { store.close(); localKey.fill(0); }
  };
  return { ...n, desktop, runtimeDirectory, settings, request, init, unlock, input, review, apply, append };
}

it('requires authentication and maintenance, reviews all histories, retains selection across lock and prevents environment override', async () => {
  const n = await fixture(); expect((await n.review()).status).toBe(401); expect((await n.request('/api/relay/history/collection')).status).toBe(401);
  await n.init(); expect((await n.review()).status).toBe(409); await n.request('/api/relay/maintenance', {});
  const review = await n.review(); expect(review.status, JSON.stringify(review.body)).toBe(200); expect(review.body.histories).toHaveLength(5);
  expect(review.body.health).toMatchObject({ histories: 5, retainedBlocks: 5 });
  expect((await n.apply('sha256:' + '0'.repeat(64))).status).toBe(409);
  expect((await n.apply(review.body.approvalDigest)).body).toMatchObject({ result: 'history-collection-selected', startsService: false, readiness: 'unverified', maintenanceActive: true });
  expect(installRelayService).not.toHaveBeenCalled(); expect(loadRelayConfig().enabled).toBe(false);
  await n.request('/api/lock', {}); await n.unlock(); expect((await n.request('/api/relay/history/collection')).body.input).toEqual(n.input);
  const saved = loadRelayConfig(); expect(saved.historyStorageDirectories).toHaveLength(6);
  vi.stubEnv('RESONANCE_RELAY_HISTORY_VOLUNTEER_FILE', '/obsolete/single.json');
  vi.stubEnv('RESONANCE_RELAY_HISTORY_VOLUNTEER_COLLECTION_FILE', '/obsolete/collection.json');
  expect(relayServiceRuntime(saved.runtime, volunteerActivationServiceFiles(saved))).toMatchObject({ historyVolunteerFile: '', historyVolunteerCollectionFile: n.paths[0] });
  // Exercise the actual background Node runtime; only the native installer is
  // substituted, so start observes real /stats readiness and saved selection.
  let child: ReturnType<typeof spawn> | undefined, output = '';
  vi.mocked(installRelayService).mockImplementation(options => {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('RELAY_')));
    child = spawn(options.nodePath, ['--import', options.tsxImportPath ?? import.meta.resolve('tsx'), options.entryPath], {
      cwd: options.workingDirectory, stdio: ['ignore', 'pipe', 'pipe'], env: { ...environment, ...relayServiceEnvironment(options) } });
    child.stdout!.on('data', bytes => { output += String(bytes); }); child.stderr!.on('data', bytes => { output += String(bytes); });
    const process_ = child, exited = once(process_, 'exit');
    cleanup.push(async () => { if (process_.exitCode === null && process_.signalCode === null) process_.kill('SIGTERM');
      const timer = setTimeout(() => process_.kill('SIGKILL'), 10000); try { await exited; } finally { clearTimeout(timer); } });
  });
  vi.mocked(uninstallRelayService).mockImplementation(() => { child?.kill('SIGTERM'); });
  expect((await n.request('/api/relay/maintenance', undefined, 'DELETE')).status).toBe(200);
  const started = await n.request('/api/relay/start', {}); expect(started.status, JSON.stringify(started.body) + output).toBe(200); expect(installRelayService).toHaveBeenCalledTimes(1);
  expect(loadRelayConfig().historyCollectionBinding).toEqual(saved.historyCollectionBinding);
  expect(loadRelayConfig().historyCollectionInput).toEqual(n.input);
  expect((await n.request('/api/relay/maintenance', {})).status).toBe(200);
  writeFileSync(n.paths[0], JSON.stringify({ ...n.configs[0], histories: n.configs[0].histories.slice(1) }));
  expect(() => historyCollectionActivationServiceFiles(saved)).toThrow('changed'); expect((await n.review()).status).toBe(409);
  expect(loadRelayConfig().historyCollectionBinding?.histories).toHaveLength(5);
}, 30000);

it('invalidates approval after accepted evidence changes and after configuration or key changes', async () => {
  const n = await fixture(); await n.init(); await n.request('/api/relay/maintenance', {});
  const initial = await n.review(); expect(initial.status).toBe(200); n.append(); expect((await n.apply(initial.body.approvalDigest)).status).toBe(409);
  const current = await n.review(); expect(current.body.health.retainedBlocks).toBe(6);
  const raw = structuredClone(n.configs[0]); raw.histories[0].limits.blocksPerGeneration = 900; writeFileSync(n.paths[0], JSON.stringify(raw));
  expect((await n.apply(current.body.approvalDigest)).status).toBe(409); writeFileSync(n.paths[0], JSON.stringify(n.configs[0]));
  const fresh = await n.review(), keyFile = readHistoryVolunteerCollectionFile(n.paths[0]).histories[0].storageKeyFile, originalKey = readFileSync(keyFile);
  writeFileSync(keyFile, '00'.repeat(32)); expect((await n.apply(fresh.body.approvalDigest)).status).toBe(409); writeFileSync(keyFile, originalKey);
  expect(loadRelayConfig().historyCollectionInput).toBeUndefined(); expect((await n.review()).body.health.retainedBlocks).toBe(6);
});

it('preserves existing files and inventory if saving the selection fails, and permits a fresh review afterward', async () => {
  const n = await fixture(); await n.init(); await n.request('/api/relay/maintenance', {});
  const before = readFileSync(n.settings), config = readFileSync(n.paths[0]), review = await n.review(); expect(review.status).toBe(200);
  vi.mocked(renameSync).mockImplementation((source, target) => { if (String(target) === n.settings) throw new Error('Injected settings replacement failure'); actualFs.renameSync(source, target); });
  expect((await n.apply(review.body.approvalDigest)).status).toBe(409); expect(readFileSync(n.settings)).toEqual(before); expect(readFileSync(n.paths[0])).toEqual(config);
  vi.mocked(renameSync).mockImplementation(actualFs.renameSync);
  const retry = await n.review(); expect(retry.status).toBe(200); expect((await n.apply(retry.body.approvalDigest)).status).toBe(200);
  expect(installRelayService).not.toHaveBeenCalled();
});

it('refuses missing or concurrently owned retained state and closes all earlier histories after a later failure', async () => {
  const n = await fixture(); await n.init(); await n.request('/api/relay/maintenance', {});
  const config = readHistoryVolunteerCollectionFile(n.paths[0]), role = openConfiguredHistoryVolunteerCollection(config); cleanup.push(role.close);
  expect((await n.review()).status).toBe(409); role.close();
  const last = config.histories[4].directory; renameSync(last, last + '.retained'); expect((await n.review()).status).toBe(409); renameSync(last + '.retained', last);
  expect((await n.review()).status).toBe(200); expect(loadRelayConfig().historyCollectionInput).toBeUndefined();
});

it('retains a previously selected single history when migrating to a collection and rejects its omission', async () => {
  const n = await fixture(); const c = readHistoryVolunteerCollectionFile(n.paths[0]).histories[0];
  const single = join(n.directory, 'single.json'); writeFileSync(single, JSON.stringify({ version: 1, ...n.configs[0].histories[0], controllers: n.configs[0].controllers }));
  const previous = { ...loadRelayConfig(), runtime: { ...relayServiceRuntime(), historyVolunteerFile: single } };
  const old = readFileSync(n.paths[0]); writeFileSync(n.paths[0], JSON.stringify({ ...n.configs[0], histories: n.configs[0].histories.slice(1) }));
  await expect(withRelayHistoryCollectionActivation(n.input, previous, n.runtimeDirectory, new AbortController().signal, async prepared => prepared.review)).rejects.toThrow('preserve every');
  writeFileSync(n.paths[0], old);
  const review = await withRelayHistoryCollectionActivation(n.input, previous, n.runtimeDirectory, new AbortController().signal, async prepared => prepared.review);
  expect(review.histories).toEqual(expect.arrayContaining([expect.objectContaining({ genesisId: c.genesisId, directory: realpathSync(c.directory) })]));
});

it('rechecks selected files and cancellation while the review holds ownership before saving', async () => {
  const n = await fixture(), controller = new AbortController(), previous = loadRelayConfig();
  await expect(withRelayHistoryCollectionActivation(n.input, previous, n.runtimeDirectory, controller.signal, async prepared => {
    controller.abort(); return prepared.apply(String(prepared.review.approvalDigest));
  })).rejects.toThrow();
  await expect(withRelayHistoryCollectionActivation(n.input, previous, n.runtimeDirectory, new AbortController().signal, async prepared => {
    const changed = structuredClone(n.configs[0]); changed.histories[0].limits.blocksPerGeneration = 999; writeFileSync(n.paths[0], JSON.stringify(changed));
    return prepared.apply(String(prepared.review.approvalDigest));
  })).rejects.toThrow('changed');
  writeFileSync(n.paths[0], JSON.stringify(n.configs[0]));
  const reopened = openConfiguredHistoryVolunteerCollection(readHistoryVolunteerCollectionFile(n.paths[0])); expect(reopened.health().histories).toBe(5); reopened.close();
});
