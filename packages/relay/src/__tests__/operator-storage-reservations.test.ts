import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, fsyncSync, linkSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL, withStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { writeOperatorJsonNew, writeOperatorJsonAtomic, OPERATOR_REPLACEMENT_SLOTS as SLOTS } from '../admission-operator-files.js';
import { acquireRelayRuntime, beginRelayMaintenance, acquireStoppedRelayMaintenance, finishRelayMaintenance, readRelayMaintenance } from '../relay-maintenance.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync), fsyncSync: vi.fn(fs.fsyncSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown> = [];
afterEach(() => { vi.mocked(renameSync).mockImplementation(actual.renameSync); vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync); for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(extra: number) {
  const directory = mkdtempSync(join(tmpdir(), 'operator-reservations-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = join(directory, 'authority'), authority = openStorageReservationAuthority({ directory: ledger, mode: 'create-new', limitBytes: CONTROL + extra }); cleanup.push(authority.close);
  return { directory, ledger, authority };
}
it('reserves exact immutable outputs before creation and retains partial outputs without overwriting', () => {
  const n = fixture(256), path = join(n.directory, 'export.json');
  withStorageReservationAuthority(n.authority, () => writeOperatorJsonNew(path, { accepted: true }, 256));
  expect(n.authority.status()).toMatchObject({ availableBytes: 0, components: 1 });
  expect(() => withStorageReservationAuthority(n.authority, () => writeOperatorJsonNew(join(n.directory, 'new.json'), {}, 1))).toThrow();
  expect(existsSync(join(n.directory, 'new.json'))).toBe(false);
  const before = readFileSync(path);
  expect(() => withStorageReservationAuthority(n.authority, () => writeOperatorJsonNew(path, {}, 256))).toThrow();
  expect(readFileSync(path)).toEqual(before);
});
it('reuses one atomic settings reservation for repeated replacements and preserves it across reopening', () => {
  const maximum = 256, n = fixture((SLOTS + 1) * maximum + 8192), path = join(n.directory, 'settings.json');
  for (let revision = 0; revision < 30; revision++) withStorageReservationAuthority(n.authority, () => writeOperatorJsonAtomic(path, { revision }, maximum));
  expect(n.authority.status()).toMatchObject({ availableBytes: 0, components: 1 });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ revision: 29 });
  expect(readdirSync(n.directory).sort()).toEqual(['authority', 'settings.json']);
  const id = n.authority.status().authorityId; n.authority.close();
  const reopened = openStorageReservationAuthority({ directory: n.ledger, mode: 'open-existing', authorityId: id }); cleanup.push(reopened.close);
  withStorageReservationAuthority(reopened, () => writeOperatorJsonAtomic(path, { revision: 30 }, maximum));
  expect(reopened.status()).toMatchObject({ availableBytes: 0, components: 1 });
});
it('refuses unfunded atomic settings before creating their directory or lock', () => {
  const n = fixture(0), path = join(n.directory, 'missing', 'settings.json');
  expect(() => withStorageReservationAuthority(n.authority, () => writeOperatorJsonAtomic(path, {}, 256))).toThrow(/exhausted/);
  expect(existsSync(join(n.directory, 'missing'))).toBe(false);
});
it('retains interrupted old/new settings names and refuses another temporary when every slot is occupied', () => {
  const maximum = 256, n = fixture((SLOTS + 1) * maximum + 8192), path = join(n.directory, 'settings.json');
  const write = () => withStorageReservationAuthority(n.authority, () => writeOperatorJsonAtomic(path, { valid: true }, maximum)); write();
  for (let i = 0; i < SLOTS - 1; i++) writeFileSync(join(n.directory, `${i % 2 ? '.' : ''}settings.json.${i.toString(16).padStart(16, '0')}.tmp`), 'interrupted');
  write();
  const last = join(n.directory, `.settings.json.${'f'.repeat(16)}.tmp`); writeFileSync(last, 'interrupted');
  const names = readdirSync(n.directory).sort(), before = readFileSync(path);
  expect(write).toThrow(/slots are full/); expect(readdirSync(n.directory).sort()).toEqual(names); expect(readFileSync(path)).toEqual(before);
});
it.each(['rename', 'directory-flush'] as const)('keeps a whole old/new settings image after %s failure', point => {
  if (point === 'directory-flush' && process.platform === 'win32') return;
  const maximum = 256, n = fixture((SLOTS + 1) * maximum + 8192), path = join(n.directory, 'settings.json');
  withStorageReservationAuthority(n.authority, () => writeOperatorJsonAtomic(path, { revision: 0 }, maximum));
  let targeted = false;
  if (point === 'rename') vi.mocked(renameSync).mockImplementation((from, to) => {
    if (String(to) === path) { targeted = true; throw new Error('settings rename failed'); } actual.renameSync(from, to);
  });
  else {
    let published = false;
    vi.mocked(renameSync).mockImplementation((from, to) => { actual.renameSync(from, to); if (String(to) === path) published = true; });
    vi.mocked(fsyncSync).mockImplementation(fd => { if (published) { targeted = true; throw new Error('settings directory flush failed'); } actual.fsyncSync(fd); });
  }
  expect(() => withStorageReservationAuthority(n.authority, () => writeOperatorJsonAtomic(path, { revision: 1 }, maximum))).toThrow(/settings/);
  expect(targeted).toBe(true);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ revision: point === 'rename' ? 0 : 1 });
  expect(n.authority.status()).toMatchObject({ availableBytes: 0, components: 1 });
});
it('rejects a pre-reserved output outside its directory or declared capacity', () => {
  const n = fixture(1024), scope = join(n.directory, 'controlled'), reservation = n.authority.reserve({ path: scope, component: 'test-outputs', scope: 'directory', maximumBytes: 1024 });
  expect(() => writeOperatorJsonNew(join(n.directory, 'elsewhere'), {}, 256, { reservation })).toThrow(/outside/);
  expect(() => writeOperatorJsonNew(join(scope, 'large'), {}, 1025, { reservation })).toThrow(/capacity/);
  expect(existsSync(join(n.directory, 'elsewhere'))).toBe(false); expect(existsSync(scope)).toBe(false);
});
it('keeps pause and ownership metadata available when the shared authority is full', () => {
  const n = fixture(8192 + 1024), runtime = join(n.directory, 'runtime');
  const release = withStorageReservationAuthority(n.authority, () => acquireRelayRuntime(runtime)); cleanup.push(release);
  expect(n.authority.status()).toMatchObject({ availableBytes: 0, components: 2 });
  withStorageReservationAuthority(n.authority, () => beginRelayMaintenance(runtime));
  release();
  const maintenance = withStorageReservationAuthority(n.authority, () => acquireStoppedRelayMaintenance(runtime)); maintenance();
  withStorageReservationAuthority(n.authority, () => finishRelayMaintenance(runtime));
  expect(readRelayMaintenance(runtime)).toBeNull(); expect(n.authority.status()).toMatchObject({ availableBytes: 0, components: 2 });
});
it('reserves standalone ownership files and refuses oversized or aliased retained locks', () => {
  const n = fixture(8192), resource = join(n.directory, 'writer');
  const release = withStorageReservationAuthority(n.authority, () => acquireLocalStateLock(resource)); release();
  expect(n.authority.status()).toMatchObject({ availableBytes: 0, components: 1 });
  expect(() => withStorageReservationAuthority(n.authority, () => acquireLocalStateLock(join(n.directory, 'unfunded')))).toThrow(/exhausted/);
  const lock = resource + '.lock'; writeFileSync(lock, 'x'.repeat(4097));
  expect(() => acquireLocalStateLock(resource)).toThrow(/bounded/); expect(readFileSync(lock).length).toBe(4097);
  rmSync(lock); writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'retained' })); linkSync(lock, join(n.directory, 'alias'));
  expect(() => acquireLocalStateLock(resource)).toThrow(/bounded/);
  if (process.platform !== 'win32') {
    rmSync(lock); symlinkSync(join(n.directory, 'alias'), lock);
    expect(() => acquireLocalStateLock(resource)).toThrow(/bounded/);
  }
});

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
it.skipIf(process.platform === 'win32').each(['partial-write', 'before-rename', 'after-rename'])(
  'retains its reservation and a complete current settings file across SIGKILL at %s', async boundary => {
    const n = fixture((SLOTS + 1) * 256 + 8192), path = join(n.directory, 'settings.json');
    withStorageReservationAuthority(n.authority, () => writeOperatorJsonAtomic(path, { revision: 0 }, 256));
    const id = n.authority.status().authorityId; n.authority.close();
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/operator-output-crash.ts', import.meta.url)), n.ledger, id, path, boundary], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes.toString(); });
    const exit = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { expect(await exit, stderr).toEqual([null, 'SIGKILL']); expect(stderr).toBe(''); }
    finally { clearTimeout(timer); }
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ revision: boundary === 'after-rename' ? 1 : 0 });
    const interrupted = readdirSync(n.directory).filter(name => name.endsWith('.tmp')).sort();
    expect(interrupted).toHaveLength(boundary === 'after-rename' ? 0 : 1);
    const authority = openStorageReservationAuthority({ directory: n.ledger, mode: 'open-existing', authorityId: id }); cleanup.push(authority.close);
    expect(authority.status()).toMatchObject({ availableBytes: 0, components: 1 });
    withStorageReservationAuthority(authority, () => writeOperatorJsonAtomic(path, { revision: 2 }, 256));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ revision: 2 });
    expect(readdirSync(n.directory).filter(name => name.endsWith('.tmp')).sort()).toEqual(interrupted);
  }, 15000);

it('rejects an unencodable JSON value before reserving or creating output', () => {
  const n = fixture(100000);
  for (const write of [writeOperatorJsonNew, writeOperatorJsonAtomic]) {
    const path = join(n.directory, 'invalid.json');
    expect(() => withStorageReservationAuthority(n.authority, () => write(path, undefined, 256))).toThrow(/JSON value/);
    expect(existsSync(path)).toBe(false); expect(n.authority.status().components).toBe(0);
  }
});
