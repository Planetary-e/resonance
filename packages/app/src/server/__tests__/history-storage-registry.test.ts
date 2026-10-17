import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { inventoryRelayHistoryStorage, retainRelayHistoryOperationLocations } from '../history-storage.js';
import type { RelayHistorySetupInput } from '../history-setup.js';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { readRelayStorageRegistry, readRelayStorageLocations, retainRelayStorageRegistry, RELAY_STORAGE_REGISTRY_DIRECTORY } from '../history-storage-registry.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.mocked(renameSync).mockImplementation(actualFs.renameSync); });
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'resonance-location-registry-')));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = join(directory, 'relay-data'), target = join(directory, 'owner-history'); mkdirSync(runtime);
  const registry = join(directory, RELAY_STORAGE_REGISTRY_DIRECTORY), manifest = join(registry, 'locations.json');
  return { directory, runtime, target, registry, manifest };
}
it('retains committed planned roots across failed operations, later selection and aliases without creating those roots', () => {
  const n = fixture(); expect(readRelayStorageRegistry(n.runtime)).toEqual([]);
  retainRelayStorageRegistry(n.runtime, [n.runtime, n.target]);
  expect(actualFs.existsSync(n.target)).toBe(false);
  const next = join(n.directory, 'volunteer'); retainRelayStorageRegistry(n.runtime, [n.runtime, next]);
  expect(readRelayStorageRegistry(n.runtime)).toEqual([n.target, n.runtime, next].sort());
  if (process.platform !== 'win32') {
    const alias = join(n.directory, 'runtime-alias'); symlinkSync(n.runtime, alias);
    retainRelayStorageRegistry(n.runtime, [alias]);
    expect(readRelayStorageRegistry(n.runtime)).toEqual([n.target, n.runtime, next].sort());
  }
});
it('rejects competing writers and failed registry replacement before the caller can create history', () => {
  const n = fixture(); retainRelayStorageRegistry(n.runtime, [n.runtime]); const before = readFileSync(n.manifest);
  const release = acquireLocalStateLock(n.registry);
  try { expect(() => retainRelayStorageRegistry(n.runtime, [n.target])).toThrow(/already open/); }
  finally { release(); }
  vi.mocked(renameSync).mockImplementation(() => { throw new Error('Injected registry replacement failure'); });
  expect(() => { retainRelayStorageRegistry(n.runtime, [n.target]); mkdirSync(n.target); }).toThrow(/Injected/);
  expect(actualFs.existsSync(n.target)).toBe(false); expect(readFileSync(n.manifest)).toEqual(before);
  expect(readRelayStorageRegistry(n.runtime)).toEqual([n.runtime]);
});
it('refuses missing or malformed authoritative state and changed canonical paths without initializing again', () => {
  const n = fixture(); mkdirSync(n.registry);
  expect(() => retainRelayStorageRegistry(n.runtime, [n.runtime])).toThrow(/incomplete/);
  writeFileSync(n.manifest, 'partial'); expect(() => readRelayStorageRegistry(n.runtime)).toThrow();
  writeFileSync(n.manifest, JSON.stringify({ version: 1, kind: 'relay-storage-locations', directories: [n.runtime] }));
  writeFileSync(join(n.registry, 'unknown'), 'retain me'); expect(() => readRelayStorageRegistry(n.runtime)).toThrow(/unexpected/);
  rmSync(join(n.registry, 'unknown'));
  if (process.platform !== 'win32') {
    const moved = n.runtime + '-moved'; renameSync(n.runtime, moved); symlinkSync(moved, n.runtime);
    expect(() => readRelayStorageRegistry(n.runtime)).toThrow(/paths changed/);
  }
});
it('rejects a full location registry without dropping previous roots or creating output', () => {
  const n = fixture(), roots = Array.from({ length: 128 }, (_, index) => join(n.directory, `kept-${index}`));
  retainRelayStorageRegistry(n.runtime, roots);
  expect(() => retainRelayStorageRegistry(n.runtime, [n.target])).toThrow(/128/);
  expect(readRelayStorageRegistry(n.runtime)).toEqual(roots.sort()); expect(actualFs.existsSync(n.target)).toBe(false);
});
it.skipIf(process.platform === 'win32').each(['initial-directory', 'initial-partial-manifest', 'before-rename', 'after-rename', 'registered', 'written'])(
  'preserves the correct committed locations after SIGKILL at %s', async boundary => {
    const n = fixture(); if (!boundary.startsWith('initial-')) retainRelayStorageRegistry(n.runtime, [n.runtime]);
    const child = fork(fileURLToPath(new URL('./fixtures/storage-registry-crash.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let error = ''; child.stderr?.on('data', bytes => { error += bytes.toString(); });
    const exited = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
      expect((await once(child, 'message'))[0]).toBe('ready');
      child.send({ runtime: n.runtime, target: n.target, boundary });
      const [code, signal] = await exited; expect(code, error).toBe(null); expect(signal, error).toBe('SIGKILL'); expect(error).toBe('');
      if (boundary.startsWith('initial-')) {
        expect(() => readRelayStorageRegistry(n.runtime)).toThrow();
        expect(() => retainRelayStorageRegistry(n.runtime, [n.runtime])).toThrow();
        expect(actualFs.existsSync(n.target)).toBe(false); return;
      }
      expect(readRelayStorageRegistry(n.runtime)).toEqual(boundary === 'before-rename' ? [n.runtime] : [n.target, n.runtime].sort());
      expect(actualFs.existsSync(join(n.target, 'created-output'))).toBe(boundary === 'written');
      // A dead registry lock can be reclaimed; the next selection preserves every
      // previously committed root, even if settings were never saved.
      retainRelayStorageRegistry(n.runtime, [n.runtime]);
      expect(readRelayStorageRegistry(n.runtime)).toEqual(boundary === 'before-rename' ? [n.runtime] : [n.target, n.runtime].sort());
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
  }, 20000);

it('registers older settings locations before replacing a selection from before the registry existed', () => {
  const n = fixture(), oldDirectory = join(n.directory, 'older-history');
  const input: RelayHistorySetupInput = { role: 'owner', directory: oldDirectory, historyConfigFile: '/config', policyFile: '/policy', storageKeyFile: '/key', output: '/enrollment', mode: 'resume' };
  const previous = { enabled: false, port: 12345, historySetupInput: input };
  retainRelayHistoryOperationLocations({ ...previous, historySetupInput: { ...input, directory: n.target } }, n.runtime, previous);
  expect(readRelayStorageRegistry(n.runtime)).toEqual([oldDirectory, n.target, n.runtime].sort());
});

it.skipIf(process.platform === 'win32')('omits private path names when resolving a saved inventory location fails', async () => {
  const n = fixture(), alias = join(n.directory, 'private-history-alias');
  symlinkSync(join(n.directory, 'missing-private-target'), alias);
  const result = inventoryRelayHistoryStorage({ enabled: false, port: 12345, historyStorageDirectories: [alias] }, n.runtime, new AbortController().signal);
  await expect(result).rejects.toThrow('Storage inventory unavailable: retained locations or their registry are missing, unreadable or changed');
});


it('retains explicit outputs across later selections and migrates a directory-only manifest without dropping roots', async () => {
  const n = fixture(), first = join(n.directory, 'owner-config.json'), second = join(n.directory, 'enrollment.json');
  mkdirSync(n.registry); writeFileSync(n.manifest, JSON.stringify({ version: 1, kind: 'relay-storage-locations', directories: [n.runtime] }));
  retainRelayStorageRegistry(n.runtime, [n.runtime], [first]);
  expect(readRelayStorageLocations(n.runtime)).toEqual({ directories: [n.runtime], files: [first] });
  expect(actualFs.existsSync(first)).toBe(false);
  await expect(inventoryRelayHistoryStorage({ enabled: false, port: 12345 }, n.runtime, new AbortController().signal)).rejects.toThrow(/unavailable/);
  writeFileSync(first, 'configuration'); retainRelayStorageRegistry(n.runtime, [n.runtime], [second]); writeFileSync(second, 'enrollment');
  writeFileSync(join(n.directory, 'unrelated-private-file'), Buffer.alloc(1000000));
  retainRelayStorageRegistry(n.runtime, [n.runtime]);
  expect(readRelayStorageLocations(n.runtime).files).toEqual([first, second].sort());
  const result = await inventoryRelayHistoryStorage({ enabled: false, port: 12345 }, n.runtime, new AbortController().signal);
  expect(result).toMatchObject({ selectedDirectories: 2, selectedFiles: 2, files: 3, scannedRoots: 2 });
  expect(result.logicalBytes).toBe(actualFs.statSync(n.manifest).size + 23);
  expect(JSON.stringify(result)).not.toContain(n.directory);
});
it('refuses full explicit-file retention before creating an untracked output', () => {
  const n = fixture(), files = Array.from({ length: 128 }, (_, index) => join(n.directory, `output-${index}`));
  retainRelayStorageRegistry(n.runtime, [n.runtime], files);
  const extra = join(n.directory, 'extra');
  expect(() => { retainRelayStorageRegistry(n.runtime, [n.runtime], [extra]); writeFileSync(extra, 'untracked'); }).toThrow(/128/);
  expect(readRelayStorageLocations(n.runtime).files).toEqual(files.sort()); expect(actualFs.existsSync(extra)).toBe(false);
});
it('preserves earlier configuration outputs when a later registry update fails', () => {
  const n = fixture(), first = join(n.directory, 'first.json'), second = join(n.directory, 'second.json');
  const input: RelayHistorySetupInput = { role: 'configuration', ownerKeyFile: '/owner-key', authorityFile: '/authority', policyFile: '/policy', membersFile: '/members', output: first, historyId: '' };
  const previous = { enabled: false, port: 12345, historySetupInput: input };
  retainRelayHistoryOperationLocations(previous, n.runtime); writeFileSync(first, 'retained output');
  const before = readFileSync(n.manifest);
  vi.mocked(renameSync).mockImplementation(() => { throw new Error('Output registry flush failed'); });
  expect(() => retainRelayHistoryOperationLocations({ ...previous, historySetupInput: { ...input, output: second } }, n.runtime, previous)).toThrow(/registry flush failed/);
  expect(readFileSync(n.manifest)).toEqual(before); expect(readRelayStorageLocations(n.runtime).files).toEqual([first]);
  expect(readFileSync(first, 'utf8')).toBe('retained output'); expect(actualFs.existsSync(second)).toBe(false);
});


it.skipIf(process.platform === 'win32').each(['before-rename', 'after-rename', 'written'])(
  'retains explicitly registered output files after SIGKILL at %s', async boundary => {
    const n = fixture(); retainRelayStorageRegistry(n.runtime, [n.runtime]);
    const child = fork(fileURLToPath(new URL('./fixtures/storage-registry-crash.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let error = ''; child.stderr?.on('data', bytes => { error += bytes.toString(); });
    const exited = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
      expect((await once(child, 'message'))[0]).toBe('ready'); child.send({ runtime: n.runtime, target: n.target, boundary, file: true });
      expect(await exited, error).toEqual([null, 'SIGKILL']); expect(error).toBe('');
      expect(readRelayStorageLocations(n.runtime)).toEqual({ directories: [n.runtime], files: boundary === 'before-rename' ? [] : [n.target] });
      expect(actualFs.existsSync(n.target)).toBe(boundary === 'written');
      retainRelayStorageRegistry(n.runtime, [n.runtime]);
      expect(readRelayStorageLocations(n.runtime).files).toEqual(boundary === 'before-rename' ? [] : [n.target]);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
  }, 20000);


import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { RELAY_STORAGE_REGISTRY_PEAK_BYTES } from '../history-storage-registry.js';
it('reserves registry and ownership peaks once and updates at full capacity without temporary allocations', () => {
  const n = fixture(), authority = openStorageReservationAuthority({ directory: join(n.directory, 'authority'), mode: 'create-new', limitBytes: CONTROL + RELAY_STORAGE_REGISTRY_PEAK_BYTES + 8192 }); cleanup.push(authority.close);
  for (let i = 0; i < 20; i++) withStorageReservationAuthority(authority, () => retainRelayStorageRegistry(n.runtime, [join(n.directory, `history-${i}`)]));
  expect(authority.status()).toMatchObject({ components: 2, availableBytes: 0 });
  expect(readRelayStorageRegistry(n.runtime)).toHaveLength(20);
});
it('refuses an unfunded registry before creating its directory or ownership files', () => {
  const n = fixture(), authority = openStorageReservationAuthority({ directory: join(n.directory, 'authority'), mode: 'create-new', limitBytes: CONTROL + RELAY_STORAGE_REGISTRY_PEAK_BYTES }); cleanup.push(authority.close);
  expect(() => withStorageReservationAuthority(authority, () => retainRelayStorageRegistry(n.runtime, [n.target]))).toThrow(/exhausted/);
  expect(actualFs.existsSync(n.registry)).toBe(false); expect(actualFs.existsSync(n.registry + '.lock')).toBe(false);
});
it('keeps the 128-temporary registry ceiling during replacement instead of opening a 129th candidate', () => {
  const n = fixture(); retainRelayStorageRegistry(n.runtime, [n.runtime]);
  for (let i = 0; i < 128; i++) writeFileSync(join(n.registry, `.locations.${i.toString(16).padStart(16, '0')}.tmp`), 'retained');
  const before = readFileSync(n.manifest), names = actualFs.readdirSync(n.registry).sort();
  expect(() => retainRelayStorageRegistry(n.runtime, [n.target])).toThrow(/slots are full/);
  expect(readFileSync(n.manifest)).toEqual(before); expect(actualFs.readdirSync(n.registry).sort()).toEqual(names);
  expect(retainRelayStorageRegistry(n.runtime, [n.runtime])).toEqual([n.runtime]);
});
