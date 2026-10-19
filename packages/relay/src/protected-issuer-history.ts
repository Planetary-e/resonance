/** Fixed admission-issuer role. Existing disk bytes, domains and public interfaces are preserved. */
import type { SigningKeyPair } from '@resonance/core';
import type { HistoryCheckpointContext, HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import type { createRetainedHistoryCheckpointWriter } from './history-retained-writer.js';
import { openProtectedCheckpointOwner, checkpointOwnerReplayDigest, readProtectedCheckpointOwnerRecoverySource, fenceProtectedCheckpointOwnerRecoverySource, MAX_PROTECTED_CHECKPOINT_OWNER_BYTES, MAX_PROTECTED_CHECKPOINT_IMAGE_BYTES } from './protected-checkpoint-owner.js';
type WriterOptions = Parameters<typeof createRetainedHistoryCheckpointWriter>[0];
export const MAX_PROTECTED_ISSUER_HISTORY_BYTES = MAX_PROTECTED_CHECKPOINT_OWNER_BYTES;
export const MAX_PROTECTED_ISSUER_IMAGE_BYTES = MAX_PROTECTED_CHECKPOINT_IMAGE_BYTES;
export interface ProtectedIssuerHistoryRestoration<T> {
  genesis: HistoryCheckpointEnvelope; root: HistoryCheckpointEnvelope; baseline: T; replayDigest: string;
}
interface ProtectedIssuerHistoryBase<T> {
  kind: 'protected-admission-issuer'; context: HistoryCheckpointContext;
  root: HistoryCheckpointEnvelope; image: T;
  applied: { sequence: number; id: string } | null; pending: HistoryCheckpointEnvelope | null;
}
export type ProtectedIssuerHistoryState<T> = ProtectedIssuerHistoryBase<T> & ({ version: 1 } | {
  version: 2; restoration: Omit<ProtectedIssuerHistoryRestoration<T>, 'root'>;
});
/** Binds the immutable restored baseline to its original enrollment and selected proposal. */
export const protectedIssuerReplayDigest = (contextId: string, genesisId: string, proposalId: string, image: unknown): string =>
  checkpointOwnerReplayDigest('resonance:admission-issuer-replay:v1', contextId, genesisId, proposalId, image);
export interface ProtectedIssuerHistoryOptions<T> {
  /** Same file, domain and key as the local-only issuer. Its parser rejects the protected outer shape. */
  path: string; writerDirectory: string; domain: string; encryptionKey: Uint8Array;
  context: HistoryCheckpointContext; signingKey: SigningKeyPair; members: WriterOptions['members'];
  initial: T;
  /** Authenticate and normalize the complete issuer image, including its allocation and all retained decisions. */
  validate(value: unknown, operation?: object): T | Promise<T>;
  /** Trusted business semantics, used for live and retained generation transitions. */
  assertTransition?(previous: T, next: T): void | Promise<void>;
  validateGenesis?(image: T): void | Promise<void>;
  ancestrySource?: () => Iterable<HistoryCheckpointEnvelope>;
  expectedAncestry?: { rootId: string; genesisId: string };
  validateProof?(image: T, source: () => Iterable<HistoryCheckpointEnvelope>, operation?: object): void | Promise<void>;
  /** Internal trusted restoration input. Business APIs must require their reviewed capability first. */
  restore?: ProtectedIssuerHistoryRestoration<T>;
  /** Internal exact interrupted restoration completion, approved by the dedicated resumption workflow. */
  resumeRestoration?: ProtectedIssuerHistoryRestoration<T>;
  resumePristineArchive?: boolean;
  expectedRestorationDigest?: string;
  initialize?: boolean; initializeWriter?: boolean; initializeArchive?: boolean;
  timeoutMs?: number; transport?: WriterOptions['transport']; maxArchiveBlocks?: number; maxArchiveBytes?: number;
}
export const PROTECTED_ISSUER_RECOVERY_FENCE = 'issuer-recovery-fence.json';
export interface ProtectedIssuerHistoryRecoverySource<T> {
  readonly path: string; readonly writerDirectory: string; readonly contextId: string; readonly genesisId: string;
  readonly rootId: string; readonly generation: number; readonly stateDigest: string;
}
export interface ProtectedIssuerHistoryRecoveryEvidence<T> extends ProtectedIssuerHistoryRecoverySource<T> {
  context: HistoryCheckpointContext; genesis: HistoryCheckpointEnvelope; root: HistoryCheckpointEnvelope;
  minimumEvidence: T[]; applied: { sequence: number; id: string } | null; pending: { sequence: number; id: string } | null;
}
export function readProtectedIssuerHistoryRecoverySource<T>(source: ProtectedIssuerHistoryRecoverySource<T>): ProtectedIssuerHistoryRecoveryEvidence<T> {
  const evidence = readProtectedCheckpointOwnerRecoverySource<T>(source);
  if (evidence.context.role !== 'admission-issuer') throw new Error('Issuer recovery source has another history role');
  return evidence;
}
export async function fenceProtectedIssuerHistoryRecoverySource<T>(source: ProtectedIssuerHistoryRecoverySource<T>): Promise<void> {
  readProtectedIssuerHistoryRecoverySource(source);
  await fenceProtectedCheckpointOwnerRecoverySource(source);
}
export interface ProtectedIssuerHistoryStatus {
  ready: boolean; busy: boolean; pending: boolean; fenced: boolean;
  applied: { sequence: number; id: string } | null; rootId: string;
  retainedBlocks: number; retainedCiphertextBytes: number; maximumBlocks: number; maximumCiphertextBytes: number;
}
export interface ProtectedIssuerHistory<T> {
  reviewRecoverySource(): Promise<ProtectedIssuerHistoryRecoverySource<T>>;
  read(): T; commit(value: T, assertBeforeIntent?: () => void): Promise<void>; ready(): Promise<void>; assertServing(): void;
  assertCapacity(values: readonly T[]): Promise<void>;
  status(): ProtectedIssuerHistoryStatus;
  history(): Iterable<HistoryCheckpointEnvelope>;
  enrollment(): { context: HistoryCheckpointContext; root: HistoryCheckpointEnvelope };
  close(): void;
}
export function openProtectedIssuerHistory<T>(options: ProtectedIssuerHistoryOptions<T>): Promise<ProtectedIssuerHistory<T>> {
  return openProtectedCheckpointOwner(options, { role: 'admission-issuer', kind: 'protected-admission-issuer',
    fenceFilename: PROTECTED_ISSUER_RECOVERY_FENCE, fenceDomain: 'resonance:admission-issuer-recovery-fence:v1',
    replayDomain: 'resonance:admission-issuer-replay:v1', allowRecovery: true });
}
