/** Explicit review of a complete selected image, before initializing a new protected directory. */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { admissionAuthorityFingerprint, admissionPolicyDigest, assertAdmissionPolicyCurrent,
  assertAdmissionPolicySuccessor, verifyAdmissionPolicy, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { historyCheckpointContextId, historyDigest, parseHistoryCheckpointContext, type HistoryCheckpointContext,
  type HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import { historyContinuationRootId, parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { replayAdmissionHistory } from './admission-history-replay.js';
import type { AdmissionHistoryImage } from './admission-history-records.js';

export interface AdmissionHistoryRestoration {
  genesis: HistoryEncryptedEnvelope; baseline: AdmissionHistoryImage; replayDigest: string;
}
export interface PreparedAdmissionHistoryRestore {
  readonly review: Readonly<{
    kind: 'admission-history-restore'; directory: string; contextId: string; genesisId: string; rootId: string; generation: number;
    authorityFingerprint: string; recoveredPolicyRevision: number; requestedPolicyRevision: number;
    spends: number; unattributedSpends: number; permanentDenials: number; blocks: number; bytes: number; generations: number;
    witnessVotes: number; coordinatorCertificates: number; rolePermanentDenials: number;
    approvalDigest: string;
  }>;
}
interface Prepared {
  directory: string; contextId: string; policyDigest: string; root: HistoryContinuationRoot; restoration: AdmissionHistoryRestoration;
  approvalDigest: string;
}
const prepared = new WeakMap<PreparedAdmissionHistoryRestore, Prepared>();

export async function prepareAdmissionHistoryRestore(options: Omit<Parameters<typeof replayAdmissionHistory>[0], 'proposal'> & {
  directory: string; continuation: HistoryContinuationRoot; policy: unknown; now?: () => number;
}): Promise<PreparedAdmissionHistoryRestore> {
  const directory = resolve(options.directory), context = parseHistoryCheckpointContext(options.context);
  if (existsSync(directory) && readdirSync(directory).length) throw new Error('Admission restore requires a new empty destination');
  const root = parseHistoryContinuationRoot(options.continuation, context), rootId = historyContinuationRootId(root);
  const policy = await verifyAdmissionPolicy(options.policy, context.authority);
  assertAdmissionPolicyCurrent(policy, (options.now ?? Date.now)());
  const replay = await replayAdmissionHistory({ ...options, context, proposal: root.proposal });
  assertAdmissionPolicySuccessor(replay.image.policy, policy);
  assertAdmissionPolicyCurrent(policy, (options.now ?? Date.now)());
  const policyDigest = admissionPolicyDigest(policy);
  const approvalDigest = historyDigest(`resonance:admission-history-restore:v1\n${JSON.stringify([
    directory, replay.contextId, replay.genesisId, rootId, replay.replayDigest, policyDigest,
  ])}`);
  const result = Object.freeze({ review: Object.freeze({ kind: 'admission-history-restore' as const, directory,
    contextId: replay.contextId, genesisId: replay.genesisId, rootId, generation: root.generation,
    authorityFingerprint: admissionAuthorityFingerprint(context.authority), recoveredPolicyRevision: replay.image.policy.revision,
    requestedPolicyRevision: policy.revision, spends: replay.image.state.spends.length,
    unattributedSpends: replay.image.state.spends.filter(row => row.issuerKey === null).length,
    permanentDenials: replay.image.state.retiredIssuerKeys.length,
    witnessVotes: replay.image.version === 2 ? replay.image.roles.witness?.votes.length ?? 0 : 0,
    coordinatorCertificates: replay.image.version === 2 ? replay.image.roles.coordinator?.certificates.length ?? 0 : 0,
    rolePermanentDenials: replay.image.version === 2 ? (replay.image.roles.witness?.retiredIssuerKeys.length ?? 0)
      + (replay.image.roles.coordinator?.retiredIssuerKeys.length ?? 0) : 0,
    blocks: replay.blocks, bytes: replay.bytes, generations: replay.generations, approvalDigest }) });
  prepared.set(result, { directory, contextId: replay.contextId, policyDigest, root,
    restoration: { genesis: replay.genesis, baseline: replay.image, replayDigest: replay.replayDigest }, approvalDigest });
  return result;
}

/** Internal capability check. JSON reviews, booleans and fabricated/cloned facades cannot initialize a ledger. */
export function readPreparedAdmissionRestore(value: PreparedAdmissionHistoryRestore, approvedDigest: string,
  directory: string, context: HistoryCheckpointContext, policy: SignedAdmissionPolicy) {
  const record = prepared.get(value);
  if (!record || typeof approvedDigest !== 'string' || approvedDigest !== record.approvalDigest
    || record.directory !== resolve(directory) || record.contextId !== historyCheckpointContextId(context)
    || record.policyDigest !== admissionPolicyDigest(policy)) throw new Error('Admission restore needs matching reviewed history, policy and destination');
  return structuredClone({ root: record.root, restoration: record.restoration });
}
