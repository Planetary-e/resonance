import { afterEach, expect, it } from 'vitest';
import { cpSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createAdmissionPolicyHeadRequest, parseAdmissionPolicyHeadVote } from '@resonance/core/admission-policy-freshness';
import { exchangeAdmissionPolicyObservation } from '../admission-policy-observation-transport.js';
import { openConfiguredPolicyObserver, readPolicyObserverConfigurationFile } from '../policy-observer-config.js';
import { runPolicyObserverCommand } from '../policy-observer-command.js';
import { policyObserverOutboundFixture, waitForPolicyLinks } from './fixtures/policy-observer-outbound-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
type Fixture = Awaited<ReturnType<typeof policyObserverOutboundFixture>>;
async function fixture(networkOptions?: Parameters<typeof policyObserverOutboundFixture>[1]) {
  const n = await policyObserverOutboundFixture(close => cleanup.push(close), networkOptions);
  const options = { transportFile: n.transportFile };
  const review = (await runPolicyObserverCommand('initialize-plan', [n.configPath], undefined, options)).result as { approvalDigest: string };
  await runPolicyObserverCommand('initialize', ['--approve', review.approvalDigest, n.configPath], undefined, options);
  return n;
}
function start(n: Fixture, environment: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('RELAY_')));
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../main.ts', import.meta.url))], {
    cwd: n.directory, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, RELAY_HOST: '127.0.0.1', RELAY_PORT: '0',
      RELAY_DATA_DIR: n.identityDirectory, RELAY_IDENTITY_PASSPHRASE_FILE: n.secret, RELAY_ADMIN_API_KEY: 'observer-runtime-test',
      ...(n.coLocatedFile ? { RELAY_HISTORY_VOLUNTEER_FILE: n.coLocatedFile } : {}),
      RELAY_POLICY_OBSERVER_FILE: n.configPath, RELAY_POLICY_OBSERVER_LINKS_FILE: n.links, ...environment } });
  const exited = once(child, 'exit'); let output = '', port = 0, endpoint = '', closed = false;
  const read = (bytes: Buffer) => {
    output += bytes.toString();
    for (const line of output.split('\n')) { try {
      const event = JSON.parse(line); if (event.event === 'started') port = event.port;
      if (event.event === 'policy_observer_ready') endpoint = event.endpoint;
    } catch { /* Partial log line. */ } }
  };
  child.stdout.on('data', read); child.stderr.on('data', read);
  const close = async () => {
    if (closed) return; closed = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000); try { await exited; } finally { clearTimeout(timer); }
  }; cleanup.push(close);
  async function wait(test: () => boolean) {
    await waitForPolicyLinks(() => { if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Observer runtime exited: ${output}`); return test(); });
  }
  return { child, close, exited, output: () => output, endpoint: () => endpoint,
    listening: () => wait(() => port > 0), ready: () => wait(() => !!endpoint),
    async stats() { return await (await fetch(`http://127.0.0.1:${port}/stats?key=observer-runtime-test`)).json(); } };
}
function observe(n: Fixture, endpoint: string, advance: unknown = null) {
  const request = createAdmissionPolicyHeadRequest(n.context);
  return exchangeAdmissionPolicyObservation({ publicKey: n.enrollment.historyContext.owner, endpoint },
    { request, advance: advance as never }, AbortSignal.timeout(10000))
    .then(reply => parseAdmissionPolicyHeadVote(reply, request, n.context, Date.now()));
}

it('serves an existing observer through the ordinary background runtime, accounts traffic and retains updates across restart and an owner pause', async () => {
  const n = await fixture();
  let runtime = start(n); await runtime.ready();
  expect((await observe(n, runtime.endpoint())).head.revision).toBe(1);
  expect((await observe(n, runtime.endpoint(), n.advance)).head.revision).toBe(2);
  const stats = await runtime.stats(); expect(stats.transport_ingress_bytes).toBeGreaterThan(0); expect(stats.transport_egress_bytes).toBeGreaterThan(0);
  await runtime.close(); if (process.platform !== 'win32') expect(runtime.child.exitCode).toBe(0);
  if (process.platform !== 'win32') {
    const usage = JSON.parse(readFileSync(join(n.identityDirectory, 'relay-resource-usage.json'), 'utf8'));
    expect(usage.totals.ingressBytes).toBeGreaterThan(0); expect(usage.totals.egressBytes).toBeGreaterThan(0);
  }
  runtime = start(n, { RELAY_NEW_WORK_BANDWIDTH_BYTES_PER_HOUR: '0' }); await runtime.ready();
  await expect(observe(n, runtime.endpoint(), n.later)).rejects.toThrow(); await runtime.close();
  const config = readPolicyObserverConfigurationFile(n.configPath), retained = await openConfiguredPolicyObserver(config); cleanup.push(retained.close);
  expect(retained.policy()).toEqual(n.second); expect(retained.status().pending).toBe(false); retained.close();
  runtime = start(n); await runtime.ready(); expect((await observe(n, runtime.endpoint(), n.later)).head.revision).toBe(3);
}, 60000);

it('refuses a restored stale local owner before exposing observations and does not create missing owner state', async () => {
  const n = await fixture(), backup = join(n.directory, 'owner-backup'); cpSync(n.ownerDirectory, backup, { recursive: true });
  const running = start(n); await running.ready(); await observe(n, running.endpoint(), n.advance); await running.close();
  renameSync(n.ownerDirectory, n.ownerDirectory + '.advanced'); renameSync(backup, n.ownerDirectory);
  const stale = start(n); await stale.exited;
  expect(stale.child.exitCode).toBe(1); expect(stale.endpoint()).toBe(''); expect(stale.output()).toContain('policy_observer_startup_failed');
  renameSync(n.ownerDirectory, backup);
  const missing = start(n); await missing.exited;
  expect(missing.child.exitCode).toBe(1); expect(missing.endpoint()).toBe('');
  expect(existsSync(join(n.ownerDirectory, 'history-writer.json'))).toBe(false);
}, 60000);

it('requires four reachable copies on startup and handles shutdown while outbound readiness is waiting', async () => {
  const n = await fixture(); await n.volunteers[3].stop({ graceful: false }); await n.volunteers[4].stop({ graceful: false });
  const insufficient = start(n); await insufficient.exited;
  expect(insufficient.child.exitCode).toBe(1); expect(insufficient.endpoint()).toBe('');
  expect(insufficient.output()).toContain('policy_observer_startup_failed');
  await n.bridge.stop({ graceful: false });
  const waiting = start(n); await waiting.listening(); const started = performance.now(); await waiting.close();
  expect(performance.now() - started).toBeLessThan(10000); expect(waiting.endpoint()).toBe('');
  const retained = await openConfiguredPolicyObserver(readPolicyObserverConfigurationFile(n.configPath)); cleanup.push(retained.close);
  expect(retained.policy()).toEqual(n.first);
}, 60000);

it('refuses explicitly broken routing without silently trying direct endpoints', async () => {
  const n = await fixture(), broken = start(n, { RELAY_POLICY_OBSERVER_LINKS_FILE: join(n.directory, 'missing-links') });
  await broken.exited; expect(broken.child.exitCode).toBe(1); expect(broken.endpoint()).toBe('');
  const partial = start(n, { RELAY_POLICY_OBSERVER_FILE: '' }); await partial.exited;
  expect(partial.child.exitCode).toBe(1); expect(partial.output()).toContain('require RELAY_POLICY_OBSERVER_FILE');
}, 60000);

it('uses its own enrolled replica plus three remote volunteers without a self-link and refuses progress with only three total copies', async () => {
  const n = await fixture({ coLocated: true });
  // Initialization used four remote volunteers. The runtime now reopens the
  // fifth enrolled replica in its own process; one remote goes offline.
  await n.volunteers[3].stop({ graceful: false });
  const runtime = start(n); await runtime.ready();
  expect((await observe(n, runtime.endpoint(), n.advance)).head.revision).toBe(2);
  const stats = await runtime.stats(); expect(stats.history.volunteer).toMatchObject({ state: 'available', usage: { retainedBlocks: 2 } });
  expect(stats.history.transport).toMatchObject({ state: 'available', usage: { configuredLocalMembers: 1, configuredMembers: 5 } });
  await n.volunteers[2].stop({ graceful: false });
  await expect(observe(n, runtime.endpoint())).rejects.toThrow(); await runtime.close();
  const unavailable = start(n); await unavailable.exited; expect(unavailable.child.exitCode).toBe(1); expect(unavailable.endpoint()).toBe('');
  const retained = await openConfiguredPolicyObserver(readPolicyObserverConfigurationFile(n.configPath)); cleanup.push(retained.close);
  expect(retained.policy()).toEqual(n.second); expect(retained.status().pending).toBe(false);
}, 60000);

// Windows task termination does not deliver Unix SIGTERM to drain handlers.
it.skipIf(process.platform === 'win32')('drains an admitted remote write before closing the runtime history router', async () => {
  let hold = false, reached!: () => void, release!: () => void;
  const admitted = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const n = await fixture({ beforeExchange: async (_i, method, value) => {
    const action = (value as { request?: { action?: string } })?.request?.action;
    if (hold && method === 'checkpoint' && action === 'append') { reached(); await gate; }
  } });
  const runtime = start(n); await runtime.ready(); hold = true;
  const response = observe(n, runtime.endpoint(), n.advance).catch(error => error); await admitted;
  const closing = runtime.close();
  try {
    await waitForPolicyLinks(() => runtime.output().includes('policy_observer_draining'));
    expect(runtime.child.exitCode).toBeNull();
  } finally { release(); }
  await closing; expect(runtime.child.exitCode).toBe(0); expect(await response).toBeInstanceOf(Error);
  const observer = await openConfiguredPolicyObserver(readPolicyObserverConfigurationFile(n.configPath)); cleanup.push(observer.close);
  expect(observer.policy()).toEqual(n.second); expect(observer.status().pending).toBe(false);
}, 60000);
