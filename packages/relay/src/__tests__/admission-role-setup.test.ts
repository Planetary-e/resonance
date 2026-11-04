import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { admissionPolicyDigest, signAdmissionPolicy } from '@resonance/core/admission-policy';
import { admissionWitnessSetId, createAdmissionWitnessRequest } from '@resonance/core/admission-witness';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { withStorageReservationAuthority, type StorageReservationAuthority } from '@resonance/core/storage-reservations';
import { openAdmissionRoleSetup, openAdmissionRoleKeyExport, type AdmissionRoleSetupInput } from '../admission-role-setup.js';
import { openAdmissionRoleCapture } from '../admission-role-capture.js';
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';
import { createProtectedAdmissionRoles } from '../protected-admission-roles.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { createHistoryCheckpointReplica, exchangeHistoryCheckpoint, listenHistoryCheckpointReplica } from '../history-checkpoint-exchange.js';
import { readOperatorSigningKey } from '../admission-operator-files.js';
import { runAdmissionHistoryCommand } from '../admission-history-command.js';
import { witnessFixture } from './fixtures/admission-witness-fixture.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
let f: Awaited<ReturnType<typeof witnessFixture>>;
beforeAll(async () => { f = await witnessFixture(); });
function fixture(selection: 'witness' | 'coordinator' = 'witness') {
  const directory = mkdtempSync(join(tmpdir(), 'fresh-admission-role-')), key = randomBytes(32);
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const input: AdmissionRoleSetupInput = { mode: 'new', selection, directory: join(directory, 'role'), output: join(directory, 'public.json'), storageKeyFile: join(directory, 'storage.hex') };
  writeFileSync(input.storageKeyFile, key.toString('hex'), { mode: 0o600 });
  const open = (overrides: Partial<AdmissionRoleSetupInput> = {}) => { const prepared = openAdmissionRoleSetup({ ...input, ...overrides }); cleanup.push(prepared.close); return prepared; };
  return { directory, key, input, open };
}

it.each(['witness', 'coordinator'] as const)('generates a fresh %s key only on approval and exports no secret before enrollment', selection => {
  const n = fixture(selection), setup = n.open();
  expect(setup.review).toMatchObject({ phase: 'new', publicKey: null, secretKeyExported: false }); expect(existsSync(n.input.directory)).toBe(false);
  expect(() => setup.apply('wrong')).toThrow(/approval/); expect(existsSync(n.input.directory)).toBe(false);
  const completed = setup.apply(setup.review.approvalDigest); setup.close();
  const identity = JSON.parse(readFileSync(n.input.output, 'utf8'));
  expect(identity).toEqual({ version: 1, kind: 'admission-role-public-key', role: selection, publicKey: completed.publicKey });
  expect(readFileSync(join(n.input.directory, 'admission-role-preparation.json'), 'utf8')).not.toContain('secretKey');
  expect(() => n.open({ output: join(n.directory, 'other.json') })).toThrow(/new directory/);
  const resume = n.open({ mode: 'resume', output: join(n.directory, 'public-copy.json') });
  expect(resume.review.publicKey).toBe(completed.publicKey); expect(resume.apply(resume.review.approvalDigest).publicKey).toBe(completed.publicKey);
});

it('refuses missing prepared history instead of reinitializing its retained key', () => {
  const n = fixture(), setup = n.open(); setup.apply(setup.review.approvalDigest); setup.close();
  const path = join(n.input.directory, 'admission-witness-votes.json'); rmSync(path);
  expect(() => n.open({ mode: 'resume', output: join(n.directory, 'copy.json') })).toThrow(/missing/);
  expect(existsSync(path)).toBe(false); expect(existsSync(join(n.directory, 'copy.json'))).toBe(false);
});

it.each(['before-role', 'after-role', 'after-prepared'] as const)('resumes an unpublished fresh key after interruption %s', boundary => {
  const n = fixture(), setup = n.open(); let journalWrites = 0;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    const path = String(to); if (path.endsWith('/admission-role-preparation.json')) journalWrites++;
    if (boundary === 'before-role' && path.endsWith('/admission-witness-votes.json')) throw new Error('Interrupted preparation');
    actualFs.renameSync(from, to);
    if ((boundary === 'after-role' && path.endsWith('/admission-witness-votes.json')) || (boundary === 'after-prepared' && journalWrites === 2)) throw new Error('Interrupted preparation');
  });
  try { expect(() => setup.apply(setup.review.approvalDigest)).toThrow(/Interrupted/); } finally { setup.close(); vi.mocked(renameSync).mockImplementation(actualFs.renameSync); }
  expect(existsSync(n.input.output)).toBe(false);
  const resume = n.open({ mode: 'resume' }); expect(resume.review.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(resume.apply(resume.review.approvalDigest).publicKey).toBe(resume.review.publicKey);
});

