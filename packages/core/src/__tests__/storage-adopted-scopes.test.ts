import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL, withStorageReservationAuthority } from '../storage-reservations.js';
import { openEncryptedLocalState } from '../local-encrypted-state.js';
const cleanup: Array<() => unknown> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'adopted-scopes-'))); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = join(directory, 'authority'), data = join(directory, 'retained'); mkdirSync(data); writeFileSync(join(data, 'unknown'), 'retain');
  const authority = openStorageReservationAuthority({ directory: ledger, mode: 'create-new', limitBytes: CONTROL + 100000 }); cleanup.push(authority.close);
  const id = authority.status().authorityId;
  return { directory, ledger, data, authority, id, adopt(path = data, scope: 'file' | 'directory' = 'directory') {
    const targets = [{ path, scope }], review = authority.reviewExisting(targets); authority.adoptExisting(targets, review.approvalDigest);
  }, open() { authority.close(); const scoped = openStorageReservationAuthority({ directory: ledger, authorityId: id, mode: 'open-existing', requireAdoptedScopes: true }); cleanup.push(scoped.close); return scoped; } };
}
const file = (path: string, maximumBytes = 100) => ({ path, scope: 'file' as const, component: 'test', maximumBytes });
it('requires adoption even when an existing authority has no allocations', () => {
  const n = fixture(), before = readFileSync(join(n.ledger, 'reservations.json'));
  expect(n.open).toThrow(/Adopt existing/); expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(before);
});
it('permits new writers only beneath adopted directories and retains unknown byte floors', () => {
  const n = fixture(); n.adopt(); const scoped = n.open();
  scoped.reserve(file(join(n.data, 'new'))).assertWritable();
  scoped.reserve({ path: join(n.data, 'nested'), scope: 'directory', component: 'ciphertext', maximumBytes: 100 }).assertWritable();
  expect(scoped.status()).toMatchObject({ adoptedBytes: 6, components: 2, reservedBytes: CONTROL + 206 });
  expect(() => scoped.reserve(file(join(n.directory, 'retained-extra', 'escape')))).toThrow(/no reviewed/);
  expect(() => scoped.reserve({ path: n.directory, scope: 'directory', component: 'parent', maximumBytes: 100 })).toThrow(/no reviewed/);
  expect(readFileSync(join(n.data, 'unknown'), 'utf8')).toBe('retain');
});
it('does not expand an exact adopted file into its parent or siblings', () => {
  const n = fixture(), target = join(n.data, 'unknown'); n.adopt(target, 'file'); const scoped = n.open();
  scoped.reserve(file(target)).assertWritable();
  expect(() => scoped.reserve(file(join(n.data, 'other')))).toThrow(/no reviewed/);
  expect(() => scoped.reserve({ path: n.data, scope: 'directory', component: 'parent', maximumBytes: 100 })).toThrow(/no reviewed/);
  expect(scoped.status()).toMatchObject({ adoptedBytes: 6, components: 1 });
});
it('refuses old allocations outside adopted scopes until their files are reviewed too', () => {
  const n = fixture(), external = join(n.directory, 'older-output'); writeFileSync(external, 'unknown old output');
  n.authority.reserve(file(external)); n.adopt(); const before = readFileSync(join(n.ledger, 'reservations.json'));
  expect(n.open).toThrow(/no reviewed/); expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(before);
  const owner = openStorageReservationAuthority({ directory: n.ledger, authorityId: n.id, mode: 'open-existing' }); cleanup.push(owner.close);
  const targets = [{ path: external, scope: 'file' as const }], review = owner.reviewExisting(targets); owner.adoptExisting(targets, review.approvalDigest); owner.close();
  const scoped = n.open(); scoped.reserve(file(external)).assertWritable(); expect(scoped.status().adoptedSelections).toBe(2);
});
it('does not silently adopt a legacy v1 ledger when scoped reopening is requested', () => {
  const n = fixture(); n.authority.close(); const path = join(n.ledger, 'reservations.json'), value = JSON.parse(readFileSync(path, 'utf8'));
  value.version = 1; delete value.adoptions; writeFileSync(path, JSON.stringify(value)); const before = readFileSync(path);
  expect(n.open).toThrow(/Adopt existing/); expect(readFileSync(path)).toEqual(before);
});
it.skipIf(process.platform === 'win32')('rejects a new output redirected outside its adopted root before allocation', () => {
  const n = fixture(); n.adopt(); const scoped = n.open(), other = join(n.directory, 'outside'); mkdirSync(other); symlinkSync(other, join(n.data, 'redirect'));
  expect(() => scoped.reserve(file(join(n.data, 'redirect', 'new')))).toThrow(/no reviewed/); expect(scoped.status().components).toBe(0);
});
it.skipIf(process.platform === 'win32')('refuses reopening a redirected adopted root and retains its ledger unchanged', () => {
  const n = fixture(); n.adopt(); n.authority.close(); const before = readFileSync(join(n.ledger, 'reservations.json'));
  renameSync(n.data, n.data + '-retained'); const other = join(n.directory, 'outside'); mkdirSync(other); symlinkSync(other, n.data);
  expect(n.open).toThrow(/redirected/); expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(before);
});
it('refuses an actual encrypted writer outside reviewed storage before creating state', () => {
  const n = fixture(); n.adopt(); const scoped = n.open(), path = join(n.directory, 'unreviewed');
  expect(() => withStorageReservationAuthority(scoped, () => openEncryptedLocalState({ path: join(path, 'state'), key: new Uint8Array(32), domain: 'test', maxBytes: 1024, initial: { n: 0 }, validate: (value: unknown): value is { n: number } => !!value && typeof value === 'object' && 'n' in value && Number.isSafeInteger(value.n) }))).toThrow(/no reviewed/);
  expect(existsSync(path)).toBe(false); expect(scoped.status().components).toBe(0);
});
