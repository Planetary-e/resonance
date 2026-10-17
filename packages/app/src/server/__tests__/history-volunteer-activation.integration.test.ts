import { afterEach, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { EmbeddingEngine, generateIdentity } from '@resonance/core';
import { createHistoryFreeze, historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, parseHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createRelayServer, HistoryRelayRouter, openHistoryVolunteerService } from '@resonance/relay';
import { loadOrCreateRelayIdentity } from '../../../../relay/src/relay-identity-store.js';
import { openHistoryCheckpointStore } from '../../../../relay/src/history-checkpoint-store.js';
import { historyCheckpointFixture } from '../../../../relay/src/__tests__/fixtures/history-checkpoint-fixture.js';
import { admissionActivationFixture } from '../../../../relay/src/__tests__/fixtures/admission-activation-fixture.js';
import { createAppServer } from '../server.js';
import { lockSession, loadRelayConfig } from '../session.js';
import { installRelayService, relayServiceEnvironment, relayServiceRuntime } from '../relay-supervisor.js';
import { volunteerActivationServiceFiles, type RelayVolunteerActivationInput } from '../history-volunteer-activation.js';

vi.mock('../relay-supervisor.js', async original => ({ ...await original<typeof import('../relay-supervisor.js')>(), installRelayService: vi.fn(), uninstallRelayService: vi.fn() }));
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  lockSession(); const errors: unknown[] = [];
  try { for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { errors.push(error); } } }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); }
  if (errors.length) throw new AggregateError(errors, 'Volunteer activation cleanup failed');
});
async function fixture() {
  const h = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'desktop-volunteer-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const desktopDirectory = join(directory, 'desktop'), runtimeDirectory = join(desktopDirectory, 'relay-data'); mkdirSync(runtimeDirectory, { recursive: true });
  vi.stubEnv('RESONANCE_DATA_DIR', desktopDirectory); vi.stubEnv('RESONANCE_RELAY_ENTRY', fileURLToPath(new URL('../../../../relay/src/main.ts', import.meta.url)));
  const json = (name: string, value: unknown) => { const path = join(directory, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const genesisId = historyCheckpointEnvelopeId(h.root), member = h.memberKeys[0];
  const input: RelayVolunteerActivationInput = { enrollmentFile: json('enrollment.json', { version: 1, kind: 'admission-history-enrollment', context: h.context, root: h.root }),
    signingKeyFile: json('member.json', { publicKey: h.context.members[0], secretKey: Buffer.from(member.secretKey).toString('base64url') }),
    storageKeyFile: join(directory, 'storage.hex'), directory: join(directory, 'volunteer'),
    controllersFile: json('controllers.json', [{ relayId: generateIdentity().did, endpoint: 'ws://127.0.0.1:9/' }]),
    output: join(directory, 'volunteer-service.json'), generationMiB: 64, blocksPerGeneration: 10001, maximumGenerations: 65 };
  writeFileSync(input.storageKeyFile, h.localKey.toString('hex'), { mode: 0o600 });
  const options = { directory: input.directory, context: h.context, signingKey: member, localKey: h.localKey, genesisId };
  openHistoryVolunteerService({ ...options, initialize: h.root }).close();
  const append = (envelope = h.next(h.root)) => {
    const store = openHistoryCheckpointStore({ directory: join(input.directory, 'genesis'), context: h.context, replica: h.context.members[0], localKey: h.localKey, rootId: genesisId, generation: 0 });
    try { store.append(envelope); } finally { store.close(); } return envelope;
  };
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
  const settings = join(desktopDirectory, 'relay-config.json'); writeFileSync(settings, JSON.stringify({ enabled: false, port }));
  vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
  const app = createAppServer({ port: 0, relayUrl: `ws://127.0.0.1:${port}/` }), base = `http://127.0.0.1:${await app.start()}`; cleanup.push(() => app.stop()); let token = '';
  const request = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const unlock = async () => { const result = await request('/api/unlock', { password: 'volunteer activation test' }); expect(result.status).toBe(200); token = result.body.token; };
  const init = async () => { expect((await request('/api/init', { password: 'volunteer activation test' })).status).toBe(200); await unlock(); };
  const review = (selection = input) => request('/api/relay/history/volunteer-activation/review', { input: selection });
  const apply = (approvalDigest: string, selection = input) => request('/api/relay/history/volunteer-activation/apply', { input: selection, approvalDigest });
  return { ...h, directory, desktopDirectory, runtimeDirectory, input, genesisId, options, append, settings, request, init, unlock, review, apply, json };
}
async function until(test: () => boolean, timeout = 15000) {
  const deadline = performance.now() + timeout;
  while (!test()) { if (performance.now() >= deadline) throw new Error('Volunteer runtime did not reach the expected state'); await new Promise(r => setTimeout(r, 20)); }
}

it('reviews existing enrollment and launches the real Node volunteer from the saved configuration only after explicit maintenance exit', async () => {
  const n = await fixture(), volunteerId = loadOrCreateRelayIdentity(n.runtimeDirectory).did;
  const router = new HistoryRelayRouter({ members: [{ publicKey: n.context.members[0], relayId: volunteerId }] }); cleanup.push(() => router.close());
  const controller = createRelayServer({ port: 0, host: '127.0.0.1', persistDir: join(n.directory, 'controller'), historyLinks: router,
    relayDiscovery: { endpoints: ['ws://127.0.0.1:0/'], reachability: 'direct', supportedGroups: ['public'], storage: { capacityBytes: 1000000, availableBytes: 1000000 } } });
  await controller.start(); cleanup.push(() => controller.stop({ graceful: false }));
  const descriptor = controller.getRelayDescriptor()!; writeFileSync(n.input.controllersFile, JSON.stringify([{ relayId: descriptor.relayId, endpoint: descriptor.endpoints[0] }]));
  expect((await n.review()).status).toBe(401); expect((await n.request('/api/relay/history/volunteer-activation')).status).toBe(401);
  await n.init(); expect((await n.review()).status).toBe(409); await n.request('/api/relay/maintenance', {});
  const review = await n.review(); expect(review.status, JSON.stringify(review.body)).toBe(200); expect(review.body.health.retainedBlocks).toBe(1);
  expect(existsSync(n.input.output)).toBe(false); expect(controller.getRelayLinkStatus().inboundRelayIds).toHaveLength(0);
  expect((await n.apply('sha256:' + '0'.repeat(64))).status).toBe(409); expect(existsSync(n.input.output)).toBe(false);
  expect((await n.apply(review.body.approvalDigest)).body).toMatchObject({ result: 'volunteer-service-configured', startsService: false, readiness: 'unverified', maintenanceActive: true });
  expect(installRelayService).not.toHaveBeenCalled();
  await n.request('/api/lock', {}); await n.unlock();
  expect((await n.request('/api/relay/history/volunteer-activation')).body.input).toEqual(n.input);
  const configured = loadRelayConfig(); expect(configured.enabled).toBe(false);
  vi.stubEnv('RESONANCE_RELAY_HISTORY_VOLUNTEER_FILE', '/obsolete/volunteer.json');
  const runtime = relayServiceRuntime(configured.runtime, volunteerActivationServiceFiles(configured)); expect(runtime.historyVolunteerFile).toBe(n.input.output);
  expect((await n.request('/api/relay/maintenance', undefined, 'DELETE')).body.active).toBe(false);
  const env = relayServiceEnvironment({ ...runtime, port: 0, dataDir: n.desktopDirectory, adminKey: 'test-admin', contacts: [] });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RELAY_')));
  const child = spawn(process.execPath, ['--import', 'tsx', runtime.entryPath], { env: { ...inherited, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let output = '';
  child.stdout.on('data', bytes => { output += bytes.toString(); }); child.stderr.on('data', bytes => { output += bytes.toString(); });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await until(() => { if (child.exitCode !== null) throw new Error(output); return controller.getRelayLinkStatus().inboundRelayIds.includes(volunteerId); });
  const issuedAt = Date.now(), request = createHistoryExchangeRequest({ action: 'head', rootId: n.genesisId, generation: 0, replica: n.context.members[0],
    sequence: 0, envelopeId: null, challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
  const response = await router.checkpoint({ publicKey: request.replica, endpoint: 'ws://127.0.0.1:9/history-checkpoint' }, { request, envelope: null }, new AbortController().signal);
  expect(parseHistoryExchangeResponse(response, request, n.context).head.sequence).toBe(0);
  child.kill('SIGTERM'); expect((await exited)[0]).toBe(0);
}, 30000);

it('invalidates approval when retained history changes, preserves capacity commitments and prevents directory or identity replacement', async () => {
  const n = await fixture(); await n.init(); await n.request('/api/relay/maintenance', {});
  const first = await n.review(); expect(first.status, JSON.stringify(first.body)).toBe(200); n.append();
  expect((await n.apply(first.body.approvalDigest)).status).toBe(409); expect(existsSync(n.input.output)).toBe(false);
  expect((await n.review({ ...n.input, blocksPerGeneration: 1 })).status).toBe(409);
  const next = await n.review(); expect(next.body.health.retainedBlocks).toBe(2); expect(next.body.retainedDigest).not.toBe(first.body.retainedDigest);
  expect((await n.apply(next.body.approvalDigest)).status).toBe(200);
  const copied = join(n.directory, 'copied-history'); cpSync(n.input.directory, copied, { recursive: true });
  expect((await n.review({ ...n.input, directory: copied, output: join(n.directory, 'replacement.json') })).body.error).toContain('cannot be replaced');
  const original = readFileSync(n.input.output), value = JSON.parse(original.toString());
  writeFileSync(n.input.output, JSON.stringify({ ...value, directory: copied }));
  expect(() => volunteerActivationServiceFiles(loadRelayConfig())).toThrow('cannot be replaced');
  writeFileSync(n.input.output, original);
  const output = join(n.directory, 'revised-limits.json'), update = { ...n.input, output, blocksPerGeneration: 2, generationMiB: 5 };
  const adjusted = await n.review(update); expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(200);
  expect((await n.apply(adjusted.body.approvalDigest, update)).status).toBe(200);
  const binding = loadRelayConfig().historyVolunteerBinding!; expect(binding.directory).not.toBe(copied);
  const reopened = openHistoryVolunteerService({ ...n.options, maxBlocks: 2, maxBytes: 5 * 1048576 }); expect(reopened.describe().latest.sequence).toBe(1); reopened.close();
});

it('retains configuration and history when saving settings fails, and reopens only provably pristine interrupted slots', async () => {
  const n = await fixture(); await n.init(); await n.request('/api/relay/maintenance', {});
  const successor = join(n.input.directory, `successors-${n.genesisId.slice(7)}`); rmSync(successor, { recursive: true });
  const review = await n.review(); expect(review.status, JSON.stringify(review.body)).toBe(200); expect(existsSync(successor)).toBe(true);
  const before = readFileSync(n.settings), manifest = readFileSync(join(n.input.directory, 'genesis', 'history-manifest.json'));
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === n.settings) throw new Error('Injected volunteer settings failure'); actualFs.renameSync(from, to); });
  try { expect((await n.apply(review.body.approvalDigest)).body.error).toContain('Injected volunteer settings failure'); }
  finally { vi.mocked(renameSync).mockImplementation(actualFs.renameSync); }
  expect(readFileSync(n.settings)).toEqual(before); expect(existsSync(n.input.output)).toBe(true);
  expect(readFileSync(join(n.input.directory, 'genesis', 'history-manifest.json'))).toEqual(manifest);
  const input = { ...n.input, output: join(n.directory, 'retry-service.json') }, retry = await n.review(input);
  expect((await n.apply(retry.body.approvalDigest, input)).status).toBe(200);
  rmSync(join(n.input.directory, 'genesis', 'history-manifest.json'));
  expect((await n.review({ ...input, output: join(n.directory, 'missing.json') })).status).toBe(409); expect(existsSync(join(n.directory, 'missing.json'))).toBe(false);
  expect(installRelayService).not.toHaveBeenCalled();
});


it('rejects unsafe selections and changed key files without replacing retained data', async () => {
  const n = await fixture(); await n.init(); await n.request('/api/relay/maintenance', {});
  const manifest = readFileSync(join(n.input.directory, 'genesis', 'history-manifest.json'));
  for (const input of [{ ...n.input, command: 'anything' }, { ...n.input, directory: n.runtimeDirectory },
    { ...n.input, output: join(n.input.directory, 'config.json') }, { ...n.input, generationMiB: 4 },
    { ...n.input, maximumGenerations: 66 }]) expect((await n.review(input)).status).toBe(409);
  const contacts = readFileSync(n.input.controllersFile), controller = JSON.parse(contacts.toString())[0];
  for (const controllers of [[controller, controller], [{ ...controller, endpoint: 'ws://example.org/' }], []]) {
    writeFileSync(n.input.controllersFile, JSON.stringify(controllers)); expect((await n.review()).status).toBe(409);
  }
  writeFileSync(n.input.controllersFile, contacts);
  const review = await n.review(); expect(review.status, JSON.stringify(review.body)).toBe(200);
  const key = readFileSync(n.input.signingKeyFile); writeFileSync(n.input.signingKeyFile, Buffer.concat([key, Buffer.from('\n')]));
  expect((await n.apply(review.body.approvalDigest)).status).toBe(409);
  expect(readFileSync(join(n.input.directory, 'genesis', 'history-manifest.json'))).toEqual(manifest);
  expect(existsSync(n.input.output)).toBe(false); expect(loadRelayConfig().historyVolunteerBinding).toBeUndefined();
});

it('binds approval to retained generation barriers even when block and byte counts are unchanged', async () => {
  const n = await fixture(); await n.init(); await n.request('/api/relay/maintenance', {});
  const first = await n.review(); expect(first.status, JSON.stringify(first.body)).toBe(200);
  const store = openHistoryCheckpointStore({ ...n.options,
    directory: join(n.input.directory, 'genesis'), replica: n.context.members[0], rootId: n.genesisId, generation: 0 });
  try { store.freeze(createHistoryFreeze(n.context, 0, 1, randomBytes(32).toString('base64url'), n.owner)); }
  finally { store.close(); }
  const next = await n.review(); expect(next.status, JSON.stringify(next.body)).toBe(200);
  expect(next.body.health).toEqual(first.body.health); expect(next.body.retainedDigest).not.toBe(first.body.retainedDigest);
  expect((await n.apply(first.body.approvalDigest)).status).toBe(409); expect(existsSync(n.input.output)).toBe(false);
  expect((await n.apply(next.body.approvalDigest)).status).toBe(200);
});

it('preserves both reviewed roles through later activation and service start despite obsolete launch variables', async () => {
  const n = await fixture(), owner = await admissionActivationFixture(); cleanup.push(owner.close);
  await n.init(); await n.request('/api/relay/maintenance', {});
  const activateOwner = async () => {
    const review = await n.request('/api/relay/history/activation/review', { input: owner.input });
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    const applied = await n.request('/api/relay/history/activation/apply', { input: owner.input, approvalDigest: review.body.approvalDigest });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  };
  await activateOwner();
  vi.stubEnv('RESONANCE_RELAY_ADMISSION_HISTORY_FILE', '/obsolete/owner.json');
  const review = await n.review(); expect(review.status, JSON.stringify(review.body)).toBe(200);
  expect((await n.apply(review.body.approvalDigest)).status).toBe(200);
  expect(loadRelayConfig().runtime?.admissionHistoryFile).toBe(owner.input.historyConfigFile);
  vi.stubEnv('RESONANCE_RELAY_HISTORY_VOLUNTEER_FILE', '/obsolete/volunteer.json');
  await activateOwner(); expect(loadRelayConfig().runtime?.historyVolunteerFile).toBe(n.input.output);
  await n.request('/api/lock', {}); await n.unlock();
  expect(loadRelayConfig().historyVolunteerActivationInput).toEqual(n.input);
  expect((await n.request('/api/relay/maintenance', undefined, 'DELETE')).body.active).toBe(false);
  vi.mocked(installRelayService).mockImplementation(() => { throw new Error('Captured service definition without installation'); });
  const start = await n.request('/api/relay/start', {}); expect(start.body.error).toContain('Captured service definition');
  expect(installRelayService).toHaveBeenCalledWith(expect.objectContaining({ historyVolunteerFile: n.input.output,
    admissionHistoryFile: owner.input.historyConfigFile, admissionHistoryDirectory: owner.input.historyDirectory }));
}, 30000);
