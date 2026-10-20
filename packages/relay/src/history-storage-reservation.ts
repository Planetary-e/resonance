/** Ciphertext and its manifest share one authority, but retain separate peaks.
 * Reserve both before any directory, block, snapshot or local lock is created.
 * A serial immutable-block write uses the remaining ciphertext capacity: rename
 * publishes that same inode, so no second copy of the block is charged.
 */
import { join } from 'node:path';
import { reserveManagedStorage } from '@resonance/core/storage-reservations';
export function reserveHistoryStorage(options: {
  directory: string; component: string; ciphertextBytes: number;
  manifestFilename: string; manifestBytes: number;
}) {
  const blocks = reserveManagedStorage({ path: options.directory, component: options.component,
    scope: 'directory', maximumBytes: options.ciphertextBytes });
  const manifest = reserveManagedStorage({ path: join(options.directory, options.manifestFilename),
    component: 'encrypted-local-state', scope: 'file', maximumBytes: 2 * options.manifestBytes + 8192 });
  return { assertWritable() { blocks?.assertWritable(); manifest?.assertWritable(); } };
}
