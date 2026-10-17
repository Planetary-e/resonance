import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createPublicationRecord, generatePublicationKeyMaterial, createPublicationOperationFrame, serializePublicationOperationFrame, parseMessage } from '@resonance/core';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL } from '@resonance/core/storage-reservations';
import { openRelayStorageOwner, withRelayStorageControls, writeOperatorJsonAtomic, writeOperatorJsonNew } from '@resonance/relay';
import { beginRelayMaintenance, finishRelayMaintenance } from '../../../../relay/src/relay-maintenance.js';
import { RELAY_OPERATION_LOG_FILENAME } from '../../../../relay/src/operation-log.js';
import { runAdmissionHistoryCommand } from '../../../../relay/src/admission-history-command.js';
import { beginRelayHistoryMaintenance, finishRelayHistoryMaintenance, getRelayMaintenanceStatus, runRelayHistoryOperation, startRelayMode, stopRelayMode, loadRelayConfig } from '../session.js';
import { desktopRelayStorageControls } from '../relay-storage.js';
import { relayServiceEnvironment, relayServiceRuntime, relayServiceOutputFiles, prepareRelayServiceInstallation, type RelayServiceOptions } from '../relay-supervisor.js';

// Native commands are always mocked. The started relay is a real Node child,
// using only this test's files, loopback listener and independently held budget.
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFileSync: vi.fn() }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: vi.fn() }));
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture() {
  vi.mocked(renameSync).mockReset().mockImplementation(actual.renameSync);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'selected-desktop-'))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'app'), home = join(root, 'home'), ledger = join(root, 'authority'); mkdirSync(directory); mkdirSync(home);
  vi.mocked(homedir).mockReturnValue(home);
  const holder = createServer(); holder.listen(0, '127.0.0.1'); await once(holder, 'listening');
  const port = (holder.address() as { port: number }).port; await new Promise<void>(resolve => holder.close(() => resolve()));
  for (const key of Object.keys(process.env)) if (key.startsWith('RESONANCE_RELAY_')) vi.stubEnv(key, undefined);
  vi.stubEnv('RESONANCE_DATA_DIR', directory); vi.stubEnv('RESONANCE_RELAY_ENTRY', fileURLToPath(new URL('../../../../relay/src/main.ts', import.meta.url)));
  const configPath = join(directory, 'relay-config.json'); writeFileSync(configPath, JSON.stringify({ enabled: false, port, adminKey: 'test-admin' }));
  writeFileSync(join(directory, 'unknown-retained'), 'retain old work');
  const authority = openStorageReservationAuthority({ directory: ledger, mode: 'create-new', limitBytes: CONTROL + 64 * 1024 * 1024 }); cleanup.push(authority.close);
  const scope = [{ path: directory, scope: 'directory' as const }]; authority.adoptExisting(scope, authority.reviewExisting(scope).approvalDigest);
  const options: RelayServiceOptions = { ...relayServiceRuntime(), port, dataDir: directory, adminKey: 'test-admin', contacts: [], controls: { publicationStorageMiB: 1 } };
  const nativeFiles = relayServiceOutputFiles(options, process.platform, home);
  for (const file of nativeFiles) mkdirSync(dirname(file.path), { recursive: true });
  const newScopes = nativeFiles.filter(file => !file.path.startsWith(directory + '/')).map(file => ({ path: file.path, scope: 'file' as const }));
  if (newScopes.length) authority.approveNewScopes(newScopes, authority.reviewNewScopes(newScopes).approvalDigest);
  const pins = { authorityDirectory: ledger, authorityId: authority.status().authorityId, runtimeDirectory: join(directory, 'relay-data') }; authority.close();
  const controls = desktopRelayStorageControls(directory), runtime = openRelayStorageOwner(pins, 'runtime', controls);
  runtime.run(() => beginRelayMaintenance(pins.runtimeDirectory)); runtime.close();
  const selected = join(directory, 'storage-selection.json'), binding = { runtimePort: port, runtimeHost: '127.0.0.1' as const };
  const owner = openRelayStorageOwner(pins, 'maintenance', controls); owner.exportSelection(selected, binding, owner.reviewSelectionOutput(selected, binding).approvalDigest); owner.close();
  withRelayStorageControls(pins, controls, () => {
    writeOperatorJsonAtomic(configPath, { enabled: false, port, adminKey: 'test-admin', controls: options.controls, runtime: { ...relayServiceRuntime(), storageSelectionFile: selected } }, 65536);
    finishRelayMaintenance(pins.runtimeDirectory);
  });
  let child: ChildProcess | undefined, starts = 0, output = ''; const children: Array<{ child: ChildProcess; exited: Promise<unknown> }> = [];
  vi.mocked(execFileSync).mockReset().mockImplementation(((_program: string, args: readonly string[]) => {
    const start = args[0] === 'kickstart' || args.includes('restart') || args[0] === '/Run';
    if (start) {
      const saved = loadRelayConfig(), configured = { ...options, ...saved.runtime!, controls: saved.controls, contacts: saved.contacts ?? [] };
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RELAY_')));
      child = spawn(process.execPath, ['--import', 'tsx', options.entryPath], { env: { ...inherited, ...relayServiceEnvironment(configured) }, stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = once(child, 'exit'); children.push({ child, exited }); starts++;
      child.stdout!.on('data', bytes => { output += String(bytes); }); child.stderr!.on('data', bytes => { output += String(bytes); });
    } else if (args[0] === 'bootout' || args.includes('disable') || args[0] === '/End') child?.kill('SIGTERM');
    return Buffer.alloc(0);
  }) as typeof execFileSync);
  cleanup.push(async () => { for (const running of children) { if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGKILL'); await running.exited; } });
  const open = () => openStorageReservationAuthority({ directory: ledger, authorityId: pins.authorityId, mode: 'open-existing', requireAdoptedScopes: true });
  const cap = () => { const current = open(), review = current.reviewLimit(current.status().reservedBytes); current.applyLimit(review.limitBytes, review.approvalDigest); current.close(); };
  return { root, directory, ledger, pins, selected, configPath, port, open, cap, nativeFiles, options, controls, starts: () => starts, output: () => output };
}
async function publish(port: number) {
  const now = Date.now(), record = createPublicationRecord({ groupId: 'public', fingerprintEpoch: 'selected-desktop', fingerprint: new Uint8Array(64).fill(5), itemType: 'offer', createdAt: now, expiresAt: now + 3600000 }, generatePublicationKeyMaterial());
  const socket = new WebSocket(`ws://127.0.0.1:${port}`), timer = setTimeout(() => socket.terminate(), 5000);
  try { await once(socket, 'open'); const response = once(socket, 'message'); socket.send(serializePublicationOperationFrame(createPublicationOperationFrame(record)));
    expect(parseMessage((await response)[0].toString()).payload).toMatchObject({ status: 'ok' }); return record;
  } finally { clearTimeout(timer); socket.terminate(); }
}
it('hands off to a real child, pauses at full capacity, keeps stopped work scoped and restarts retained publications', async () => {
  const n = await fixture(); await startRelayMode(); const first = await publish(n.port);
  expect(n.starts()).toBe(1); expect(n.open).toThrow(/already open/);
  const identity = readFileSync(join(n.pins.runtimeDirectory, 'relay-identity.json'));
  await stopRelayMode(); n.cap(); const primary = readFileSync(join(n.ledger, 'reservations.json'));
  await startRelayMode(); await publish(n.port); expect(n.starts()).toBe(2);
  await beginRelayHistoryMaintenance(); expect(getRelayMaintenanceStatus().active).toBe(true);
  await stopRelayMode(); expect(getRelayMaintenanceStatus().active).toBe(true);
  const result = await runRelayHistoryOperation(async signal => {
    expect(n.open).toThrow(/before entering a managed operation/);
    expect(() => writeOperatorJsonNew(join(n.directory, 'unfunded.json'), {}, 1024)).toThrow(/exhausted/);
    expect(() => writeOperatorJsonNew(join(n.root, 'outside.json'), {}, 1024)).toThrow(/no reviewed/);
    return runAdmissionHistoryCommand('storage-inventory', [n.pins.runtimeDirectory], { signal });
  });
  expect(result.result.kind).toBe('storage-inventory');
  await expect(runRelayHistoryOperation(async () => { throw new Error('operator failed'); })).rejects.toThrow('operator failed');
  const released = n.open(); expect(released.status().availableBytes).toBe(0); released.close();
  await finishRelayHistoryMaintenance(); await startRelayMode(); await stopRelayMode(); expect(n.starts()).toBe(3);
  expect(readFileSync(join(n.pins.runtimeDirectory, 'relay-identity.json'))).toEqual(identity);
  expect(readFileSync(join(n.pins.runtimeDirectory, RELAY_OPERATION_LOG_FILENAME), 'utf8')).toContain(first.publicationId);
  expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(primary);
  expect(readFileSync(join(n.directory, 'unknown-retained'), 'utf8')).toBe('retain old work');
}, 40000);
it('retains its pause and settings when native preparation has no remaining budget', async () => {
  const n = await fixture(), before = readFileSync(n.configPath); n.cap();
  await expect(startRelayMode()).rejects.toThrow(/exhausted/);
  expect(n.starts()).toBe(0); expect(getRelayMaintenanceStatus().active).toBe(true); expect(readFileSync(n.configPath)).toEqual(before);
  await finishRelayHistoryMaintenance(); const released = n.open(); expect(released.status().availableBytes).toBe(0); released.close();
});
it('does not start a prepared service after settings publication fails and leaves the pause funded', async () => {
  const n = await fixture(), before = readFileSync(n.configPath);
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === n.configPath) throw new Error('settings publication failed'); actual.renameSync(from, to); });
  await expect(startRelayMode()).rejects.toThrow('settings publication failed');
  expect(n.starts()).toBe(0); expect(getRelayMaintenanceStatus().active).toBe(true); expect(readFileSync(n.configPath)).toEqual(before);
  vi.mocked(renameSync).mockImplementation(actual.renameSync); await finishRelayHistoryMaintenance();
  const released = n.open(); released.close();
});
it('refuses missing pins, endpoint changes and disabling an existing selection before native commands', async () => {
  const n = await fixture();
  await expect(startRelayMode(n.port === 65535 ? n.port - 1 : n.port + 1)).rejects.toThrow(/separately reviewed/);
  vi.stubEnv('RESONANCE_RELAY_STORAGE_SELECTION_FILE', ''); await expect(stopRelayMode()).rejects.toThrow(/separately reviewed/);
  vi.stubEnv('RESONANCE_RELAY_STORAGE_SELECTION_FILE', undefined); rmSync(n.selected);
  await expect(beginRelayHistoryMaintenance()).rejects.toThrow();
  expect(execFileSync).not.toHaveBeenCalled(); expect(n.starts()).toBe(0); expect(getRelayMaintenanceStatus().active).toBe(false);
  expect(existsSync(join(n.directory, 'relay-desktop-control.lock'))).toBe(false);
});

it('refuses selected service preparation outside its stopped owner before reserving or writing native definitions', async () => {
  const n = await fixture(), options = { ...n.options, storageSelectionFile: n.selected };
  expect(() => prepareRelayServiceInstallation(options)).toThrow(/stopped storage ownership/);
  const runtime = openRelayStorageOwner(n.pins, 'runtime', n.controls);
  try { expect(() => runtime.run(() => prepareRelayServiceInstallation(options))).toThrow(/stopped storage ownership/); }
  finally { runtime.close(); }
  expect(n.nativeFiles.every(file => !existsSync(file.path))).toBe(true); expect(execFileSync).not.toHaveBeenCalled();
});
