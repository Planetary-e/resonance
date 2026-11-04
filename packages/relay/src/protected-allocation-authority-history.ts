/** Fixed allocation-authority owner. Business callers authenticate restoration capabilities before entering this adapter. */
import type { SigningKeyPair } from '@resonance/core';
import type { HistoryCheckpointContext, HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import type { HistoryCheckpointTransport, HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';
import { openProtectedCheckpointOwner, checkpointOwnerReplayDigest, readProtectedCheckpointOwnerRecoverySource, fenceProtectedCheckpointOwnerRecoverySource } from './protected-checkpoint-owner.js';

export const PROTECTED_ALLOCATION_AUTHORITY_OWNER_DOMAIN = 'resonance:protected-admission-allocation-authority:v1';
export const PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FENCE = 'allocation-authority-recovery-fence.json';
export const protectedAllocationAuthorityReplayDigest = (contextId: string, genesisId: string, proposalId: string, image: unknown): string =>
  checkpointOwnerReplayDigest('resonance:admission-allocation-authority-replay:v1', contextId, genesisId, proposalId, image);
export interface ProtectedAllocationAuthorityHistoryRestoration<T> {
  genesis: HistoryCheckpointEnvelope; root: HistoryCheckpointEnvelope; baseline: T; replayDigest: string;
}
export interface ProtectedAllocationAuthorityHistoryRecoverySource<T> {
  readonly path: string; readonly writerDirectory: string; readonly contextId: string; readonly genesisId: string;
  readonly rootId: string; readonly generation: number; readonly stateDigest: string;
}
export interface ProtectedAllocationAuthorityHistoryRecoveryEvidence<T> extends ProtectedAllocationAuthorityHistoryRecoverySource<T> {
  context: HistoryCheckpointContext; genesis: HistoryCheckpointEnvelope; root: HistoryCheckpointEnvelope;
  minimumEvidence: T[]; applied: { sequence: number; id: string } | null; pending: { sequence: number; id: string } | null;
}
export function readProtectedAllocationAuthorityHistoryRecoverySource<T>(source: ProtectedAllocationAuthorityHistoryRecoverySource<T>): ProtectedAllocationAuthorityHistoryRecoveryEvidence<T> {
  const evidence = readProtectedCheckpointOwnerRecoverySource<T>(source);
  if (evidence.context.role !== 'admission-allocation-authority') throw new Error('Allocation authority recovery source has another history role');
  return evidence;
}
export async function fenceProtectedAllocationAuthorityHistoryRecoverySource<T>(source: ProtectedAllocationAuthorityHistoryRecoverySource<T>): Promise<void> {
  readProtectedAllocationAuthorityHistoryRecoverySource(source); // Check role before any irreversible fencing.
  await fenceProtectedCheckpointOwnerRecoverySource(source);
}
export interface ProtectedAllocationAuthorityHistoryOptions<T> {
  path: string; writerDirectory: string; encryptionKey: Uint8Array; context: HistoryCheckpointContext;
  signingKey: SigningKeyPair; members: HistoryReplicaEndpoint[]; initial: T;
  timeoutMs?: number; transport?: HistoryCheckpointTransport; maxArchiveBlocks?: number; maxArchiveBytes?: number;
  validate(value: unknown): T | Promise<T>;
  assertTransition(previous: T, next: T): void | Promise<void>;
  validateGenesis(image: T): void | Promise<void>;
  initialize?: boolean;
  /** Trusted internal result of business-level complete replay and reviewed capability validation. */
  restore?: ProtectedAllocationAuthorityHistoryRestoration<T>;
}
export interface ProtectedAllocationAuthorityHistoryStatus {
  ready: boolean; busy: boolean; pending: boolean; fenced: boolean;
  applied: { sequence: number; id: string } | null; rootId: string;
  retainedBlocks: number; retainedCiphertextBytes: number; maximumBlocks: number; maximumCiphertextBytes: number;
}
export interface ProtectedAllocationAuthorityHistory<T> {
  reviewRecoverySource(): Promise<ProtectedAllocationAuthorityHistoryRecoverySource<T>>;
  read(): T; commit(value: T, assertBeforeIntent?: () => void): Promise<void>; ready(): Promise<void>; assertServing(): void;
  assertCapacity(values: readonly T[]): Promise<void>;
  status(): ProtectedAllocationAuthorityHistoryStatus;
  enrollment(): { context: HistoryCheckpointContext; root: HistoryCheckpointEnvelope };
  close(): void;
}
export async function openProtectedAllocationAuthorityHistory<T>(options: ProtectedAllocationAuthorityHistoryOptions<T>): Promise<ProtectedAllocationAuthorityHistory<T>> {
  const allowed = ['path', 'writerDirectory', 'encryptionKey', 'context', 'signingKey', 'members', 'initial', 'timeoutMs', 'transport', 'maxArchiveBlocks', 'maxArchiveBytes',
    'validate', 'assertTransition', 'validateGenesis', 'initialize', 'restore'];
  if (Object.keys(options).some(key => !allowed.includes(key))) throw new Error('Allocation history role, domains and recovery behavior are fixed');
  const history = await openProtectedCheckpointOwner({ ...options, domain: PROTECTED_ALLOCATION_AUTHORITY_OWNER_DOMAIN,
    initializeWriter: options.initialize === true, initializeArchive: options.initialize === true },
  { role: 'admission-allocation-authority', kind: 'protected-admission-allocation-authority', fenceFilename: PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FENCE,
    fenceDomain: 'resonance:admission-allocation-authority-recovery-fence:v1', replayDomain: 'resonance:admission-allocation-authority-replay:v1', allowRecovery: true });
  return history;
}
