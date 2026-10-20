import { archivedAdmissionPolicyDigest, verifyArchivedAdmissionPolicy, assertArchivedAdmissionPolicyCurrent, type ArchivedAdmissionPolicy } from '@resonance/core/admission-policy-archive';
/** Explicit review of a complete selected image, before initializing a new protected directory. */
import { existsSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { admissionAuthorityFingerprint, assertAdmissionPolicySuccessor, openAdmissionPolicyStore } from '@resonance/core/admission-policy';
import { historyCheckpointContextId, historyDigest, parseHistoryCheckpointContext, type HistoryCheckpointContext, type HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import { historyContinuationRootId, parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { canonicalHistorySetupPath } from './admission-history-setup.js';
import { assertExistingHistoryAncestryFunding, type OwnedHistoryAncestrySource } from './history-ancestry-source.js';
import { replayAdmissionHistory } from './admission-history-replay.js';
import type { AdmissionHistoryImage } from './admission-history-records.js';

export interface AdmissionHistoryRestoration {
  genesis: HistoryEncryptedEnvelope; baseline: AdmissionHistoryImage; replayDigest: string;
}
export interface PreparedAdmissionHistoryRestore {
  close?(): void;
  readonly review: Readonly<{
    kind: 'admission-history-restore'; directory: string; contextId: string; genesisId: string; rootId: string; generation: number;
    authorityFingerprint: string; recoveredPolicyRevision: number; requestedPolicyRevision: number;
    spends: number; unattributedSpends: number; permanentDenials: number; blocks: number; bytes: number; generations: number;
    witnessVotes: number; coordinatorCertificates: number; rolePermanentDenials: number;
    approvalDigest: string;
  }>;
}
interface Prepared {
  state: 'open' | 'checked' | 'consumed' | 'closed'; requestedDirectory: string; ancestry?: OwnedHistoryAncestrySource; ancestryDirectory?: string; fundingId?: string;
  directory: string; contextId: string; policyDigest: string; root: HistoryContinuationRoot; restoration: AdmissionHistoryRestoration;
  approvalDigest: string; policyStore?: { store: Awaited<ReturnType<typeof openAdmissionPolicyStore>>; identities: Array<{ path: string; dev: number; ino: number; directory: boolean }> };
}
const prepared = new WeakMap<PreparedAdmissionHistoryRestore, Prepared>();

export async function prepareAdmissionHistoryRestore(options: Omit<Parameters<typeof replayAdmissionHistory>[0], 'proposal'> & {
  directory: string; continuation: HistoryContinuationRoot; policy: unknown; now?: () => number; ancestry?: OwnedHistoryAncestrySource; ancestryDirectory?: string; requireSelectedAncestry?: boolean;
}): Promise<PreparedAdmissionHistoryRestore> {
  const requestedDirectory = resolve(options.directory), directory = canonicalHistorySetupPath(requestedDirectory), context = parseHistoryCheckpointContext(structuredClone(options.context));
  const policyInput = structuredClone(options.policy), ancestry = options.ancestry;
  const ancestryDirectory = options.ancestryDirectory === undefined ? undefined : canonicalHistorySetupPath(options.ancestryDirectory);
  if (context.role !== 'relay-admission-spends') throw new Error('Admission history requires its own history role');
  if (existsSync(directory) && readdirSync(directory).length) throw new Error('Admission restore requires a new empty destination');
  const root = parseHistoryContinuationRoot(structuredClone(options.continuation), context), rootId = historyContinuationRootId(root);
  const policy = await verifyArchivedAdmissionPolicy(policyInput, context.authority);
  assertArchivedAdmissionPolicyCurrent(policy, (options.now ?? Date.now)());
  const replay = await replayAdmissionHistory({ ...options, context, proposal: root.proposal });
  if (replay.image.policy.version !== 3 && policy.version !== 3) assertAdmissionPolicySuccessor(replay.image.policy, policy);
  else if (archivedAdmissionPolicyDigest(replay.image.policy) !== archivedAdmissionPolicyDigest(policy)) throw new Error('V3 restoration must retain its exact selected policy and proof');
  assertArchivedAdmissionPolicyCurrent(policy, (options.now ?? Date.now)());
  if (canonicalHistorySetupPath(requestedDirectory) !== directory) throw new Error('Admission restore destination changed during review');
  if (policy.version === 3 && options.requireSelectedAncestry && !ancestry?.binding) throw new Error('Restored v3 admission history requires explicitly selected original ancestry');
  const fundingId = policy.version === 3 && ancestryDirectory ? assertExistingHistoryAncestryFunding(ancestryDirectory) : undefined;
  const policyDigest = archivedAdmissionPolicyDigest(policy);
  const approvalDigest = historyDigest(`resonance:admission-history-restore:v1\n${JSON.stringify([
    directory, replay.contextId, replay.genesisId, rootId, replay.replayDigest, policyDigest, ...(ancestry?.binding ? [ancestry.binding] : []), ...(fundingId ? [fundingId] : []),
  ])}`);
  const result: PreparedAdmissionHistoryRestore = { review: Object.freeze({ kind: 'admission-history-restore' as const, directory,
    contextId: replay.contextId, genesisId: replay.genesisId, rootId, generation: root.generation,
    authorityFingerprint: admissionAuthorityFingerprint(context.authority), recoveredPolicyRevision: replay.image.policy.revision,
    requestedPolicyRevision: policy.revision, spends: replay.image.state.spends.length,
    unattributedSpends: replay.image.state.spends.filter(row => row.issuerKey === null).length,
    permanentDenials: replay.image.state.retiredIssuerKeys.length,
    witnessVotes: replay.image.version === 2 ? replay.image.roles.witness?.votes.length ?? 0 : 0,
    coordinatorCertificates: replay.image.version === 2 ? replay.image.roles.coordinator?.certificates.length ?? 0 : 0,
    rolePermanentDenials: replay.image.version === 2 ? (replay.image.roles.witness?.retiredIssuerKeys.length ?? 0)
      + (replay.image.roles.coordinator?.retiredIssuerKeys.length ?? 0) : 0,
    blocks: replay.blocks, bytes: replay.bytes, generations: replay.generations, approvalDigest }) };
  Object.defineProperty(result, 'close', { value() { const record = prepared.get(result); if (record) { record.state = 'closed'; record.ancestry?.close(); record.ancestry = undefined; } } });
  Object.freeze(result);
  prepared.set(result, { state: 'open', requestedDirectory, ancestry, ancestryDirectory, fundingId, directory, contextId: replay.contextId, policyDigest, root,
    restoration: { genesis: replay.genesis, baseline: replay.image, replayDigest: replay.replayDigest }, approvalDigest });
  return result;
}

/** Only this factory can attach the actual new, live verifier store to a preparation. */
export async function openPreparedAdmissionPolicyStore(value: PreparedAdmissionHistoryRestore, options: {
  directory: string; encryptionKey: Uint8Array; now?: () => number;
}) {
  const record = prepared.get(value);
  if (!record || record.state !== 'open' || record.policyStore || canonicalHistorySetupPath(options.directory) !== record.directory
    || canonicalHistorySetupPath(record.requestedDirectory) !== record.directory) throw new Error('Configured restore needs its original reviewed destination');
  assertRestoreDestination(record);
  const path = join(record.directory, 'admission-community-policy.json');
  const store = await openAdmissionPolicyStore({ path, encryptionKey: options.encryptionKey, now: options.now, mode: 'create-new' });
  try {
    if (record.state !== 'open') throw new Error('Configured restore preparation closed during policy-store acquisition');
    const paths = [path, `${path}.lock`, ...readdirSync(`${path}.lock`).map(name => join(`${path}.lock`, name))];
    const identities = paths.map(path => { const stat = lstatSync(path); if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error('Invalid owned policy-store identity'); return { path, dev: stat.dev, ino: stat.ino, directory: stat.isDirectory() }; });
    record.policyStore = { store, identities };
    assertRestoreDestination(record); return store;
  } catch (error) { store.close(); throw error; }
}
function assertRestorePath(record: Prepared) {
  if (canonicalHistorySetupPath(record.requestedDirectory) !== record.directory) throw new Error('Admission restore destination changed after review');
}
function assertRestoreDestination(record: Prepared) {
  assertRestorePath(record);
  const owned = record.policyStore;
  if (owned) {
    owned.store.retained(); // Closed or foreign handles cannot preserve the exception.
    const lock = owned.identities[1].path;
    if (JSON.stringify(readdirSync(lock).sort()) !== JSON.stringify(owned.identities.slice(2).map(identity => basename(identity.path)).sort())) throw new Error('Owned verifier policy-store lock changed');
    for (const identity of owned.identities) {
      const stat = lstatSync(identity.path);
      if (stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino || stat.isDirectory() !== identity.directory
        || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Owned verifier policy-store identity changed');
    }
  }
  if (existsSync(record.directory) && readdirSync(record.directory).some(name => !owned || !['admission-community-policy.json', 'admission-community-policy.json.lock'].includes(name))) throw new Error('Admission restore requires a new empty destination');
}

/** Internal capability check. JSON reviews, booleans and fabricated/cloned facades cannot initialize a ledger. */
export function readPreparedAdmissionRestore(value: PreparedAdmissionHistoryRestore, approvedDigest: string,
  directory: string, context: HistoryCheckpointContext, policy: ArchivedAdmissionPolicy) {
  const record = prepared.get(value);
  if (!record || record.state === 'closed' || record.state === 'consumed' || typeof approvedDigest !== 'string' || approvedDigest !== record.approvalDigest
    || record.directory !== canonicalHistorySetupPath(directory) || record.directory !== canonicalHistorySetupPath(record.requestedDirectory) || record.contextId !== historyCheckpointContextId(context)
    || record.policyDigest !== archivedAdmissionPolicyDigest(policy)) throw new Error('Admission restore needs matching reviewed history, policy and destination');
  if (record.fundingId && record.ancestryDirectory) assertExistingHistoryAncestryFunding(record.ancestryDirectory, record.fundingId);
  if (record.ancestry) for (const _ of record.ancestry.blocks()) { /* Validate before owner mutation. */ }
  assertRestoreDestination(record);
  record.state = 'checked';
  return { ...structuredClone({ root: record.root, restoration: record.restoration }), directory: record.directory,
    assertDestination: () => assertRestoreDestination(record), assertPath: () => assertRestorePath(record) };
}

/** One-time ownership transfer after checking the opaque review capability. */
export function takePreparedAdmissionAncestry(value: PreparedAdmissionHistoryRestore) {
  const record = prepared.get(value);
  if (!record || record.state !== 'checked') throw new Error('Admission restore preparation is closed, consumed or unchecked');
  record.state = 'consumed'; const source = record.ancestry; record.ancestry = undefined; return source;
}
