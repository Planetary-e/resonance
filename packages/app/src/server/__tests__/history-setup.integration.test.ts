import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { EmbeddingEngine } from '@resonance/core';
import { listenHistoryAgreementReplica, openHistoryVolunteerService, readHistoryEnrollmentFile } from '@resonance/relay';
import { admissionSetupFixture } from '../../../../relay/src/__tests__/fixtures/admission-setup-fixture.js';
import { protectedRoleFixture } from '../../../../relay/src/__tests__/fixtures/protected-role-fixture.js';
import { createAdmissionWitness } from '../../../../relay/src/admission-witness.js';
import { createAppServer } from '../server.js';
import { lockSession, loadRelayConfig } from '../session.js';
import { installRelayService } from '../relay-supervisor.js';
import type { RelayHistorySetupInput } from '../history-setup.js';

vi.mock('../relay-supervisor.js', async original => ({ ...await original<typeof import('../relay-supervisor.js')>(), installRelayService: vi.fn(), uninstallRelayService: vi.fn() }));
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { lockSession(); for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
async function setup() {
  const n = await admissionSetupFixture(); cleanup.push(n.close);
  vi.stubEnv('RESONANCE_DATA_DIR', n.desktopDirectory);
  vi.stubEnv('RESONANCE_RELAY_ENTRY', fileURLToPath(new URL('../../../../relay/src/main.ts', import.meta.url)));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
  writeFileSync(join(n.desktopDirectory, 'relay-config.json'), JSON.stringify({ enabled: false, port }));
  vi.spyOn(EmbeddingEngine.prototype, 'initialize').mockResolvedValue();
  const app = createAppServer({ port: 0, relayUrl: `ws://127.0.0.1:${port}/` });
  const base = `http://127.0.0.1:${await app.start()}`; cleanup.push(() => app.stop()); let token = '';
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const unlock = async () => { const response = await request('/api/unlock', { password: 'initial setup password' }); expect(response.status).toBe(200); token = response.body.token; };
  const init = async () => { expect((await request('/api/init', { password: 'initial setup password' })).status).toBe(200); await unlock(); };
  const run = (action: 'review' | 'apply', input: RelayHistorySetupInput, approvalDigest?: string) => request('/api/relay/history/setup', { action, input, ...(approvalDigest ? { approvalDigest } : {}) });
  return { ...n, request, init, unlock, run };
}

async function roleSetup() {
  const app = await setup(), roles = await protectedRoleFixture(app.issuer); cleanup.push(roles.close); roles.history.close();
  const localRoleDirectory = join(app.directory, 'existing-roles'); mkdirSync(localRoleDirectory);
  for (const name of ['admission-witness-votes.json', 'admission-witness-certificates.json']) actualFs.renameSync(join(roles.options.directory, name), join(localRoleDirectory, name));
  const input: Extract<RelayHistorySetupInput, { role: 'admission-role-capture' }> = { role: 'admission-role-capture',
    historyConfigFile: app.json('roles-owner.json', { version: 1, context: roles.context, members: roles.members, ownerKeyFile: app.keyFile('roles-owner-key.json', roles.owner) }),
    policyFile: app.json('roles-policy.json', app.issuer.policy), storageKeyFile: join(app.directory, 'roles-storage.hex'),
    directory: roles.options.directory, localRoleDirectory, selection: 'both', operatorTransportFile: '' };
  writeFileSync(input.storageKeyFile, roles.key.toString('hex'), { mode: 0o600 });
  const local = () => ({ ...roles.localOptions, directory: localRoleDirectory, signingKey: app.issuer.witnesses[0] });
  return { ...app, roles, roleInput: input, local };
}

it('protects intact external admission roles through authenticated reviewed setup and retains both locations', async () => {
  const n = await roleSetup(), input = n.roleInput;
  expect((await n.run('review', input)).status).toBe(401);
  await n.init(); expect((await n.run('review', input)).status).toBe(409); await n.request('/api/relay/maintenance', {});
  const before = readFileSync(join(input.localRoleDirectory, 'admission-witness-votes.json'));
  const review = await n.run('review', input); expect(review.status, JSON.stringify(review.body)).toBe(200);
  expect(review.body.result).toMatchObject({ kind: 'admission-local-role-capture', witnessVotes: 1, coordinatorCertificates: 1, fits: true, fencedRoles: 0 });
  expect(JSON.stringify(review.body)).not.toContain(n.roles.initial.spend);
  expect(readFileSync(join(input.localRoleDirectory, 'admission-witness-votes.json'))).toEqual(before);
  expect((await n.run('apply', { ...input, selection: 'witness' }, review.body.result.approvalDigest)).status).toBe(409);
  // A changed retained file, even with the same parsed policy, requires a fresh review.
  const policy = readFileSync(input.policyFile); writeFileSync(input.policyFile, Buffer.concat([policy, Buffer.from('\n')]));
  expect((await n.run('apply', input, review.body.result.approvalDigest)).status).toBe(409); writeFileSync(input.policyFile, policy);
  expect(readFileSync(join(input.localRoleDirectory, 'admission-witness-votes.json'))).toEqual(before);
  for (const candidate of [{ ...input, localRoleDirectory: join(n.directory, 'missing') }, { ...input, selection: 'reset' }, { ...input, initialize: true }]) {
    expect((await n.request('/api/relay/history/setup', { action: 'review', input: candidate })).status).toBe(409);
  }
  expect(existsSync(join(n.directory, 'missing'))).toBe(false);
  const applied = await n.run('apply', input, review.body.result.approvalDigest);
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  expect(applied.body.result).toMatchObject({ result: 'admission-roles-protected', readiness: 'confirmed', durableCopies: 4, startsService: false });
  expect(() => createAdmissionWitness(n.local())).toThrow(/invalid/);
  await n.request('/api/lock', {}); await n.unlock();
  expect((await n.request('/api/relay/history/setup')).body.input).toEqual(input);
  expect(loadRelayConfig().historyStorageDirectories).toContain(actualFs.realpathSync(input.localRoleDirectory));
  expect(loadRelayConfig().historyStorageDirectories).toContain(actualFs.realpathSync(input.directory));
  expect((await n.request('/api/relay/history/storage', {})).status).toBe(200);
  expect((await n.request('/api/relay/maintenance')).body.active).toBe(true); expect(installRelayService).not.toHaveBeenCalled();
  await n.roles.reopen(); await n.roles.history.ready(); expect(n.roles.history.roleState().witness!.votes[0].spend).toBe(n.roles.initial.spend);
}, 30000);

it('retains captured roles and their original files after a desktop settings failure', async () => {
  const n = await roleSetup(), input = n.roleInput;
  await n.init(); await n.request('/api/relay/maintenance', {});
  const review = await n.run('review', input); expect(review.status).toBe(200);
  const settings = join(n.desktopDirectory, 'relay-config.json'), original = readFileSync(settings);
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === settings) throw new Error('Role settings failure'); actualFs.renameSync(from, to); });
  try { expect((await n.run('apply', input, review.body.result.approvalDigest)).body.error).toContain('Role settings failure'); }
  finally { vi.mocked(renameSync).mockImplementation(actualFs.renameSync); }
  expect(readFileSync(settings)).toEqual(original); expect(() => createAdmissionWitness(n.local())).toThrow(/invalid/);
  const inventory = await n.request('/api/relay/history/storage', {});
  expect(inventory.status, JSON.stringify(inventory.body)).toBe(200); expect(inventory.body.selectedDirectories).toBe(4);
  expect((await n.run('apply', input, review.body.result.approvalDigest)).status).toBe(409);
  const resume = await n.run('review', input); expect(resume.body.result).toMatchObject({ alreadyCaptured: true, fencedRoles: 2 });
  expect((await n.run('apply', input, resume.body.result.approvalDigest)).status).toBe(200);
  expect((await n.request('/api/relay/maintenance')).body.active).toBe(true); expect(installRelayService).not.toHaveBeenCalled();
}, 30000);

