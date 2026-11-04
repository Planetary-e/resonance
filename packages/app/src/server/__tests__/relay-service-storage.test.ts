import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, linkSync, symlinkSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { installRelayService, prepareRelayServiceInstallation, relayServiceOutputFiles, windowsServiceTask, RELAY_SERVICE_FILE_MAX_BYTES as MAXIMUM, type RelayServiceOptions } from '../relay-supervisor.js';
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFileSync: vi.fn(() => Buffer.alloc(0)) }));
vi.mock('node:os', async original => { const os = await original<typeof import('node:os')>(); return { ...os, homedir: vi.fn(() => { throw new Error('Native output test needs an explicit temporary home'); }) }; });
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const cleanup: Array<() => unknown> = [];
afterEach(() => { vi.mocked(renameSync).mockImplementation(actual.renameSync); for (const close of cleanup.splice(0).reverse()) close(); vi.mocked(execFileSync).mockReset().mockReturnValue(Buffer.alloc(0)); });
const PEAK = 9 * MAXIMUM + 8192;
function fixture(extra: number) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'service-output-probe-'))); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  vi.mocked(homedir).mockReturnValue(directory);
  const entry = join(directory, 'relay.mjs'); writeFileSync(entry, '// local test fixture');
  const options: RelayServiceOptions = { dataDir: join(directory, 'app-data'), port: 9091, contacts: [], adminKey: 'test-only', nodePath: process.execPath, entryPath: entry, workingDirectory: directory };
  const authority = openStorageReservationAuthority({ directory: join(directory, 'authority'), mode: 'create-new', limitBytes: CONTROL + extra }); cleanup.push(authority.close);
  return { directory, options, authority };
}
function platform<T>(value: NodeJS.Platform, operation: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value });
  try { return operation(); } finally { Object.defineProperty(process, 'platform', original); }
}
it('renders all native definitions without creating files or invoking service commands', () => {
  const n = fixture(0), before = readdirSync(n.directory).sort();
  for (const host of ['darwin', 'linux', 'win32'] as const) {
    const files = relayServiceOutputFiles(n.options, host, n.directory);
    expect(files).toHaveLength(host === 'win32' ? 2 : 1); expect(files.every(file => Buffer.byteLength(file.text) <= MAXIMUM)).toBe(true);
  }
  windowsServiceTask(n.options);
  expect(readdirSync(n.directory).sort()).toEqual(before); expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
});
it.each(['darwin', 'linux', 'win32'] as const)('reserves and atomically replaces %s definitions at full capacity with native commands mocked', host => {
  const n = fixture((host === 'win32' ? 2 : 1) * PEAK);
  expect(vi.isMockFunction(execFileSync)).toBe(true);
  platform(host, () => {
    let prepared: ReturnType<typeof prepareRelayServiceInstallation> | undefined;
    for (let i = 0; i < 4; i++) prepared = withStorageReservationAuthority(n.authority, () => prepareRelayServiceInstallation(n.options));
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    expect(n.authority.status()).toMatchObject({ availableBytes: 0, components: host === 'win32' ? 2 : 1 });
    n.authority.close(); prepared!.start();
  });
  const files = relayServiceOutputFiles(n.options, host, n.directory);
  for (const file of files) expect(readFileSync(file.path, 'utf8')).toBe(file.text);
  expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(3);
});
it('reserves the complete Windows output set before creating either file or stopping the existing task', () => {
  const n = fixture(PEAK);
  expect(() => platform('win32', () => withStorageReservationAuthority(n.authority, () => prepareRelayServiceInstallation(n.options)))).toThrow(/exhausted/);
  expect(existsSync(n.options.dataDir)).toBe(false); expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  expect(n.authority.status()).toMatchObject({ components: 1, availableBytes: 0 });
});
it('refuses oversized definitions before reserving storage or changing a running service', () => {
  const n = fixture(3 * PEAK), before = readdirSync(n.directory).sort();
  for (const host of ['darwin', 'linux', 'win32'] as const) expect(() => platform(host, () => withStorageReservationAuthority(n.authority, () => prepareRelayServiceInstallation({ ...n.options, adminKey: 'x'.repeat(MAXIMUM) })))).toThrow(/byte limit/);
  expect(readdirSync(n.directory).sort()).toEqual(before); expect(n.authority.status().components).toBe(0); expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
});
it('keeps the previous definition and does not stop the service after a failed replacement', () => {
  const n = fixture(PEAK);
  platform('darwin', () => withStorageReservationAuthority(n.authority, () => prepareRelayServiceInstallation(n.options)));
  vi.mocked(execFileSync).mockClear();
  const path = relayServiceOutputFiles(n.options, 'darwin', n.directory)[0].path, previous = readFileSync(path);
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === path) throw new Error('definition replacement failed'); actual.renameSync(from, to); });
  expect(() => platform('darwin', () => withStorageReservationAuthority(n.authority, () => prepareRelayServiceInstallation({ ...n.options, port: 9191 })))).toThrow(/replacement failed/);
  expect(readFileSync(path)).toEqual(previous); expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
});

