import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { installRelayService, relayServiceOutputFiles, windowsServiceTask, RELAY_SERVICE_FILE_MAX_BYTES as MAXIMUM, type RelayServiceOptions } from '../relay-supervisor.js';
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFileSync: vi.fn(() => Buffer.alloc(0)) }));
vi.mock('node:os', async original => { const os = await original<typeof import('node:os')>(); return { ...os, homedir: vi.fn(() => { throw new Error('Native output test needs an explicit temporary home'); }) }; });
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown> = [];
afterEach(() => { vi.mocked(renameSync).mockImplementation(actual.renameSync); for (const close of cleanup.splice(0).reverse()) close(); vi.mocked(execFileSync).mockClear(); });
const PEAK = 9 * MAXIMUM + 8192;
function fixture(extra: number) {
  const directory = mkdtempSync(join(tmpdir(), 'service-output-probe-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
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
    for (let i = 0; i < 4; i++) withStorageReservationAuthority(n.authority, () => installRelayService(n.options));
  });
  const files = relayServiceOutputFiles(n.options, host, n.directory);
  for (const file of files) expect(readFileSync(file.path, 'utf8')).toBe(file.text);
  expect(n.authority.status()).toMatchObject({ availableBytes: 0, components: files.length });
  expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(12);
});
it('reserves the complete Windows output set before creating either file or stopping the existing task', () => {
  const n = fixture(PEAK);
  expect(() => platform('win32', () => withStorageReservationAuthority(n.authority, () => installRelayService(n.options)))).toThrow(/exhausted/);
  expect(existsSync(n.options.dataDir)).toBe(false); expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  expect(n.authority.status()).toMatchObject({ components: 1, availableBytes: 0 });
});
it('refuses oversized definitions before reserving storage or changing a running service', () => {
  const n = fixture(3 * PEAK), before = readdirSync(n.directory).sort();
  for (const host of ['darwin', 'linux', 'win32'] as const) expect(() => platform(host, () => withStorageReservationAuthority(n.authority, () => installRelayService({ ...n.options, adminKey: 'x'.repeat(MAXIMUM) })))).toThrow(/byte limit/);
  expect(readdirSync(n.directory).sort()).toEqual(before); expect(n.authority.status().components).toBe(0); expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
});
it('keeps the previous definition and does not stop the service after a failed replacement', () => {
  const n = fixture(PEAK);
  platform('darwin', () => withStorageReservationAuthority(n.authority, () => installRelayService(n.options)));
  vi.mocked(execFileSync).mockClear();
  const path = relayServiceOutputFiles(n.options, 'darwin', n.directory)[0].path, previous = readFileSync(path);
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === path) throw new Error('definition replacement failed'); actual.renameSync(from, to); });
  expect(() => platform('darwin', () => withStorageReservationAuthority(n.authority, () => installRelayService({ ...n.options, port: 9191 })))).toThrow(/replacement failed/);
  expect(readFileSync(path)).toEqual(previous); expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
});
