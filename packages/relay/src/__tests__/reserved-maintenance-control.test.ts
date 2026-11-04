import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { openStorageReservationAuthority, openReservedStorageControl, withStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL } from '@resonance/core/storage-reservations';
import { acquireRelayRuntime, beginRelayMaintenance, readRelayMaintenance } from '../relay-maintenance.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, lstatSync: vi.fn(fs.lstatSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.mocked(lstatSync).mockImplementation(actual.lstatSync); for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(extra = 0) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'reserved-control-'))); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = join(directory, 'authority'), data = join(directory, 'relay'); mkdirSync(data);
  const controls = [{ path: join(data, 'relay-runtime.lock'), component: 'local-state-lock', scope: 'file' as const, maximumBytes: 8192 },
    { path: join(data, 'relay-maintenance.json'), component: 'operator-output', scope: 'file' as const, maximumBytes: 1024 }];
  const authority = openStorageReservationAuthority({ directory: ledger, mode: 'create-new', limitBytes: CONTROL + 9216 + extra }); cleanup.push(authority.close);
  controls.forEach(request => authority.reserve(request)); const authorityId = authority.status().authorityId;
  const options = { directory: ledger, authorityId, controls };
  const open = () => { const value = openReservedStorageControl(options); cleanup.push(value.close); return value; };
  return { directory, ledger, data, controls, authority, authorityId, options, open };
}
it('writes only a prepaid pause while the full ledger and runtime remain owned', () => {
  const n = fixture(), release = withStorageReservationAuthority(n.authority, () => acquireRelayRuntime(n.data)); cleanup.push(release);
  const bytes = readFileSync(join(n.ledger, 'reservations.json')), view = n.open();
  expect(() => openStorageReservationAuthority({ directory: n.ledger, authorityId: n.authorityId, mode: 'open-existing' })).toThrow(/already open/);
  expect(withStorageReservationAuthority(view, () => beginRelayMaintenance(n.data))).toMatchObject({ kind: 'relay-maintenance' });
  expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(bytes);
  expect(n.authority.status()).toMatchObject({ availableBytes: 0, components: 2 }); expect(existsSync(join(n.data, 'relay-runtime.lock'))).toBe(true);
});
it('rejects new allocations, increased caps and redirected outputs while retaining copied control pins', () => {
  const n = fixture(), view = n.open(), lease = view.reserve(n.controls[1]);
  expect(() => view.reserve({ ...n.controls[1], maximumBytes: 1025 })).toThrow(/scope or capacity/);
  expect(() => view.reserve({ ...n.controls[1], path: join(n.data, 'new') })).toThrow(/scope or capacity/);
  expect(() => lease.assertWritable({ path: join(n.data, 'new'), maximumBytes: 1 })).toThrow(/scope/);
  n.controls[1].path = join(n.data, 'moved'); n.controls[1].maximumBytes = 999999;
  lease.assertWritable(); expect(() => view.reserve(n.controls[1])).toThrow(/scope or capacity/);
  view.close(); expect(() => lease.assertWritable()).toThrow(/closed/);
});
it('keeps existing controls usable while the real owner grows its committed allocation set', () => {
  const n = fixture(100), view = n.open(), lease = view.reserve(n.controls[1]);
  n.authority.reserve({ path: join(n.directory, 'new-data'), component: 'test', scope: 'file', maximumBytes: 100 });
  lease.assertWritable(); expect(n.authority.status().availableBytes).toBe(0);
});
it.each(['legacy-file', 'directory', 'marker'] as const)('keeps funded controls usable when a runtime %s disappears during validation', kind => {
  const n = fixture(), view = n.open(), lease = view.reserve(n.controls[1]), lock = n.controls[0].path;
  const before = readFileSync(join(n.ledger, 'reservations.json'));
  let release: () => void;
  if (kind === 'legacy-file') { writeFileSync(lock, JSON.stringify({ pid: process.pid })); release = () => rmSync(lock); }
  else { release = withStorageReservationAuthority(n.authority, () => acquireRelayRuntime(n.data)); cleanup.push(release); }
  let interrupted = false;
  vi.mocked(lstatSync).mockImplementation(((selected: string, options: unknown) => {
    const result = actual.lstatSync(selected, options as any), name = String(selected);
    if (!interrupted && (kind === 'marker' ? name.startsWith(lock + '/') || name.startsWith(lock + '\\') : name === lock)) {
      interrupted = true; release();
    }
    return result;
  }) as typeof lstatSync);
  lease.assertWritable(); expect(interrupted).toBe(true); expect(existsSync(lock)).toBe(false);
  withStorageReservationAuthority(view, () => beginRelayMaintenance(n.data));
  expect(readRelayMaintenance(n.data)).not.toBeNull(); expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(before);
});
it('does not reinterpret a dangling ownership alias as a released control', () => {
  const n = fixture(), view = n.open(), lease = view.reserve(n.controls[1]), lock = n.controls[0].path;
  symlinkSync(join(n.data, 'missing'), lock, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => lease.assertWritable()).toThrow(); expect(actual.lstatSync(lock).isSymbolicLink()).toBe(true);
  expect(existsSync(n.controls[1].path)).toBe(false);
});
it('refuses wrong, missing, corrupt or insufficient committed metadata without creating control output', () => {
  const n = fixture(), path = join(n.ledger, 'reservations.json'), before = readFileSync(path); n.authority.close();
  expect(() => openReservedStorageControl({ ...n.options, authorityId: '0'.repeat(32) })).toThrow(/independently retained/);
  const view = n.open(), lease = view.reserve(n.controls[1]);
  writeFileSync(path, 'private invalid contents'); expect(() => lease.assertWritable()).toThrow('Reserved storage authority metadata is invalid; retain it for inspection');
  const smaller = JSON.parse(before.toString()); smaller.allocations.find((entry: any) => entry.component === 'operator-output').maximumBytes = 1;
  writeFileSync(path, JSON.stringify(smaller)); expect(() => lease.assertWritable()).toThrow(/committed reservation/);
  rmSync(path); expect(() => lease.assertWritable()).toThrow(); expect(existsSync(n.controls[1].path)).toBe(false);
});
it('does not migrate a valid old primary merely to grant already funded controls', () => {
  const n = fixture(); n.authority.close(); const path = join(n.ledger, 'reservations.json'), raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.version = 1; delete raw.adoptions; writeFileSync(path, JSON.stringify(raw)); const before = readFileSync(path);
  const view = n.open(); withStorageReservationAuthority(view, () => beginRelayMaintenance(n.data));
  expect(readFileSync(path)).toEqual(before);
});
it.skipIf(process.platform === 'win32')('permits the funded pause even if an unrelated recorded history path is redirected', () => {
  const n = fixture(100), old = join(n.directory, 'old'), replacement = join(n.directory, 'replacement'); mkdirSync(old); mkdirSync(replacement);
  n.authority.reserve({ path: join(old, 'payload'), component: 'history', scope: 'file', maximumBytes: 100 });
  renameSync(old, old + '-retained'); symlinkSync(replacement, old);
  const view = n.open(); withStorageReservationAuthority(view, () => beginRelayMaintenance(n.data));
  expect(readRelayMaintenance(n.data)).not.toBeNull();
});
it('detects replacement of the observed authority directory', () => {
  const n = fixture(), view = n.open(), lease = view.reserve(n.controls[1]); n.authority.close(); renameSync(n.ledger, n.ledger + '-retained'); mkdirSync(n.ledger);
  expect(() => lease.assertWritable()).toThrow(/directory changed/);
});
it('pauses from another process at exact capacity without competing for its active authority', async () => {
  const n = fixture(); n.authority.close();
  const child = fork(new URL('./fixtures/reserved-maintenance-owner.ts', import.meta.url), [n.ledger, n.authorityId, n.data], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let error = ''; child.stderr?.on('data', value => { error += value.toString(); }); const exited = once(child, 'exit');
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(error); })]))[0]).toBe('ready');
  const bytes = readFileSync(join(n.ledger, 'reservations.json')), view = n.open();
  withStorageReservationAuthority(view, () => beginRelayMaintenance(n.data));
  expect(readRelayMaintenance(n.data)).not.toBeNull(); expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(bytes);
  expect(() => openStorageReservationAuthority({ directory: n.ledger, authorityId: n.authorityId, mode: 'open-existing' })).toThrow(/already open/);
  child.kill('SIGKILL'); expect((await exited)[1], error).toBe('SIGKILL');
  const restored = openStorageReservationAuthority({ directory: n.ledger, authorityId: n.authorityId, mode: 'open-existing' }); cleanup.push(restored.close);
  expect(() => withStorageReservationAuthority(restored, () => acquireRelayRuntime(n.data))).toThrow(/maintenance is active/);
  expect(restored.status()).toMatchObject({ availableBytes: 0, components: 2 });
}, 15_000);