it('binds storage key bytes and cancellation to the offline preparation without accepting an existing signing key', async () => {
  const n = fixture(), setup = n.open(); writeFileSync(n.input.storageKeyFile, randomBytes(32).toString('hex'));
  expect(() => setup.apply(setup.review.approvalDigest)).toThrow(/selection changed/); expect(existsSync(n.input.directory)).toBe(false);
  const controller = new AbortController(); controller.abort();
  expect(() => openAdmissionRoleSetup(n.input, controller.signal)).toThrow();
  await expect(runAdmissionHistoryCommand('role-setup-plan', ['new', 'witness', n.input.storageKeyFile, n.input.directory, n.input.output, 'old-key.json'])).rejects.toThrow(/Invalid/);
});

it('retains the opening budget at later apply and funds every output before creating a role directory', () => {
  const n = fixture(), paths: string[] = [];
  const authority: StorageReservationAuthority = { reserve(request) { paths.push(request.path); return { assertWritable() {
    if (request.path.endsWith('admission-witness-votes.json')) throw new Error('No room for role lifetime peak');
  } }; } };
  const setup = withStorageReservationAuthority(authority, () => n.open());
  expect(() => withStorageReservationAuthority({ reserve: authority.reserve }, () => setup.apply(setup.review.approvalDigest))).toThrow(/switch/);
  expect(() => setup.apply(setup.review.approvalDigest)).toThrow(/No room/);
  expect(paths).toHaveLength(2); expect(existsSync(n.input.directory)).toBe(false); expect(existsSync(n.input.output)).toBe(false);
});

