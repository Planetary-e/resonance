import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createAdmissionPolicyHeadRequest, parseAdmissionPolicyHeadVote } from '@resonance/core/admission-policy-freshness';
import { openPolicyObserverSetup, POLICY_OBSERVER_ROOT_SUFFIX, readPolicyObserverEnrollment } from '../policy-observer-setup.js';
import { readPolicyObserverConfigurationFile } from '../policy-observer-config.js';
import { exchangeAdmissionPolicyObservation } from '../admission-policy-observation-transport.js';
import { policyObserverSetupFixture } from './fixtures/policy-observer-setup-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const fixture = () => policyObserverSetupFixture(close => cleanup.push(close));
const main = fileURLToPath(new URL('../policy-observer-main.ts', import.meta.url)), loader = import.meta.resolve('tsx');

it('reviews offline, binds exact files, publishes one root and re-exports it without creating owner state or exposing keys', async () => {
  const n = await fixture(), input = { setupFile: n.setupFile, output: n.configPath, mode: 'new' as const };
  const handle = await openPolicyObserverSetup(input); cleanup.push(handle.close);
  const repeated = await n.call('setup-plan'); expect(handle.review()).toEqual(repeated);
  expect(existsSync(n.configPath)).toBe(false); expect(existsSync(n.ownerDirectory)).toBe(false);
  await expect(handle.apply('wrong')).rejects.toThrow('reviewed');
  const policy = join(n.directory, 'policy.json'), original = readFileSync(policy); writeFileSync(policy, original + '\n');
  await expect(handle.apply(repeated.approvalDigest)).rejects.toThrow('selection changed'); writeFileSync(policy, original);
  await handle.apply(repeated.approvalDigest); handle.close();
  const prepared = readPolicyObserverConfigurationFile(n.configPath), copy = join(n.directory, 'copy.json');
  await expect(n.call('setup-create', ['--approve', repeated.approvalDigest, n.setupFile, copy])).rejects.toThrow('already exists');
  await n.call('setup-export', [n.setupFile, copy]); expect(readPolicyObserverConfigurationFile(copy)).toEqual(prepared);
  expect(existsSync(n.ownerDirectory)).toBe(false);
  await n.call('enrollment-export', [copy, n.enrollmentPath]); const exported = readFileSync(n.enrollmentPath, 'utf8');
  expect(readPolicyObserverEnrollment(n.enrollmentPath).root).toEqual(prepared.genesis);
  for (const secret of [n.directory, Buffer.from(n.keys[0].secretKey).toString('base64url'), Buffer.from(n.options.encryptionKey).toString('hex')]) expect(exported).not.toContain(secret);
});

it('refuses malformed, mismatched, oversized and impossible preparation inputs before any root is published', async () => {
  const n = await fixture();
  for (const change of ['extra', 'members', 'endpoint', 'route', 'budget', 'port', 'path']) {
    const value = structuredClone(n.input);
    if (change === 'extra') Object.assign(value, { initialize: true });
    if (change === 'members') value.members[0] = value.members[1];
    if (change === 'endpoint') value.members[0].endpoint = 'ws://example.org/history-checkpoint';
    if (change === 'route') value.members[0].endpoint += '?different=route';
    if (change === 'budget') value.limits.archiveBytes = 1;
    if (change === 'port') value.listen.port = -1;
    if (change === 'path') value.directory = '.';
    writeFileSync(n.setupFile, JSON.stringify(value)); await expect(n.call('setup-plan'), change).rejects.toThrow();
  }
  writeFileSync(n.setupFile, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d])); await expect(n.call('setup-plan')).rejects.toThrow('UTF-8');
  writeFileSync(n.setupFile, ' '.repeat(65537)); await expect(n.call('setup-plan')).rejects.toThrow('bounded');
  writeFileSync(n.setupFile, JSON.stringify(n.input)); writeFileSync(join(n.directory, 'policy.json'), JSON.stringify(n.second));
  await expect(n.call('setup-plan')).rejects.toThrow();
  expect(existsSync(n.keyFiles[0] + POLICY_OBSERVER_ROOT_SUFFIX)).toBe(false); expect(existsSync(n.configPath)).toBe(false);
});

it('preserves partial anchors and used destinations and does not regenerate a root under the same canonical key', async () => {
  const n = await fixture(), anchor = n.keyFiles[0] + POLICY_OBSERVER_ROOT_SUFFIX;
  mkdirSync(n.ownerDirectory); writeFileSync(join(n.ownerDirectory, 'retained'), 'history');
  await expect(n.call('setup-plan')).rejects.toThrow('empty owner'); rmSync(n.ownerDirectory, { recursive: true });
  writeFileSync(anchor, 'interrupted root publication');
  await expect(n.call('setup-plan')).rejects.toThrow('already exists'); await expect(n.call('setup-export')).rejects.toThrow('UTF-8');
  expect(readFileSync(anchor, 'utf8')).toBe('interrupted root publication'); expect(existsSync(n.configPath)).toBe(false);
});

it('rejects changed keys and cancellation between review and preparation', async () => {
  const n = await fixture(), controller = new AbortController();
  const handle = await openPolicyObserverSetup({ setupFile: n.setupFile, output: n.configPath, mode: 'new' }, controller.signal); cleanup.push(handle.close);
  const review = handle.review(), key = readFileSync(n.storagePath); writeFileSync(n.storagePath, key + '\n');
  await expect(handle.apply(review.approvalDigest)).rejects.toThrow('selection changed'); writeFileSync(n.storagePath, key);
  controller.abort(); await expect(handle.apply(review.approvalDigest)).rejects.toThrow();
  expect(existsSync(n.keyFiles[0] + POLICY_OBSERVER_ROOT_SUFFIX)).toBe(false);
});