it('cancels role readiness through the API before changing either original role', async () => {
  const n = await roleSetup(), input = n.roleInput;
  await n.init(); await n.request('/api/relay/maintenance', {});
  const connections = new Set<import('node:net').Socket>(), silent = createServer(socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  silent.listen(0, '127.0.0.1'); await once(silent, 'listening');
  cleanup.push(async () => { for (const socket of connections) socket.destroy(); await new Promise<void>(r => silent.close(() => r())); });
  const config = JSON.parse(readFileSync(input.historyConfigFile, 'utf8'));
  config.members.forEach((member: { endpoint: string }, index: number) => { member.endpoint = `ws://127.0.0.1:${(silent.address() as { port: number }).port}/member-${index}/history-checkpoint`; });
  writeFileSync(input.historyConfigFile, JSON.stringify(config));
  const files = ['admission-witness-votes.json', 'admission-witness-certificates.json'].map(name => join(input.localRoleDirectory, name));
  const before = files.map(path => readFileSync(path));
  const review = await n.run('review', input); expect(review.status, JSON.stringify(review.body)).toBe(200); expect(connections.size).toBe(0);
  const applying = n.run('apply', input, review.body.result.approvalDigest);
  await vi.waitFor(() => expect(connections.size).toBeGreaterThan(0));
  expect((await n.request('/api/relay/history/cancel', {})).body.active).toBe(true);
  expect((await applying).status).toBe(409);
  files.forEach((path, i) => expect(readFileSync(path)).toEqual(before[i]));
  const witness = createAdmissionWitness(n.local()); witness.close();
  expect((await n.request('/api/relay/maintenance')).body.active).toBe(true); expect(installRelayService).not.toHaveBeenCalled();
});

it('prepares a new owner, enrolls five local volunteers, requires four fresh copies and separately activates through the real API', async () => {
  const n = await setup();
  let configuration: RelayHistorySetupInput = { ...n.configInput, role: 'configuration', historyId: '' };
  expect((await n.run('review', configuration)).status).toBe(401); expect((await n.request('/api/relay/history/setup')).status).toBe(401);
  await n.init(); expect((await n.run('review', configuration)).status).toBe(409);
  await n.request('/api/relay/maintenance', {});
  const configPlan = await n.run('review', configuration); expect(configPlan.status, JSON.stringify(configPlan.body)).toBe(200);
  configuration = configPlan.body.input;
  expect((await n.run('apply', configuration, 'sha256:' + '0'.repeat(64))).status).toBe(409); expect(existsSync(n.configInput.output)).toBe(false);
  expect((await n.run('apply', configuration, configPlan.body.result.approvalDigest)).body.result.result).toBe('new-owner-configuration');
  const owner: RelayHistorySetupInput = { ...n.input, role: 'owner' }, ownerPlan = await n.run('review', owner);
  expect(ownerPlan.status, JSON.stringify(ownerPlan.body)).toBe(200); expect(existsSync(n.input.directory)).toBe(false);
  expect((await n.run('apply', owner, ownerPlan.body.result.approvalDigest)).body.result.readiness).toBe('unverified');
  const enrollment = readHistoryEnrollmentFile(n.input.output), config = JSON.parse(readFileSync(n.configInput.output, 'utf8'));
  let exchanges = 0; const listeners: Array<Awaited<ReturnType<typeof listenHistoryAgreementReplica>>> = [];
  const services: ReturnType<typeof openHistoryVolunteerService>[] = [];
  for (let i = 0; i < 5; i++) {
    const input: RelayHistorySetupInput = { role: 'volunteer', enrollmentFile: n.input.output, signingKeyFile: n.keyFile(`member-${i}.json`, n.memberKeys[i]),
      storageKeyFile: join(n.directory, `member-${i}.hex`), directory: join(n.directory, `member-${i}`) };
    writeFileSync(input.storageKeyFile, n.localKey.toString('hex'));
    const review = await n.run('review', input); expect(review.status, JSON.stringify(review.body)).toBe(200);
    expect((await n.run('apply', input, review.body.result.approvalDigest)).body.result).toMatchObject({ result: 'enrolled', readiness: 'unverified', startsService: false });
    expect((await n.run('review', input)).status).toBe(409);
    const service = openHistoryVolunteerService({ directory: input.directory, context: enrollment.context, genesisId: enrollment.genesisId, signingKey: n.memberKeys[i], localKey: n.localKey });
    services.push(service); cleanup.push(service.close);
    const listener = await listenHistoryAgreementReplica({ ...service, checkpoint: value => { exchanges++; return service.checkpoint(value); } }, { port: 0 });
    listeners.push(listener); cleanup.push(listener.close); config.members[i].endpoint = listener.checkpointEndpoint;
  }
  writeFileSync(n.configInput.output, JSON.stringify(config));
  const readiness: RelayHistorySetupInput = { role: 'readiness', historyConfigFile: n.configInput.output, enrollmentFile: n.input.output, policyFile: n.input.policyFile,
    storageKeyFile: n.input.storageKeyFile, directory: n.input.directory, operatorTransportFile: '' };
  const ready = await n.run('review', readiness); expect(ready.status, JSON.stringify(ready.body)).toBe(200);
  expect(ready.body.result.kind).toBe('admission-initial-readiness'); expect(exchanges).toBe(0);
  expect((await n.run('apply', readiness, 'sha256:' + '0'.repeat(64))).status).toBe(409); expect(exchanges).toBe(0);
  await listeners[3].close(); await listeners[4].close();
  expect((await n.run('apply', readiness, ready.body.result.approvalDigest)).status).toBe(409);
  expect(existsSync(join(n.runtimeDirectory, 'admission-community-policy.json'))).toBe(false);
  const fourth = await listenHistoryAgreementReplica(services[3], { port: Number(new URL(listeners[3].endpoint).port) }); cleanup.push(fourth.close);
  await n.request('/api/lock', {}); await n.unlock();
  const repeated = await n.run('review', readiness); expect(repeated.status).toBe(200);
  expect((await n.run('apply', readiness, repeated.body.result.approvalDigest)).body.result).toMatchObject({ result: 'history-ready', readiness: 'confirmed', startsService: false });
  expect((await n.request('/api/relay/history/setup')).body.input).toEqual(readiness);
  const activation = { historyConfigFile: n.configInput.output, enrollmentFile: n.input.output, authorityFile: n.configInput.authorityFile,
    policyFile: n.input.policyFile, storageKeyFile: n.input.storageKeyFile, historyDirectory: n.input.directory, linksFile: '', operatorTransportFile: '' };
  const review = await n.request('/api/relay/history/activation/review', { input: activation }); expect(review.status, JSON.stringify(review.body)).toBe(200);
  expect((await n.request('/api/relay/history/activation/apply', { input: activation, approvalDigest: review.body.approvalDigest })).status).toBe(200);
  expect(loadRelayConfig().enabled).toBe(false); expect(loadRelayConfig().historySetupInput).toEqual(readiness);
  expect((await n.request('/api/relay/maintenance')).body.active).toBe(true); expect(installRelayService).not.toHaveBeenCalled();
}, 30000);

it('rejects arbitrary commands, changed selection, runtime overlap, aliases and extra fields before setup', async () => {
  const n = await setup(); await n.init(); await n.request('/api/relay/maintenance', {}); await n.createConfig();
  const input: RelayHistorySetupInput = { ...n.input, role: 'owner' }, review = await n.run('review', input); expect(review.status).toBe(200);
  const invalid = [{ ...input, directory: n.runtimeDirectory }, { ...input, directory: join(n.runtimeDirectory, 'new') }, { ...input, directory: 'relative' },
    { ...input, mode: 'reset' }, { ...input, args: [] }];
  if (process.platform !== 'win32') { const alias = join(n.directory, 'runtime-alias'); symlinkSync(n.runtimeDirectory, alias); invalid.push({ ...input, directory: join(alias, 'new') }); }
  for (const candidate of invalid) expect((await n.request('/api/relay/history/setup', { action: 'review', input: candidate })).status).toBe(409);
  expect((await n.request('/api/relay/history/setup', { action: 'owner-ready', input })).status).toBe(409);
  expect((await n.request('/api/relay/history/setup', { action: 'apply', input, approvalDigest: review.body.result.approvalDigest, command: 'owner-ready' })).status).toBe(409);
  expect((await n.run('apply', { ...input, output: join(n.directory, 'different.json') }, review.body.result.approvalDigest)).status).toBe(409);
  expect(existsSync(join(n.desktopDirectory, 'relay-storage-locations'))).toBe(false);
  expect(existsSync(n.input.directory)).toBe(false); expect(existsSync(n.input.output)).toBe(false);
});

it('preserves prepared history after a settings write failure and permits a separately reviewed export after reopening', async () => {
  const n = await setup(); await n.init(); await n.request('/api/relay/maintenance', {}); await n.createConfig();
  const input: RelayHistorySetupInput = { ...n.input, role: 'owner' }, plan = await n.run('review', input);
  const settings = join(n.desktopDirectory, 'relay-config.json'), previous = readFileSync(settings);
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === settings) throw new Error('Injected setup settings failure'); actualFs.renameSync(from, to); });
  try { expect((await n.run('apply', input, plan.body.result.approvalDigest)).body.error).toContain('Injected setup settings failure'); }
  finally { vi.mocked(renameSync).mockImplementation(actualFs.renameSync); }
  expect(readFileSync(settings)).toEqual(previous); const retained = readHistoryEnrollmentFile(n.input.output);
  const inventory = await n.request('/api/relay/history/storage', {});
  expect(inventory.status, JSON.stringify(inventory.body)).toBe(200);
  expect(inventory.body).toMatchObject({ selectedDirectories: 3, selectedFiles: 1, scannedRoots: 3 });
  await n.request('/api/lock', {}); await n.unlock();
  expect((await n.run('review', input)).status).toBe(409);
  const output = join(n.directory, 'copy.json'), exported: RelayHistorySetupInput = { ...input, mode: 'export', output };
  const review = await n.run('review', exported); expect(review.status).toBe(200);
  expect((await n.run('apply', exported, review.body.result.approvalDigest)).status).toBe(200);
  expect(readHistoryEnrollmentFile(output)).toEqual(retained); expect(loadRelayConfig().historySetupInput).toEqual(exported);
  expect(installRelayService).not.toHaveBeenCalled();
});


