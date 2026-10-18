import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runPolicyObserverCommand } from '../policy-observer-command.js';
import { policyObserverOutboundFixture, waitForPolicyLinks } from './fixtures/policy-observer-outbound-fixture.js';
import { policyObserverSetupFixture } from './fixtures/policy-observer-setup-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('uses the explicit finite maintenance budget for a cold durable write without changing personal observation deadlines', async () => {
  let delay = false, delayed = false;
  const n = await policyObserverOutboundFixture(close => cleanup.push(close), { beforeExchange: async (_replica, method, frame) => {
    if (delay && !delayed && method === 'checkpoint' && (frame as { request?: { action?: string } }).request?.action === 'append') {
      delayed = true; await new Promise(resolve => setTimeout(resolve, 3500));
    }
  } });
  const options = { transportFile: n.transportFile };
  const plan = await runPolicyObserverCommand('initialize-plan', [n.configPath], undefined, options);
  await runPolicyObserverCommand('initialize', ['--approve', (plan.result as { approvalDigest: string }).approvalDigest, n.configPath], undefined, options);
  delay = true;
  const ready = await runPolicyObserverCommand('ready', [n.configPath], undefined, options);
  expect(delayed).toBe(true); expect(ready.result).toMatchObject({ readiness: 'confirmed' });
}, 30000);

it('initializes and recovers a policy observer through a pinned bridge using only outbound owner and volunteer links', async () => {
  const n = await policyObserverOutboundFixture(close => cleanup.push(close));
  const main = fileURLToPath(new URL('../policy-observer-main.ts', import.meta.url)), loader = import.meta.resolve('tsx');
  const run = async (command: string, args = [n.configPath]) => {
    const result = await promisify(execFile)(process.execPath, ['--import', loader, main, command, ...args], {
      cwd: n.directory, timeout: 20000, env: { ...process.env, RESONANCE_HISTORY_OPERATOR_TRANSPORT_FILE: n.transportFile } });
    await waitForPolicyLinks(() => !n.bridge.getRelayLinkStatus().inboundRelayIds.includes(n.operatorId));
    expect(result.stderr).toBe(''); return JSON.parse(result.stdout);
  };
  const offline = async (command: string, args?: string[]) => {
    // A missing passphrase makes even an attempted infrastructure-key read fail.
    renameSync(n.secret, n.secret + '.offline');
    try { return await run(command, args); } finally { renameSync(n.secret + '.offline', n.secret); }
  };
  for (const volunteer of n.volunteers) expect(volunteer.getRelayDescriptor()!.endpoints).toEqual([]);
  const review = await offline('initialize-plan'); expect(existsSync(n.ownerDirectory)).toBe(false);
  await run('initialize', ['--approve', review.approvalDigest, n.configPath]);
  expect((await run('ready')).readiness).toBe('confirmed');
  expect((await offline('status')).readiness).toBe('unverified');
  const advance = join(n.directory, 'advance.json'); writeFileSync(advance, JSON.stringify(n.advance));
  expect((await run('advance', [n.configPath, advance])).status.head).toEqual(n.advance.commitment.next);
  const workspace = join(n.directory, 'recovery'), args = [n.configPath, workspace];
  const recovery = await run('recovery-plan', [...args, 'available', '1']);
  await run('recovery-start', ['--approve', recovery.approvalDigest, ...args, 'available', '1']);
  expect((await offline('status')).status.fenced).toBe(true);
  let status = await offline('recovery-status', args);
  for (let step = 0; step < 12 && !status.complete; step++) status = await run('recovery-step', args);
  expect(status.complete).toBe(true);
  const restored = join(n.directory, 'restored'), restore = await offline('recovery-review', [...args, restored]);
  await offline('recovery-restore', ['--approve', restore.approvalDigest, ...args, restored]);
  // The restored generation has never served. The resumption command must still
  // obtain its fresh unchanged-root quorum through the configured bridge.
  rmSync(join(restored, 'history-writer.json')); rmSync(join(restored, 'payloads'), { recursive: true });
  const resume = await offline('recovery-resume-plan', [...args, restored]);
  await run('recovery-resume', ['--approve', resume.approvalDigest, ...args, restored]);
  const config = join(n.directory, 'restored.json'); await offline('recovery-export', [...args, restored, config]);
  expect((await run('ready', [config])).readiness).toBe('confirmed');
  const later = join(n.directory, 'later.json'); writeFileSync(later, JSON.stringify(n.later));
  expect((await run('advance', [config, later])).status.head).toEqual(n.later.commitment.next);
  expect((await offline('status', [config])).status.head).toEqual(n.later.commitment.next);
  expect(n.bridgeRouter.usage().operations).toBe(0);
}, 120000);

it('does not fall back to direct history when the configured operator file is missing', async () => {
  const n = await policyObserverSetupFixture(close => cleanup.push(close)); await n.prepare();
  for (let i = 0; i < 5; i++) { await n.enroll(i); await n.start(i); }
  const missing = join(n.directory, 'absent-transport.json');
  await expect(runPolicyObserverCommand('initialize-plan', [n.configPath], undefined, { transportFile: missing })).rejects.toThrow();
  expect(existsSync(n.ownerDirectory)).toBe(false);
  await n.initialize(); await n.call('ready', [n.configPath]);
  const before = readFileSync(join(n.ownerDirectory, 'history-writer.json'));
  await expect(runPolicyObserverCommand('ready', [n.configPath], undefined, { transportFile: missing })).rejects.toThrow();
  expect(readFileSync(join(n.ownerDirectory, 'history-writer.json'))).toEqual(before);
});

it('keeps finite maintenance transport separate from continuous services and closes on pre-cancelled commands', async () => {
  const n = await policyObserverSetupFixture(close => cleanup.push(close)); await n.prepare();
  const options = { transportFile: join(n.directory, 'operator.json') };
  await expect(runPolicyObserverCommand('serve', [n.configPath], undefined, options)).rejects.toThrow('continuous');
  await expect(runPolicyObserverCommand('replica-serve', [...n.replicaArgs(0), '0'], undefined, options)).rejects.toThrow('background routing');
  await expect(runPolicyObserverCommand('initialize', ['--approve', 'invalid', n.configPath], AbortSignal.abort(), options)).rejects.toThrow();
  expect(existsSync(n.ownerDirectory)).toBe(false);
});
