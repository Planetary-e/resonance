/** One explicit selection per desktop operation, separate from writer ownership. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { join, resolve } from 'node:path';
import { getDataDir } from '@resonance/node';
import { readRelayStorageSnapshot, openSelectedRelayStorageOwner, withRelayStorageControls, type RelayStorageOwner, type RelayStorageConfiguration } from '@resonance/relay';
import type { StorageReservationRequest } from '@resonance/core/storage-reservations';

export function desktopRelayStorageControls(directory: string): StorageReservationRequest[] {
  return [
    { path: join(directory, 'relay-desktop-control.lock'), scope: 'file', component: 'local-state-lock', maximumBytes: 8192 },
    { path: join(directory, 'relay-config.json'), scope: 'file', component: 'operator-atomic-output', maximumBytes: 9 * 65536 + 8192 },
  ];
}
export interface DesktopRelayStorage {
  file: string; source: ReturnType<typeof readRelayStorageSnapshot>['source']; configuration: RelayStorageConfiguration;
  assertCurrent(): void;
  controls<T>(operation: () => T & (T extends PromiseLike<unknown> ? never : unknown)): T;
  stopped(signal?: AbortSignal): Promise<RelayStorageOwner>;
}
export function readDesktopRelayStorage(config: { port: number; runtime?: { storageSelectionFile?: string } }): DesktopRelayStorage | undefined {
  const retained = config.runtime?.storageSelectionFile, override = process.env.RESONANCE_RELAY_STORAGE_SELECTION_FILE;
  if (retained && override !== undefined && resolve(override) !== resolve(retained)) {
    throw new Error('Changing an existing storage selection requires a separately reviewed migration');
  }
  const file = override ?? retained;
  if (!file) return undefined;
  const snapshot = readRelayStorageSnapshot(file), selected = snapshot.configuration, directory = getDataDir();
  if (resolve(selected.runtimeDirectory) !== resolve(join(directory, 'relay-data'))
    || selected.runtimePort !== config.port || selected.runtimeHost !== '127.0.0.1') {
    throw new Error('Desktop relay settings differ from their selected storage directory, port or host');
  }
  for (const request of desktopRelayStorageControls(directory)) {
    if (!selected.controls.some(control => resolve(control.path) === resolve(request.path) && control.scope === request.scope
      && control.component === request.component && control.maximumBytes >= request.maximumBytes)) {
      throw new Error('Storage selection is missing a required prepaid desktop control');
    }
  }
  const assertCurrent = () => {
    if (JSON.stringify(readRelayStorageSnapshot(file).source) !== JSON.stringify(snapshot.source)) throw new Error('Desktop storage selection changed during the operation');
  };
  return { file: resolve(file), source: { ...snapshot.source }, configuration: structuredClone(selected), assertCurrent,
    controls<T>(operation: () => T & (T extends PromiseLike<unknown> ? never : unknown)): T {
      assertCurrent(); return withRelayStorageControls(selected, selected.controls, operation);
    },
    stopped(signal?: AbortSignal) { return openSelectedRelayStorageOwner(file, { purpose: 'maintenance', signal, expectedSource: snapshot.source }); },
  };
}
const active = new AsyncLocalStorage<DesktopRelayStorage | undefined>();
export function currentDesktopRelayStorage(): DesktopRelayStorage | undefined { return active.getStore(); }
export function withDesktopRelayStorage<T>(selected: DesktopRelayStorage | undefined, operation: () => T): T { return active.run(selected, operation); }

/** Bounded immutable publication attempts. Partial files retain their allocations;
 * a retry uses another reviewed slot rather than overwriting uncertain output. */
export const DESKTOP_STORAGE_SELECTION_FILENAME = 'relay-storage-selection.json';
export function desktopStorageSelectionPaths(directory: string): string[] {
  return Array.from({ length: 8 }, (_, index) => join(directory, index === 0 ? DESKTOP_STORAGE_SELECTION_FILENAME
    : `${DESKTOP_STORAGE_SELECTION_FILENAME}.attempt-${index}.json`));
}
