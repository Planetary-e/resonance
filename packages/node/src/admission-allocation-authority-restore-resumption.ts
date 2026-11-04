/** Fixed authority entry for explicit, readiness-unverified restoration completion. */
import { PROTECTED_ALLOCATION_AUTHORITY_OWNER_DOMAIN, PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FENCE,
  type ProtectedAllocationAuthorityHistoryStatus } from '@resonance/relay/protected-allocation-authority-history';
import type { SigningKeyPair } from '@resonance/core';
import type { HistoryContinuationRoot } from '@resonance/core/history-continuation';
import type { HistoryCheckpointTransport, HistoryReplicaEndpoint } from '../../relay/src/history-checkpoint-exchange.js';
import { openProtectedCheckpointOwner, MAX_PROTECTED_CHECKPOINT_OWNER_BYTES } from '../../relay/src/protected-checkpoint-owner.js';
import { deriveAdmissionAllocationAuthorityEncryptionKey, parseAdmissionAllocationAuthorityState,
  assertProtectedAllocationAuthoritySuccessor, assertProtectedAllocationAuthorityGenesis,
  type AdmissionAllocationAuthorityState } from './admission-allocation-authority-state.js';
import { replayProtectedAllocationAuthorityHistory, type ProtectedAllocationAuthorityReplayOptions } from './admission-allocation-authority-history-replay.js';
import { openProtectedHistoryRestoreResumption, type ProtectedHistoryRestoreResumptionStrategy } from './protected-history-restore-resumption.js';