it('refuses the combined install or start inside a managed scope before native actions', () => {
  const n = fixture(PEAK);
  expect(() => withStorageReservationAuthority(n.authority, () => installRelayService(n.options))).toThrow(/Prepare.*separately/);
  expect(n.authority.status().components).toBe(0); expect(existsSync(n.options.dataDir)).toBe(false);
  const prepared = withStorageReservationAuthority(n.authority, () => prepareRelayServiceInstallation(n.options));
  expect(() => withStorageReservationAuthority(n.authority, prepared.start)).toThrow(/Release.*authority/);
  expect(vi.mocked(execFileSync)).not.toHaveBeenCalled(); n.authority.close(); prepared.start();
  expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(3);
});
it('starts the original prepared files after authority release despite mutated caller options', () => {
  const n = fixture(PEAK), prepared = platform('darwin', () => withStorageReservationAuthority(n.authority, () => prepareRelayServiceInstallation(n.options)));
  const expected = relayServiceOutputFiles(n.options, 'darwin', n.directory)[0]; n.authority.close();
  n.options.port = 11111; n.options.dataDir = join(n.directory, 'other'); n.options.contacts.push('wss://other.example/');
  platform('darwin', prepared.start);
  expect(readFileSync(expected.path, 'utf8')).toBe(expected.text); expect(existsSync(n.options.dataDir)).toBe(false);
  expect(vi.mocked(execFileSync).mock.calls[1][1]).toContain(expected.path);
  expect(() => platform('darwin', prepared.start)).toThrow(/already attempted/);
  expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(3);
});
it.each(['modified', 'removed', 'replaced', 'hard-linked', 'symlinked'] as const)('refuses a %s prepared definition before any native action', change => {
  const n = fixture(PEAK), prepared = platform('darwin', () => withStorageReservationAuthority(n.authority, () => prepareRelayServiceInstallation(n.options)));
  const file = relayServiceOutputFiles(n.options, 'darwin', n.directory)[0]; n.authority.close();
  if (change === 'modified') writeFileSync(file.path, 'changed');
  else if (change === 'removed') rmSync(file.path);
  else if (change === 'hard-linked') linkSync(file.path, file.path + '-alias');
  else { renameSync(file.path, file.path + '-retained'); if (change === 'replaced') writeFileSync(file.path, file.text); else symlinkSync(file.path + '-retained', file.path); }
  expect(() => platform('darwin', prepared.start)).toThrow(); expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
});
it('validates both Windows outputs before stopping a currently installed task', () => {
  const n = fixture(2 * PEAK), prepared = platform('win32', () => withStorageReservationAuthority(n.authority, () => prepareRelayServiceInstallation(n.options)));
  const files = relayServiceOutputFiles(n.options, 'win32', n.directory); n.authority.close();
  writeFileSync(files[1].path, 'changed XML');
  expect(() => platform('win32', prepared.start)).toThrow(/changed/); expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  expect(readFileSync(files[0].path, 'utf8')).toBe(files[0].text);
});
it('keeps a failed native start handle spent and requires a new preparation', () => {
  const n = fixture(PEAK), prepared = platform('darwin', () => withStorageReservationAuthority(n.authority, () => prepareRelayServiceInstallation(n.options))); n.authority.close();
  vi.mocked(execFileSync).mockImplementation((_program, args) => { if (args?.[0] === 'bootstrap') throw new Error('native registration failed'); return Buffer.alloc(0); });
  expect(() => platform('darwin', prepared.start)).toThrow(/native registration failed/);
  expect(() => platform('darwin', prepared.start)).toThrow(/already attempted/); expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(2);
});
it('hands the full authority to a real child before the first mocked native command', () => {
  const n = fixture(PEAK + 9216), data = join(n.options.dataDir, 'relay-data');
  n.authority.reserve({ path: join(data, 'relay-runtime.lock'), component: 'local-state-lock', scope: 'file', maximumBytes: 8192 });
  n.authority.reserve({ path: join(data, 'relay-maintenance.json'), component: 'operator-output', scope: 'file', maximumBytes: 1024 });
  const id = n.authority.status().authorityId;
  const prepared = platform('darwin', () => withStorageReservationAuthority(n.authority, () => prepareRelayServiceInstallation(n.options)));
  expect(n.authority.status().availableBytes).toBe(0); const ledger = join(n.directory, 'authority'), before = readFileSync(join(ledger, 'reservations.json'));
  n.authority.close();
  vi.mocked(execFileSync).mockImplementationOnce(() => {
    const result = native.execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/storage-service-start.ts', import.meta.url)), ledger, id, data], { timeout: 10000, encoding: 'utf8' });
    expect(result.trim()).toBe('owned'); return Buffer.alloc(0);
  });
  platform('darwin', prepared.start);
  expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(3); expect(readFileSync(join(ledger, 'reservations.json'))).toEqual(before);
  const reopened = openStorageReservationAuthority({ directory: ledger, mode: 'open-existing', authorityId: id }); cleanup.push(reopened.close);
  expect(reopened.status()).toMatchObject({ availableBytes: 0, components: 3 });
}, 15000);
it('retains the unmanaged install convenience for existing desktop callers', () => {
  const n = fixture(0); installRelayService(n.options);
  expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(3); expect(n.authority.status().components).toBe(0);
});
