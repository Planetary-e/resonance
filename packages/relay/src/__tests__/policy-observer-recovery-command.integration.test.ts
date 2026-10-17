import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { historySuccessorProposalId } from '@resonance/core/history-successor';
import { readPolicyObserverConfigurationFile } from '../policy-observer-config.js';
import { runPolicyObserverCommand } from '../policy-observer-command.js';
import { runPolicyObserverRecoveryCommand } from '../policy-observer-recovery-command.js';
import { policyObserverReplayDigest } from '../policy-observer-history-replay.js';
import { POLICY_OBSERVER_RESTORATION_FILENAME } from '../policy-observer-history-restore.js';
import { policyObserverRecoveryFixture } from './fixtures/policy-observer-recovery-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const n = await policyObserverRecoveryFixture(close => cleanup.push(close)); await n.observer.advance(n.advance); n.observer.close();
  const signingKeyFile = join(n.directory, 'owner-key.json'), storageKeyFile = join(n.directory, 'storage.key');
  writeFileSync(signingKeyFile, JSON.stringify({ publicKey: Buffer.from(n.owner.publicKey).toString('base64url'), secretKey: Buffer.from(n.owner.secretKey).toString('base64url') }), { mode: 0o600 });
  writeFileSync(storageKeyFile, n.key.toString('hex'), { mode: 0o600 });
  const configuration = { version: 1, kind: 'policy-observer-configuration', context: n.context, historyContext: n.enrolled.context,
    genesis: n.enrolled.root, root: n.enrolled.root, members: n.recoveryMembers, directory: n.options.directory, signingKeyFile, storageKeyFile,
    limits: { archiveBytes: 64 * 1024 * 1024, archiveBlocks: 10001 }, listen: { port: 0, maxConnections: 4, connectionTimeoutMs: 10000 } };
  const configPath = join(n.directory, 'observer-config.json'); writeFileSync(configPath, JSON.stringify(configuration));
  const prefix = [configPath, n.recoveryOptions.directory], destination = join(n.directory, 'restored'), output = join(n.directory, 'restored-config.json');
  const call = async (command: string, args = prefix) => (await runPolicyObserverRecoveryCommand(command, args)).result;
  return { ...n, configuration, configPath, prefix, destination, output, call };
}
async function complete(n: Awaited<ReturnType<typeof fixture>>) {
  const planned = await n.call('recovery-plan', [...n.prefix, 'available', '1']);
  if (!('approvalDigest' in planned)) throw new Error('Missing recovery review');
  await n.call('recovery-start', ['--approve', planned.approvalDigest, ...n.prefix, 'available', '1']);
  let status = await n.call('recovery-status');
  for (let count = 0; count < 12 && !('complete' in status && status.complete); count++) status = await n.call('recovery-step');
  expect(status).toMatchObject({ complete: true });
  const reviewed = await n.call('recovery-review', [...n.prefix, n.destination]);
  if (!('approvalDigest' in reviewed)) throw new Error('Missing restore review');
  await n.call('recovery-restore', ['--approve', reviewed.approvalDigest, ...n.prefix, n.destination]);
}

