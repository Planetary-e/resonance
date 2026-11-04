import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL, withStorageReservationAuthority } from '../storage-reservations.js';
import { openEncryptedLocalState } from '../local-encrypted-state.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, lstatSync: vi.fn(fs.lstatSync), fsyncSync: vi.fn(fs.fsyncSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.mocked(lstatSync).mockImplementation(actual.lstatSync); vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync); for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(extra = 10240) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'new-storage-scopes-'))); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = join(directory, 'authority'), parent = join(directory, 'outputs'); mkdirSync(parent);
  const authority = openStorageReservationAuthority({ directory: ledger, mode: 'create-new', limitBytes: CONTROL + extra }); cleanup.push(authority.close);
  const id = authority.status().authorityId, target = { path: join(parent, 'new-history'), scope: 'directory' as const };
  return { directory, ledger, parent, target, authority, id, open(scoped = true) {
    authority.close(); const value = openStorageReservationAuthority({ directory: ledger, authorityId: id, mode: 'open-existing', requireAdoptedScopes: scoped }); cleanup.push(value.close); return value;
  } };
}
it.each(['file', 'directory'] as const)('approves an explicit absent %s without creating it and charges later writers at a full budget', scope => {
  const n = fixture(), target = { ...n.target, scope }, targets = [target];
  const review = n.authority.reviewNewScopes(targets); expect(review).toMatchObject({ additionalBytes: 0, reservedBytes: CONTROL, atomicSnapshot: false });
  n.authority.approveNewScopes(targets, review.approvalDigest); expect(existsSync(target.path)).toBe(false);
  const scoped = n.open(), path = scope === 'file' ? target.path : join(target.path, 'state');
  const state = withStorageReservationAuthority(scoped, () => openEncryptedLocalState({ path, key: Buffer.alloc(32, 1), domain: 'new-scope', maxBytes: 1024,
    initial: { count: 0 }, validate: (value): value is { count: number } => !!value && typeof value === 'object' && 'count' in value && Number.isSafeInteger(value.count) })); cleanup.push(state.close);
  state.write({ count: 1 }); expect(state.read()).toEqual({ count: 1 }); expect(scoped.status()).toMatchObject({ availableBytes: 0, adoptedBytes: 0, adoptedSelections: 1, components: 1 });
});
it('approving a new scope does not grant bytes or allow unfunded output', () => {
  const n = fixture(0), review = n.authority.reviewNewScopes([n.target]); n.authority.approveNewScopes([n.target], review.approvalDigest);
  const scoped = n.open(); expect(() => scoped.reserve({ ...n.target, component: 'ciphertext', maximumBytes: 1 })).toThrow(/exhausted/);
  expect(existsSync(n.target.path)).toBe(false); expect(scoped.status()).toMatchObject({ availableBytes: 0, components: 0 });
});
it('never treats a missing existing selection as a request to approve an empty scope', () => {
  const n = fixture(); expect(() => n.authority.reviewExisting([n.target])).toThrow(/missing/);
  expect(n.authority.status().adoptedSelections).toBe(0);
});
it.each(['file', 'directory', 'dangling-link'] as const)('refuses an already present %s during new-scope review without changing it', present => {
  const n = fixture();
  if (present === 'file') writeFileSync(n.target.path, 'accepted');
  else if (present === 'directory') mkdirSync(n.target.path);
  else symlinkSync(join(n.directory, 'missing'), n.target.path);
  expect(() => n.authority.reviewNewScopes([n.target])).toThrow(/already exist/); expect(lstatSync(n.target.path)).toBeTruthy(); expect(n.authority.status().adoptedSelections).toBe(0);
});
it.each(['target-created', 'parent-replaced', 'parent-modified', 'reservation-added', 'budget-changed'] as const)('invalidates new-scope approval after %s', change => {
  const n = fixture(), review = n.authority.reviewNewScopes([n.target]);
  if (change === 'target-created') mkdirSync(n.target.path);
  if (change === 'parent-replaced') { renameSync(n.parent, n.parent + '-retained'); mkdirSync(n.parent); }
  if (change === 'parent-modified') writeFileSync(join(n.parent, 'unknown'), 'retain');
  if (change === 'reservation-added') n.authority.reserve({ path: join(n.directory, 'reserved'), component: 'test', scope: 'file', maximumBytes: 1 });
  if (change === 'budget-changed') { const limit = n.authority.reviewLimit(CONTROL + 10241); n.authority.applyLimit(limit.limitBytes, limit.approvalDigest); }
  expect(() => n.authority.approveNewScopes([n.target], review.approvalDigest)).toThrow(/already exist|approval changed/);
  expect(n.authority.status().adoptedSelections).toBe(0);
});
it.each(['adopted-root', 'existing-allocation', 'retained-descendant'] as const)('refuses declaring a missing %s new', kind => {
  const n = fixture();
  if (kind === 'adopted-root') {
    mkdirSync(n.target.path); writeFileSync(join(n.target.path, 'work'), 'accepted');
    const review = n.authority.reviewExisting([n.target]); n.authority.adoptExisting([n.target], review.approvalDigest); rmSync(n.target.path, { recursive: true });
  } else n.authority.reserve({ path: kind === 'existing-allocation' ? n.target.path : join(n.target.path, 'child'), component: 'history', scope: 'directory', maximumBytes: 100 });
  const before = n.authority.status(); expect(() => n.authority.reviewNewScopes([n.target])).toThrow(/overlaps retained/); expect(n.authority.status()).toEqual(before);
});
it('requires an existing ordinary immediate parent and refuses authority-internal paths', () => {
  const n = fixture();
  expect(() => n.authority.reviewNewScopes([{ ...n.target, path: join(n.target.path, 'nested') }])).toThrow(/parent/);
  expect(() => n.authority.reviewNewScopes([{ ...n.target, path: join(n.ledger, 'new') }])).toThrow(/control headroom/);
  expect(n.authority.status().adoptedSelections).toBe(0);
});
it('deduplicates exact targets but rejects conflicting scopes and excessive target counts', () => {
  const n = fixture(); expect(n.authority.reviewNewScopes([n.target, n.target]).targets).toHaveLength(1);
  expect(() => n.authority.reviewNewScopes([n.target, { ...n.target, scope: 'file' }])).toThrow(/conflicting/);
  expect(() => n.authority.reviewNewScopes(Array(257).fill(n.target))).toThrow(/bounded/);
  expect(() => n.authority.reviewNewScopes([])).toThrow(/bounded/);
});
it('detects a parent changed within its absence scan and bounds its deadline', () => {
  const n = fixture(); let changed = false;
  vi.mocked(lstatSync).mockImplementation(((path: string, options: unknown) => {
    const result = actual.lstatSync(path, options as any);
    if (String(path) === n.parent && !changed) { changed = true; writeFileSync(join(n.parent, 'unknown'), 'retained'); }
    return result;
  }) as typeof lstatSync);
  expect(() => n.authority.reviewNewScopes([n.target])).toThrow(/parent changed/); expect(n.authority.status().adoptedSelections).toBe(0);
  vi.mocked(lstatSync).mockImplementation(actual.lstatSync);
  const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(31000);
  try { expect(() => n.authority.reviewNewScopes([n.target])).toThrow(/deadline/); } finally { clock.mockRestore(); }
});
it('retains the old primary after a failed scope flush and refuses further use until reopen', () => {
  const n = fixture(), review = n.authority.reviewNewScopes([n.target]), before = readFileSync(join(n.ledger, 'reservations.json'));
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('injected scope flush failure'); });
  expect(() => n.authority.approveNewScopes([n.target], review.approvalDigest)).toThrow(/scope flush/);
  expect(() => n.authority.status()).toThrow(/uncertain/); expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(before);
  expect(n.open(false).status().adoptedSelections).toBe(0); expect(existsSync(n.target.path)).toBe(false);
});
it.each(['before-rename', 'after-rename', 'approved'] as const)('retains the correct new-scope decision across SIGKILL at %s', async boundary => {
  const n = fixture(); n.authority.close();
  const child = fork(new URL('./fixtures/storage-new-scope-child.ts', import.meta.url), [n.ledger, n.id, n.target.path, boundary], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let error = ''; child.stderr?.on('data', value => { error += value.toString(); }); const exited = once(child, 'exit'), timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  try { expect(await exited, error).toEqual([null, 'SIGKILL']); } finally { clearTimeout(timeout); }
  expect(existsSync(n.target.path)).toBe(false); const owner = n.open(false); expect(owner.status()).toMatchObject({ adoptedSelections: boundary === 'before-rename' ? 0 : 1, adoptedBytes: 0, components: 0 }); owner.close();
  if (boundary === 'before-rename') expect(n.open).toThrow(/Adopt existing/);
  else { const scoped = n.open(); scoped.reserve({ ...n.target, component: 'future', maximumBytes: 10240 }); expect(scoped.status().availableBytes).toBe(0); }
}, 15000);

it('does not reinterpret an approved new directory itself as a file output', () => {
  const n = fixture(), review = n.authority.reviewNewScopes([n.target]); n.authority.approveNewScopes([n.target], review.approvalDigest);
  const scoped = n.open();
  expect(() => scoped.reserve({ ...n.target, scope: 'file', component: 'file', maximumBytes: 1 })).toThrow(/no reviewed/);
  expect(existsSync(n.target.path)).toBe(false); expect(scoped.status().components).toBe(0);
});

it('exposes read-only scope coverage without turning missing retained storage into a new approval', () => {
  const n = fixture(), before = readFileSync(join(n.ledger, 'reservations.json'));
  expect(n.authority.reviewScope(n.target)).toMatchObject({ reviewed: false, reserved: false });
  expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(before);
  const approved = n.authority.reviewNewScopes([n.target]); n.authority.approveNewScopes([n.target], approved.approvalDigest);
  expect(n.authority.reviewScope(n.target)).toMatchObject({ reviewed: true, reserved: false });
  n.authority.reserve({ ...n.target, maximumBytes: 100, component: 'test:retained-history' });
  expect(n.authority.reviewScope(n.target)).toMatchObject({ reviewed: true, reserved: true });
  expect(n.authority.reviewScope({ path: join(n.target.path, 'child'), scope: 'file' })).toMatchObject({ reviewed: true, reserved: true });
  expect(() => n.authority.reviewNewScopes([n.target])).toThrow(/overlaps retained/);
  expect(existsSync(n.target.path)).toBe(false);
  n.authority.close(); expect(() => n.authority.reviewScope(n.target)).toThrow(/closed/);
});
it('keeps filesystem review evidence distinct from ledger revisions without relaxing approval binding', () => {
  const n = fixture(), existing = join(n.directory, 'existing'); mkdirSync(existing); writeFileSync(join(existing, 'record'), 'retained');
  const targets = [{ path: existing, scope: 'directory' as const }];
  const first = n.authority.reviewExisting(targets), absent = n.authority.reviewNewScopes([n.target]);
  n.authority.adoptExisting(targets, first.approvalDigest);
  const second = n.authority.reviewExisting(targets), updated = n.authority.reviewNewScopes([n.target]);
  expect(second.metadataDigest).toBe(first.metadataDigest); expect(second.approvalDigest).not.toBe(first.approvalDigest);
  expect(updated.metadataDigest).toBe(absent.metadataDigest); expect(updated.approvalDigest).not.toBe(absent.approvalDigest);
  expect(() => n.authority.approveNewScopes([n.target], absent.approvalDigest)).toThrow(/approval changed/);
  writeFileSync(join(existing, 'record'), 'changed'); expect(n.authority.reviewExisting(targets).metadataDigest).not.toBe(first.metadataDigest);
});
