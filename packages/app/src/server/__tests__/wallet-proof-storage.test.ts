import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorageReservationAuthority } from '@resonance/core/storage-reservations';
import { openWalletProofStorageSelection, parseWalletProofStorageSelection } from '../wallet-proof-storage.js';

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wallet-proof-selection-')); directories.push(root);
  return { root, value: { version: 1 as const, authorityDirectory: join(root, 'authority'), authorityId: 'ab'.repeat(16),
    walletDirectory: join(root, 'wallet'), directory: join(root, 'proof'), maxCiphertextBytes: 1024 * 1024, maxRecords: 100,
    limits: { maxPages: 10, maxEntries: 100, maxArchiveBytes: 1024 * 1024, maxHistoryBytes: 1024 * 1024,
      maxTransitions: 100, maxPageReads: 100, timeoutMs: 3000 } } };
}
it('leaves unconfigured legacy wallets alone without creating a storage authority', () => {
  vi.stubEnv('RESONANCE_WALLET_PROOF_STORAGE_SELECTION_FILE', undefined);
  expect(openWalletProofStorageSelection('/unused/wallet')).toBeUndefined();
});
it('copies explicit limits and refuses wrong wallet, missing limits or extra configuration', () => {
  const { value } = fixture();
  const parsed = parseWalletProofStorageSelection(value, value.walletDirectory);
  value.limits.maxTransitions = 1;
  expect(parsed.limits.maxTransitions).toBe(100);
  for (const invalid of [{ ...value, walletDirectory: '/other' }, { ...value, maxRecords: 0 },
    { ...value, authorityId: 'unknown' }, { ...value, limits: {} }, { ...value, autoCreate: true },
    { ...value, limits: { ...value.limits, timeoutMs: Infinity } }]) {
    expect(() => parseWalletProofStorageSelection(invalid, value.walletDirectory)).toThrow('Invalid personal wallet');
  }
});
it('opens only the selected existing authority and releases ownership', () => {
  const { root, value } = fixture(), file = join(root, 'selection.json');
  writeFileSync(file, JSON.stringify(value));
  expect(() => openWalletProofStorageSelection(value.walletDirectory, file)).toThrow();
  const initial = openStorageReservationAuthority({ directory: value.authorityDirectory, mode: 'create-new',
    authorityId: value.authorityId, limitBytes: 10 * 1024 * 1024 });
  const scopes = [{ path: value.walletDirectory, scope: 'directory' as const }, { path: value.directory, scope: 'directory' as const }];
  initial.approveNewScopes(scopes, initial.reviewNewScopes(scopes).approvalDigest); initial.close();
  const selected = openWalletProofStorageSelection(value.walletDirectory, file)!;
  expect(selected.proofStorage.authorityId).toBe(value.authorityId);
  expect(() => openWalletProofStorageSelection(value.walletDirectory, file)).toThrow();
  selected.close();
  openWalletProofStorageSelection(value.walletDirectory, file)!.close();
  writeFileSync(file, JSON.stringify({ ...value, authorityId: 'cd'.repeat(16) }));
  expect(() => openWalletProofStorageSelection(value.walletDirectory, file)).toThrow();
});