it('runs reviewed source fencing, every recovery phase, restoration, export and fresh readiness through actual Node CLI processes', async () => {
  const n = await fixture(), main = fileURLToPath(new URL('../policy-observer-main.ts', import.meta.url)), loader = import.meta.resolve('tsx');
  const run = async (command: string, args = n.prefix) => JSON.parse((await promisify(execFile)(process.execPath,
    ['--import', loader, main, command, ...args], { cwd: n.directory, timeout: 15000 })).stdout);
  const planned = await run('recovery-plan', [...n.prefix, 'available', '1']);
  await expect(run('recovery-start', ['--approve', 'wrong', ...n.prefix, 'available', '1'])).rejects.toThrow('reviewed');
  expect(existsSync(n.recoveryOptions.directory)).toBe(false);
  await run('recovery-start', ['--approve', planned.approvalDigest, ...n.prefix, 'available', '1']);
  expect((await run('status', [n.configPath])).status.fenced).toBe(true);
  let status = await run('recovery-status');
  for (let step = 0; step < 12 && !status.complete; step++) status = await run('recovery-step');
  expect(status.complete).toBe(true);
  const reviewed = await run('recovery-review', [...n.prefix, n.destination]);
  await expect(run('recovery-restore', ['--approve', 'wrong', ...n.prefix, n.destination])).rejects.toThrow('reviewed');
  expect(existsSync(n.destination)).toBe(false);
  expect(await run('recovery-restore', ['--approve', reviewed.approvalDigest, ...n.prefix, n.destination])).toMatchObject({ readiness: 'unverified', startsService: false });
  expect(await run('recovery-export', [...n.prefix, n.destination, n.output])).toMatchObject({ readiness: 'unverified', startsService: false });
  const exported = readPolicyObserverConfigurationFile(n.output); expect(exported.root.kind).toBe('continuation'); expect(exported.directory).toBe(n.destination);
  expect((await run('ready', [n.output])).readiness).toBe('confirmed');
  const later = join(n.directory, 'later.json'); writeFileSync(later, JSON.stringify(n.later));
  expect((await run('advance', [n.output, later])).status.head).toEqual(n.later.commitment.next);
  // An occupied restored directory can be re-exported without repeating restore,
  // while its immutable selected baseline is independently checked again.
  const secondOutput = join(n.directory, 'another-export.json'); await run('recovery-export', [...n.prefix, n.destination, secondOutput]);
  const before = readFileSync(secondOutput); await expect(run('recovery-export', [...n.prefix, n.destination, secondOutput])).rejects.toThrow('EEXIST');
  expect(readFileSync(secondOutput)).toEqual(before);
}, 60000);

it('rejects a re-encrypted but wrong restoration baseline before exporting any runtime configuration', async () => {
  const n = await fixture(); await complete(n);
  const path = join(n.destination, POLICY_OBSERVER_RESTORATION_FILENAME);
  const storage = openEncryptedLocalState<Record<string, unknown>>({ path, key: n.key, domain: 'resonance:policy-observer-restoration:v1',
    maxBytes: 4 * 1024 * 1024, mode: 'open-existing', initial: {}, validate: (value): value is Record<string, unknown> => !!value && typeof value === 'object' });
  const retained = storage.read(), state = { ...(retained.state as object), previous: n.second, policy: n.third, advance: n.later.commitment };
  // Read the confirmed continuation via an export before introducing corruption.
  storage.close(); await n.call('recovery-export', [...n.prefix, n.destination, n.output]);
  const config = readPolicyObserverConfigurationFile(n.output); if (config.root.kind !== 'continuation') throw new Error('Missing certified generation');
  const changed = openEncryptedLocalState<Record<string, unknown>>({ path, key: n.key, domain: 'resonance:policy-observer-restoration:v1',
    maxBytes: 4 * 1024 * 1024, mode: 'open-existing', initial: {}, validate: (value): value is Record<string, unknown> => !!value && typeof value === 'object' });
  changed.write({ ...retained, state, replayDigest: policyObserverReplayDigest(retained.contextId as string, retained.genesisId as string,
    historySuccessorProposalId(config.root.proposal), state as Parameters<typeof policyObserverReplayDigest>[3]) }); changed.close();
  const destination = join(n.directory, 'bad-export.json');
  await expect(n.call('recovery-export', [...n.prefix, n.destination, destination])).rejects.toThrow('baseline differs');
  expect(existsSync(destination)).toBe(false);
}, 30000);

it('requires explicit source availability and preserves missing local state instead of silently declaring loss', async () => {
  const n = await fixture();
  await expect(n.call('recovery-plan', [...n.prefix, 'guess', '1'])).rejects.toThrow('explicit');
  await expect(n.call('recovery-plan', [...n.prefix, 'unavailable', '0'])).rejects.toThrow('positive');
  await expect(runPolicyObserverRecoveryCommand('recovery-status', n.prefix, AbortSignal.abort())).rejects.toThrow('cancelled');
  writeFileSync(n.configPath, JSON.stringify({ ...n.configuration, directory: join(n.directory, 'lost-owner') }));
  await expect(n.call('recovery-plan', [...n.prefix, 'available', '1'])).rejects.toThrow('missing');
  const review = await n.call('recovery-plan', [...n.prefix, 'unavailable', '1']); expect(review).toMatchObject({ localStateDigest: null });
  expect(existsSync(n.recoveryOptions.directory)).toBe(false);
});

