import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createAdmissionPolicyHeadRequest, parseAdmissionPolicyHeadVote } from '@resonance/core/admission-policy-freshness';
import { exchangeAdmissionPolicyObservation } from '../admission-policy-observation-transport.js';
import { parsePolicyObserverConfiguration, readPolicyObserverConfigurationFile, openConfiguredPolicyObserver, serveConfiguredPolicyObserver } from '../policy-observer-config.js';
import { runPolicyObserverCommand } from '../policy-observer-command.js';
import { policyObserverRestoreFixture } from './fixtures/policy-observer-restore-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const n = await policyObserverRestoreFixture(close => cleanup.push(close)); n.observer.close();
  writeFileSync(join(n.directory, 'owner-key.json'), JSON.stringify({ publicKey: Buffer.from(n.owner.publicKey).toString('base64url'), secretKey: Buffer.from(n.owner.secretKey).toString('base64url') }), { mode: 0o600 });
  writeFileSync(join(n.directory, 'storage.key'), n.key.toString('hex'), { mode: 0o600 });
  const raw = { version: 1, kind: 'policy-observer-configuration', context: n.context, historyContext: n.enrolled.context,
    genesis: n.enrolled.root, root: n.enrolled.root, members: n.members, directory: 'owner', signingKeyFile: 'owner-key.json', storageKeyFile: 'storage.key',
    limits: { archiveBytes: 64 * 1024 * 1024, archiveBlocks: 10001 }, listen: { port: 0, maxConnections: 4, connectionTimeoutMs: 10000 } };
  const path = join(n.directory, 'observer-config.json'); writeFileSync(path, JSON.stringify(raw));
  return { ...n, raw, config: readPolicyObserverConfigurationFile(path), configPath: path };
}

it('validates complete independent pins, bounded UTF-8 input and paths relative to the configuration', async () => {
  const n = await fixture(); expect(n.config.directory).toBe(n.options.directory); expect(n.config.signingKeyFile).toBe(join(n.directory, 'owner-key.json'));
  for (const damage of ['role', 'root', 'member', 'endpoint', 'route', 'limits', 'port', 'connections', 'timeout', 'path', 'extra']) {
    const value = structuredClone(n.raw);
    if (damage === 'role') value.historyContext.role = 'relay-admission-spends';
    if (damage === 'root') value.root = { ...value.root, signature: 'invalid' };
    if (damage === 'member') value.members[0] = value.members[1];
    if (damage === 'endpoint') value.members[0].endpoint = 'ws://example.org/history-checkpoint';
    if (damage === 'route') value.members[0].endpoint += '?untrusted=true';
    if (damage === 'limits') value.limits.archiveBlocks = 10002;
    if (damage === 'port') value.listen.port = 65536;
    if (damage === 'connections') value.listen.maxConnections = 9;
    if (damage === 'timeout') value.listen.connectionTimeoutMs = 30001;
    if (damage === 'path') value.directory = '\0';
    if (damage === 'extra') Object.assign(value, { initialize: true });
    expect(() => parsePolicyObserverConfiguration(value, n.directory), damage).toThrow();
  }
  writeFileSync(n.configPath, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d]));
  expect(() => readPolicyObserverConfigurationFile(n.configPath)).toThrow('UTF-8');
});

it('inspects existing state without contacting volunteers and never creates a replacement missing writer', async () => {
  const n = await fixture(); let calls = 0;
  const observer = await openConfiguredPolicyObserver(n.config, { transport: () => { calls++; throw new Error('Unexpected I/O'); } }); cleanup.push(observer.close);
  expect(observer.policy()).toEqual(n.first); expect(calls).toBe(0); observer.close();
  const result = await runPolicyObserverCommand('status', [n.configPath]); expect(result.result).toMatchObject({ readiness: 'unverified' });
  const missing = join(n.directory, 'missing-owner'); await expect(openConfiguredPolicyObserver({ ...n.config, directory: missing })).rejects.toThrow('missing');
  expect(existsSync(join(missing, 'history-writer.json'))).toBe(false);
});

it('requires four current copies before listening, performs signed operations and drains shutdown before reopening', async () => {
  const n = await fixture(); n.online(3);
  await expect(serveConfiguredPolicyObserver(n.config, { transport: n.transport })).rejects.toThrow('Four');
  n.online(5); const service = await serveConfiguredPolicyObserver(n.config, { transport: n.transport }); cleanup.push(service.close);
  const member = { publicKey: n.enrolled.context.owner, endpoint: service.endpoint }, request = createAdmissionPolicyHeadRequest(n.context);
  const response = await exchangeAdmissionPolicyObservation(member, { request, advance: n.advance }, new AbortController().signal);
  expect(parseAdmissionPolicyHeadVote(response, request, n.context, Date.now()).head).toEqual(n.advance.commitment.next);
  expect(service.status().head).toEqual(n.advance.commitment.next);
  const first = service.close(); expect(service.close()).toBe(first); await first;
  const reopened = await openConfiguredPolicyObserver(n.config); cleanup.push(reopened.close); expect(reopened.policy()).toEqual(n.second);
});

