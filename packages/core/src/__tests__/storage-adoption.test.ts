import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL, withStorageReservationAuthority, type StorageAdoptionTarget } from '../storage-reservations.js';
import { openEncryptedLocalState } from '../local-encrypted-state.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, lstatSync: vi.fn(fs.lstatSync), fsyncSync: vi.fn(fs.fsyncSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync); vi.mocked(lstatSync).mockImplementation(actual.lstatSync); for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(extra = 1000) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'storage-adoption-'))); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = join(directory, 'authority'), data = join(directory, 'data'); mkdirSync(data);
  const authority = openStorageReservationAuthority({ directory: ledger, mode: 'create-new', limitBytes: CONTROL + extra }); cleanup.push(authority.close);
  const targets: StorageAdoptionTarget[] = [{ path: data, scope: 'directory' }];
  const reopen = () => { const restored = openStorageReservationAuthority({ directory: ledger, mode: 'open-existing', authorityId: authorityId }); cleanup.push(restored.close); return restored; };
  const authorityId = authority.status().authorityId;
  const output = (name: string, bytes: number) => { const path = join(data, name); writeFileSync(path, Buffer.alloc(bytes, 17)); return path; };
  return { directory, ledger, data, targets, authority, authorityId, output, reopen };
}
const adopt = (authority: ReturnType<typeof openStorageReservationAuthority>, targets: StorageAdoptionTarget[]) => authority.adoptExisting(targets, authority.reviewExisting(targets).approvalDigest);
it('charges unknown and interrupted files in addition to a future writer peak without reading or discarding them', () => {
  const peak = 2 * 512 + 8192, n = fixture(600 + peak);
  const unknown = n.output('unknown-history', 300), temporary = n.output('.interrupted.tmp', 200), old = n.output('old-config', 100);
  const before = [unknown, temporary, old].map(path => readFileSync(path));
  expect(n.authority.reviewExisting(n.targets)).toMatchObject({ files: 3, observedBytes: 600, additionalBytes: 600, fits: true, atomicSnapshot: false });
  adopt(n.authority, n.targets);
  const state = withStorageReservationAuthority(n.authority, () => openEncryptedLocalState({ path: join(n.data, 'new-state'), key: Buffer.alloc(32, 2), domain: 'test:adopted-storage', maxBytes: 512,
    initial: { count: 0 }, validate: (value): value is { count: number } => !!value && typeof value === 'object' && 'count' in value && Number.isSafeInteger(value.count) })); cleanup.push(state.close);
  state.write({ count: 1 }); expect(state.read().count).toBe(1);
  expect(n.authority.status()).toMatchObject({ components: 1, adoptedSelections: 1, adoptedBytes: 600, availableBytes: 0 });
  expect([unknown, temporary, old].map(path => readFileSync(path))).toEqual(before);
  expect(() => n.authority.reserve({ path: join(n.data, 'unfunded'), scope: 'file', component: 'test', maximumBytes: 1 })).toThrow(/exhausted/);
});
it('never frees an adopted floor after shrinking files, losing paths or changing the selected root', () => {
  const n = fixture(300), file = n.output('retained', 200); adopt(n.authority, n.targets);
  writeFileSync(file, Buffer.alloc(1)); const smaller = n.authority.reviewExisting(n.targets);
  expect(smaller).toMatchObject({ observedBytes: 1, additionalBytes: 0 }); n.authority.adoptExisting(n.targets, smaller.approvalDigest);
  const other = join(n.directory, 'other'); mkdirSync(other); writeFileSync(join(other, 'other-history'), Buffer.alloc(100));
  adopt(n.authority, [{ path: other, scope: 'directory' }]);
  expect(n.authority.status()).toMatchObject({ adoptedSelections: 2, adoptedBytes: 300, availableBytes: 0 });
  expect(() => n.authority.reviewLimit(CONTROL + 299)).toThrow(/retained/);
  rmSync(n.data, { recursive: true }); n.authority.close(); const restored = n.reopen();
  expect(restored.status()).toMatchObject({ adoptedSelections: 2, adoptedBytes: 300, availableBytes: 0 });
  expect(() => restored.reviewExisting(n.targets)).toThrow(/missing/);
});
it('refuses insufficient adoption without altering either existing files or committed reservations', () => {
  const n = fixture(99), path = n.output('retained', 100), bytes = readFileSync(path), before = n.authority.status();
  const review = n.authority.reviewExisting(n.targets); expect(review).toMatchObject({ fits: false, additionalBytes: 100 });
  expect(() => n.authority.adoptExisting(n.targets, review.approvalDigest)).toThrow(/exhausted/);
  expect(n.authority.status()).toEqual(before); expect(readFileSync(path)).toEqual(bytes);
  const raised = n.authority.reviewLimit(CONTROL + 100); n.authority.applyLimit(raised.limitBytes, raised.approvalDigest);
  expect(() => n.authority.adoptExisting(n.targets, review.approvalDigest)).toThrow(/approval changed/);
  adopt(n.authority, n.targets); expect(n.authority.status().availableBytes).toBe(0);
});
it.each(['replacement', 'addition', 'new-reservation'])('invalidates adoption approval after %s', changed => {
  const n = fixture(), path = n.output('retained', 100), review = n.authority.reviewExisting(n.targets);
  if (changed === 'replacement') { n.output('replacement', 100); renameSync(join(n.data, 'replacement'), path); }
  if (changed === 'addition') n.output('new-file', 1);
  if (changed === 'new-reservation') n.authority.reserve({ path: join(n.directory, 'future'), scope: 'file', component: 'test', maximumBytes: 1 });
  expect(() => n.authority.adoptExisting(n.targets, review.approvalDigest)).toThrow(/approval changed/);
  expect(n.authority.status().adoptedBytes).toBe(0); expect(readFileSync(path).length).toBe(100);
});
it('deduplicates overlapping selections in one review and preserves previously charged nested floors', () => {
  const n = fixture(250), path = n.output('record', 100);
  const selections: StorageAdoptionTarget[] = [...n.targets, { path, scope: 'file' }, ...n.targets];
  const review = n.authority.reviewExisting(selections); expect(review).toMatchObject({ files: 1, observedBytes: 100 }); expect(review.targets).toHaveLength(1);
  adopt(n.authority, [{ path, scope: 'file' }]); adopt(n.authority, selections);
  expect(n.authority.status()).toMatchObject({ adoptedSelections: 2, adoptedBytes: 200 });
  const charged = n.authority.status(); adopt(n.authority, selections); expect(n.authority.status()).toEqual(charged);
});
it('excludes its already reserved control directory while adopting an enclosing data root', () => {
  const n = fixture(100); n.output('retained', 100);
  const parent: StorageAdoptionTarget[] = [{ path: n.directory, scope: 'directory' }];
  const review = n.authority.reviewExisting(parent); expect(review).toMatchObject({ files: 1, observedBytes: 100 });
  n.authority.adoptExisting(parent, review.approvalDigest);
  expect(n.authority.status()).toMatchObject({ adoptedBytes: 100, availableBytes: 0 });
  expect(() => n.authority.reviewExisting([{ path: n.ledger, scope: 'directory' }])).toThrow(/control headroom/);
});
it.each(['hard-link', 'symlink'] as const)('preserves and refuses a %s inside an adopted root', kind => {
  if (kind === 'symlink' && process.platform === 'win32') return;
  const n = fixture(), path = n.output('retained', 10), alias = join(n.data, 'alias');
  if (kind === 'hard-link') linkSync(path, alias); else symlinkSync(path, alias);
  expect(() => n.authority.reviewExisting(n.targets)).toThrow(/links/);
  expect(n.authority.status().adoptedBytes).toBe(0); expect(readFileSync(path).length).toBe(10);
});
it.each([{ maximumEntries: 1 }, { maximumDepth: 0 }, { maximumMetadataBytes: 1 }])('refuses an incomplete bounded inventory: %j', bounds => {
  const n = fixture(); n.output('retained', 100);
  expect(() => n.authority.reviewExisting(n.targets, bounds)).toThrow(/capacity/); expect(n.authority.status().adoptedBytes).toBe(0);
});
it('bounds the scan deadline without interpreting unvisited files as zero bytes', () => {
  const n = fixture(); n.output('retained', 100);
  const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(100);
  try { expect(() => n.authority.reviewExisting(n.targets, { timeoutMs: 50 })).toThrow(/deadline/); }
  finally { clock.mockRestore(); }
  expect(n.authority.status().adoptedBytes).toBe(0);
});
it('detects a file changed during the metadata walk', () => {
  const n = fixture(), path = n.output('retained', 100); let changed = false;
  vi.mocked(lstatSync).mockImplementation(((selected: string, options: unknown) => {
    const result = actual.lstatSync(selected, options as any);
    if (String(selected) === path && !changed) { changed = true; writeFileSync(path, Buffer.alloc(101)); }
    return result;
  }) as typeof lstatSync);
  expect(() => n.authority.reviewExisting(n.targets)).toThrow(/changed during review/);
  expect(n.authority.status().adoptedBytes).toBe(0); expect(readFileSync(path).length).toBe(101);
});
it('retains zero-byte existing selections and upgrades a v1 authority only on durable mutation', () => {
  const n = fixture(100), target = join(n.directory, 'future');
  n.authority.reserve({ path: target, component: 'test', scope: 'file', maximumBytes: 100 }); const previous = n.authority.status(); n.authority.close();
  const path = join(n.ledger, 'reservations.json'), raw = JSON.parse(readFileSync(path, 'utf8')); delete raw.adoptions; raw.version = 1; writeFileSync(path, JSON.stringify(raw));
  const bytes = readFileSync(path), restored = n.reopen();
  expect(readFileSync(path)).toEqual(bytes); expect(restored.status()).toEqual(previous);
  adopt(restored, n.targets);
  expect(restored.status()).toMatchObject({ components: 1, adoptedSelections: 1, adoptedBytes: 0, availableBytes: 0, revision: previous.revision + 1 });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 2, authorityId: n.authorityId, allocations: raw.allocations });
});
it.each(['file', 'directory'] as const)('retains the correct floor after an uncertain %s flush', kind => {
  if (kind === 'directory' && process.platform === 'win32') return;
  const n = fixture(200); n.output('retained', 100); const review = n.authority.reviewExisting(n.targets); let calls = 0;
  vi.mocked(fsyncSync).mockImplementation(fd => { if (++calls === (kind === 'file' ? 1 : 2)) throw new Error('adoption flush failed'); actual.fsyncSync(fd); });
  expect(() => n.authority.adoptExisting(n.targets, review.approvalDigest)).toThrow(/flush failed/);
  expect(() => n.authority.status()).toThrow(/uncertain/); n.authority.close(); vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync);
  expect(n.reopen().status().adoptedBytes).toBe(kind === 'file' ? 0 : 100); expect(existsSync(join(n.data, 'retained'))).toBe(true);
});
it.each(['bad-floor', 'duplicate', 'overflow'])('refuses corrupt retained-floor metadata: %s', fault => {
  const n = fixture(); n.output('retained', 10); adopt(n.authority, n.targets); n.authority.close();
  const path = join(n.ledger, 'reservations.json'), raw = JSON.parse(readFileSync(path, 'utf8'));
  if (fault === 'bad-floor') raw.adoptions[0].maximumBytes = -1;
  if (fault === 'duplicate') raw.adoptions.push(raw.adoptions[0]);
  if (fault === 'overflow') { raw.limitBytes = Number.MAX_SAFE_INTEGER; raw.adoptions[0].maximumBytes = Number.MAX_SAFE_INTEGER; }
  writeFileSync(path, JSON.stringify(raw)); const before = readFileSync(path);
  expect(n.reopen).toThrow(); expect(readFileSync(path)).toEqual(before);
});
it.each([false, true])('retains adopted floors through process death with legacy=%s', async legacy => {
  for (const boundary of ['before-rename', 'after-rename', 'adopted']) {
    const n = fixture(300), retained = n.output('retained', 100), bytes = readFileSync(retained);
    n.authority.reserve({ path: join(n.directory, 'future'), component: 'test', scope: 'file', maximumBytes: 200 }); n.authority.close();
    const path = join(n.ledger, 'reservations.json');
    if (legacy) { const raw = JSON.parse(readFileSync(path, 'utf8')); raw.version = 1; delete raw.adoptions; writeFileSync(path, JSON.stringify(raw)); }
    const child = fork(new URL('./fixtures/storage-adoption-child.ts', import.meta.url), [n.ledger, n.authorityId, n.data, boundary],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let error = ''; child.stderr?.on('data', chunk => { error += chunk.toString(); }); const exited = once(child, 'exit');
    const timeout = setTimeout(() => child.kill('SIGTERM'), 10_000);
    try { expect(await exited, error).toEqual([null, 'SIGKILL']); expect(error).toBe(''); }
    finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
    const restored = n.reopen(); expect(restored.status()).toMatchObject({ components: 1, adoptedBytes: boundary === 'before-rename' ? 0 : 100 });
    expect(readFileSync(retained)).toEqual(bytes); adopt(restored, n.targets);
    expect(restored.status()).toMatchObject({ adoptedBytes: 100, components: 1, availableBytes: 0 });
  }
}, 30_000);

it('shares the metadata entry bound between adopted floors and future writer allocations', () => {
  const n = fixture(); n.authority.close();
  const path = join(n.ledger, 'reservations.json'), raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.allocations = Array.from({ length: 511 }, (_, i) => ({ path: join(n.directory, `future-${String(i).padStart(3, '0')}`), scope: 'file', component: 'test', maximumBytes: 0 }));
  writeFileSync(path, JSON.stringify(raw)); const restored = n.reopen(); adopt(restored, n.targets);
  expect(restored.status()).toMatchObject({ components: 511, adoptedSelections: 1 });
  expect(() => restored.reserve({ path: join(n.directory, 'overflow'), scope: 'file', component: 'test', maximumBytes: 0 })).toThrow(/entry capacity/);
  const other = join(n.directory, 'other'); mkdirSync(other);
  expect(() => restored.reviewExisting([{ path: other, scope: 'directory' }])).toThrow(/entry capacity/);
  restored.reserve({ ...raw.allocations[0], maximumBytes: 1 });
  n.output('existing', 1); adopt(restored, n.targets);
  expect(restored.status()).toMatchObject({ components: 511, adoptedSelections: 1, adoptedBytes: 1, reservedBytes: CONTROL + 2 });
});
it('does not reinterpret a previously retained file as a new empty directory', () => {
  const n = fixture(), path = n.output('existing', 10); adopt(n.authority, [{ path, scope: 'file' }]);
  rmSync(path); mkdirSync(path);
  expect(() => n.authority.reviewExisting([{ path, scope: 'directory' }])).toThrow(/retained scope/);
  expect(n.authority.status().adoptedBytes).toBe(10);
});
