import { afterEach, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { historySuccessorProposalId } from '@resonance/core/history-successor';
import { openConfiguredPolicyObserver, readPolicyObserverConfigurationFile, serveConfiguredPolicyObserver } from '../policy-observer-config.js';
import { readArchivedPolicySuccessor } from '../policy-observer-archive.js';
import { HISTORY_DOWNLOAD_FILENAME } from '../history-ancestry-download.js';
import { runPolicyObserverCommand } from '../policy-observer-command.js';
import { runPolicyObserverRecoveryCommand } from '../policy-observer-recovery-command.js';
import { policyObserverReplayDigest } from '../policy-observer-history-replay.js';
import { POLICY_OBSERVER_RESTORATION_FILENAME } from '../policy-observer-history-restore.js';
import { policyObserverRecoveryFixture } from './fixtures/policy-observer-recovery-fixture.js';
import { exchangeHistoryProvision } from '../history-agreement-exchange.js';

vi.mock('../history-agreement-exchange.js', async original => {
  const actual = await original<typeof import('../history-agreement-exchange.js')>();
  return { ...actual, exchangeHistoryProvision: vi.fn(actual.exchangeHistoryProvision) };
});
const actualExchange = await vi.importActual<typeof import('../history-agreement-exchange.js')>('../history-agreement-exchange.js');

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(twoAdvances = false) {
  const n = await policyObserverRecoveryFixture(close => cleanup.push(close)); await n.observer.advance(n.advance);
  if (twoAdvances) await n.observer.advance(n.later);
  n.observer.close();
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

it('recovers through provisioning slower than a personal observation without extending personal challenges', async () => {
  const n = await fixture(); let provisionRequests = 0;
  vi.mocked(exchangeHistoryProvision).mockImplementation(async (member, request, signal) => {
    expect(request.expiresAt - request.issuedAt).toBe(30000); provisionRequests++;
    await delay(3200, undefined, { signal });
    return actualExchange.exchangeHistoryProvision(member, request, signal);
  });
  try {
    await complete(n);
    expect(provisionRequests).toBe(5);
    expect(await n.call('recovery-status')).toMatchObject({ complete: true });
  } finally { vi.mocked(exchangeHistoryProvision).mockImplementation(actualExchange.exchangeHistoryProvision); }
}, 30000);

it('serves an older signed policy after recovery using its complete retained archive without network requests or file changes', async () => {
  const n = await fixture(true); await complete(n); await n.call('recovery-export', [...n.prefix, n.destination, n.output]);
  const config = readPolicyObserverConfigurationFile(n.output), archive = config.archiveDirectory!;
  const orphan = join(archive, `.download-${'1'.repeat(32)}.tmp`); writeFileSync(orphan, 'retained interrupted write');
  const snapshot = () => Object.fromEntries(readdirSync(archive).sort().map(name => [name, readFileSync(join(archive, name)).toString('base64')]));
  const service = await serveConfiguredPolicyObserver(config, { timeoutMs: 10000 }); cleanup.push(service.close);
  const before = snapshot(), received = n.received();
  expect(await service.successor(n.context.genesis)).toEqual(n.advance);
  expect(await service.successor(n.advance.commitment.next)).toEqual(n.later);
  expect(n.received()).toBe(received); expect(snapshot()).toEqual(before);
  // The oldest requested transition can be found before the tail is checked.
  // Corrupting that later block must still prevent any earlier result escaping.
  const manifest = openEncryptedLocalState<{ version: number; blocks: string[] }>({ path: join(archive, HISTORY_DOWNLOAD_FILENAME), key: n.key,
    domain: 'resonance:history-ancestry-download:v1', maxBytes: 2 * 1024 * 1024, mode: 'open-existing', initial: { version: 2, blocks: [] },
    validate: (value): value is { version: number; blocks: string[] } => !!value && typeof value === 'object' && 'blocks' in value });
  expect(manifest.read().version).toBe(2);
  const newest = join(archive, `${manifest.read().blocks[0].slice(7)}.block`); manifest.close();
  const original = readFileSync(newest); writeFileSync(newest, Buffer.from([0xff]));
  await expect(service.successor(n.context.genesis)).rejects.toThrow('encoding'); expect(readFileSync(newest)).toEqual(Buffer.from([0xff]));
  writeFileSync(newest, original);
  const controller = new AbortController(), cancelled = service.successor(n.context.genesis, controller.signal); queueMicrotask(() => controller.abort());
  await expect(cancelled).rejects.toThrow(); expect(await service.successor(n.context.genesis)).toEqual(n.advance);
  const pending = service.successor(n.context.genesis); await service.close(); await expect(pending).rejects.toThrow();
  expect(snapshot()).toEqual(before);
  const legacy = { ...config }; delete legacy.archiveDirectory;
  const older = await serveConfiguredPolicyObserver(legacy, { timeoutMs: 10000 }); cleanup.push(older.close);
  await expect(older.successor(n.context.genesis)).rejects.toThrow('outside this retained generation');
}, 30000);

it('reads a legacy version 1 retained archive without network requests or file changes', async () => {
  const n = await fixture(true); await complete(n); await n.call('recovery-export', [...n.prefix, n.destination, n.output]);
  const config = readPolicyObserverConfigurationFile(n.output), archive = config.archiveDirectory!;
  const manifest = openEncryptedLocalState<Record<string, unknown> & { blocks: string[] }>({ path: join(archive, HISTORY_DOWNLOAD_FILENAME), key: n.key,
    domain: 'resonance:history-ancestry-download:v1', maxBytes: 2 * 1024 * 1024, mode: 'open-existing', initial: { blocks: [] },
    validate: (value): value is Record<string, unknown> & { blocks: string[] } => !!value && typeof value === 'object' && 'blocks' in value });
  manifest.write({ ...manifest.read(), version: 1 }); manifest.close();
  const snapshot = () => Object.fromEntries(readdirSync(archive).sort().map(name => [name, readFileSync(join(archive, name)).toString('base64')]));
  const before = snapshot(), received = n.received();
  expect(await readArchivedPolicySuccessor(config, n.context.genesis)).toEqual(n.advance);
  expect(await readArchivedPolicySuccessor(config, n.advance.commitment.next)).toEqual(n.later);
  expect(n.received()).toBe(received); expect(snapshot()).toEqual(before);
}, 30000);

it('refuses missing, owned, incomplete and mismatched archives without recreating or repairing them', async () => {
  const n = await fixture(true); await complete(n); await n.call('recovery-export', [...n.prefix, n.destination, n.output]);
  const config = readPolicyObserverConfigurationFile(n.output), archive = config.archiveDirectory!, path = join(archive, HISTORY_DOWNLOAD_FILENAME);
  const bytes = readFileSync(path), read = () => readArchivedPolicySuccessor(config, n.context.genesis);
  const open = () => openEncryptedLocalState<Record<string, unknown> & { blocks: string[] }>({ path, key: n.key,
    domain: 'resonance:history-ancestry-download:v1', maxBytes: 2 * 1024 * 1024, mode: 'open-existing', initial: { blocks: [] },
    validate: (value): value is Record<string, unknown> & { blocks: string[] } => !!value && typeof value === 'object' && 'blocks' in value });
  const owned = open(), saved = owned.read();
  try { await expect(read()).rejects.toThrow(); } finally { owned.close(); }
  for (const invalid of [
    ...[0, 3, '2', null].map(version => ({ ...saved, version })),
    { ...saved, extra: true }, { ...saved, compaction: {} },
    { ...saved, blocks: saved.blocks.slice(1) }, { ...saved, blocks: saved.blocks.slice(0, -1) },
    { ...saved, blocks: [...saved.blocks, saved.blocks[0]] }, { ...saved, contextId: 'sha256:' + '0'.repeat(64) },
    { ...saved, proposal: { ...(saved.proposal as object), sequence: 0 } },
  ]) {
    const state = open(); state.write(invalid); state.close(); const damaged = readFileSync(path);
    await expect(read()).rejects.toThrow(); expect(readFileSync(path)).toEqual(damaged); writeFileSync(path, bytes);
  }
  renameSync(path, path + '.retained');
  await expect(read()).rejects.toThrow(); expect(existsSync(path)).toBe(false); renameSync(path + '.retained', path);
  renameSync(archive, archive + '.retained');
  await expect(read()).rejects.toThrow(); expect(existsSync(archive)).toBe(false); renameSync(archive + '.retained', archive);
  await expect(readArchivedPolicySuccessor(config, n.context.genesis, AbortSignal.abort())).rejects.toThrow();
  expect(await read()).toEqual(n.advance); expect(readFileSync(path)).toEqual(bytes);
}, 30000);

it('preserves terminal conflict evidence when reading a historical transition from a restored archive', async () => {
  // This explicit fixture mutation prepares a recovery archive. Windows can
  // spend >3 s flushing its certificate; use a maintenance allowance here.
  // Runtime observation challenges keep their independent three-second bound.
  const n = await fixture(), owner = await openConfiguredPolicyObserver(readPolicyObserverConfigurationFile(n.configPath), { timeoutMs: 10000 });
  try { await expect(owner.advance(n.conflict)).rejects.toThrow('equivocated'); } finally { owner.close(); }
  await complete(n); await n.call('recovery-export', [...n.prefix, n.destination, n.output]);
  const config = readPolicyObserverConfigurationFile(n.output), path = join(config.archiveDirectory!, HISTORY_DOWNLOAD_FILENAME), before = readFileSync(path);
  await expect(readArchivedPolicySuccessor(config, n.context.genesis)).rejects.toThrow('conflict evidence');
  expect(readFileSync(path)).toEqual(before);
}, 30000);

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
  expect(exported.archiveDirectory).toBe(join(n.recoveryOptions.directory, 'download'));
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
}, 15000); // Includes real observer/volunteer setup before the offline refusal assertions.

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
