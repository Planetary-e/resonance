import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createPublicationRecord, generatePublicationKeyMaterial, createPublicationOperationFrame, serializePublicationOperationFrame, parseMessage } from '@resonance/core';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { inspectLocalStateOwnership } from '@resonance/core/local-state';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { openStorageReservationAuthority, assertNoStorageReservationContext } from '@resonance/core/storage-reservations';
import { beginRelayMaintenance, finishRelayMaintenance, withRelayStorageControls, readRelayMaintenance, readRelayStorageSnapshot, writeOperatorJsonAtomic } from '@resonance/relay';
import { openDesktopStorageBootstrapReview } from '../relay-storage-bootstrap.js';
import { openDesktopStorageAdoptionReview } from '../relay-storage-adoption.js';
import { openDesktopStorageActivationReview } from '../relay-storage-activation.js';
import { relayServiceOutputPaths, relayServiceEnvironment, relayServiceStats, type RelayServiceOptions } from '../relay-supervisor.js';
import type { RelayConfig } from '../session.js';
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFileSync: vi.fn() }));
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.mocked(renameSync).mockImplementation(actual.renameSync); for (const close of cleanup.splice(0).reverse()) await close(); vi.clearAllMocks(); });
async function fixture(limitBytes = 256 * 1024 * 1024) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-storage-activation-'))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'app'), home = join(root, 'home'); mkdirSync(directory); mkdirSync(home); vi.mocked(homedir).mockReturnValue(home);
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const runtime = join(directory, 'relay-data'), config: RelayConfig = { enabled: false, port, contacts: ['wss://contact.example/'], storageCommitmentFloorBytes: 1234 };
  const configFile = join(directory, 'relay-config.json'); writeFileSync(configFile, JSON.stringify(config)); beginRelayMaintenance(runtime);
  const entry = join(root, 'relay.mjs'); writeFileSync(entry, '// test runtime');
  const service: RelayServiceOptions = { port, dataDir: directory, contacts: config.contacts!, controls: { publicationStorageMiB: 32 }, adminKey: 'private-test-key',
    nodePath: process.execPath, entryPath: entry, workingDirectory: root };
  const bootstrap = await openDesktopStorageBootstrapReview({ dataDirectory: directory, runtimePort: port, mode: 'new', limitBytes });
  const ready = bootstrap.apply(bootstrap.review().approvalDigest), adoption = await openDesktopStorageAdoptionReview({ dataDirectory: directory, config }); adoption.apply(adoption.review().approvalDigest);
  const saved: RelayConfig[] = [], saveConfig = (next: RelayConfig) => { writeOperatorJsonAtomic(configFile, next, 65536); saved.push(next); };
  const options = { dataDirectory: directory, config, service, saveConfig };
  const native = (_program: unknown, args: unknown) => {
    assertNoStorageReservationContext();
    // A competing lock attempt creates a recovery guard and changes parent
    // metadata, correctly invalidating the pending output approval. Inspect the
    // live claims here without producing that separate race.
    for (const path of [join(directory, 'relay-desktop-control.lock'), join(runtime, 'relay-runtime.lock')]) {
      const claim = inspectLocalStateOwnership(path);
      expect(claim.files).toEqual([]); expect(claim.directories).toHaveLength(2);
      expect(basename(claim.directories[1])).toMatch(new RegExp(`^owner-${process.pid}-[a-f0-9]{32}$`));
    }
    expect(readRelayMaintenance(runtime)).not.toBeNull();
    return Array.isArray(args) && args.includes('-Command') ? '{"state":"absent"}' : '';
  };
  vi.mocked(execFileSync).mockImplementation(native as typeof execFileSync);
  const open = async (overrides: Partial<typeof options> & { signal?: AbortSignal; approvalTimeoutMs?: number } = {}) => {
    const handle = await openDesktopStorageActivationReview({ ...options, ...overrides }); cleanup.push(handle.close); return handle;
  };
  return { directory, home, runtime, config, configFile, service, ready, saved, open, native, selection: join(directory, 'relay-storage-selection.json'),
    nativeFiles: relayServiceOutputPaths(directory), primary: join(ready.authorityDirectory, 'reservations.json') };
}
it('reviews and commits the complete paused handoff without exposing the admin key or starting supervision', async () => {
  const n = await fixture(), before = readFileSync(n.primary), handle = await n.open(), review = handle.review();
  expect(review).toMatchObject({ fits: true, startsService: false, reusesPublishedOutput: false });
  expect(JSON.stringify(review)).not.toContain('private-test-key'); expect(execFileSync).not.toHaveBeenCalled();
  expect(readFileSync(n.primary)).toEqual(before); expect(existsSync(n.selection)).toBe(false);
  expect(handle.apply(review.approvalDigest)).toMatchObject({ result: 'desktop-storage-activated', running: false, maintenanceActive: true });
  expect(n.saved[0]).toMatchObject({ enabled: false, contacts: n.config.contacts, storageCommitmentFloorBytes: 1234,
    runtime: { storageSelectionFile: n.selection, entryPath: n.service.entryPath } });
  expect(readRelayStorageSnapshot(n.selection).configuration.authorityId).toBe(n.ready.authorityId);
  expect(n.nativeFiles.every(existsSync)).toBe(true); expect(readRelayMaintenance(n.runtime)).not.toBeNull();
  expect(vi.mocked(execFileSync).mock.calls.some(([, args]) => args?.some(arg => ['bootstrap', 'kickstart', 'enable', '/Run'].includes(arg)))).toBe(false);
  expect(() => handle.apply(review.approvalDigest)).toThrow(/closed/);
});
it('checks the combined peak before stopping native supervision or publishing selection', async () => {
  const n = await fixture(), raw = openStorageReservationAuthority({ directory: n.ready.authorityDirectory, authorityId: n.ready.authorityId, mode: 'open-existing' });
  const limit = raw.reviewLimit(raw.status().reservedBytes + 128 * 1024); raw.applyLimit(limit.limitBytes, limit.approvalDigest); raw.close();
  const before = readFileSync(n.primary), h = await n.open(); expect(h.review().fits).toBe(false);
  expect(() => h.apply(h.review().approvalDigest)).toThrow(/available budget/);
  expect(existsSync(n.selection)).toBe(false); expect(n.nativeFiles.some(existsSync)).toBe(false); expect(execFileSync).not.toHaveBeenCalled(); expect(readFileSync(n.primary)).toEqual(before);
});
it('refuses an uncertain native stop and retries under a fresh review', async () => {
  const n = await fixture(), h = await n.open(), original = readFileSync(n.configFile);
  vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('private native stderr'); });
  expect(() => h.apply(h.review().approvalDigest)).toThrow(/could not be confirmed stopped/);
  expect(existsSync(n.selection)).toBe(false); expect(readFileSync(n.configFile)).toEqual(original);
  const retry = await n.open(); expect(retry.apply(retry.review().approvalDigest).running).toBe(false);
});
it.each(['native-definition', 'settings-before', 'settings-after'] as const)('retains partial publication at %s and recovers from fresh settings', async boundary => {
  const n = await fixture(), before = readFileSync(n.configFile), h = await n.open(); let failed = false;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    const target = String(to), fail = !failed && (boundary === 'native-definition' ? n.nativeFiles.includes(target) : target === n.configFile);
    if (fail) { failed = true; if (boundary === 'settings-after') actual.renameSync(from, to); throw new Error('interrupted activation publication'); }
    actual.renameSync(from, to);
  });
  expect(() => h.apply(h.review().approvalDigest)).toThrow(/interrupted/); vi.mocked(renameSync).mockImplementation(actual.renameSync);
  expect(failed).toBe(true); const retained = readFileSync(n.selection); expect(readRelayMaintenance(n.runtime)).not.toBeNull();
  const current = JSON.parse(readFileSync(n.configFile, 'utf8')) as RelayConfig;
  if (boundary === 'settings-after') {
    expect(current.runtime?.storageSelectionFile).toBe(n.selection); expect(current.enabled).toBe(false);
    await expect(n.open({ config: current })).rejects.toThrow(/unconfigured/);
  } else {
    expect(readFileSync(n.configFile)).toEqual(before); const retry = await n.open(); expect(retry.review().reusesPublishedOutput).toBe(true);
    expect(retry.apply(retry.review().approvalDigest).selectionFile).toBe(n.selection);
  }
  expect(readFileSync(n.selection)).toEqual(retained);
});
it.each(['wrong-approval', 'cancelled', 'changed-pins', 'missing-entry'] as const)('rejects %s without native changes', async failure => {
  const n = await fixture(), controller = new AbortController(), h = await n.open({ signal: controller.signal }), review = h.review();
  if (failure === 'cancelled') controller.abort();
  if (failure === 'changed-pins') { const path = join(n.directory, 'relay-storage-bootstrap', 'intent.json'); writeFileSync(path, readFileSync(path)); }
  if (failure === 'missing-entry') rmSync(n.service.entryPath);
  expect(() => h.apply(failure === 'wrong-approval' ? '0'.repeat(64) : review.approvalDigest)).toThrow();
  expect(execFileSync).not.toHaveBeenCalled(); expect(existsSync(n.selection)).toBe(false);
});
it('expires an abandoned approval and rejects competing review ownership', async () => {
  const n = await fixture(), h = await n.open({ approvalTimeoutMs: 100 });
  await expect(n.open()).rejects.toThrow(); await new Promise(resolve => setTimeout(resolve, 150));
  expect(() => h.review()).toThrow(/closed|expired/); const retry = await n.open(); retry.close();
  expect(execFileSync).not.toHaveBeenCalled(); expect(readRelayMaintenance(n.runtime)).not.toBeNull();
});
it('refuses an occupied configured listener even when the stored relay runtime claim is free', async () => {
  const n = await fixture(), listener = createServer(); listener.listen(n.config.port, '127.0.0.1'); await once(listener, 'listening');
  try { await expect(n.open()).rejects.toThrow(/listener is not closed/); }
  finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
  const retry = await n.open(); retry.close(); expect(execFileSync).not.toHaveBeenCalled();
});
it.skipIf(process.platform === 'win32').each(['native', 'settings'] as const)('recovers the %s handoff boundary after SIGKILL', async boundary => {
  const n = await fixture(), child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/storage-activation-crash.ts', import.meta.url)),
    JSON.stringify({ dataDirectory: n.directory, config: n.config, service: n.service }), n.home, boundary], { stdio: ['ignore', 'ignore', 'pipe'] });
  let error = ''; child.stderr!.on('data', chunk => { error += String(chunk); }); const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try { expect(await once(child, 'exit'), error).toEqual([null, 'SIGKILL']); } finally { clearTimeout(timer); }
  expect(error).toBe(''); const retained = readFileSync(n.selection), config = JSON.parse(readFileSync(n.configFile, 'utf8')) as RelayConfig;
  expect(readRelayMaintenance(n.runtime)).not.toBeNull();
  if (boundary === 'settings') {
    expect(config).toMatchObject({ enabled: false, runtime: { storageSelectionFile: n.selection } });
    const owner = openStorageReservationAuthority({ directory: n.ready.authorityDirectory, authorityId: n.ready.authorityId, mode: 'open-existing' }); owner.close();
  } else {
    expect(config.runtime?.storageSelectionFile).toBeUndefined(); const retry = await n.open({ config });
    expect(retry.review().reusesPublishedOutput).toBe(true); retry.apply(retry.review().approvalDigest);
  }
  expect(readFileSync(n.selection)).toEqual(retained);
}, 15000);
it('boots the real Node relay from the activated settings, accepts a publication and retains it across restart', async () => {
  const n = await fixture(4096 * 1048576); n.service.contacts = [];
  n.service.entryPath = fileURLToPath(new URL('../../../../relay/src/main.ts', import.meta.url));
  n.service.tsxImportPath = fileURLToPath(import.meta.resolve('tsx'));
  const h = await n.open(); h.apply(h.review().approvalDigest);
  const selected = readRelayStorageSnapshot(n.selection).configuration;
  withRelayStorageControls(selected, selected.controls, () => finishRelayMaintenance(n.runtime));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RELAY_') && !key.startsWith('RESONANCE_RELAY_')));
  async function start() {
    const child = spawn(process.execPath, ['--import', n.service.tsxImportPath!, n.service.entryPath], {
      cwd: n.service.workingDirectory, env: { ...inherited, ...relayServiceEnvironment({ ...n.service, storageSelectionFile: n.selection }) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit'); let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000); void exited.then(() => clearTimeout(timer));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    const deadline = performance.now() + 12000;
    while (!await relayServiceStats(n.config.port, n.service.adminKey)) {
      if (child.exitCode !== null || child.signalCode !== null || performance.now() > deadline) throw new Error(`Selected relay did not start: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return { child, exited };
  }
  const now = Date.now(), record = createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'desktop-activation', fingerprint: new Uint8Array(64).fill(5),
    itemType: 'offer', createdAt: now, expiresAt: now + 3600000 }, generatePublicationKeyMaterial());
  async function publish() {
    const socket = new WebSocket(`ws://127.0.0.1:${n.config.port}`), timer = setTimeout(() => socket.terminate(), 5000);
    try {
      await once(socket, 'open'); const response = once(socket, 'message'); socket.send(serializePublicationOperationFrame(createPublicationOperationFrame(record)));
      expect(parseMessage((await response)[0].toString()).payload).toMatchObject({ status: 'ok' });
    } finally { clearTimeout(timer); socket.terminate(); }
  }
  const first = await start(); await publish(); const identity = readFileSync(join(n.runtime, 'relay-identity.json'));
  first.child.kill('SIGTERM'); expect((await first.exited)[0]).toBe(0);
  const ledger = readFileSync(n.primary), second = await start(); await publish(); second.child.kill('SIGTERM'); expect((await second.exited)[0]).toBe(0);
  expect(readFileSync(join(n.runtime, 'relay-identity.json'))).toEqual(identity); expect(readFileSync(n.primary)).toEqual(ledger);
}, 35000);
