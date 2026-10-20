import type { ArchivedAdmissionPolicy } from '@resonance/core/admission-policy-archive';
/** Reviewed owner-policy preparation. The caller holds stopped-runtime exclusion
 * through review/apply and any subsequent desktop configuration write. */
import { captureStorageReservationOperation } from '@resonance/core/storage-reservations';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLocalStateLock } from '@resonance/core/local-state';
import { admissionPolicyDigest as legacyAdmissionPolicyDigest, assertAdmissionPolicyCurrent, assertAdmissionPolicySuccessor, openAdmissionPolicyStore, verifyAdmissionPolicy } from '@resonance/core/admission-policy';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest, parseHistoryCheckpointEnvelope, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { openProtectedAdmissionSpendHistory, type AdmissionHistoryProtection } from './protected-admission-history.js';

export interface AdmissionHistoryActivationOptions {
  runtimeDirectory: string; historyDirectory: string; policy: unknown; encryptionKey: Uint8Array;
  protection: AdmissionHistoryProtection; genesis: HistoryCheckpointEnvelope;
  /** Binds desktop settings/file selection to this review without storing their contents here. */
  intentDigest?: string; signal?: AbortSignal;
}
export interface AdmissionHistoryActivationReview {
  version: 1; kind: 'protected-owner-activation'; runtimeDirectory: string; historyDirectory: string;
  contextId: string; genesisId: string; owner: string; authority: string;
  generation: number; sequence: number; headId: string; policyDigest: string; policyRevision: number;
  previousPolicyDigest: string | null; previousContextId: string | null;
  policyAction: 'create' | 'resume' | 'update' | 'retain'; spends: number; permanentDenials: number;
  intentDigest: string | null; readiness: 'unverified'; startsService: false; initializesWitnessState: false;
  approvalDigest: string;
}
function present(path: string) {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function openAdmissionHistoryActivation(options: AdmissionHistoryActivationOptions) {
  const run = captureStorageReservationOperation();
  const cancelled = () => { if (options.signal?.aborted) throw new Error('Owner activation cancelled; retain prepared policy and history'); };
  cancelled();
  if (options.protection.initializeWriter || options.protection.initializeArchive || options.protection.resumePristineArchive || options.protection.promoteLocalHistory || options.protection.restore) {
    throw new Error('Activation only opens already prepared history; initialization, promotion and restore require separate review');
  }
  if (options.intentDigest !== undefined && !isHistoryDigest(options.intentDigest)) throw new Error('Invalid activation intent digest');
  const runtimeDirectory = realpathSync(options.runtimeDirectory), historyDirectory = realpathSync(options.historyDirectory);
  const contextId = historyCheckpointContextId(options.protection.context);
  const genesis = parseHistoryCheckpointEnvelope(options.genesis, options.protection.context), genesisId = historyCheckpointEnvelopeId(genesis);
  if (genesis.generation !== 0 || genesis.sequence !== 0 || genesis.kind !== 'checkpoint') throw new Error('Activation requires independently pinned genesis');
  const policy = await verifyAdmissionPolicy(options.policy, options.protection.context.authority);
  assertAdmissionPolicyCurrent(policy, Date.now()); cancelled();
  const policyPath = join(runtimeDirectory, 'admission-community-policy.json');
  const release = acquireLocalStateLock(join(runtimeDirectory, 'admission-history-activation'));
  let store: Awaited<ReturnType<typeof openAdmissionPolicyStore>> | undefined;
  let history: Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>> | undefined;
  let closed = false, busy = false, applied = false;
  function close() {
    if (closed) return; closed = true;
    try { history?.close(); } finally { try { store?.close(); } finally { release(); } }
  }
  try {
    const existed = present(policyPath);
    if (existed) store = await openAdmissionPolicyStore({ path: policyPath, encryptionKey: options.encryptionKey, mode: 'open-existing' });
    const previousPolicy = store?.current(), previousContext = store?.protectedHistoryContext();
    if (previousContext && previousContext !== contextId) throw new Error('Activation cannot replace the retained protected history context');
    if (previousPolicy) assertAdmissionPolicySuccessor(previousPolicy, policy);
    // An unrelated local ledger may contain accepted work that was never copied
    // into this history. Review cannot silently bypass its migration/promotion.
    if (!previousContext && runtimeDirectory !== historyDirectory && present(join(runtimeDirectory, 'admission-spends-v2.jsonl'))) {
      throw new Error('Existing unbound spend history must be protected at its current location before selecting a separate history');
    }
    history = await openProtectedAdmissionSpendHistory({ directory: historyDirectory, encryptionKey: options.encryptionKey,
      authority: options.protection.context.authority, policy, protection: options.protection });
    const state = history.read(), retainedGenesis = state.version === 4 ? state.restoration.genesis : state.root;
    if (historyCheckpointEnvelopeId(retainedGenesis) !== genesisId) throw new Error('Prepared history differs from independently pinned genesis');
    if (state.pending || !state.applied) throw new Error('Finish pending protected history explicitly before reviewing activation');
    if (admissionPolicyDigest(state.image.policy) !== admissionPolicyDigest(policy)) throw new Error('Apply the supplied policy to protected history before reviewing activation');
    const headId = state.applied.id, policyDigest = admissionPolicyDigest(policy);
    const details: Omit<AdmissionHistoryActivationReview, 'approvalDigest'> = {
      version: 1, kind: 'protected-owner-activation', runtimeDirectory, historyDirectory, contextId, genesisId,
      owner: options.protection.context.owner, authority: policy.authority, generation: state.root.generation, sequence: state.applied.sequence,
      headId, policyDigest, policyRevision: policy.revision, previousPolicyDigest: previousPolicy ? admissionPolicyDigest(previousPolicy) : null,
      previousContextId: previousContext ?? null, policyAction: !existed ? 'create' : !previousPolicy ? 'resume'
        : admissionPolicyDigest(previousPolicy) !== policyDigest ? 'update' : 'retain',
      spends: state.image.state.spends.length, permanentDenials: state.image.state.retiredIssuerKeys.length,
      intentDigest: options.intentDigest ?? null, readiness: 'unverified', startsService: false, initializesWitnessState: false,
    };
    const review: AdmissionHistoryActivationReview = { ...details,
      approvalDigest: historyDigest(`resonance:protected-owner-activation:v1\n${JSON.stringify([details, historyDigest(options.encryptionKey)])}`) };
    cancelled();
    return {
      review: () => { if (closed) throw new Error('Activation review is closed'); return structuredClone(review); },
      async apply(approvedDigest: string) { return run(async () => {
        if (closed || busy || applied) throw new Error('Activation is closed, busy or already applied');
        if (approvedDigest !== review.approvalDigest) throw new Error('Activation approval does not match; review current history and settings again');
        cancelled(); busy = true;
        try {
          // Approval is checked before the first network exchange. A cached
          // receipt, copied review or coherent stale backup cannot authorize this.
          await history!.ready(); cancelled();
          const current = history!.read();
          if (current.pending || !current.applied || current.applied.id !== headId
            || admissionPolicyDigest(current.image.policy) !== policyDigest) throw new Error('Protected history changed; review activation again');
          assertAdmissionPolicyCurrent(policy, Date.now());
          if (!store) {
            // Exclusive creation refuses a racing initializer. Interrupted empty
            // preparation needs another explicit review, never automatic startup.
            store = await openAdmissionPolicyStore({ path: policyPath, encryptionKey: options.encryptionKey, mode: 'create-new' });
            if (closed) { store.close(); throw new Error('Activation is closed'); }
          }
          cancelled(); await store.install(policy, policy.authority); cancelled();
          store.bindProtectedHistory(contextId); cancelled(); applied = true;
          return { result: 'owner-policy-prepared' as const, contextId, generation: current.root.generation,
            readiness: 'confirmed' as const, startsService: false as const, initializesWitnessState: false as const };
        } finally { busy = false; }
      }); }, close,
    };
  } catch (error) { close(); throw error; }
}

function admissionPolicyDigest(policy: ArchivedAdmissionPolicy): string { if (policy.version === 3) throw new Error('This operator entrypoint explicitly refuses v3 policies'); return legacyAdmissionPolicyDigest(policy); }
