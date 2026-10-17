/** Review completion of an already published restoration, without replacing it. */
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { admissionPolicyDigest, assertAdmissionPolicyCurrent, verifyAdmissionPolicy } from '@resonance/core/admission-policy';
import { copyAdmissionSigningKey } from '@resonance/core/admission-witness';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest } from '@resonance/core/history-checkpoint';
import { inspectProtectedAdmissionSpendHistory, openProtectedAdmissionSpendHistory, type AdmissionHistoryProtection } from './protected-admission-history.js';

interface AdmissionHistoryReadinessReview {
  kind: 'admission-restoration-readiness' | 'admission-initial-readiness'; directory: string; contextId: string; genesisId: string; rootId: string; generation: number;
  replayDigest: string | null;
  stateDigest: string; sequence: number | null; pending: boolean; policyRevision: number; requestedPolicyRevision: number;
  appliedSpends: number; permanentDenials: number; initializeWriter: boolean; initializeArchive: boolean;
  readiness: 'unverified'; startsService: false; approvalDigest: string;
}
export interface AdmissionRestorationReadinessReview extends AdmissionHistoryReadinessReview { kind: 'admission-restoration-readiness'; replayDigest: string }
export interface AdmissionInitialReadinessReview extends AdmissionHistoryReadinessReview { kind: 'admission-initial-readiness'; replayDigest: null }
interface ReadinessOptions {
  directory: string; policy: unknown; encryptionKey: Uint8Array; protection: AdmissionHistoryProtection; signal?: AbortSignal;
}
function present(path: string) {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
/** Expected roots/replay come from the completed recovery workspace, not from
 * the candidate directory or a browser-supplied serialized review. */
export async function openAdmissionRestorationReadiness(options: ReadinessOptions & { expected: { rootId: string; genesisId: string; replayDigest: string } }) {
  const handle = await openReadiness(options, false);
  return { ...handle, review: () => handle.review() as AdmissionRestorationReadinessReview };
}
/** Initial readiness is pinned to the independently exported generation-zero
 * genesis. It cannot be used to bypass recovery ancestry for a restored owner. */
export async function openAdmissionInitialReadiness(options: ReadinessOptions & { genesisId: string }) {
  const handle = await openReadiness({ ...options, expected: { rootId: options.genesisId, genesisId: options.genesisId, replayDigest: null } }, true);
  return { ...handle, review: () => handle.review() as AdmissionInitialReadinessReview };
}
async function openReadiness(options: ReadinessOptions & { expected: { rootId: string; genesisId: string; replayDigest: string | null } }, initial: boolean) {
  const check = () => { if (options.signal?.aborted) throw new Error('Readiness completion cancelled; retain restored history'); };
  check();
  if (!isHistoryDigest(options.expected.rootId) || !isHistoryDigest(options.expected.genesisId)
    || (!initial && !isHistoryDigest(options.expected.replayDigest))) throw new Error('Invalid recovery readiness pins');
  const directory = realpathSync(options.directory);
  const policy = await verifyAdmissionPolicy(options.policy, options.protection.context.authority); assertAdmissionPolicyCurrent(policy, Date.now()); check();
  const encryptionKey = Buffer.from(options.encryptionKey);
  let signingKey: ReturnType<typeof copyAdmissionSigningKey>;
  try { signingKey = copyAdmissionSigningKey(options.protection.signingKey); }
  catch (error) { encryptionKey.fill(0); throw error; }
  const p = { ...options.protection, signingKey };
  let inspection: Awaited<ReturnType<typeof inspectProtectedAdmissionSpendHistory>> | undefined;
  let history: Awaited<ReturnType<typeof openProtectedAdmissionSpendHistory>> | undefined;
  let closed = false, busy = false, applied = false;
  function close() {
    if (closed) return; closed = true;
    try { inspection?.close(); } finally { try { history?.close(); } finally { encryptionKey.fill(0); signingKey.secretKey.fill(0); } }
  }
  try {
    inspection = await inspectProtectedAdmissionSpendHistory({ directory, policy, authority: p.context.authority, encryptionKey, protection: p });
    const state = inspection.read();
    if (initial ? state.version !== 3 || historyCheckpointEnvelopeId(state.root) !== options.expected.genesisId
      : state.version !== 4 || historyCheckpointEnvelopeId(state.root) !== options.expected.rootId
        || historyCheckpointEnvelopeId(state.restoration.genesis) !== options.expected.genesisId
        || state.restoration.replayDigest !== options.expected.replayDigest) {
      throw new Error(initial ? 'Initial history differs from its independently pinned genesis' : 'Restored history differs from the completed recovery workspace');
    }
    const stateDigest = historyDigest(JSON.stringify(state)), writer = join(directory, 'admission-history-writer');
    const initializeWriter = !present(join(writer, 'history-writer.json'));
    const initializeArchive = !present(join(writer, 'payloads', 'history-writer-payloads.json'));
    if ((initializeWriter || initializeArchive) && state.applied !== null) throw new Error('Committed writer or archive history is missing; preserve the directory for recovery');
    const details: Omit<AdmissionHistoryReadinessReview, 'approvalDigest'> = {
      kind: initial ? 'admission-initial-readiness' : 'admission-restoration-readiness', directory, contextId: historyCheckpointContextId(p.context),
      ...options.expected, generation: state.root.generation, stateDigest,
      sequence: state.applied?.sequence ?? null, pending: state.pending !== null,
      policyRevision: state.image.policy.revision, requestedPolicyRevision: policy.revision,
      appliedSpends: state.image.state.spends.length, permanentDenials: state.image.state.retiredIssuerKeys.length,
      initializeWriter, initializeArchive, readiness: 'unverified', startsService: false,
    };
    const review: AdmissionHistoryReadinessReview = { ...details, approvalDigest: historyDigest(
      `resonance:${details.kind}:v1\n${JSON.stringify([details, admissionPolicyDigest(policy), historyDigest(encryptionKey)])}`) };
    check();
    return {
      review() { if (closed) throw new Error('Readiness review is closed'); return structuredClone(review); },
      async apply(approved: string) {
        if (closed || busy || applied) throw new Error('Readiness review is closed, busy or already applied');
        if (approved !== review.approvalDigest) throw new Error('Readiness approval changed; review retained restoration again');
        check(); busy = true;
        try {
          inspection!.close();
          history = await openProtectedAdmissionSpendHistory({ directory, policy, authority: p.context.authority, encryptionKey,
            expectedStateDigest: stateDigest, protection: { ...p, initializeWriter, initializeArchive, resumePristineArchive: initializeArchive } });
          if (closed) { history.close(); throw new Error('Readiness review is closed'); }
          check(); await history.ready(); check(); applied = true;
          return { result: 'history-ready' as const, generation: history.read().root.generation, readiness: 'confirmed' as const, startsService: false as const };
        } finally { busy = false; }
      }, close,
    };
  } catch (error) { close(); throw error; }
}
