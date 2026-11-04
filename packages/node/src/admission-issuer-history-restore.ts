import { assertExistingHistoryAncestryFunding, type OwnedHistoryAncestrySource } from '../../relay/src/history-ancestry-source.js';
import type { ProtectedIssuerState as State } from './protected-admission-issuer-state.js';
/** In-process review capability for a complete selected issuer history. */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalHistorySetupPath } from '../../relay/src/admission-history-setup.js';
import { admissionAuthorityFingerprint } from '@resonance/core/admission-policy';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, parseHistoryCheckpointContext, type HistoryCheckpointContext, type HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import { parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { protectedIssuerReplayDigest } from '@resonance/relay/protected-issuer-history';
import { historySuccessorProposalId } from '@resonance/core/history-successor';
import { admissionKeyFingerprint, type AdmissionWalletProfileV1 } from './admission-wallet-profile.js';
import { totals } from './admission-issuer-state.js';
import { replayProtectedIssuerHistory, type ProtectedIssuerReplayOptions } from './admission-issuer-history-replay.js';

export interface ProtectedIssuerRestoration { genesis: HistoryEncryptedEnvelope; root: HistoryContinuationRoot; baseline: State; replayDigest: string }
export interface PreparedProtectedIssuerRestore {
  close?(): void;
  readonly review: Readonly<{ kind: 'protected-issuer-restore'; path: string; writerDirectory: string; contextId: string; genesisId: string;
    rootId: string; generation: number; authorityFingerprint: string; issuerKeyFingerprint: string; policyRevision: number;
    observedRevision: number; conflict: boolean; permanentlyRetired: boolean; allocatedPermits: number; boundPermits: number;
    preparedPermits: number; completedPermits: number; blocks: number; bytes: number; generations: number; approvalDigest: string }>;
}
interface Prepared { state: 'open' | 'checked' | 'consumed' | 'closed'; path: string; writerDirectory: string; requestedPath: string; requestedWriterDirectory: string; contextId: string; profile: AdmissionWalletProfileV1; authority: string;
  ancestryDirectory?: string; fundingId?: string; ancestry?: OwnedHistoryAncestrySource; restoration: ProtectedIssuerRestoration; approvalDigest: string }
const prepared = new WeakMap<PreparedProtectedIssuerRestore, Prepared>();
function emptyDestination(path: string, writerDirectory: string) {
  if (existsSync(path) || existsSync(writerDirectory) && readdirSync(writerDirectory).length) throw new Error('Issuer restore requires a new owner file and empty writer destination');
}
export async function prepareProtectedIssuerRestore(options: Omit<ProtectedIssuerReplayOptions, 'proposal'> & {
  destination: { path: string; writerDirectory: string }; continuation: HistoryContinuationRoot; ancestry?: OwnedHistoryAncestrySource; ancestryDirectory?: string;
}): Promise<PreparedProtectedIssuerRestore> {
  const ancestry = options.ancestry, ancestryDirectory = options.ancestryDirectory === undefined ? undefined : canonicalHistorySetupPath(options.ancestryDirectory);
  const requestedPath = resolve(options.destination.path), requestedWriterDirectory = resolve(options.destination.writerDirectory);
  const path = canonicalHistorySetupPath(requestedPath), writerDirectory = canonicalHistorySetupPath(requestedWriterDirectory);
  const context = parseHistoryCheckpointContext(structuredClone(options.context)), authority = options.authority, profile = structuredClone(options.profile);
  const root = parseHistoryContinuationRoot(structuredClone(options.continuation), context), rootId = historyCheckpointEnvelopeId(root);
  emptyDestination(path, writerDirectory);
  // replay snapshots caller-owned blocks, evidence and key synchronously before its first await.
  const replay = await replayProtectedIssuerHistory({ ...options, context, profile, authority, proposal: root.proposal });
  if (canonicalHistorySetupPath(requestedPath) !== path || canonicalHistorySetupPath(requestedWriterDirectory) !== writerDirectory) throw new Error('Issuer restore destinations changed during review');
  const fundingId = replay.state.communityPolicy?.version === 3 && ancestryDirectory ? assertExistingHistoryAncestryFunding(ancestryDirectory) : undefined;
  const canonicalProfile = structuredClone(replay.state.profile);
  const approvalDigest = historyDigest(`resonance:protected-issuer-restore:v1\n${JSON.stringify([
    path, writerDirectory, replay.contextId, replay.genesisId, rootId, canonicalProfile, authority, replay.replayDigest, ...(ancestry?.binding ? [ancestry.binding] : []), ...(fundingId ? [fundingId] : []),
  ])}`);
  const result = Object.freeze({ close() { const record = prepared.get(result); if (record) { record.state = 'closed'; record.ancestry?.close(); record.ancestry = undefined; } }, review: Object.freeze({ kind: 'protected-issuer-restore' as const, path, writerDirectory,
    contextId: replay.contextId, genesisId: replay.genesisId, rootId, generation: root.generation,
    authorityFingerprint: admissionAuthorityFingerprint(authority), issuerKeyFingerprint: admissionKeyFingerprint(profile.issuerPublicKey),
    policyRevision: replay.state.communityPolicy!.revision, observedRevision: replay.state.freshness!.observed.revision,
    conflict: !!replay.state.freshness!.conflict, permanentlyRetired: replay.state.version === 9, ...totals(replay.state),
    preparedPermits: replay.state.entries.filter(entry => entry.preparedResponse).length, blocks: replay.blocks, bytes: replay.bytes,
    generations: replay.generations, approvalDigest }) });
  prepared.set(result, { state: 'open', path, writerDirectory, requestedPath, requestedWriterDirectory, contextId: replay.contextId, profile: canonicalProfile, authority,
    ancestryDirectory, fundingId, ancestry, restoration: { genesis: replay.genesis, root, baseline: replay.state, replayDigest: replay.replayDigest }, approvalDigest });
  return result;
}
/** Serialized reviews and cloned or fabricated facades confer no capability. */
export function readPreparedProtectedIssuerRestore(value: PreparedProtectedIssuerRestore, approvedDigest: string, pins: {
  path: string; writerDirectory: string; context: HistoryCheckpointContext; profile: AdmissionWalletProfileV1; authority: string;
}): ProtectedIssuerRestoration {
  const record = prepared.get(value);
  if (!record || record.state === 'closed' || record.state === 'consumed' || approvedDigest !== record.approvalDigest || record.path !== canonicalHistorySetupPath(pins.path) || record.writerDirectory !== canonicalHistorySetupPath(pins.writerDirectory)
    || record.path !== canonicalHistorySetupPath(record.requestedPath) || record.writerDirectory !== canonicalHistorySetupPath(record.requestedWriterDirectory)
    || record.contextId !== historyCheckpointContextId(pins.context) || record.authority !== pins.authority || JSON.stringify(record.profile) !== JSON.stringify(pins.profile)
    || record.restoration.replayDigest !== protectedIssuerReplayDigest(record.contextId, historyCheckpointEnvelopeId(record.restoration.genesis),
      historySuccessorProposalId(record.restoration.root.proposal), record.restoration.baseline)) throw new Error('Issuer restore requires matching reviewed history, profile, authority and destinations');
  if (record.fundingId && record.ancestryDirectory) assertExistingHistoryAncestryFunding(record.ancestryDirectory, record.fundingId);
  if (record.ancestry) for (const _ of record.ancestry.blocks()) { /* Recheck immutable ciphertext before any owner intent. */ }
  emptyDestination(record.path, record.writerDirectory);
  record.state = 'checked';
  return structuredClone(record.restoration);
}

/** Transfer the authenticated downloader only after the restoration capability was checked. */
export function takePreparedProtectedIssuerAncestry(value: PreparedProtectedIssuerRestore) {
  const record = prepared.get(value);
  if (!record || record.state !== 'checked') throw new Error('Issuer restore preparation is closed, consumed or unchecked');
  record.state = 'consumed';
  const source = record.ancestry; record.ancestry = undefined;
  return source;
}
