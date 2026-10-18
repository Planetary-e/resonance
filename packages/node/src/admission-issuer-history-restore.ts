/** In-process review capability for a complete selected issuer history. */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { admissionAuthorityFingerprint } from '@resonance/core/admission-policy';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, parseHistoryCheckpointContext,
  type HistoryCheckpointContext, type HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import { parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { protectedIssuerReplayDigest } from '@resonance/relay/protected-issuer-history';
import { historySuccessorProposalId } from '@resonance/core/history-successor';
import { admissionKeyFingerprint, type AdmissionWalletProfileV1 } from './admission-wallet-profile.js';
import { totals, type State } from './admission-issuer-state.js';
import { replayProtectedIssuerHistory, type ProtectedIssuerReplayOptions } from './admission-issuer-history-replay.js';

export interface ProtectedIssuerRestoration { genesis: HistoryEncryptedEnvelope; root: HistoryContinuationRoot; baseline: State; replayDigest: string }
export interface PreparedProtectedIssuerRestore {
  readonly review: Readonly<{ kind: 'protected-issuer-restore'; path: string; writerDirectory: string; contextId: string; genesisId: string;
    rootId: string; generation: number; authorityFingerprint: string; issuerKeyFingerprint: string; policyRevision: number;
    observedRevision: number; conflict: boolean; permanentlyRetired: boolean; allocatedPermits: number; boundPermits: number;
    preparedPermits: number; completedPermits: number; blocks: number; bytes: number; generations: number; approvalDigest: string }>;
}
interface Prepared { path: string; writerDirectory: string; contextId: string; profile: AdmissionWalletProfileV1; authority: string;
  restoration: ProtectedIssuerRestoration; approvalDigest: string }
const prepared = new WeakMap<PreparedProtectedIssuerRestore, Prepared>();
function emptyDestination(path: string, writerDirectory: string) {
  if (existsSync(path) || existsSync(writerDirectory) && readdirSync(writerDirectory).length) throw new Error('Issuer restore requires a new owner file and empty writer destination');
}
export async function prepareProtectedIssuerRestore(options: Omit<ProtectedIssuerReplayOptions, 'proposal'> & {
  destination: { path: string; writerDirectory: string }; continuation: HistoryContinuationRoot;
}): Promise<PreparedProtectedIssuerRestore> {
  const path = resolve(options.destination.path), writerDirectory = resolve(options.destination.writerDirectory);
  const context = parseHistoryCheckpointContext(structuredClone(options.context)), authority = options.authority, profile = structuredClone(options.profile);
  const root = parseHistoryContinuationRoot(structuredClone(options.continuation), context), rootId = historyCheckpointEnvelopeId(root);
  emptyDestination(path, writerDirectory);
  // replay snapshots caller-owned blocks, evidence and key synchronously before its first await.
  const replay = await replayProtectedIssuerHistory({ ...options, context, profile, authority, proposal: root.proposal });
  const canonicalProfile = structuredClone(replay.state.profile);
  const approvalDigest = historyDigest(`resonance:protected-issuer-restore:v1\n${JSON.stringify([
    path, writerDirectory, replay.contextId, replay.genesisId, rootId, canonicalProfile, authority, replay.replayDigest,
  ])}`);
  const result = Object.freeze({ review: Object.freeze({ kind: 'protected-issuer-restore' as const, path, writerDirectory,
    contextId: replay.contextId, genesisId: replay.genesisId, rootId, generation: root.generation,
    authorityFingerprint: admissionAuthorityFingerprint(authority), issuerKeyFingerprint: admissionKeyFingerprint(profile.issuerPublicKey),
    policyRevision: replay.state.communityPolicy!.revision, observedRevision: replay.state.freshness!.observed.revision,
    conflict: !!replay.state.freshness!.conflict, permanentlyRetired: replay.state.version === 9, ...totals(replay.state),
    preparedPermits: replay.state.entries.filter(entry => entry.preparedResponse).length, blocks: replay.blocks, bytes: replay.bytes,
    generations: replay.generations, approvalDigest }) });
  prepared.set(result, { path, writerDirectory, contextId: replay.contextId, profile: canonicalProfile, authority,
    restoration: { genesis: replay.genesis, root, baseline: replay.state, replayDigest: replay.replayDigest }, approvalDigest });
  return result;
}
/** Serialized reviews and cloned or fabricated facades confer no capability. */
export function readPreparedProtectedIssuerRestore(value: PreparedProtectedIssuerRestore, approvedDigest: string, pins: {
  path: string; writerDirectory: string; context: HistoryCheckpointContext; profile: AdmissionWalletProfileV1; authority: string;
}): ProtectedIssuerRestoration {
  const record = prepared.get(value);
  if (!record || approvedDigest !== record.approvalDigest || record.path !== resolve(pins.path) || record.writerDirectory !== resolve(pins.writerDirectory)
    || record.contextId !== historyCheckpointContextId(pins.context) || record.authority !== pins.authority || JSON.stringify(record.profile) !== JSON.stringify(pins.profile)
    || record.restoration.replayDigest !== protectedIssuerReplayDigest(record.contextId, historyCheckpointEnvelopeId(record.restoration.genesis),
      historySuccessorProposalId(record.restoration.root.proposal), record.restoration.baseline)) throw new Error('Issuer restore requires matching reviewed history, profile, authority and destinations');
  emptyDestination(record.path, record.writerDirectory);
  return structuredClone(record.restoration);
}
