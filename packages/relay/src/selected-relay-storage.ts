import { isAbsolute, resolve } from 'node:path';
import { relayPortClosed } from './relay-listener.js';
import { readRelayStorageSnapshot } from './relay-storage-selection.js';
import { openRelayStorageOwner } from './relay-storage-owner.js';
export async function openSelectedRelayStorageOwner(file: string, options: ({ purpose: 'runtime'; runtimeDirectory: string; runtimePort: number; runtimeHost: string } | { purpose: 'maintenance' }) & { signal?: AbortSignal; expectedSource?: ReturnType<typeof readRelayStorageSnapshot>['source'] }) {
  options = { ...options }; options.signal?.throwIfAborted();
  const before = readRelayStorageSnapshot(file), selected = before.configuration;
  if (options.expectedSource && JSON.stringify(before.source) !== JSON.stringify(options.expectedSource)) {
    throw new Error('Selected storage file changed since the operation acquired control');
  }
  if (options.purpose === 'runtime' && (typeof options.runtimeDirectory !== 'string' || !isAbsolute(options.runtimeDirectory)
    || resolve(options.runtimeDirectory) !== resolve(selected.runtimeDirectory) || options.runtimePort !== selected.runtimePort || options.runtimeHost !== selected.runtimeHost)) {
    throw new Error('Runtime directory, port or host differs from its explicit storage selection');
  }
  const owner = openRelayStorageOwner(selected, options.purpose, selected.controls);
  try {
    if (!await relayPortClosed(selected.runtimePort)) throw new Error('Configured relay listener is not closed; stop it before managed storage work');
    options.signal?.throwIfAborted();
    if (JSON.stringify(readRelayStorageSnapshot(file).source) !== JSON.stringify(before.source)) throw new Error('Selected storage file changed during ownership acquisition');
    return owner;
  } catch (error) { owner.close(); throw error; }
}
