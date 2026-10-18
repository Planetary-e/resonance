/** Fixed allocation-authority checkpoint owner. No restoration or role selection is exposed. */
import type { SigningKeyPair } from '@resonance/core';
import type { HistoryCheckpointContext, HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import type { HistoryCheckpointTransport, HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';
import { openProtectedCheckpointOwner } from './protected-checkpoint-owner.js';

export const PROTECTED_ALLOCATION_AUTHORITY_OWNER_DOMAIN = 'resonance:protected-admission-allocation-authority:v1';
export const PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FENCE = 'allocation-authority-recovery-fence.json';
export interface ProtectedAllocationAuthorityHistoryOptions<T> {
  path: string; writerDirectory: string; encryptionKey: Uint8Array; context: HistoryCheckpointContext;
  signingKey: SigningKeyPair; members: HistoryReplicaEndpoint[]; initial: T;
  timeoutMs?: number; transport?: HistoryCheckpointTransport; maxArchiveBlocks?: number; maxArchiveBytes?: number;
  validate(value: unknown): T | Promise<T>;
  assertTransition(previous: T, next: T): void | Promise<void>;
  validateGenesis(image: T): void | Promise<void>;
  initialize?: boolean;
}
export interface ProtectedAllocationAuthorityHistoryStatus {
  ready: boolean; busy: boolean; pending: boolean; fenced: boolean;
  applied: { sequence: number; id: string } | null; rootId: string;
  retainedBlocks: number; retainedCiphertextBytes: number; maximumBlocks: number; maximumCiphertextBytes: number;
}
export interface ProtectedAllocationAuthorityHistory<T> {
  read(): T; commit(value: T, assertBeforeIntent?: () => void): Promise<void>; ready(): Promise<void>; assertServing(): void;
  assertCapacity(values: readonly T[]): Promise<void>;
  status(): ProtectedAllocationAuthorityHistoryStatus;
  enrollment(): { context: HistoryCheckpointContext; root: HistoryCheckpointEnvelope };
  close(): void;
}
export async function openProtectedAllocationAuthorityHistory<T>(options: ProtectedAllocationAuthorityHistoryOptions<T>): Promise<ProtectedAllocationAuthorityHistory<T>> {
  const allowed = ['path', 'writerDirectory', 'encryptionKey', 'context', 'signingKey', 'members', 'initial', 'timeoutMs', 'transport', 'maxArchiveBlocks', 'maxArchiveBytes',
    'validate', 'assertTransition', 'validateGenesis', 'initialize'];
  if (Object.keys(options).some(key => !allowed.includes(key))) throw new Error('Allocation history role, domains and recovery behavior are fixed');
  const history = await openProtectedCheckpointOwner({ ...options, domain: PROTECTED_ALLOCATION_AUTHORITY_OWNER_DOMAIN,
    initializeWriter: options.initialize === true, initializeArchive: options.initialize === true },
  { role: 'admission-allocation-authority', kind: 'protected-admission-allocation-authority', fenceFilename: PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FENCE,
    fenceDomain: 'resonance:admission-allocation-authority-recovery-fence:v1', replayDomain: 'resonance:admission-allocation-authority-replay:v1', allowRecovery: false });
  const { reviewRecoverySource: _internalRecovery, ...api } = history;
  return api;
}
