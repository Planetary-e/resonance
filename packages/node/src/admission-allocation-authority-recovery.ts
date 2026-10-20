/** Fixed allocation-authority recovery. Selected history is replayed before confirmation. */
import type { SigningKeyPair } from '@resonance/core';
import type { HistoryCheckpointContext, HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import type { HistoryContinuationRoot } from '@resonance/core/history-continuation';
import type { HistoryCheckpointTransport, HistoryReplicaEndpoint } from '../../relay/src/history-checkpoint-exchange.js';
import type { HistoryAgreementTransport, HistoryAgreementDataTransport, HistoryProvisionTransport } from '../../relay/src/history-agreement-exchange.js';
import { PROTECTED_ALLOCATION_AUTHORITY_OWNER_DOMAIN, PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FENCE,
  type ProtectedAllocationAuthorityHistoryStatus } from '@resonance/relay/protected-allocation-authority-history';
import { openProtectedCheckpointOwner } from '../../relay/src/protected-checkpoint-owner.js';
import { parseAdmissionHistoryArchiveLimits } from '../../relay/src/admission-history-config.js';
import { parseAdmissionAllocationAuthorityState, assertProtectedAllocationAuthoritySuccessor, assertProtectedAllocationAuthorityGenesis,
  type AdmissionAllocationAuthorityState as State } from './admission-allocation-authority-state.js';
import { replayProtectedAllocationAuthorityHistory } from './admission-allocation-authority-history-replay.js';
import { fenceProtectedAllocationAuthorityRecoverySource, readProtectedAllocationAuthorityRecoverySource,
  type ProtectedAllocationAuthorityRecoverySource } from './protected-admission-allocation-authority.js';
import { prepareProtectedAllocationAuthorityRestore, type PreparedProtectedAllocationAuthorityRestore } from './admission-allocation-authority-history-restore.js';
import { openProtectedAllocationAuthorityRestoreResumption, type ProtectedAllocationAuthorityRestoreResumption } from './admission-allocation-authority-restore-resumption.js';
import { createProtectedHistoryRecovery, type ProtectedHistoryRecoveryCaptured } from './protected-history-recovery.js';

export const PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FILENAME = 'admission-allocation-authority-recovery.json';
export interface ProtectedAllocationAuthorityRecoveryOptions {
  directory: string; encryptionKey: Uint8Array; signingKey: SigningKeyPair; context: HistoryCheckpointContext; authority: string;
  genesis: HistoryEncryptedEnvelope; members: HistoryReplicaEndpoint[]; timeoutMs?: number;
  maxReplayBlocks?: number; maxReplayBytes?: number; replayTimeoutMs?: number; maxArchiveBlocks?: number; maxArchiveBytes?: number;
  transport?: HistoryCheckpointTransport; agreementTransport?: HistoryAgreementTransport;
  dataTransport?: HistoryAgreementDataTransport; provisionTransport?: HistoryProvisionTransport;
}
export interface ProtectedAllocationAuthorityRecoveryReview {
  readonly kind: 'protected-allocation-authority-recovery-freeze'; readonly directory: string; readonly contextId: string; readonly genesisId: string;
  readonly rootId: string; readonly generation: number; readonly nextGeneration: number; readonly view: number;
  readonly localStateDigest: string | null; readonly localSource: ProtectedAllocationAuthorityRecoverySource | null; readonly approvalDigest: string;
}
export interface ProtectedAllocationAuthorityRecoveryStatus {
  rootId: string; generation: number; nextGeneration: number; view: number; complete: boolean; localStateDigest: string | null; phase: string;
}
export interface ProtectedAllocationAuthorityRecoveryResumptionOptions { secretKey: Uint8Array; maxArchiveBlocks?: number; maxArchiveBytes?: number; signal?: AbortSignal }
export interface ProtectedAllocationAuthorityRecovery {
  status(): ProtectedAllocationAuthorityRecoveryStatus;
  advance(options?: { maxBlocks?: number; signal?: AbortSignal }): Promise<ProtectedAllocationAuthorityRecoveryStatus>;
  reviewRestore(destination: { path: string; writerDirectory: string }, signal?: AbortSignal): Promise<{ preparation: PreparedProtectedAllocationAuthorityRestore; continuation: HistoryContinuationRoot }>;
  inspectRestored(destination: { path: string; writerDirectory: string }, signal?: AbortSignal): Promise<{ continuation: HistoryContinuationRoot; status: ProtectedAllocationAuthorityHistoryStatus; readiness: 'unverified' }>;
  reviewResumption(destination: { path: string; writerDirectory: string }, options: ProtectedAllocationAuthorityRecoveryResumptionOptions): Promise<ProtectedAllocationAuthorityRestoreResumption>;
  close(): void;
}
type Pins = { maxArchiveBlocks: number; maxArchiveBytes: number };
type Captured = ProtectedHistoryRecoveryCaptured<ProtectedAllocationAuthorityRecoveryOptions, Pins>;
function replayOptions(p: Captured, blocks: Iterable<unknown>, minimum: State[] | null) {
  return { context: p.context, authority: p.authority, genesisId: p.genesisId, encryptionKey: p.key,
    maxBlocks: p.maxBlocks, maxBytes: p.maxBytes, timeoutMs: p.replayTimeoutMs, blocks, ...(minimum ? { minimumEvidence: minimum } : {}) };
}
const recovery = createProtectedHistoryRecovery<ProtectedAllocationAuthorityRecoveryOptions, Pins, State, ProtectedAllocationAuthorityRecoverySource,
  PreparedProtectedAllocationAuthorityRestore, ProtectedAllocationAuthorityHistoryStatus, ProtectedAllocationAuthorityRecoveryResumptionOptions,
  ProtectedAllocationAuthorityRestoreResumption, 'protected-allocation-authority-recovery-freeze'>({
  role: 'admission-allocation-authority', filename: PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FILENAME,
  domain: 'resonance:admission-allocation-authority-recovery:v1', kind: 'protected-allocation-authority-recovery-freeze', label: 'Allocation authority',
  capturePins(options) {
    const limits = parseAdmissionHistoryArchiveLimits({ archiveBlocks: options.maxArchiveBlocks ?? 10001, archiveBytes: options.maxArchiveBytes ?? 64 * 1024 * 1024 });
    return { maxArchiveBlocks: limits.archiveBlocks, maxArchiveBytes: limits.archiveBytes };
  },
  async normalizePins() {},
  configuration(p) {
    return { authority: p.authority, members: p.members, timeoutMs: p.timeoutMs, maxReplayBlocks: p.maxBlocks, maxReplayBytes: p.maxBytes,
      replayTimeoutMs: p.replayTimeoutMs, maxArchiveBlocks: p.maxArchiveBlocks, maxArchiveBytes: p.maxArchiveBytes };
  },
  parseImage(value, p) { return parseAdmissionAllocationAuthorityState(value, p.authority); },
  assertGenesis(image, p) { assertProtectedAllocationAuthorityGenesis(image, p.context); },
  readSource: readProtectedAllocationAuthorityRecoverySource, fenceSource: fenceProtectedAllocationAuthorityRecoverySource,
  replay(p, blocks, minimum, proposal, signal) { return replayProtectedAllocationAuthorityHistory({ ...replayOptions(p, blocks, minimum), proposal, signal }); },
  prepareRestore(p, blocks, minimum, destination, continuation, signal) { return prepareProtectedAllocationAuthorityRestore({ ...replayOptions(p, blocks, minimum), destination, continuation, signal }); },
  openInspector(p, destination, replayDigest) {
    return openProtectedCheckpointOwner<State>({ ...destination, context: p.context, domain: PROTECTED_ALLOCATION_AUTHORITY_OWNER_DOMAIN, encryptionKey: p.key,
      signingKey: p.signer, members: p.members, initial: undefined!, expectedRestorationDigest: replayDigest,
      maxArchiveBlocks: p.maxArchiveBlocks, maxArchiveBytes: p.maxArchiveBytes,
      validate: value => parseAdmissionAllocationAuthorityState(value, p.authority), assertTransition: assertProtectedAllocationAuthoritySuccessor,
      validateGenesis: image => assertProtectedAllocationAuthorityGenesis(image, p.context) },
    { role: 'admission-allocation-authority', kind: 'protected-admission-allocation-authority', fenceFilename: PROTECTED_ALLOCATION_AUTHORITY_RECOVERY_FENCE,
      fenceDomain: 'resonance:admission-allocation-authority-recovery-fence:v1', replayDomain: 'resonance:admission-allocation-authority-replay:v1', allowRecovery: true });
  },
  openResumption(p, blocks, minimum, destination, continuation, options) {
    if (options.maxArchiveBlocks !== undefined && options.maxArchiveBlocks !== p.maxArchiveBlocks
      || options.maxArchiveBytes !== undefined && options.maxArchiveBytes !== p.maxArchiveBytes) throw new Error('Allocation authority resumption archive bounds differ from the reviewed recovery configuration');
    return openProtectedAllocationAuthorityRestoreResumption({ ...replayOptions(p, blocks, minimum), destination, continuation, secretKey: options.secretKey,
      signingKey: p.signer, members: p.members, transport: p.transport, timeoutMs: p.timeoutMs, replayTimeoutMs: p.replayTimeoutMs,
      maxArchiveBlocks: p.maxArchiveBlocks, maxArchiveBytes: p.maxArchiveBytes, signal: options.signal });
  },
});
const fields = ['directory', 'encryptionKey', 'signingKey', 'context', 'authority', 'genesis', 'members', 'timeoutMs', 'maxReplayBlocks', 'maxReplayBytes',
  'replayTimeoutMs', 'maxArchiveBlocks', 'maxArchiveBytes', 'transport', 'agreementTransport', 'dataTransport', 'provisionTransport'];
function assertOptions(options: object, extra: readonly string[]) {
  if (!options || typeof options !== 'object' || Object.keys(options).some(key => !fields.includes(key) && !extra.includes(key))) throw new Error('Allocation authority recovery role, domains and validation options are fixed');
}
export async function prepareProtectedAllocationAuthorityRecovery(options: ProtectedAllocationAuthorityRecoveryOptions & {
  source: ProtectedAllocationAuthorityRecoverySource | 'unavailable'; view?: number; signal?: AbortSignal;
}): Promise<ProtectedAllocationAuthorityRecoveryReview> { assertOptions(options, ['source', 'view', 'signal']); return recovery.prepare(options); }
export async function openProtectedAllocationAuthorityRecovery(options: ProtectedAllocationAuthorityRecoveryOptions & {
  initialize?: { review: ProtectedAllocationAuthorityRecoveryReview; approvedDigest: string };
}): Promise<ProtectedAllocationAuthorityRecovery> {
  assertOptions(options, ['initialize']);
  if (options.initialize !== undefined && (!options.initialize || Object.keys(options.initialize).some(key => !['review', 'approvedDigest'].includes(key)))) throw new Error('Allocation authority recovery initialization is fixed');
  const handle = await recovery.open(options);
  return { ...handle, async reviewResumption(destination, value) {
    if (!value || Object.keys(value).some(key => !['secretKey', 'maxArchiveBlocks', 'maxArchiveBytes', 'signal'].includes(key))) throw new Error('Allocation authority resumption options are fixed');
    const target = { path: destination.path, writerDirectory: destination.writerDirectory };
    const signal = value.signal, maxArchiveBlocks = value.maxArchiveBlocks, maxArchiveBytes = value.maxArchiveBytes, secretKey = Uint8Array.from(value.secretKey);
    try { return await handle.reviewResumption(target, { secretKey, signal, maxArchiveBlocks, maxArchiveBytes }); } finally { secretKey.fill(0); }
  } };
}