it('reviews interrupted volunteer enrollment, preserves completed history after a settings failure and resumes the saved selection', async () => {
  const n = await setup(); await n.init(); await n.request('/api/relay/maintenance', {}); await n.createConfig();
  const owner: RelayHistorySetupInput = { ...n.input, role: 'owner' }, plan = await n.run('review', owner);
  expect((await n.run('apply', owner, plan.body.result.approvalDigest)).status).toBe(200);
  const input: Extract<RelayHistorySetupInput, { role: 'volunteer' }> = { role: 'volunteer', enrollmentFile: n.input.output,
    signingKeyFile: n.keyFile('resuming-member.json', n.memberKeys[0]), storageKeyFile: join(n.directory, 'member-storage.hex'), directory: join(n.directory, 'resuming-member') };
  writeFileSync(input.storageKeyFile, n.localKey.toString('hex'));
  const initial = await n.run('review', input);
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to).endsWith('.block')) throw new Error('Interrupted initial block'); actualFs.renameSync(from, to); });
  try { expect((await n.run('apply', input, initial.body.result.approvalDigest)).body.error).toContain('Interrupted initial block'); }
  finally { vi.mocked(renameSync).mockImplementation(actualFs.renameSync); }
  const resume: RelayHistorySetupInput = { ...input, role: 'volunteer-resume' }, review = await n.run('review', resume);
  expect(review.status, JSON.stringify(review.body)).toBe(200); expect(review.body.result.phase).toBe('genesis-pending');
  expect((await n.run('apply', resume, 'sha256:' + '0'.repeat(64))).status).toBe(409);
  const settings = join(n.desktopDirectory, 'relay-config.json'), before = readFileSync(settings);
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === settings) throw new Error('Interrupted resumption settings'); actualFs.renameSync(from, to); });
  try { expect((await n.run('apply', resume, review.body.result.approvalDigest)).body.error).toContain('Interrupted resumption settings'); }
  finally { vi.mocked(renameSync).mockImplementation(actualFs.renameSync); }
  expect(readFileSync(settings)).toEqual(before);
  expect((await n.run('apply', resume, review.body.result.approvalDigest)).status).toBe(409);
  const retained = await n.run('review', resume); expect(retained.body.result).toMatchObject({ phase: 'retained', retainedBlocks: 1 });
  expect((await n.run('apply', resume, retained.body.result.approvalDigest)).body.result).toMatchObject({ result: 'enrollment-resumed', startsService: false, readiness: 'unverified' });
  await n.request('/api/lock', {}); await n.unlock();
  expect((await n.request('/api/relay/history/setup')).body.input).toEqual(resume);
  expect((await n.request('/api/relay/maintenance')).body.active).toBe(true); expect(installRelayService).not.toHaveBeenCalled();
  const enrollment = readHistoryEnrollmentFile(input.enrollmentFile), service = openHistoryVolunteerService({ directory: input.directory,
    context: enrollment.context, genesisId: enrollment.genesisId, signingKey: n.memberKeys[0], localKey: n.localKey });
  expect(service.describe().latest.envelopeId).toBe(enrollment.genesisId); service.close();
});

