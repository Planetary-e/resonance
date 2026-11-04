import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStorageReservationAuthority, openReservedStorageControl, STORAGE_RESERVATION_CONTROL_BYTES as CONTROL, type StorageReservationRequest } from '@resonance/core/storage-reservations';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { openRelayStorageOwner, withRelayStorageControls } from '../relay-storage-owner.js';
import { acquireRelayRuntime, acquireStoppedRelayMaintenance, beginRelayMaintenance, finishRelayMaintenance, relayMaintenanceStorageRequests } from '../relay-maintenance.js';
import { writeOperatorJsonAtomic, writeOperatorJsonNew } from '../admission-operator-files.js';
const cleanup: Array<() => unknown> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const SETTINGS = 9 * 65536 + 8192, RUNTIME = 9216;
function fixture(extra = 0) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'relay-storage-owner-'))); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = join(directory, 'authority'), data = join(directory, 'managed'), runtimeDirectory = join(data, 'relay-data');
  const authority = openStorageReservationAuthority({ directory: ledger, mode: 'create-new', limitBytes: CONTROL + RUNTIME + extra }); cleanup.push(authority.close);
  const targets = [{ path: data, scope: 'directory' as const }], review = authority.reviewNewScopes(targets); authority.approveNewScopes(targets, review.approvalDigest);
  const selection = { authorityDirectory: ledger, authorityId: authority.status().authorityId, runtimeDirectory }; authority.close();
  const settings = join(data, 'relay-config.json'), desktop = join(data, 'relay-desktop-control');
  const controls: StorageReservationRequest[] = [{ path: settings, scope: 'file', component: 'operator-atomic-output', maximumBytes: SETTINGS },
    { path: desktop + '.lock', scope: 'file', component: 'local-state-lock', maximumBytes: 8192 }];
  const open = (purpose: 'runtime' | 'maintenance', extraControls: StorageReservationRequest[] = []) => { const owner = openRelayStorageOwner(selection, purpose, extraControls); cleanup.push(owner.close); return owner; };
  return { directory, ledger, data, selection, settings, desktop, controls, open };
}
it('pre-funds controls before runtime and hands stopped ownership to maintenance at exact capacity', async () => {
  const n = fixture(SETTINGS + 8192), owner = n.open('runtime', n.controls), runtime = owner.run(() => acquireRelayRuntime(n.selection.runtimeDirectory)); cleanup.push(runtime);
  expect(owner.status()).toMatchObject({ availableBytes: 0, components: 4 }); const primary = readFileSync(join(n.ledger, 'reservations.json'));
  // Leave the narrow control scope after taking the desktop lock. The lock may
  // span supervisor stop and the later exclusive authority without switching ALS.
  const desktop = withRelayStorageControls(n.selection, n.controls, () => acquireLocalStateLock(n.desktop)); cleanup.push(desktop);
  withRelayStorageControls(n.selection, n.controls, () => {
    writeOperatorJsonAtomic(n.settings, { enabled: false }, 65536); beginRelayMaintenance(n.selection.runtimeDirectory);
  });
  expect(() => n.open('maintenance', n.controls)).toThrow(/already open/);
  runtime(); owner.close(); const maintenance = n.open('maintenance', n.controls);
  await maintenance.run(async () => { await new Promise(resolve => setImmediate(resolve)); writeOperatorJsonAtomic(n.settings, { enabled: false, maintenance: true }, 65536); });
  expect(() => acquireStoppedRelayMaintenance(n.selection.runtimeDirectory)).toThrow(/already open/);
  expect(() => maintenance.run(() => writeOperatorJsonNew(join(n.data, 'unfunded'), { value: 1 }, 100))).toThrow(/exhausted/);
  expect(existsSync(join(n.data, 'unfunded'))).toBe(false); maintenance.close();
  withRelayStorageControls(n.selection, n.controls, () => finishRelayMaintenance(n.selection.runtimeDirectory)); desktop();
  const restarted = n.open('runtime', n.controls); const release = restarted.run(() => acquireRelayRuntime(n.selection.runtimeDirectory)); release();
  expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(primary); expect(JSON.parse(readFileSync(n.settings, 'utf8'))).toEqual({ enabled: false, maintenance: true });
});
it('reads aggregate committed accounting while the runtime owns the writer without changing or trusting corrupt metadata', () => {
  const n = fixture(SETTINGS + 8192), owner = n.open('runtime', n.controls);
  const view = openReservedStorageControl({ directory: n.ledger, authorityId: n.selection.authorityId, controls: n.controls }); cleanup.push(view.close);
  const path = join(n.ledger, 'reservations.json'), before = readFileSync(path);
  expect(view.status()).toEqual(owner.status()); expect(JSON.stringify(view.status())).not.toContain(n.data);
  expect(readFileSync(path)).toEqual(before);
  const changed = JSON.parse(before.toString()); changed.authorityId = 'f'.repeat(32); writeFileSync(path, JSON.stringify(changed));
  expect(() => view.status()).toThrow(/independently retained/); writeFileSync(path, '{');
  expect(() => view.status()).toThrow(/invalid/); writeFileSync(path, before);
  view.close(); expect(() => view.status()).toThrow(/closed/);
});
it('changes a selected limit only in stopped maintenance and preserves committed floors', () => {
  const n = fixture(), runtime = n.open('runtime');
  expect(() => runtime.reviewLimit(10000000)).toThrow(/stopped/); runtime.run(() => beginRelayMaintenance(n.selection.runtimeDirectory)); runtime.close();
  const owner = n.open('maintenance'), before = owner.status();
  expect(() => owner.reviewLimit(before.reservedBytes - 1)).toThrow(/cannot drop/);
  const review = owner.reviewLimit(before.limitBytes + 1024); expect(owner.status()).toEqual(before);
  expect(() => owner.applyLimit(review.limitBytes, '0'.repeat(64))).toThrow(/approval/);
  expect(owner.applyLimit(review.limitBytes, review.approvalDigest).availableBytes).toBe(1024);
});
it('refuses unpaused maintenance and paused runtime without creating a runtime directory', () => {
  const n = fixture(); expect(() => n.open('maintenance')).toThrow(/Start relay maintenance/); expect(existsSync(n.data)).toBe(false);
  const first = n.open('runtime'); first.run(() => beginRelayMaintenance(n.selection.runtimeDirectory)); first.close();
  const primary = readFileSync(join(n.ledger, 'reservations.json'));
  expect(() => n.open('runtime')).toThrow(/maintenance is active/); expect(readFileSync(join(n.ledger, 'reservations.json'))).toEqual(primary);
  const maintained = n.open('maintenance'); maintained.close(); expect(existsSync(join(n.selection.runtimeDirectory, 'relay-maintenance.json'))).toBe(true);
});
it('refuses an unfunded control before runtime output and retains completed reservations', () => {
  const n = fixture(SETTINGS - 1);
  expect(() => n.open('runtime', n.controls)).toThrow(/exhausted/); expect(existsSync(n.data)).toBe(false);
  const authority = openStorageReservationAuthority({ directory: n.ledger, authorityId: n.selection.authorityId, mode: 'open-existing' }); cleanup.push(authority.close);
  expect(authority.status().components).toBe(2);
});
it('validates controls before taking ownership or charging any reservation', () => {
  const n = fixture(SETTINGS);
  expect(() => n.open('runtime', [{ ...n.controls[0], maximumBytes: 2 * 1024 * 1024 }])).toThrow(/control scope/);
  expect(() => n.open('runtime', [{ ...n.controls[0], component: 'history' }])).toThrow(/control scope/);
  expect(() => n.open('runtime', [n.controls[0], n.controls[0]])).toThrow(/Duplicate/);
  expect(() => n.open('runtime', [{ ...n.controls[0], extra: true } as typeof n.controls[0]])).toThrow(/control scope/);
  const authority = openStorageReservationAuthority({ directory: n.ledger, authorityId: n.selection.authorityId, mode: 'open-existing' }); cleanup.push(authority.close);
  expect(authority.status().components).toBe(0); expect(existsSync(n.data)).toBe(false);
});
it('never initializes missing authority state or trusts mismatched authority pins', () => {
  const n = fixture();
  expect(() => openRelayStorageOwner({ ...n.selection, authorityId: '0'.repeat(32) }, 'runtime')).toThrow(/independently retained/);
  const primary = join(n.ledger, 'reservations.json'); rmSync(primary);
  expect(() => n.open('runtime')).toThrow(); expect(existsSync(primary)).toBe(false); expect(existsSync(n.data)).toBe(false);
});
it('rejects runtime locations outside reviewed scopes before creating their files', () => {
  const n = fixture(); n.selection.runtimeDirectory = join(n.directory, 'unreviewed');
  expect(() => n.open('runtime')).toThrow(/no reviewed/); expect(existsSync(n.selection.runtimeDirectory)).toBe(false);
});
it('retains the original selection and invalidates captured work after close', () => {
  const n = fixture(), owner = n.open('runtime'); n.selection.runtimeDirectory = join(n.directory, 'changed');
  const selected = relayMaintenanceStorageRequests(join(n.data, 'relay-data'));
  expect(owner.status().components).toBe(2);
  const primary = JSON.parse(readFileSync(join(n.ledger, 'reservations.json'), 'utf8')); expect(primary.allocations.map((entry: { path: string }) => entry.path).sort()).toEqual(selected.map(entry => entry.path).sort());
  owner.close(); expect(() => owner.run(() => writeFileSync(join(n.data, 'late'), 'forbidden'))).toThrow(/closed/);
  expect(existsSync(join(n.data, 'late'))).toBe(false);
});
it('does not let a stopped operator scope switch into another authority', () => {
  const n = fixture(), owner = n.open('runtime');
  expect(() => owner.run(() => withRelayStorageControls(n.selection, [], () => beginRelayMaintenance(n.selection.runtimeDirectory)))).toThrow(/before entering/);
  expect(existsSync(n.data)).toBe(false);
});