it('retries an atomic primary replacement by the current owner without widening the control scope', () => {
  const n = fixture(1), view = n.open(), lease = view.reserve(n.controls[1]), path = join(n.ledger, 'reservations.json'); let changed = false;
  vi.mocked(lstatSync).mockImplementation(((selected: string, options: unknown) => {
    const result = actual.lstatSync(selected, options as any);
    if (String(selected) === path && !changed) {
      changed = true; n.authority.reserve({ path: join(n.directory, 'parallel'), component: 'test', scope: 'file', maximumBytes: 1 });
    }
    return result;
  }) as typeof lstatSync);
  lease.assertWritable(); expect(changed).toBe(true); expect(n.authority.status()).toMatchObject({ components: 3, availableBytes: 0 });
});
it('refuses hard-linked control outputs after a lease has already been issued', () => {
  const n = fixture(), view = n.open(), lease = view.reserve(n.controls[1]);
  writeFileSync(n.controls[1].path, 'pause'); linkSync(n.controls[1].path, join(n.data, 'alias'));
  expect(() => lease.assertWritable()).toThrow(/unaliased/); expect(readFileSync(n.controls[1].path, 'utf8')).toBe('pause');
});
it.each([
  { scope: 'directory' }, { component: 'encrypted-local-state' }, { maximumBytes: 1024 * 1024 + 1 }, { maximumBytes: -1 },
])('refuses an unsuitable control allowlist: %j', changes => {
  const n = fixture();
  expect(() => openReservedStorageControl({ ...n.options, controls: [{ ...n.controls[1], ...changes }] as typeof n.controls })).toThrow(/control scope/);
  expect(existsSync(n.controls[1].path)).toBe(false);
});

it('bounds repeated replacement races and refuses output instead of using a cached proof', () => {
  const n = fixture(3), view = n.open(), lease = view.reserve(n.controls[1]), path = join(n.ledger, 'reservations.json'); let inside = false, changes = 0;
  vi.mocked(lstatSync).mockImplementation(((selected: string, options: unknown) => {
    const result = actual.lstatSync(selected, options as any);
    if (String(selected) === path && !inside) {
      inside = true;
      try { n.authority.reserve({ path: join(n.directory, `parallel-${++changes}`), component: 'test', scope: 'file', maximumBytes: 1 }); }
      finally { inside = false; }
    }
    return result;
  }) as typeof lstatSync);
  expect(() => lease.assertWritable()).toThrow(/metadata changed/); expect(changes).toBe(3);
  vi.mocked(lstatSync).mockImplementation(actual.lstatSync);
  expect(n.authority.status()).toMatchObject({ components: 5, availableBytes: 0 }); expect(existsSync(n.controls[1].path)).toBe(false);
});
