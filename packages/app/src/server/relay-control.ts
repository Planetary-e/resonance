/** One desktop lifecycle operation across app instances sharing the data folder. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@resonance/node';
import type { DesktopRelayStorage } from './relay-storage.js';
import { acquireLocalStateLock } from '@resonance/core/local-state';

export async function withRelayControl<T>(operation: () => T | Promise<T>, selected?: DesktopRelayStorage): Promise<T> {
  const claim = () => {
    const directory = getDataDir(); mkdirSync(directory, { recursive: true, mode: 0o700 });
    return acquireLocalStateLock(join(directory, 'relay-desktop-control'));
  };
  // Leave the short proof scope before any later exclusive ledger acquisition.
  const release = selected ? selected.controls(claim) : claim();
  try { return await operation(); } finally { release(); }
}