it('refuses blocked and locally fenced observers on startup while retaining inspectable evidence', async () => {
  const n = await fixture(), observer = await openConfiguredPolicyObserver(n.config); cleanup.push(observer.close);
  await observer.advance(n.advance); await expect(observer.advance(n.conflict)).rejects.toThrow('equivocated'); observer.close();
  await expect(serveConfiguredPolicyObserver(n.config)).rejects.toThrow('equivocated');
  const blocked = await openConfiguredPolicyObserver(n.config); cleanup.push(blocked.close); expect(blocked.status().evidence).toHaveLength(2);
  const { fencePolicyObserverRecoverySource } = await import('../protected-policy-observer.js');
  await fencePolicyObserverRecoverySource(blocked.reviewRecoverySource()); blocked.close();
  await expect(serveConfiguredPolicyObserver(n.config)).rejects.toThrow('fenced');
  expect((await runPolicyObserverCommand('status', [n.configPath])).result).toMatchObject({ status: { blocked: true, fenced: true } });
});

it('cancels startup during unresponsive readiness and releases directory ownership', async () => {
  const n = await fixture(), controller = new AbortController(); let started!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  const opening = serveConfiguredPolicyObserver(n.config, { signal: controller.signal, transport: () => { started(); return new Promise(() => {}); } });
  await reached; controller.abort(); await expect(opening).rejects.toThrow(/cancelled|closed/);
  const reopened = await openConfiguredPolicyObserver(n.config); cleanup.push(reopened.close); expect(reopened.policy()).toEqual(n.first);
  await expect(runPolicyObserverCommand('ready', [n.configPath], AbortSignal.abort())).rejects.toThrow('cancelled');
});

it('waits for an admitted update during shutdown even after its client loses the reply', async () => {
  const n = await fixture(); let hold = false, reached!: () => void, release!: () => void;
  const admitted = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const service = await serveConfiguredPolicyObserver(n.config, { transport: async (member, frame, signal) => {
    if (hold && frame.request.action === 'append') { reached(); await gate; }
    return n.transport(member, frame, signal);
  } }); cleanup.push(service.close);
  hold = true; const request = createAdmissionPolicyHeadRequest(n.context);
  const response = exchangeAdmissionPolicyObservation({ publicKey: n.enrolled.context.owner, endpoint: service.endpoint }, { request, advance: n.advance }, new AbortController().signal);
  const rejected = response.catch(error => error); await admitted;
  let closed = false; const closing = service.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false);
  try { await expect(openConfiguredPolicyObserver(n.config)).rejects.toThrow(/owned|lock|already open/); }
  finally { release(); }
  await closing; expect(await rejected).toBeInstanceOf(Error);
  const observer = await openConfiguredPolicyObserver(n.config); cleanup.push(observer.close);
  expect(observer.policy()).toEqual(n.second); expect(observer.status().pending).toBe(false);
});

it.each(['signing', 'storage'])('rejects changed %s key files without replacing retained history', async key => {
  const n = await fixture(), before = readFileSync(join(n.options.directory, 'history-writer.json'));
  if (key === 'signing') writeFileSync(n.config.signingKeyFile, JSON.stringify({ publicKey: Buffer.from(n.keys[1].publicKey).toString('base64url'), secretKey: Buffer.from(n.keys[1].secretKey).toString('base64url') }));
  else writeFileSync(n.config.storageKeyFile, '00'.repeat(32));
  await expect(serveConfiguredPolicyObserver(n.config)).rejects.toThrow();
  expect(readFileSync(join(n.options.directory, 'history-writer.json'))).toEqual(before);
});

it('runs status, signed advance and actual service startup through the Node CLI', async () => {
  const n = await fixture(), main = fileURLToPath(new URL('../policy-observer-main.ts', import.meta.url)), loader = import.meta.resolve('tsx');
  const run = (args: string[]) => promisify(execFile)(process.execPath, ['--import', loader, main, ...args], { cwd: n.directory, timeout: 15000 });
  const before = readFileSync(join(n.options.directory, 'history-writer.json'));
  const status = JSON.parse((await run(['status', n.configPath])).stdout); expect(status.readiness).toBe('unverified');
  expect(readFileSync(join(n.options.directory, 'history-writer.json'))).toEqual(before);
  const advanceFile = join(n.directory, 'advance.json'); writeFileSync(advanceFile, JSON.stringify(n.advance));
  expect(JSON.parse((await run(['advance', n.configPath, advanceFile])).stdout).status.head).toEqual(n.advance.commitment.next);
  const child = spawn(process.execPath, ['--import', loader, main, 'serve', n.configPath], { cwd: n.directory, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stderr = ''; child.stderr.on('data', value => { stderr += String(value); });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const lines = createInterface({ input: child.stdout }); cleanup.push(() => lines.close());
  const started = await Promise.race([once(lines, 'line'), exited.then(() => { throw new Error(`Observer CLI exited before listening: ${stderr}`); })]);
  const output = JSON.parse(String(started[0])); expect(output.result).toBe('policy-observer-listening');
  const request = createAdmissionPolicyHeadRequest(n.context);
  const response = await exchangeAdmissionPolicyObservation({ publicKey: n.enrolled.context.owner, endpoint: output.endpoint }, { request, advance: null }, new AbortController().signal);
  expect(parseAdmissionPolicyHeadVote(response, request, n.context, Date.now()).head).toEqual(n.advance.commitment.next);
  child.kill('SIGTERM'); await exited;
  // Windows task termination is abrupt; Unix additionally exercises graceful shutdown.
  if (process.platform !== 'win32') expect(child.exitCode).toBe(0);
  const reopened = await openConfiguredPolicyObserver(n.config); cleanup.push(reopened.close); expect(reopened.policy()).toEqual(n.second);
}, 30000);