it('retains earlier setup locations across reload and measures only saved roots under maintenance', async () => {
  const n = await setup(), path = '/api/relay/history/storage';
  expect((await n.request(path, {})).status).toBe(401); await n.init();
  expect((await n.request(path, {})).status).toBe(409); await n.request('/api/relay/maintenance', {});
  await n.createConfig();
  const owner: RelayHistorySetupInput = { ...n.input, role: 'owner' }, plan = await n.run('review', owner);
  expect((await n.run('apply', owner, plan.body.result.approvalDigest)).status).toBe(200);
  for (let i = 0; i < 2; i++) {
    const input: RelayHistorySetupInput = { role: 'volunteer', enrollmentFile: n.input.output, signingKeyFile: n.keyFile(`inventory-member-${i}.json`, n.memberKeys[i]),
      storageKeyFile: join(n.directory, `inventory-member-${i}.hex`), directory: join(n.directory, `inventory-member-${i}`) };
    writeFileSync(input.storageKeyFile, n.localKey.toString('hex'));
    const review = await n.run('review', input); expect(review.status, JSON.stringify(review.body)).toBe(200);
    expect((await n.run('apply', input, review.body.result.approvalDigest)).status).toBe(200);
  }
  const before = loadRelayConfig(); expect(before.historyStorageDirectories).toHaveLength(4);
  await n.request('/api/lock', {}); await n.unlock();
  expect(loadRelayConfig().historyStorageDirectories).toEqual(before.historyStorageDirectories);
  const measured = await n.request(path, {}); expect(measured.status, JSON.stringify(measured.body)).toBe(200);
  expect(measured.body).toMatchObject({ scannedRoots: 5, selectedFiles: 1, enforcesQuota: false, atomicSnapshot: false });
  expect(measured.body.logicalBytes).toBeGreaterThan(0); expect(JSON.stringify(measured.body)).not.toContain(n.directory);
  expect((await n.request(path, { directory: n.directory })).status).toBe(409);
  const old = join(n.directory, 'inventory-member-0'); actualFs.renameSync(old, `${old}-moved`);
  expect((await n.request(path, {})).status).toBe(409);
  expect(loadRelayConfig().historyStorageDirectories).toEqual(before.historyStorageDirectories);
  expect((await n.request('/api/relay/maintenance')).body.active).toBe(true); expect(installRelayService).not.toHaveBeenCalled();
}, 30000);