it('runs preparation, five volunteer processes, quorum-gated initialization and actual observation through the Node CLI', async () => {
  const n = await fixture();
  const run = async (command: string, args = n.args) => JSON.parse((await promisify(execFile)(process.execPath,
    ['--import', loader, main, command, ...args], { cwd: n.directory, timeout: 20000 })).stdout);
  async function serve(command: string, args: string[]) {
    const child = spawn(process.execPath, ['--import', loader, main, command, ...args], { cwd: n.directory, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', bytes => { errors += String(bytes); }); const exited = once(child, 'exit');
    const lines = createInterface({ input: child.stdout });
    let stopped = false;
    const stop = async () => { if (stopped) return; stopped = true; lines.close(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; };
    cleanup.push(stop);
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    try {
      const line = await Promise.race([once(lines, 'line').then(([line]) => line), exited.then(() => { throw new Error(`CLI exited before listening: ${errors}`); })]);
      return { message: JSON.parse(line), stop };
    } finally { clearTimeout(timer); }
  }
  const plan = await run('setup-plan'); await run('setup-create', ['--approve', plan.approvalDigest, ...n.args]);
  await run('enrollment-export', [n.configPath, n.enrollmentPath]);
  const volunteers: Array<Awaited<ReturnType<typeof serve>>> = [];
  for (let i = 0; i < 5; i++) {
    const args = n.replicaArgs(i), planned = await run('replica-plan', args);
    await run('replica-enroll', ['--approve', planned.approvalDigest, ...args]);
    const service = await serve('replica-serve', [...args, '0']); volunteers.push(service);
    n.endpoints[i].forwardTo(Number(new URL(service.message.checkpointEndpoint).port));
  }
  const initial = await run('initialize-plan', [n.configPath]); n.endpoints[3].disconnect(); n.endpoints[4].disconnect();
  await expect(run('initialize', ['--approve', initial.approvalDigest, n.configPath])).rejects.toThrow('Four current');
  expect(existsSync(n.ownerDirectory)).toBe(false);
  for (let i = 3; i < 5; i++) n.endpoints[i].forwardTo(Number(new URL(volunteers[i].message.checkpointEndpoint).port));
  expect(await run('initialize', ['--approve', initial.approvalDigest, n.configPath])).toMatchObject({ readiness: 'unverified', startsService: false });
  expect(await run('ready', [n.configPath])).toMatchObject({ readiness: 'confirmed' });
  const observer = await serve('serve', [n.configPath]), request = createAdmissionPolicyHeadRequest(n.context);
  const response = await exchangeAdmissionPolicyObservation({ publicKey: n.input.members[0].publicKey, endpoint: observer.message.endpoint },
    { request, advance: n.advance }, new AbortController().signal);
  expect(parseAdmissionPolicyHeadVote(response, request, n.context, Date.now()).head).toEqual(n.advance.commitment.next);
  await observer.stop();
  expect((await run('status', [n.configPath])).status.head).toEqual(n.advance.commitment.next);
  await volunteers[0].stop();
  const resumed = await run('replica-resume-plan', n.replicaArgs(0));
  await run('replica-resume', ['--approve', resumed.approvalDigest, ...n.replicaArgs(0)]);
  const restarted = await serve('replica-serve', [...n.replicaArgs(0), '0']); n.endpoints[0].forwardTo(Number(new URL(restarted.message.checkpointEndpoint).port));
  expect((await run('ready', [n.configPath])).readiness).toBe('confirmed');
}, 120000);

it('refuses initial recreation after both owner files disappear but remote replicas retain a later accepted policy', async () => {
  const n = await fixture(); await n.prepare();
  for (let i = 0; i < 5; i++) { await n.enroll(i); await n.start(i); }
  await n.initialize(); await n.call('ready', [n.configPath]);
  const advancePath = join(n.directory, 'advance.json'); writeFileSync(advancePath, JSON.stringify(n.advance)); await n.call('advance', [n.configPath, advancePath]);
  rmSync(n.ownerDirectory, { recursive: true });
  await expect(n.initialize()).rejects.toThrow('Four current'); expect(existsSync(n.ownerDirectory)).toBe(false);
}, 30000);

it('requires independently pinned volunteer keys and exact approvals and never enrolls over retained state', async () => {
  const n = await fixture(); await n.prepare(); const args = n.replicaArgs(0);
  const outsider = join(n.directory, 'outsider.json'); writeFileSync(outsider, JSON.stringify({ publicKey: Buffer.from(n.key.publicKey).toString('base64url'), secretKey: Buffer.from(n.key.secretKey).toString('base64url') }));
  await expect(n.call('replica-plan', [args[0], outsider, ...args.slice(2)])).rejects.toThrow('independently pinned');
  const review = await n.call('replica-plan', args);
  await expect(n.call('replica-enroll', ['--approve', 'wrong', ...args])).rejects.toThrow('reviewed');
  expect(existsSync(args[3])).toBe(false);
  await n.enroll(0); await expect(n.call('replica-plan', args)).rejects.toThrow('empty');
  rmSync(join(args[3], 'genesis', 'history-manifest.json'));
  await expect(n.call('replica-resume-plan', args)).rejects.toThrow(/manifest is missing|ENOENT/);
  expect(existsSync(join(args[3], 'genesis', 'history-manifest.json'))).toBe(false);
});
