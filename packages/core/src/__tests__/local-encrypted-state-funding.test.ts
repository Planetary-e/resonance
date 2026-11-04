import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, mkdirSync, symlinkSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES } from '../storage-reservations.js';
import { withStorageReservationAuthority } from '../storage-reservation-context.js';
import { openEncryptedLocalState } from '../local-encrypted-state.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => void> = [];
afterEach(() => { vi.mocked(renameSync).mockImplementation(actual.renameSync); for (const f of cleanup.splice(0).reverse()) f(); });
function fixture(extra = 1_000_000) {
  const directory = mkdtempSync(join(tmpdir(), 'funded-state-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const authority = openStorageReservationAuthority({ directory: join(directory, 'authority'), mode: 'create-new', limitBytes: STORAGE_RESERVATION_CONTROL_BYTES + extra }); cleanup.push(authority.close);
  const options = { path: join(directory, 'state'), key: randomBytes(32), domain: 'test-funded-state', maxBytes: 100_000, initial: { pending: '', done: '' }, validate: (v: unknown): v is { pending: string; done: string } => !!v && typeof v === 'object' && typeof (v as any).pending === 'string' && typeof (v as any).done === 'string', funding: 'monotone-v1' as const };
  return { directory, authority, options };
}
it('funds accepted completion before pending, completes after authority exhaustion and restart, and never refunds', () => {
  const f = fixture();
  withStorageReservationAuthority(f.authority, () => {
    let state = openEncryptedLocalState({ ...f.options, mode: 'create-new' });
    const pending = { pending: 'accepted', done: '' }, final = { pending: '', done: 'x'.repeat(20_000) };
    state.preflight(pending, final); const reserved = f.authority.status().reservedBytes;
    state.write(pending); state.close();
    f.authority.reserve({ path: join(f.directory, 'rest'), component: 'test', scope: 'file', maximumBytes: f.authority.status().availableBytes });
    state = openEncryptedLocalState({ ...f.options, mode: 'open-existing' }); state.write(final); expect(state.read()).toEqual(final); state.write(f.options.initial); state.close();
    expect(f.authority.status().availableBytes).toBe(0); expect(f.authority.status().reservedBytes).toBeGreaterThanOrEqual(reserved);
  });
});
it('refuses unfunded growth before replacing the accepted snapshot', () => {
  const f = fixture(30_000);
  withStorageReservationAuthority(f.authority, () => {
    const state = openEncryptedLocalState({ ...f.options, mode: 'create-new' }), bytes = readFileSync(f.options.path);
    expect(() => state.preflight({ pending: '', done: 'x'.repeat(40_000) })).toThrow(/exhausted/);
    expect(readFileSync(f.options.path)).toEqual(bytes); expect(state.read()).toEqual(f.options.initial); state.close();
  });
});
it('refuses a missing reservation under a new authority, changed ceiling, changed mode and tampered funded high-water', () => {
  const f = fixture();
  withStorageReservationAuthority(f.authority, () => {
    openEncryptedLocalState({ ...f.options, mode: 'create-new' }).close();
    expect(() => openEncryptedLocalState({ ...f.options, maxBytes: 100_001, mode: 'open-existing' })).toThrow(/contract/);
    expect(() => openEncryptedLocalState({ ...f.options, funding: undefined, mode: 'open-existing' })).toThrow(/mode changed/);
    const original = readFileSync(f.options.path), record = JSON.parse(original.toString()); record.funding.highWater += 100;
    writeFileSync(f.options.path, JSON.stringify(record)); expect(() => openEncryptedLocalState({ ...f.options, mode: 'open-existing' })).toThrow(); writeFileSync(f.options.path, original);
  });
  const other = openStorageReservationAuthority({ directory: join(f.directory, 'other'), mode: 'create-new', limitBytes: STORAGE_RESERVATION_CONTROL_BYTES + 1_000_000 }); cleanup.push(other.close);
  withStorageReservationAuthority(other, () => expect(() => openEncryptedLocalState({ ...f.options, mode: 'open-existing' })).toThrow(/contract/));
});
it('retains charged growth across a failed rename and reopens the original accepted image', () => {
  const f = fixture();
  withStorageReservationAuthority(f.authority, () => {
    const state = openEncryptedLocalState({ ...f.options, mode: 'create-new' }), before = f.authority.status().reservedBytes;
    state.preflight({ pending: 'accepted', done: 'x'.repeat(10_000) }); const funded = f.authority.status().reservedBytes;
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('crash at rename'); });
    expect(() => state.write({ pending: 'accepted', done: '' })).toThrow(/crash/); state.close();
    expect(funded).toBeGreaterThan(before); expect(f.authority.status().reservedBytes).toBe(funded);
    const reopened = openEncryptedLocalState({ ...f.options, mode: 'open-existing' }); expect(reopened.read()).toEqual(f.options.initial); reopened.close();
  });
});
it('preserves the generic fixed ceiling and rejects an opt-in without an authority', () => {
  const f = fixture();
  withStorageReservationAuthority(f.authority, () => { const state = openEncryptedLocalState({ ...f.options, funding: undefined, mode: 'create-new' }); expect(f.authority.status().reservedBytes).toBe(STORAGE_RESERVATION_CONTROL_BYTES + 2 * f.options.maxBytes + 8192); state.close(); });
  expect(() => openEncryptedLocalState({ ...f.options, path: join(f.directory, 'unmanaged'), mode: 'create-new' })).toThrow(/authority/); expect(existsSync(join(f.directory, 'unmanaged'))).toBe(false);
});