async function protectedFixture(selection: 'witness' | 'coordinator') {
  const n = fixture(selection), prepared = n.open(), completed = prepared.apply(prepared.review.approvalDigest); prepared.close();
  const h = historyCheckpointFixture(), body = structuredClone(f.body);
  if (selection === 'witness') body.keys[0].witnesses!.members[0].publicKey = completed.publicKey!;
  else body.keys[0].witnesses!.coordinators[0] = completed.publicKey!;
  const policy = await signAdmissionPolicy(body, f.authority, f.authorityKey.secretKey);
  const context = { ...h.context, authority: f.authority, policyDigest: `sha256:${admissionPolicyDigest(policy)}` };
  const members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${28000 + i}/history-checkpoint` }));
  let online = 5;
  const options = { directory: join(n.directory, 'owner'), encryptionKey: n.key, authority: f.authority, policy, now: () => f.time,
    protection: { context, signingKey: h.owner, members, timeoutMs: 1000,
      transport: ((member, frame, signal) => { if (context.members.indexOf(member.publicKey) >= online) throw new Error('offline'); return exchangeHistoryCheckpoint(member, frame, signal); }) as typeof exchangeHistoryCheckpoint } };
  const history = await openProtectedAdmissionSpendHistory({ ...options, initialize: true, protection: { ...options.protection, initializeWriter: true } }); cleanup.push(history.close);
  const root = history.enrollment().root;
  for (let i = 0; i < 5; i++) {
    const store = openHistoryCheckpointStore({ directory: join(n.directory, `r${i}`), context, replica: context.members[i], localKey: h.localKey,
      rootId: historyCheckpointEnvelopeId(root), generation: 0, initialize: root }); cleanup.push(store.close);
    const replica = createHistoryCheckpointReplica({ context, store, signingKey: h.memberKeys[i] }); cleanup.push(replica.close);
    const listener = await listenHistoryCheckpointReplica(replica, { port: 0 }); cleanup.push(listener.close); members[i].endpoint = listener.endpoint;
  }
  // The writer cloned its contact list at opening; reopen with the listening endpoints.
  history.close(); const serving = await openProtectedAdmissionSpendHistory(options); cleanup.push(serving.close); await serving.ready();
  const exportOptions = { directory: n.input.directory, output: join(n.directory, 'private.json'), selection, encryptionKey: n.key, history: serving };
  return { ...n, ...h, policy, context, members, ownerDirectory: options.directory, history: serving, exportOptions,
    async reopen() { serving.close(); const reopened = await openProtectedAdmissionSpendHistory(options); cleanup.push(reopened.close); await reopened.ready(); return reopened; },
    online(value: number) { online = value; } };
}

it.each(['witness', 'coordinator'] as const)('exports a new %s key only after its local fence and four protected copies', async selection => {
  const n = await protectedFixture(selection);
  await expect(openAdmissionRoleKeyExport(n.exportOptions)).rejects.toThrow(/must be captured/); expect(existsSync(n.exportOptions.output)).toBe(false);
  const capture = await openAdmissionRoleCapture({ directory: n.input.directory, encryptionKey: n.exportOptions.encryptionKey, roles: [selection], history: n.history });
  const plan = await capture.review(); await capture.apply(plan.approvalDigest); capture.close();
  const exporter = await openAdmissionRoleKeyExport(n.exportOptions); cleanup.push(exporter.close);
  await expect(exporter.apply('wrong')).rejects.toThrow(/approval/); expect(existsSync(n.exportOptions.output)).toBe(false);
  n.online(3); await expect(exporter.apply(exporter.review.approvalDigest)).rejects.toThrow(/Four/); expect(existsSync(n.exportOptions.output)).toBe(false);
  n.online(4); const result = await exporter.apply(exporter.review.approvalDigest); exporter.close(); expect(result.durableCopies).toBe(4);
  const key = readOperatorSigningKey(n.exportOptions.output); cleanup.push(() => key.secretKey.fill(0));
  expect(Buffer.from(key.publicKey).toString('base64url')).toBe(result.publicKey); expect(JSON.stringify(result)).not.toContain(Buffer.from(key.secretKey).toString('base64url'));
  if (selection === 'witness') {
    const roles = createProtectedAdmissionRoles({ history: n.history, witnessKey: key, now: () => f.time }); cleanup.push(roles.close);
    const claim = { setId: admissionWitnessSetId(n.policy.keys[0].witnesses!), issuerKey: n.policy.activeKey, spend: randomBytes(32).toString('base64url'), action: 'search' as const, requestBinding: `admreq_${'a'.repeat(86)}` };
    expect((await roles.witness!.vote(createAdmissionWitnessRequest(claim, f.coordinators[0]))).spend).toBe(claim.spend);
  }
  // Once the key is usable, neither a new directory operation nor resume can erase its evidence.
  rmSync(join(n.input.directory, selection === 'witness' ? 'admission-witness-votes.json' : 'admission-witness-certificates.json'));
  expect(() => n.open({ mode: 'resume', output: join(n.directory, 'copy.json') })).toThrow(/missing/);
  await expect(openAdmissionRoleKeyExport({ ...n.exportOptions, output: join(n.directory, 'second-private.json') })).rejects.toThrow();
}, 20000);

it.each(['before-private', 'after-private'])('preserves protected decisions and the fresh key after actual process death %s', async boundary => {
  const n = await protectedFixture('witness');
  const capture = await openAdmissionRoleCapture({ directory: n.input.directory, encryptionKey: n.exportOptions.encryptionKey, roles: ['witness'], history: n.history });
  await capture.apply((await capture.review()).approvalDigest); capture.close(); n.history.close();
  const json = (name: string, value: unknown) => { const path = join(n.directory, name); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return path; };
  const ownerKey = json('owner-private.json', { publicKey: Buffer.from(n.owner.publicKey).toString('base64url'), secretKey: Buffer.from(n.owner.secretKey).toString('base64url') });
  const config = json('owner-config.json', { version: 1, context: n.context, members: n.members, ownerKeyFile: ownerKey });
  const args = [config, json('policy.json', n.policy), n.input.storageKeyFile, n.ownerDirectory, n.input.directory, 'witness', n.exportOptions.output];
  const input = json('export-args.json', args), marker = join(n.directory, 'boundary'), env = { ...process.env };
  delete env.RESONANCE_RELAY_STORAGE_SELECTION_FILE; delete env.RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE;
  const child = fork(new URL('./fixtures/protected-role-export-crash.ts', import.meta.url), [input, boundary, marker], { env, execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', value => { errors += String(value); }); const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  cleanup.push(async () => { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await exited; clearTimeout(timer); expect(errors).toBe(''); expect(readFileSync(marker, 'utf8')).toBe(boundary);
  if (process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL');
  expect(existsSync(n.exportOptions.output)).toBe(boundary === 'after-private');
  const history = await n.reopen(), output = join(n.directory, 'reexported-private.json');
  const exporter = await openAdmissionRoleKeyExport({ ...n.exportOptions, output, history }); cleanup.push(exporter.close);
  await exporter.apply(exporter.review.approvalDigest); exporter.close();
  if (boundary === 'after-private') expect(readFileSync(output)).toEqual(readFileSync(n.exportOptions.output));
  expect(history.roleState().witness!.witness).toBe(JSON.parse(readFileSync(output, 'utf8')).publicKey);
  expect(() => n.open({ mode: 'resume', output: join(n.directory, 'reset.json') })).toThrow(/invalid/);
}, 20000);
