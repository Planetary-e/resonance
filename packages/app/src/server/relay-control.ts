/** One desktop lifecycle operation across app instances sharing the data folder. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@resonance/node';
import { acquireLocalStateLock } from '@resonance/core/local-state';

export async function withRelayControl<T>(operation: () => T | Promise<T>): Promise<T> {
  const directory = getDataDir(); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = acquireLocalStateLock(join(directory, 'relay-desktop-control'));
  try { return await operation(); } finally { release(); }
}