it('refuses a missing committed allocation even with the selected authority identity', () => {
  const f = fixture(); withStorageReservationAuthority(f.authority, () => openEncryptedLocalState({ ...f.options, mode: 'create-new' }).close());
  const missing = openStorageReservationAuthority({ directory: join(f.directory, 'missing-ledger'), authorityId: f.authority.status().authorityId, mode: 'create-new', limitBytes: STORAGE_RESERVATION_CONTROL_BYTES + 1_000_000 }); cleanup.push(missing.close);
  withStorageReservationAuthority(missing, () => {
    const before = missing.status().reservedBytes;
    expect(() => openEncryptedLocalState({ ...f.options, mode: 'open-existing' })).toThrow(/existing storage reservation/);
    expect(missing.status().reservedBytes).toBe(before);
  });
});

it('reopens the same canonical resource through a parent alias and refuses a copied nonalias state path', () => {
  const f = fixture();
  withStorageReservationAuthority(f.authority, () => {
    mkdirSync(join(f.directory, 'real')); f.options.path = join(f.directory, 'real', 'state');
    openEncryptedLocalState({ ...f.options, mode: 'create-new' }).close();
    const alias = join(f.directory, 'alias'); symlinkSync(f.directory, alias, 'dir');
    const before = f.authority.status().reservedBytes;
    const same = openEncryptedLocalState({ ...f.options, path: join(alias, 'real', 'state'), mode: 'open-existing' }); expect(same.read()).toEqual(f.options.initial); same.close();
    expect(f.authority.status().reservedBytes).toBe(before);
    const elsewhere = join(f.directory, 'copied-state'); cpSync(f.options.path, elsewhere);
    expect(() => openEncryptedLocalState({ ...f.options, path: elsewhere, mode: 'open-existing' })).toThrow(/contract/);
    expect(f.authority.status().reservedBytes).toBe(before);
  });
});

it('reproduces the independent 512-entry resource boundary with byte capacity still available', () => {
  const f = fixture();
  for (let i = 0; i < 512; i++) f.authority.reserve({ path: join(f.directory, `slot-${i}`), component: 'minimal-entry-boundary', scope: 'file', maximumBytes: 1 });
  const before = f.authority.status(); expect(before.components).toBe(512); expect(before.availableBytes).toBeGreaterThan(900_000);
  expect(() => f.authority.reserve({ path: join(f.directory, 'slot-512'), component: 'minimal-entry-boundary', scope: 'file', maximumBytes: 1 })).toThrow(/entry capacity exhausted/);
  expect(f.authority.status()).toEqual(before);
});
