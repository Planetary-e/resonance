/** In-process review capability for a complete selected allocation-authority history. */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalHistorySetupPath } from '../../relay/src/admission-history-setup.js';
import { admissionAuthorityFingerprint } from '@resonance/core/admission-policy';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, parseHistoryCheckpointContext,
  type HistoryCheckpointContext, type HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import { parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { protectedAllocationAuthorityReplayDigest } from '@resonance/relay/protected-allocation-authority-history';
import { historySuccessorProposalId } from '@resonance/core/history-successor';
import type { AdmissionAllocationAuthorityState } from './admission-allocation-authority-state.js';
import { replayProtectedAllocationAuthorityHistory, type ProtectedAllocationAuthorityReplayOptions } from './admission-allocation-authority-history-replay.js';

export interface ProtectedAllocationAuthorityRestoration {
  genesis: HistoryEncryptedEnvelope; root: HistoryContinuationRoot; baseline: AdmissionAllocationAuthorityState; replayDigest: string;
}
export interface PreparedProtectedAllocationAuthorityRestore {
  readonly review: Readonly<{ kind: 'protected-allocation-authority-restore'; path: string; writerDirectory: string;
    contextId: string; genesisId: string; rootId: string; generation: number; authorityFingerprint: string;
    manifests: number; assignments: number; blocks: number; bytes: number; generations: number; approvalDigest: string }>;
}
interface Prepared {
  path: string; writerDirectory: string; requestedPath: string; requestedWriterDirectory: string; contextId: string; authority: string;
  restoration: ProtectedAllocationAuthorityRestoration; approvalDigest: string;
}
const prepared = new WeakMap<PreparedProtectedAllocationAuthorityRestore, Prepared>();
function emptyDestination(path: string, writerDirectory: string) {
  if (existsSync(path) || existsSync(writerDirectory) && readdirSync(writerDirectory).length) throw new Error('Allocation authority restore requires a new owner file and empty writer destination');
}
export async function prepareProtectedAllocationAuthorityRestore(options: Omit<ProtectedAllocationAuthorityReplayOptions, 'proposal'> & {
  destination: { path: string; writerDirectory: string }; continuation: HistoryContinuationRoot;
}): Promise<PreparedProtectedAllocationAuthorityRestore> {
  const requestedPath = resolve(options.destination.path), requestedWriterDirectory = resolve(options.destination.writerDirectory);
  const path = canonicalHistorySetupPath(requestedPath), writerDirectory = canonicalHistorySetupPath(requestedWriterDirectory);
  const context = parseHistoryCheckpointContext(structuredClone(options.context)), authority = options.authority;
  const root = parseHistoryContinuationRoot(structuredClone(options.continuation), context), rootId = historyCheckpointEnvelopeId(root);
  emptyDestination(path, writerDirectory);
  // Replay snapshots all caller-owned inputs synchronously before its first await.
  const replay = await replayProtectedAllocationAuthorityHistory({ ...options, context, authority, proposal: root.proposal });
  if (canonicalHistorySetupPath(requestedPath) !== path || canonicalHistorySetupPath(requestedWriterDirectory) !== writerDirectory) throw new Error('Allocation authority restore destinations changed during review');
  const approvalDigest = historyDigest(`resonance:protected-allocation-authority-restore:v1\n${JSON.stringify([
    path, writerDirectory, replay.contextId, replay.genesisId, rootId, authority, replay.replayDigest,
  ])}`);
  const result = Object.freeze({ review: Object.freeze({ kind: 'protected-allocation-authority-restore' as const, path, writerDirectory,
    contextId: replay.contextId, genesisId: replay.genesisId, rootId, generation: root.generation,
    authorityFingerprint: admissionAuthorityFingerprint(authority), manifests: replay.state.manifests.length,
    assignments: replay.state.version === 2 ? replay.state.assignments.length : 0,
    blocks: replay.blocks, bytes: replay.bytes, generations: replay.generations, approvalDigest }) });
  prepared.set(result, { path, writerDirectory, requestedPath, requestedWriterDirectory, contextId: replay.contextId, authority,
    restoration: { genesis: replay.genesis, root, baseline: replay.state, replayDigest: replay.replayDigest }, approvalDigest });
  return result;
}
/** Serialized reviews and cloned or fabricated facades confer no capability. */
export function readPreparedProtectedAllocationAuthorityRestore(value: PreparedProtectedAllocationAuthorityRestore, approvedDigest: string, pins: {
  path: string; writerDirectory: string; context: HistoryCheckpointContext; authority: string;
}): ProtectedAllocationAuthorityRestoration {
  const record = prepared.get(value);
  if (!record || approvedDigest !== record.approvalDigest || record.path !== canonicalHistorySetupPath(pins.path) || record.writerDirectory !== canonicalHistorySetupPath(pins.writerDirectory)
    || record.path !== canonicalHistorySetupPath(record.requestedPath) || record.writerDirectory !== canonicalHistorySetupPath(record.requestedWriterDirectory)
    || record.contextId !== historyCheckpointContextId(pins.context) || record.authority !== pins.authority
    || record.restoration.replayDigest !== protectedAllocationAuthorityReplayDigest(record.contextId, historyCheckpointEnvelopeId(record.restoration.genesis),
      historySuccessorProposalId(record.restoration.root.proposal), record.restoration.baseline)) throw new Error('Allocation authority restore requires matching reviewed history, authority and destinations');
  emptyDestination(record.path, record.writerDirectory);
  return structuredClone(record.restoration);
}