export interface ProtectedAllocationAuthorityRestoreResumptionOptions extends Omit<ProtectedAllocationAuthorityReplayOptions, 'proposal'> {
  continuation: HistoryContinuationRoot;
  destination: { path: string; writerDirectory: string };
  secretKey: Uint8Array; signingKey: SigningKeyPair; members: HistoryReplicaEndpoint[];
  transport?: HistoryCheckpointTransport; maxArchiveBlocks?: number; maxArchiveBytes?: number;
  /** Replay has a separate bounded CPU budget; timeoutMs remains the unchanged protocol deadline. */
  replayTimeoutMs?: number;
}
export interface ProtectedAllocationAuthorityRestoreResumptionReview {
  kind: 'protected-allocation-authority-restoration-resumption'; path: string; writerDirectory: string;
  contextId: string; genesisId: string; rootId: string; generation: number; replayDigest: string; stateDigest: string;
  initializeWriter: boolean; initializeArchive: boolean; requiresUnchangedRootQuorum: boolean;
  files: { owner: string | null; writer: string | null; archive: string | null; fenced: boolean;
    writerEntries: string[] | null; archiveEntries: string[] | null };
  limits: { archiveBytes: number; archiveBlocks: number }; members: HistoryReplicaEndpoint[]; timeoutMs: number;
  readiness: 'unverified'; startsService: false; approvalDigest: string;
}
export interface ProtectedAllocationAuthorityRestoreResumptionResult {
  result: 'protected-allocation-authority-restoration-resumed'; status: ProtectedAllocationAuthorityHistoryStatus; readiness: 'unverified'; startsService: false;
}
export interface ProtectedAllocationAuthorityRestoreResumption {
  review(): ProtectedAllocationAuthorityRestoreResumptionReview;
  apply(approvedDigest: string): Promise<ProtectedAllocationAuthorityRestoreResumptionResult>;
  close(): void;
}
const authorityStrategy: ProtectedHistoryRestoreResumptionStrategy<AdmissionAllocationAuthorityState, ProtectedAllocationAuthorityRestoreResumptionOptions,
  'protected-allocation-authority-restoration-resumption', 'protected-allocation-authority-restoration-resumed'> = {
  role: 'admission-allocation-authority', ownerKind: 'protected-admission-allocation-authority', ownerDomain: PROTECTED_ALLOCATION_AUTHORITY_OWNER_DOMAIN,
  maximumOwnerBytes: MAX_PROTECTED_CHECKPOINT_OWNER_BYTES, fenceFilename: PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FENCE,
  reviewKind: 'protected-allocation-authority-restoration-resumption', reviewDomain: 'resonance:protected-allocation-authority-restoration-resumption:v1',
  result: 'protected-allocation-authority-restoration-resumed',
  errors: {
    closed: 'Allocation authority restoration resumption closed or cancelled',
    pathsChanged: 'Allocation authority restoration destinations changed since review',
    pins: 'Wrong allocation authority restoration pins or keys',
    bounds: 'Invalid allocation authority restoration protocol or archive bounds',
    memberCount: 'Allocation authority restoration requires five independently pinned members',
    unknownMember: 'Unknown allocation authority restoration member',
    endpoints: 'Allocation authority restoration requires distinct pinned endpoints',
    keyMismatch: 'Allocation authority restoration key differs from its retained allocation signing key',
    restoredOwner: 'Allocation authority resumption requires an authenticated restored owner',
    differentReplay: 'Retained allocation authority restoration differs from independently replayed selected history',
    notInitial: 'Allocation authority resumption is only for the exact interrupted initial restoration',
    fenced: 'Fenced allocation authority history requires recovery, not restoration resumption',
    missingApplied: 'Missing components beside applied allocation authority history require complete recovery',
    writerBesideArchive: 'Cannot recreate missing allocation authority writer beside retained archive evidence',
    unknownWriterFiles: 'Missing allocation authority writer has unknown retained files',
    laterWriter: 'Allocation authority restoration writer already contains a later accepted suffix',
    missingCommittedArchive: 'Committed allocation authority archive is missing; preserve it for complete recovery',
    approval: 'Allocation authority resumption requires matching reviewed approval',
    filesChanged: 'Allocation authority restoration files changed since review',
    filesChangedDuringConfirmation: 'Allocation authority restoration files changed during fresh root confirmation',
  },
  snapshot(options) {
    if (!(options.secretKey instanceof Uint8Array)) throw new Error('Allocation authority restoration requires its retained signing secret');
    const authority = options.authority, secret = Uint8Array.from(options.secretKey);
    return {
      async prepare(context, key, root, replayTimeoutMs) {
        const replay = await replayProtectedAllocationAuthorityHistory({ ...options, context, authority, encryptionKey: key, proposal: root.proposal, timeoutMs: replayTimeoutMs });
        return { replay, validate: (value: unknown) => parseAdmissionAllocationAuthorityState(value, authority) };
      },
      async deriveKey() { try { return deriveAdmissionAllocationAuthorityEncryptionKey(secret, authority); } finally { secret.fill(0); } },
      dispose() { secret.fill(0); },
    };
  },
  assertTransition: assertProtectedAllocationAuthoritySuccessor,
  validateGenesis: assertProtectedAllocationAuthorityGenesis,
  openHistory: options => openProtectedCheckpointOwner(options, { role: 'admission-allocation-authority', kind: 'protected-admission-allocation-authority',
    fenceFilename: PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FENCE, fenceDomain: 'resonance:admission-allocation-authority-recovery-fence:v1',
    replayDomain: 'resonance:admission-allocation-authority-replay:v1', allowRecovery: true }),
};
export async function openProtectedAllocationAuthorityRestoreResumption(options: ProtectedAllocationAuthorityRestoreResumptionOptions): Promise<ProtectedAllocationAuthorityRestoreResumption> {
  const allowed = ['context', 'genesisId', 'authority', 'encryptionKey', 'blocks', 'minimumEvidence', 'maxBlocks', 'maxBytes', 'timeoutMs', 'signal',
    'continuation', 'destination', 'secretKey', 'signingKey', 'members', 'transport', 'maxArchiveBlocks', 'maxArchiveBytes', 'replayTimeoutMs'];
  if (!options || typeof options !== 'object' || Object.keys(options).some(key => !allowed.includes(key))) throw new Error('Allocation authority restoration role, domains and validation are fixed');
  // Keep the originally reviewed spellings so a caller cannot replace a
  // retargeted alias with its former canonical path after review.
  const destination = { path: options.destination.path, writerDirectory: options.destination.writerDirectory };
  return openProtectedHistoryRestoreResumption({ ...options, destination }, authorityStrategy);
}