it('retains a reviewed configuration output after settings failure and includes it after a later configuration selection', async () => {
  const n = await setup(); await n.init(); await n.request('/api/relay/maintenance', {});
  const input: RelayHistorySetupInput = { ...n.configInput, role: 'configuration', historyId: '' };
  const plan = await n.run('review', input); expect(plan.status).toBe(200);
  const settings = join(n.desktopDirectory, 'relay-config.json'), previous = readFileSync(settings);
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === settings) throw new Error('Injected configuration settings failure'); actualFs.renameSync(from, to); });
  try { expect((await n.run('apply', plan.body.input, plan.body.result.approvalDigest)).body.error).toContain('Injected configuration settings failure'); }
  finally { vi.mocked(renameSync).mockImplementation(actualFs.renameSync); }
  expect(readFileSync(settings)).toEqual(previous); const original = readFileSync(input.output);
  const second = await n.run('review', { ...input, output: join(n.directory, 'second-config.json') }); expect(second.status).toBe(200);
  expect((await n.run('apply', second.body.input, second.body.result.approvalDigest)).status).toBe(200);
  await n.request('/api/lock', {}); await n.unlock();
  const measured = await n.request('/api/relay/history/storage', {});
  expect(measured.status, JSON.stringify(measured.body)).toBe(200);
  expect(measured.body).toMatchObject({ selectedDirectories: 2, selectedFiles: 2, scannedRoots: 2, enforcesQuota: false });
  expect(readFileSync(input.output)).toEqual(original); expect(JSON.stringify(measured.body)).not.toContain(n.directory);
  expect(installRelayService).not.toHaveBeenCalled();
});
