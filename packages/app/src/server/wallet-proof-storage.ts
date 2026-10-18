/** Explicit personal-wallet funding. Never creates an authority or borrows relay reserves. */
import { isAbsolute, resolve } from 'node:path';
import { openStorageReservationAuthority } from '@resonance/core/storage-reservations';
import type { AdmissionPolicyArchiveLimits } from '@resonance/core/admission-policy-archive';
import { readOperatorJson } from '@resonance/relay';

export interface WalletProofStorageSelection {
  version: 1;
  authorityDirectory: string;
  authorityId: string;
  walletDirectory: string;
  directory: string;
  maxCiphertextBytes: number;
  maxRecords: number;
  limits: AdmissionPolicyArchiveLimits;
}
const fields = (value: unknown, names: string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const absolute = (value: unknown): value is string => typeof value === 'string'
  && value.length <= 4096 && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);

export function parseWalletProofStorageSelection(value: unknown, walletDirectory: string): WalletProofStorageSelection {
  if (!fields(value, ['version', 'authorityDirectory', 'authorityId', 'walletDirectory', 'directory', 'maxCiphertextBytes', 'maxRecords', 'limits'])
    || value.version !== 1 || !absolute(value.authorityDirectory) || !absolute(value.walletDirectory) || !absolute(value.directory)
    || typeof value.authorityId !== 'string' || !/^[a-f0-9]{32}$/.test(value.authorityId)
    || resolve(value.walletDirectory) !== resolve(walletDirectory)
    || !positive(value.maxCiphertextBytes) || !positive(value.maxRecords)
    || !fields(value.limits, ['maxPages', 'maxEntries', 'maxArchiveBytes', 'maxHistoryBytes', 'maxTransitions', 'maxPageReads', 'timeoutMs'])
    || Object.values(value.limits).some(n => !Number.isSafeInteger(n) || (n as number) < 0)
    || !positive(value.limits.timeoutMs) || value.limits.timeoutMs > 2_147_483_647) {
    throw new Error('Invalid personal wallet proof storage selection');
  }
  return structuredClone(value) as unknown as WalletProofStorageSelection;
}

export function openWalletProofStorageSelection(walletDirectory: string,
  file = process.env.RESONANCE_WALLET_PROOF_STORAGE_SELECTION_FILE) {
  if (file === undefined) return undefined;
  if (!absolute(file)) throw new Error('Wallet proof storage selection needs an absolute file path');
  const selected = parseWalletProofStorageSelection(readOperatorJson(file, 16384), walletDirectory);
  const authority = openStorageReservationAuthority({ directory: selected.authorityDirectory,
    authorityId: selected.authorityId, mode: 'open-existing', requireAdoptedScopes: true });
  return {
    proofStorage: { authority, authorityId: selected.authorityId, directory: selected.directory,
      maxCiphertextBytes: selected.maxCiphertextBytes, maxRecords: selected.maxRecords, limits: selected.limits },
    close: () => authority.close(),
  };
}