it('reviews local setup offline, requires unchanged-root quorum before recreating files, then separately confirms signing readiness', async () => {
  const n = await fixture(); await complete(n);
  const writerPath = join(n.destination, 'history-writer.json'), payloads = join(n.destination, 'payloads');
  // The command created local restoration files but never sent ready(). This
  // reproduces the independently SIGKILL-tested after-baseline boundary.
  const writer = openEncryptedLocalState<Record<string, unknown>>({ path: writerPath, key: n.key, domain: 'resonance:history-checkpoint-writer:v1',
    maxBytes: 40 * 1024 * 1024, mode: 'open-existing', initial: {}, validate: (value): value is Record<string, unknown> => !!value && typeof value === 'object' });
  expect(writer.read()).toMatchObject({ committed: null, pending: null }); writer.close();
  rmSync(writerPath); rmSync(payloads, { recursive: true });
  writeFileSync(n.configPath, JSON.stringify({ ...n.configuration, limits: { ...n.configuration.limits, archiveBytes: 1 } }));
  await expect(n.call('recovery-resume-plan', [...n.prefix, n.destination])).rejects.toThrow('cannot retain its certified root');
  expect(existsSync(writerPath)).toBe(false); writeFileSync(n.configPath, JSON.stringify(n.configuration));
  // A cancelled fifth response from an earlier quorum may still reach its
  // server. Compare fresh challenges, not late copies of the old fanout.
  const before = n.receivedChallenges(), planned = await n.call('recovery-resume-plan', [...n.prefix, n.destination]);
  expect(planned).toMatchObject({ initializeWriter: true, initializeArchive: true, requiresUnchangedRootQuorum: true, readiness: 'unverified' });
  expect(n.receivedChallenges()).toEqual(before);
  if (!('approvalDigest' in planned)) throw new Error('Missing resumption review');
  await expect(n.call('recovery-resume', ['--approve', 'wrong', ...n.prefix, n.destination])).rejects.toThrow('reviewed');
  expect(existsSync(writerPath)).toBe(false); expect(n.receivedChallenges()).toEqual(before);
  expect(await n.call('recovery-resume', ['--approve', planned.approvalDigest, ...n.prefix, n.destination])).toMatchObject({ readiness: 'unverified', startsService: false });
  const after = n.receivedChallenges(); expect(after.length).toBeGreaterThan(before.length);
  await n.call('recovery-export', [...n.prefix, n.destination, n.output]); expect(n.receivedChallenges()).toEqual(after);
  await runPolicyObserverCommand('ready', [n.output]); expect(n.receivedChallenges().length).toBeGreaterThan(after.length);
}, 30000);

it('does not interpret simultaneous writer/archive loss as an empty history when replicas have accepted a later update', async () => {
  const n = await fixture(); await complete(n); await n.call('recovery-export', [...n.prefix, n.destination, n.output]);
  await runPolicyObserverCommand('ready', [n.output]);
  const later = join(n.directory, 'advance.json'); writeFileSync(later, JSON.stringify(n.later)); await runPolicyObserverCommand('advance', [n.output, later]);
  const writer = join(n.destination, 'history-writer.json'), archive = join(n.destination, 'payloads'); rmSync(writer); rmSync(archive, { recursive: true });
  const review = await n.call('recovery-resume-plan', [...n.prefix, n.destination]);
  if (!('approvalDigest' in review)) throw new Error('Missing resumption review');
  await expect(n.call('recovery-resume', ['--approve', review.approvalDigest, ...n.prefix, n.destination])).rejects.toThrow('Four current');
  expect(existsSync(writer)).toBe(false); expect(existsSync(archive)).toBe(false);
}, 30000);

it.each(['writer', 'archive'])('refuses missing used %s evidence before offering pristine resumption', async missing => {
  const n = await fixture(); await complete(n); await n.call('recovery-export', [...n.prefix, n.destination, n.output]);
  await runPolicyObserverCommand('ready', [n.output]);
  const path = missing === 'writer' ? join(n.destination, 'history-writer.json') : join(n.destination, 'payloads', 'history-writer-payloads.json');
  rmSync(path); const before = n.receivedChallenges();
  await expect(n.call('recovery-resume-plan', [...n.prefix, n.destination])).rejects.toThrow(missing === 'writer' ? 'retained archive evidence' : 'Committed policy archive');
  expect(n.receivedChallenges()).toEqual(before); expect(existsSync(path)).toBe(false);
}, 30000);
