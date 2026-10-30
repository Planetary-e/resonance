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

import { canonicalLocalStatePath } from '@resonance/core/local-state';
import { assertExistingStorageReservation, captureStorageReservationOperation, currentStorageReservationAuthorityId } from '@resonance/core/storage-reservations';
export interface HistoryFundedGrowth {
  mode: 'monotone-v1'; directory: string; component: string; ceiling: number; authorityId: string; bytes: number;
}
export function historyFundedGrowth(directory: string, component: string, ceiling: number): HistoryFundedGrowth {
  return { mode: 'monotone-v1', directory: canonicalLocalStatePath(directory), component, ceiling, authorityId: currentStorageReservationAuthorityId(), bytes: 0 };
}
export function validHistoryFundedGrowth(value: unknown, expected: HistoryFundedGrowth): value is HistoryFundedGrowth {
  if (!value || typeof value !== 'object') return false;
  const v = value as HistoryFundedGrowth;
  return Object.keys(v).sort().join(',') === Object.keys(expected).sort().join(',')
    && Object.entries(expected).every(([k, x]) => k === 'bytes' || v[k as keyof HistoryFundedGrowth] === x)
    && Number.isSafeInteger(v.bytes) && v.bytes >= 0 && v.bytes <= expected.ceiling;
}
export function openHistoryFundedGrowth(initial: HistoryFundedGrowth, reopening: boolean) {
  const run = captureStorageReservationOperation();
  let contract = { ...initial };
  const request = (bytes: number) => ({ path: contract.directory, component: contract.component, scope: 'directory' as const, maximumBytes: bytes });
  if (reopening) assertExistingStorageReservation(request(contract.bytes), contract.authorityId);
  let lease = reserveManagedStorage(request(contract.bytes));
  return {
    assertExisting(bytes = 0) {
      if (bytes > contract.bytes) throw new Error('Retained ciphertext exceeds existing funding');
      run(() => assertExistingStorageReservation(request(contract.bytes), contract.authorityId)); lease?.assertWritable();
    },
    reserve(bytes: number) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > contract.ceiling) throw new Error('History ciphertext funding ceiling exceeded');
      if (bytes > contract.bytes) { run(() => { lease = reserveManagedStorage(request(bytes)); }); contract = { ...contract, bytes }; }
      return { ...contract };
    },
  };
}
