/** Fixed issuer entry for explicit, readiness-unverified restoration completion. */
import { openProtectedIssuerHistory, MAX_PROTECTED_ISSUER_HISTORY_BYTES, PROTECTED_ISSUER_RECOVERY_FENCE, type ProtectedIssuerHistoryStatus } from '@resonance/relay/protected-issuer-history';
import type { SigningKeyPair } from '@resonance/core';
import type { HistoryContinuationRoot } from '@resonance/core/history-continuation';
import type { HistoryCheckpointTransport, HistoryReplicaEndpoint } from '../../relay/src/history-checkpoint-exchange.js';
import { prepareAdmissionBatchIssuer } from './blind-admission-issuance.js';
import { DOMAIN, deriveAdmissionIssuerEncryptionKey, type State } from './admission-issuer-state.js';
import { replayProtectedIssuerHistory, type ProtectedIssuerReplayOptions } from './admission-issuer-history-replay.js';
import { parseProtectedIssuerImage, assertProtectedIssuerImageSuccessor, assertProtectedIssuerGenesis } from './protected-admission-issuer-state.js';
import { openProtectedHistoryRestoreResumption, type ProtectedHistoryRestoreResumptionStrategy } from './protected-history-restore-resumption.js';

export interface ProtectedIssuerRestoreResumptionOptions extends Omit<ProtectedIssuerReplayOptions, 'proposal'> {
  continuation: HistoryContinuationRoot;
  destination: { path: string; writerDirectory: string };
  privateKey: CryptoKey; signingKey: SigningKeyPair; members: HistoryReplicaEndpoint[];
  transport?: HistoryCheckpointTransport; maxArchiveBlocks?: number; maxArchiveBytes?: number;
  /** Replay has a separate bounded CPU budget; timeoutMs remains the unchanged protocol deadline. */
  replayTimeoutMs?: number;
}
export interface ProtectedIssuerRestoreResumptionReview {
  kind: 'protected-issuer-restoration-resumption'; path: string; writerDirectory: string;
  contextId: string; genesisId: string; rootId: string; generation: number; replayDigest: string; stateDigest: string;
  initializeWriter: boolean; initializeArchive: boolean; requiresUnchangedRootQuorum: boolean;
  files: { owner: string | null; writer: string | null; archive: string | null; fenced: boolean;
    writerEntries: string[] | null; archiveEntries: string[] | null };
  limits: { archiveBytes: number; archiveBlocks: number }; members: HistoryReplicaEndpoint[]; timeoutMs: number;
  readiness: 'unverified'; startsService: false; approvalDigest: string;
}
export interface ProtectedIssuerRestoreResumptionResult {
  result: 'protected-issuer-restoration-resumed'; status: ProtectedIssuerHistoryStatus; readiness: 'unverified'; startsService: false;
}
export interface ProtectedIssuerRestoreResumption {
  review(): ProtectedIssuerRestoreResumptionReview;
  apply(approvedDigest: string): Promise<ProtectedIssuerRestoreResumptionResult>;
  close(): void;
}
const issuerStrategy: ProtectedHistoryRestoreResumptionStrategy<State, ProtectedIssuerRestoreResumptionOptions,
  'protected-issuer-restoration-resumption', 'protected-issuer-restoration-resumed'> = {
  role: 'admission-issuer', ownerKind: 'protected-admission-issuer', ownerDomain: DOMAIN,
  maximumOwnerBytes: MAX_PROTECTED_ISSUER_HISTORY_BYTES, fenceFilename: PROTECTED_ISSUER_RECOVERY_FENCE,
  reviewKind: 'protected-issuer-restoration-resumption', reviewDomain: 'resonance:protected-issuer-restoration-resumption:v1',
  result: 'protected-issuer-restoration-resumed',
  errors: {
    closed: 'Issuer restoration resumption closed or cancelled',
    pathsChanged: 'Issuer restoration destinations changed since review',
    pins: 'Wrong issuer restoration pins or keys',
    bounds: 'Invalid issuer restoration protocol or archive bounds',
    memberCount: 'Issuer restoration requires five independently pinned members',
    unknownMember: 'Unknown issuer restoration member',
    endpoints: 'Issuer restoration requires distinct pinned endpoints',
    keyMismatch: 'Issuer restoration key differs from its retained RSA issuer key',
    restoredOwner: 'Issuer resumption requires an authenticated restored owner',
    differentReplay: 'Retained issuer restoration differs from independently replayed selected history',
    notInitial: 'Issuer resumption is only for the exact interrupted initial restoration',
    fenced: 'Fenced issuer history requires recovery, not restoration resumption',
    missingApplied: 'Missing components beside applied issuer history require complete recovery',
    writerBesideArchive: 'Cannot recreate missing issuer writer beside retained archive evidence',
    unknownWriterFiles: 'Missing issuer writer has unknown retained files',
    laterWriter: 'Issuer restoration writer already contains a later accepted suffix',
    missingCommittedArchive: 'Committed issuer archive is missing; preserve it for complete recovery',
    approval: 'Issuer resumption requires matching reviewed approval',
    filesChanged: 'Issuer restoration files changed since review',
    filesChangedDuringConfirmation: 'Issuer restoration files changed during fresh root confirmation',
  },
  snapshot(options) {
    const authority = options.authority, profileInput = structuredClone(options.profile), privateKey = options.privateKey;
    return {
      async prepare(context, key, root, replayTimeoutMs) {
        const [issuer, replay] = await Promise.all([prepareAdmissionBatchIssuer({ expectedProfile: profileInput, privateKey }),
          replayProtectedIssuerHistory({ ...options, context, profile: profileInput, authority, encryptionKey: key, proposal: root.proposal, timeoutMs: replayTimeoutMs })]);
        const profile = issuer.profile;
        return { replay, validate: (value: unknown) => parseProtectedIssuerImage(value, { profile, authority }) };
      },
      deriveKey: () => deriveAdmissionIssuerEncryptionKey(privateKey),
    };
  },
  assertTransition: assertProtectedIssuerImageSuccessor,
  validateGenesis: assertProtectedIssuerGenesis,
  openHistory: openProtectedIssuerHistory,
};
export async function openProtectedIssuerRestoreResumption(options: ProtectedIssuerRestoreResumptionOptions): Promise<ProtectedIssuerRestoreResumption> {
  return openProtectedHistoryRestoreResumption(options, issuerStrategy);
}
