import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStorageReservationAuthority, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL } from '@resonance/core/storage-reservations';
import { openRelayStorageOwner, withRelayStorageControls } from '../relay-storage-owner.js';
import { beginRelayMaintenance, finishRelayMaintenance } from '../relay-maintenance.js';
import { parseRelayStorageConfiguration, readRelayStorageConfiguration, RELAY_STORAGE_SELECTION_MAX_BYTES as MAXIMUM } from '../relay-storage-selection.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, readSync: vi.fn(fs.readSync), writeSync: vi.fn(fs.writeSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown> = [];
afterEach(() => { vi.mocked(readSync).mockReset().mockImplementation(actual.readSync); vi.mocked(writeSync).mockReset().mockImplementation(actual.writeSync); for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(extra = MAXIMUM) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'storage-selection-'))); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = join(directory, 'authority'), data = join(directory, 'managed'), runtimeDirectory = join(data, 'relay-data');
  const authority = openStorageReservationAuthority({ directory: ledger, mode: 'create-new', limitBytes: CONTROL + 9216 + extra }); cleanup.push(authority.close);
  const targets = [{ path: data, scope: 'directory' as const }], review = authority.reviewNewScopes(targets); authority.approveNewScopes(targets, review.approvalDigest);
  const selection = { authorityDirectory: ledger, authorityId: authority.status().authorityId, runtimeDirectory }; authority.close();
  const runtime = openRelayStorageOwner(selection, 'runtime'); runtime.run(() => beginRelayMaintenance(runtimeDirectory)); runtime.close();
  const owner = openRelayStorageOwner(selection, 'maintenance'); cleanup.push(owner.close);
  const output = join(data, 'selection.json'); return { directory, ledger, data, output, selection, owner };
}
it('reviews without output or allocation and exports exact independent pins at a full budget', () => {
  const n = fixture(), before = readFileSync(join(n.ledger, 'reservations.json')), review = n.owner.reviewSelectionOutput(n.output);
  expect(existsSync(n.output)).toBe(false); expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(before);
  review.configuration.authorityId = '0'.repeat(32); // The caller does not own the retained review data.
  n.owner.exportSelection(n.output, review.approvalDigest); expect(n.owner.status()).toMatchObject({ availableBytes: 0, components: 3 });
  const value = readRelayStorageConfiguration(n.output); expect(value).toMatchObject(n.selection); expect(value.controls).toEqual([]);
  const bytes = readFileSync(n.output); expect(() => n.owner.exportSelection(n.output, review.approvalDigest)).toThrow(/already exist/); expect(readFileSync(n.output)).toEqual(bytes);
  n.owner.close(); withRelayStorageControls(value, value.controls, () => finishRelayMaintenance(value.runtimeDirectory));
  const reopened = openRelayStorageOwner(value, 'runtime', value.controls); cleanup.push(reopened.close); expect(reopened.status().availableBytes).toBe(0);
});
it('refuses unfunded or unreviewed outputs during review before creating files', () => {
  const n = fixture(MAXIMUM - 1);
  expect(() => n.owner.reviewSelectionOutput(n.output)).toThrow(/does not fit/);
  expect(() => n.owner.reviewSelectionOutput(join(n.directory, 'unreviewed.json'))).toThrow(/no reviewed/);
  expect(existsSync(n.output)).toBe(false); expect(n.owner.status().components).toBe(2);
});
it('rejects stale export approval after a parent change, target change or another reservation', () => {
  const n = fixture(2 * MAXIMUM), review = n.owner.reviewSelectionOutput(n.output);
  writeFileSync(join(n.data, 'unknown'), 'retained');
  expect(() => n.owner.exportSelection(n.output, review.approvalDigest)).toThrow(/approval changed/);
  const fresh = n.owner.reviewSelectionOutput(n.output);
  expect(() => n.owner.exportSelection(join(n.data, 'other.json'), fresh.approvalDigest)).toThrow(/approval changed/);
  const other = join(n.data, 'other.json'), otherReview = n.owner.reviewSelectionOutput(other); n.owner.exportSelection(other, otherReview.approvalDigest);
  expect(() => n.owner.exportSelection(n.output, fresh.approvalDigest)).toThrow(/approval changed/); expect(existsSync(n.output)).toBe(false);
});
it('preserves partial output and its reservation after a failed write without falling back or replacing it', () => {
  const n = fixture(), review = n.owner.reviewSelectionOutput(n.output);
  // Failure injection must target the selection bytes, independent of ledger write counts.
  vi.mocked(writeSync).mockImplementation(((fd: number, bytes: Uint8Array, ...rest: unknown[]) => {
    if (Buffer.from(bytes).toString('utf8').includes('"kind":"relay-storage-selection"')) return 0;
    return (actual.writeSync as (...args: unknown[]) => number)(fd, bytes, ...rest);
  }) as typeof writeSync);
  expect(() => n.owner.exportSelection(n.output, review.approvalDigest)).toThrow(/write stopped/);
  expect(existsSync(n.output)).toBe(true); expect(n.owner.status()).toMatchObject({ availableBytes: 0, components: 3 });
  expect(() => readRelayStorageConfiguration(n.output)).toThrow(/invalid/);
  expect(() => n.owner.exportSelection(n.output, review.approvalDigest)).toThrow(/already exist/); expect(readFileSync(n.output).length).toBe(0);
});
it.each(['oversized', 'corrupt', 'hard-link', 'symlink', 'missing'] as const)('refuses a %s selection and never initializes its authority', kind => {
  const n = fixture(), review = n.owner.reviewSelectionOutput(n.output); n.owner.exportSelection(n.output, review.approvalDigest); n.owner.close();
  if (kind === 'oversized') writeFileSync(n.output, ' '.repeat(MAXIMUM + 1));
  if (kind === 'corrupt') writeFileSync(n.output, 'private malformed contents');
  if (kind === 'hard-link') linkSync(n.output, n.output + '-alias');
  if (kind === 'symlink') { renameSync(n.output, n.output + '-retained'); symlinkSync(n.output + '-retained', n.output); }
  if (kind === 'missing') rmSync(n.output);
  const before = readFileSync(join(n.ledger, 'reservations.json')); expect(() => readRelayStorageConfiguration(n.output)).toThrow();
  expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(before);
});
it('detects replacement during its bounded read without returning stale pins', () => {
  const n = fixture(), review = n.owner.reviewSelectionOutput(n.output); n.owner.exportSelection(n.output, review.approvalDigest); const contents = readFileSync(n.output); let changed = false;
  vi.mocked(readSync).mockImplementation(((...args: unknown[]) => {
    const count = (actual.readSync as (...values: unknown[]) => number)(...args);
    if (!changed) { changed = true; renameSync(n.output, n.output + '-retained'); writeFileSync(n.output, contents); }
    return count;
  }) as typeof readSync);
  expect(() => readRelayStorageConfiguration(n.output)).toThrow(/changed/); expect(changed).toBe(true);
});
it('requires stopped ownership and rejects export after the owner closes', () => {
  const n = fixture(); n.owner.close(); expect(() => n.owner.reviewSelectionOutput(n.output)).toThrow(/stopped maintenance/);
  withRelayStorageControls(n.selection, [], () => finishRelayMaintenance(n.selection.runtimeDirectory));
  const runtime = openRelayStorageOwner(n.selection, 'runtime'); cleanup.push(runtime.close);
  expect(() => runtime.reviewSelectionOutput(n.output)).toThrow(/stopped maintenance/); expect(existsSync(n.output)).toBe(false);
});
it('copies valid controls and refuses malformed, excessive or widened selections', () => {
  const n = fixture(), raw = { version: 1, kind: 'relay-storage-selection', ...n.selection,
    controls: [{ path: join(n.data, 'control'), scope: 'file', component: 'operator-output', maximumBytes: 1024 }] };
  const parsed = parseRelayStorageConfiguration(raw); raw.controls[0].maximumBytes = 2048; expect(parsed.controls[0].maximumBytes).toBe(1024);
  for (const bad of [{ ...raw, initialize: true }, { ...raw, version: 2 }, { ...raw, authorityDirectory: './relative' },
    { ...raw, controls: [{ ...raw.controls[0], component: 'history' }] }, { ...raw, controls: [{ ...raw.controls[0], maximumBytes: 1024 * 1024 + 1 }] },
    { ...raw, controls: [raw.controls[0], raw.controls[0]] }, { ...raw, controls: Array(15).fill(raw.controls[0]) }]) expect(() => parseRelayStorageConfiguration(bad)).toThrow(/selection/);
  expect(lstatSync(n.ledger).isDirectory()).toBe(true);
});
