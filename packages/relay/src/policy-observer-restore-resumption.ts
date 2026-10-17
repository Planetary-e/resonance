/** Review only the local completion of an independently verified restoration.
 * Fresh signing readiness is a separate operation after this handle closes. */
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { captureStorageReservationOperation } from '@resonance/core/storage-reservations';
import { copyAdmissionSigningKey } from '@resonance/core/admission-witness';
import { parseAdmissionPolicyObservers } from '@resonance/core/admission-policy-freshness';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { parseHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { assertPolicyObserverHistoryContext, decodePolicyObserverSnapshot } from './policy-observer-history-replay.js';
import { openPolicyObserverRestoration } from './policy-observer-history-restore.js';
import { openProtectedPolicyObserver, POLICY_OBSERVER_RECOVERY_FENCE } from './protected-policy-observer.js';
import { createHistoryCheckpointWriter, HISTORY_WRITER_FILENAME } from './history-checkpoint-quorum.js';
import { assertHistoryWriterArchiveInitialization, HISTORY_WRITER_ARCHIVE_FILENAME } from './history-writer-archive.js';
import { readOperatorFile } from './admission-operator-files.js';
import { parseAdmissionHistoryArchiveLimits } from './admission-history-config.js';
import { HISTORY_RECOVERY_MAX_BLOCKS, HISTORY_RECOVERY_MAX_BYTES } from '@resonance/core/history-exchange';
import { assertSecureRelayTransportEndpoint } from '@resonance/core';
import { collectCurrentHistoryHead } from './history-current-head.js';
import { exchangeHistoryCheckpoint } from './history-checkpoint-exchange.js';

type Options = Omit<Parameters<typeof openProtectedPolicyObserver>[0], 'mode' | 'restore' | 'initializeWriter' | 'initializeArchive' | 'resumePristineArchive'> & {
  expectedRestorationDigest: string; signal?: AbortSignal;
};
export async function openPolicyObserverRestoreResumption(options: Options) {
  const run = captureStorageReservationOperation(), signal = options.signal;
  const directory = realpathSync(options.directory), context = parseAdmissionPolicyObservers(options.context);
  const historyContext = parseHistoryCheckpointContext(options.historyContext); assertPolicyObserverHistoryContext(context, historyContext);
  const root = parseHistoryContinuationRoot(options.root, historyContext), genesis = parseHistoryCheckpointEnvelope(options.genesis, historyContext);
  if (genesis.kind !== 'checkpoint' || genesis.generation !== 0 || genesis.sequence !== 0) throw new Error('Restoration resumption needs independent genesis');
  const rootId = historyCheckpointEnvelopeId(root), genesisId = historyCheckpointEnvelopeId(genesis);
  if (!(options.encryptionKey instanceof Uint8Array) || options.encryptionKey.length !== 32) throw new Error('Policy resumption requires a 32-byte key');
  const limits = parseAdmissionHistoryArchiveLimits({ archiveBytes: options.maxArchiveBytes ?? HISTORY_RECOVERY_MAX_BYTES, archiveBlocks: options.maxArchiveBlocks ?? HISTORY_RECOVERY_MAX_BLOCKS });
  if (limits.archiveBytes < Buffer.byteLength(JSON.stringify(root))) throw new Error('Policy archive budget cannot retain its certified root');
  const members = structuredClone(options.members), timeoutMs = options.timeoutMs ?? 3000;
  if (!Array.isArray(members) || members.length !== 5 || new Set(members.map(m => m.publicKey)).size !== 5
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) throw new Error('Invalid policy resumption members or deadline');
  for (const member of members) {
    if (!historyContext.members.includes(member.publicKey)) throw new Error('Unknown policy resumption member');
    assertSecureRelayTransportEndpoint(member.endpoint); member.endpoint = new URL(member.endpoint).href;
  }
  if (new Set(members.map(m => m.endpoint)).size !== 5) throw new Error('Policy resumption needs distinct pinned endpoints');
  const signer = copyAdmissionSigningKey(options.signingKey), key = Uint8Array.from(options.encryptionKey);
  const p = { ...options, directory, context, historyContext, root, genesis, members, timeoutMs, encryptionKey: key, signingKey: signer,
    maxArchiveBytes: limits.archiveBytes, maxArchiveBlocks: limits.archiveBlocks };
  let baseline: Awaited<ReturnType<typeof openPolicyObserverRestoration>> | undefined;
  let writer: ReturnType<typeof createHistoryCheckpointWriter> | undefined;
  let observer: Awaited<ReturnType<typeof openProtectedPolicyObserver>> | undefined;
  let closed = false, applied = false, busy = false, active: AbortController | undefined;
  function live() { if (closed || signal?.aborted) throw new Error('Policy restoration resumption closed or cancelled'); }
  function release() { observer?.close(); observer = undefined; writer?.close(); writer = undefined; baseline?.close(); baseline = undefined; }
  function close() { if (!closed) { closed = true; active?.abort(); release(); key.fill(0); signer.secretKey.fill(0); } }
  const writerPath = join(directory, HISTORY_WRITER_FILENAME), archiveDirectory = join(directory, 'payloads');
  const archivePath = join(archiveDirectory, HISTORY_WRITER_ARCHIVE_FILENAME);
  function fileDigest(path: string, max: number) {
    if (!existsSync(path)) return null;
    const bytes = readOperatorFile(path, max); try { return historyDigest(bytes); } finally { bytes.fill(0); }
  }
  function retainedFiles() { return { writer: fileDigest(writerPath, 40 * 1024 * 1024), archive: fileDigest(archivePath, 2 * 1024 * 1024),
    fenced: existsSync(join(directory, POLICY_OBSERVER_RECOVERY_FENCE)), archiveDirectory: existsSync(archiveDirectory) }; }
  try {
    live(); if (Buffer.from(signer.publicKey).toString('base64url') !== historyContext.owner) throw new Error('Wrong policy restoration owner');
    await decodePolicyObserverSnapshot(genesis, historyContext, context, key); live();
    baseline = await openPolicyObserverRestoration({ directory, context, historyContext, root, genesisId, encryptionKey: key,
      mode: 'open-existing', expectedReplayDigest: p.expectedRestorationDigest }); live();
    const initializeWriter = !existsSync(writerPath), initializeArchive = !existsSync(archivePath);
    if (initializeWriter && existsSync(archiveDirectory)) throw new Error('Cannot recreate a missing policy writer alongside retained archive evidence');
    if ((initializeWriter || initializeArchive) && existsSync(join(directory, POLICY_OBSERVER_RECOVERY_FENCE))) throw new Error('Fenced policy history needs complete recovery, not pristine resumption');
    if (!initializeWriter) writer = createHistoryCheckpointWriter({ directory, localKey: key, signingKey: signer, context: historyContext,
      rootId, generation: root.generation, continuation: root, members: p.members, timeoutMs: p.timeoutMs, transport: p.transport, requireCurrentHead: true });
    if (initializeArchive && writer?.read().committed) throw new Error('Committed policy archive is missing; preserve it for recovery');
    if (initializeArchive) assertHistoryWriterArchiveInitialization(archiveDirectory, writer?.read() ?? { committed: null, pending: null }, true);
    if (!initializeWriter && !initializeArchive) {
      release(); observer = await openProtectedPolicyObserver({ ...p, mode: 'open-existing' }); live();
    }
    const files = retainedFiles(), state = observer?.recoveryState() ?? baseline!.state;
    const details = { kind: 'policy-restoration-resumption' as const, directory, contextId: historyCheckpointContextId(historyContext), genesisId, rootId,
      generation: root.generation, replayDigest: p.expectedRestorationDigest, stateDigest: historyDigest(JSON.stringify(state)),
      policyRevision: state.policy.revision, blocked: state.conflict !== null, initializeWriter, initializeArchive,
      requiresUnchangedRootQuorum: initializeWriter || initializeArchive,
      readiness: 'unverified' as const, startsService: false as const, files, limits, members, timeoutMs };
    const review = { ...details, approvalDigest: historyDigest(`resonance:policy-restoration-resumption:v1\n${JSON.stringify([details, historyDigest(key)])}`) };
    return {
      review() { live(); return structuredClone(review); },
      async apply(approvedDigest: string) { return run(async () => {
        live(); if (busy || applied || approvedDigest !== review.approvalDigest) throw new Error('Policy resumption requires matching reviewed approval');
        if (JSON.stringify(retainedFiles()) !== JSON.stringify(files)) throw new Error('Policy restoration files changed since review');
        busy = true;
        const cancel = () => active?.abort(); signal?.addEventListener('abort', cancel, { once: true });
        try {
          if (initializeWriter || initializeArchive) {
            // Missing local files are not proof of unused history. Four fresh
            // exact unfrozen root heads must rule out a later accepted suffix.
            // These read receipts do not become a write certificate/readiness.
            active = new AbortController();
            await collectCurrentHistoryHead({ context: historyContext, key: signer, rootId, block: root, members, timeoutMs,
              transport: p.transport ?? exchangeHistoryCheckpoint, controller: active, isClosed: () => closed || !!signal?.aborted }); live();
            if (JSON.stringify(retainedFiles()) !== JSON.stringify(files)) throw new Error('Policy restoration files changed during quorum confirmation');
          }
          release(); observer = await openProtectedPolicyObserver({ ...p, mode: 'open-existing', initializeWriter, initializeArchive,
            resumePristineArchive: initializeArchive });
          if (closed || signal?.aborted) { observer.close(); live(); }
          applied = true;
          return { result: 'policy-restoration-resumed' as const, status: observer.status(), readiness: 'unverified' as const, startsService: false as const };
        } finally { signal?.removeEventListener('abort', cancel); active?.abort(); active = undefined; busy = false; }
      }); }, close,
    };
  } catch (error) { close(); throw error; }
}
