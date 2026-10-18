/** Fixed issuer recovery strategy. Public pins, journal bytes and review preimages remain stable. */
import type { SigningKeyPair } from '@resonance/core';
import type { HistoryCheckpointContext, HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import type { HistoryContinuationRoot } from '@resonance/core/history-continuation';
import type { HistoryCheckpointTransport, HistoryReplicaEndpoint } from '../../relay/src/history-checkpoint-exchange.js';
import type { HistoryAgreementTransport, HistoryAgreementDataTransport, HistoryProvisionTransport } from '../../relay/src/history-agreement-exchange.js';
import { openProtectedIssuerHistory, type ProtectedIssuerHistoryStatus } from '@resonance/relay/protected-issuer-history';
import { parseAdmissionWalletProfile, type AdmissionWalletProfileV1 } from './admission-wallet-profile.js';
import { DOMAIN, type State as IssuerState } from './admission-issuer-state.js';
import { parseProtectedIssuerImage, assertProtectedIssuerImageSuccessor, assertProtectedIssuerGenesis } from './protected-admission-issuer-state.js';
import { replayProtectedIssuerHistory } from './admission-issuer-history-replay.js';
import { fenceProtectedIssuerRecoverySource, readProtectedIssuerRecoverySource, type ProtectedIssuerRecoverySource, type ProtectedIssuerRecoveryEvidence } from './protected-admission-issuer-ledger.js';
import { prepareProtectedIssuerRestore, type PreparedProtectedIssuerRestore } from './admission-issuer-history-restore.js';
import { openProtectedIssuerRestoreResumption } from './admission-issuer-restore-resumption.js';
import { createProtectedHistoryRecovery, type ProtectedHistoryRecoveryCaptured } from './protected-history-recovery.js';

export const PROTECTED_ISSUER_RECOVERY_FILENAME = 'admission-issuer-recovery.json';
export interface ProtectedIssuerRecoveryOptions {
  directory: string; encryptionKey: Uint8Array; signingKey: SigningKeyPair; context: HistoryCheckpointContext; profile: AdmissionWalletProfileV1; authority: string;
  genesis: HistoryEncryptedEnvelope; members: HistoryReplicaEndpoint[]; timeoutMs?: number;
  maxReplayBlocks?: number; maxReplayBytes?: number; replayTimeoutMs?: number;
  transport?: HistoryCheckpointTransport; agreementTransport?: HistoryAgreementTransport;
  dataTransport?: HistoryAgreementDataTransport; provisionTransport?: HistoryProvisionTransport;
}
export interface ProtectedIssuerRecoveryReview {
  readonly kind: 'protected-issuer-recovery-freeze'; readonly directory: string; readonly contextId: string; readonly genesisId: string;
  readonly rootId: string; readonly generation: number; readonly nextGeneration: number; readonly view: number;
  readonly localStateDigest: string | null; readonly localSource: ProtectedIssuerRecoverySource | null; readonly approvalDigest: string;
}
export interface ProtectedIssuerRecoveryStatus {
  rootId: string; generation: number; nextGeneration: number; view: number; complete: boolean; localStateDigest: string | null; phase: string;
}
export interface ProtectedIssuerRecoveryResumptionOptions {
  privateKey: CryptoKey; maxArchiveBytes?: number; maxArchiveBlocks?: number; signal?: AbortSignal;
}
export interface ProtectedIssuerRecovery {
  status(): ProtectedIssuerRecoveryStatus;
  advance(options?: { maxBlocks?: number; signal?: AbortSignal }): Promise<ProtectedIssuerRecoveryStatus>;
  reviewRestore(destination: { path: string; writerDirectory: string }, signal?: AbortSignal): Promise<{ preparation: PreparedProtectedIssuerRestore; continuation: HistoryContinuationRoot }>;
  inspectRestored(destination: { path: string; writerDirectory: string }, signal?: AbortSignal): Promise<{ continuation: HistoryContinuationRoot; status: ProtectedIssuerHistoryStatus; readiness: 'unverified' }>;
  reviewResumption(destination: { path: string; writerDirectory: string }, options: ProtectedIssuerRecoveryResumptionOptions): ReturnType<typeof openProtectedIssuerRestoreResumption>;
  close(): void;
}
type Captured = ProtectedHistoryRecoveryCaptured<ProtectedIssuerRecoveryOptions, { profile: AdmissionWalletProfileV1 }>;
function replayOptions(p: Captured, blocks: Iterable<unknown>, minimum: IssuerState[] | null) {
  return { context: p.context, profile: p.profile, authority: p.authority, genesisId: p.genesisId,
    encryptionKey: p.key, maxBlocks: p.maxBlocks, maxBytes: p.maxBytes, timeoutMs: p.replayTimeoutMs, blocks,
    ...(minimum ? { minimumEvidence: minimum } : {}) };
}
const recovery = createProtectedHistoryRecovery<ProtectedIssuerRecoveryOptions, { profile: AdmissionWalletProfileV1 }, IssuerState, ProtectedIssuerRecoverySource,
  PreparedProtectedIssuerRestore, ProtectedIssuerHistoryStatus, ProtectedIssuerRecoveryResumptionOptions,
  Awaited<ReturnType<typeof openProtectedIssuerRestoreResumption>>, 'protected-issuer-recovery-freeze'>({
  role: 'admission-issuer', filename: PROTECTED_ISSUER_RECOVERY_FILENAME, domain: 'resonance:admission-issuer-recovery:v1',
  kind: 'protected-issuer-recovery-freeze', label: 'Issuer',
  capturePins(options) { return { profile: structuredClone(options.profile) }; },
  async normalizePins(p) { p.profile = (await parseAdmissionWalletProfile(p.profile)).profile; },
  configuration(p) {
    // Explicit insertion order is part of the existing issuer approval preimage and journal format.
    return { profile: p.profile, authority: p.authority, members: p.members, timeoutMs: p.timeoutMs,
      maxReplayBlocks: p.maxBlocks, maxReplayBytes: p.maxBytes, replayTimeoutMs: p.replayTimeoutMs };
  },
  parseImage(value, p) { return parseProtectedIssuerImage(value, { profile: p.profile, authority: p.authority }); },
  assertGenesis(image, p) { assertProtectedIssuerGenesis(image, p.context); },
  readSource: readProtectedIssuerRecoverySource,
  fenceSource: fenceProtectedIssuerRecoverySource,
  assertAdditionalSourcePins(captured, p) {
    if (JSON.stringify((captured as ProtectedIssuerRecoveryEvidence).profile) !== JSON.stringify(p.profile)) throw new Error('Issuer source profile differs from its independent pin');
  },
  replay(p, blocks, minimum, proposal, signal) { return replayProtectedIssuerHistory({ ...replayOptions(p, blocks, minimum), proposal, signal }); },
  prepareRestore(p, blocks, minimum, destination, continuation, signal) { return prepareProtectedIssuerRestore({ ...replayOptions(p, blocks, minimum), destination, continuation, signal }); },
  openInspector(p, destination, replayDigest) {
    return openProtectedIssuerHistory<IssuerState>({ ...destination, context: p.context, domain: DOMAIN, encryptionKey: p.key,
      signingKey: p.signer, members: p.members, initial: undefined!, expectedRestorationDigest: replayDigest,
      validate: value => parseProtectedIssuerImage(value, { profile: p.profile, authority: p.authority }),
      assertTransition: assertProtectedIssuerImageSuccessor, validateGenesis: image => assertProtectedIssuerGenesis(image, p.context) });
  },
  openResumption(p, blocks, minimum, destination, continuation, options) {
    const privateKey = options.privateKey, limits = { maxArchiveBytes: options.maxArchiveBytes, maxArchiveBlocks: options.maxArchiveBlocks }, signal = options.signal;
    return openProtectedIssuerRestoreResumption({ ...replayOptions(p, blocks, minimum), destination, continuation,
      signingKey: p.signer, members: p.members, transport: p.transport, timeoutMs: p.timeoutMs, replayTimeoutMs: p.replayTimeoutMs, privateKey, ...limits, signal });
  },
});
export function prepareProtectedIssuerRecovery(options: ProtectedIssuerRecoveryOptions & {
  source: ProtectedIssuerRecoverySource | 'unavailable'; view?: number; signal?: AbortSignal;
}): Promise<ProtectedIssuerRecoveryReview> { return recovery.prepare(options); }
export function openProtectedIssuerRecovery(options: ProtectedIssuerRecoveryOptions & {
  initialize?: { review: ProtectedIssuerRecoveryReview; approvedDigest: string };
}): Promise<ProtectedIssuerRecovery> { return recovery.open(options); }
