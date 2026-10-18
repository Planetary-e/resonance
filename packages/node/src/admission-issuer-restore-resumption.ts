/** Explicit completion of authenticated, pristine local restoration artifacts.
 * This workflow never establishes issuance readiness or recreates accepted history. */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { captureStorageReservationOperation } from '@resonance/core/storage-reservations';
import { assertSecureRelayTransportEndpoint, type SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState, inspectLocalStateOwnership, isLocalStateOwnershipName } from '@resonance/core/local-state';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, parseHistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { HISTORY_RECOVERY_MAX_BLOCKS, HISTORY_RECOVERY_MAX_BYTES } from '@resonance/core/history-exchange';
import { openProtectedIssuerHistory, MAX_PROTECTED_ISSUER_HISTORY_BYTES, PROTECTED_ISSUER_RECOVERY_FENCE, type ProtectedIssuerHistory, type ProtectedIssuerHistoryState } from '@resonance/relay/protected-issuer-history';
import { createHistoryCheckpointWriter, HISTORY_WRITER_FILENAME } from '../../relay/src/history-checkpoint-quorum.js';
import { assertHistoryWriterArchiveInitialization, HISTORY_WRITER_ARCHIVE_FILENAME } from '../../relay/src/history-writer-archive.js';
import { readOperatorFile } from '../../relay/src/admission-operator-files.js';
import { canonicalHistorySetupPath } from '../../relay/src/admission-history-setup.js';
import { collectCurrentHistoryHead } from '../../relay/src/history-current-head.js';
import { exchangeHistoryCheckpoint, type HistoryCheckpointTransport, type HistoryReplicaEndpoint } from '../../relay/src/history-checkpoint-exchange.js';
import { prepareAdmissionBatchIssuer } from './blind-admission-issuance.js';
import { DOMAIN, deriveAdmissionIssuerEncryptionKey, type State } from './admission-issuer-state.js';
import { replayProtectedIssuerHistory, type ProtectedIssuerReplayOptions } from './admission-issuer-history-replay.js';
import { parseProtectedIssuerImage, assertProtectedIssuerImageSuccessor, assertProtectedIssuerGenesis } from './protected-admission-issuer-state.js';

export interface ProtectedIssuerRestoreResumptionOptions extends Omit<ProtectedIssuerReplayOptions, 'proposal'> {
  continuation: HistoryContinuationRoot;
  destination: { path: string; writerDirectory: string };
  privateKey: CryptoKey; signingKey: SigningKeyPair; members: HistoryReplicaEndpoint[];
  transport?: HistoryCheckpointTransport; maxArchiveBlocks?: number; maxArchiveBytes?: number;
  /** Replay has a separate bounded CPU budget; timeoutMs remains the unchanged protocol deadline. */
  replayTimeoutMs?: number;
}
export async function openProtectedIssuerRestoreResumption(options: ProtectedIssuerRestoreResumptionOptions) {
  const run = captureStorageReservationOperation();
  const path = canonicalHistorySetupPath(options.destination.path), writerDirectory = canonicalHistorySetupPath(options.destination.writerDirectory);
  const context = parseHistoryCheckpointContext(structuredClone(options.context)), root = parseHistoryContinuationRoot(structuredClone(options.continuation), context);
  const authority = options.authority, profileInput = structuredClone(options.profile), privateKey = options.privateKey;
  const members = structuredClone(options.members), timeoutMs = options.timeoutMs ?? 10000, replayTimeoutMs = options.replayTimeoutMs ?? 30000;
  const maximumBlocks = options.maxArchiveBlocks ?? HISTORY_RECOVERY_MAX_BLOCKS, maximumBytes = options.maxArchiveBytes ?? HISTORY_RECOVERY_MAX_BYTES;
  const key = Uint8Array.from(options.encryptionKey), signer = copyAdmissionSigningKey(options.signingKey), signal = options.signal, transport = options.transport ?? exchangeHistoryCheckpoint;
  let owner: ReturnType<typeof openEncryptedLocalState<ProtectedIssuerHistoryState<State>>> | undefined;
  let writer: ReturnType<typeof createHistoryCheckpointWriter> | undefined, history: ProtectedIssuerHistory<State> | undefined;
  let closed = false, busy = false, applied = false, active: AbortController | undefined;
  function live() { if (closed || signal?.aborted) throw new Error('Issuer restoration resumption closed or cancelled'); }
  function release() { history?.close(); history = undefined; writer?.close(); writer = undefined; owner?.close(); owner = undefined; }
  function close() { if (!closed) { closed = true; active?.abort(); release(); key.fill(0); signer.secretKey.fill(0); } }
  const writerPath = join(writerDirectory, HISTORY_WRITER_FILENAME), archiveDirectory = join(writerDirectory, 'payloads'), archivePath = join(archiveDirectory, HISTORY_WRITER_ARCHIVE_FILENAME);
  const fencePath = join(writerDirectory, PROTECTED_ISSUER_RECOVERY_FENCE);
  function digestFile(file: string, maximum: number) {
    if (!existsSync(file)) return null;
    const bytes = readOperatorFile(file, maximum); try { return historyDigest(bytes); } finally { bytes.fill(0); }
  }
  function retainedFiles() { return { owner: digestFile(path, MAX_PROTECTED_ISSUER_HISTORY_BYTES), writer: digestFile(writerPath, 40 * 1024 * 1024),
    archive: digestFile(archivePath, 2 * 1024 * 1024), fenced: existsSync(fencePath),
    writerEntries: existsSync(writerDirectory) ? readdirSync(writerDirectory).sort() : null,
    archiveEntries: existsSync(archiveDirectory) ? readdirSync(archiveDirectory).sort() : null }; }
  function checkPaths() {
    if (canonicalHistorySetupPath(options.destination.path) !== path || canonicalHistorySetupPath(options.destination.writerDirectory) !== writerDirectory) throw new Error('Issuer restoration destinations changed since review');
  }
  try {
    live();
    if (context.role !== 'admission-issuer' || context.authority !== authority || Buffer.from(signer.publicKey).toString('base64url') !== context.owner || key.length !== 32) throw new Error('Wrong issuer restoration pins or keys');
    if (![timeoutMs, maximumBlocks, maximumBytes].every(Number.isSafeInteger) || timeoutMs < 50 || timeoutMs > 30000 || maximumBlocks < 1 || maximumBlocks > HISTORY_RECOVERY_MAX_BLOCKS
      || maximumBytes < Buffer.byteLength(JSON.stringify(root)) || maximumBytes > HISTORY_RECOVERY_MAX_BYTES) throw new Error('Invalid issuer restoration protocol or archive bounds');
    if (!Array.isArray(members) || members.length !== 5 || new Set(members.map(member => member.publicKey)).size !== 5) throw new Error('Issuer restoration requires five independently pinned members');
    for (const member of members) { if (!context.members.includes(member.publicKey)) throw new Error('Unknown issuer restoration member'); assertSecureRelayTransportEndpoint(member.endpoint); member.endpoint = new URL(member.endpoint).href; }
    if (new Set(members.map(member => member.endpoint)).size !== 5) throw new Error('Issuer restoration requires distinct pinned endpoints');
    // Both parsers snapshot inputs before their first await. A replay digest alone cannot authorize resumption.
    const [issuer, replay] = await Promise.all([prepareAdmissionBatchIssuer({ expectedProfile: profileInput, privateKey }),
      replayProtectedIssuerHistory({ ...options, context, profile: profileInput, authority, encryptionKey: key, proposal: root.proposal, timeoutMs: replayTimeoutMs })]);
    live(); const profile = issuer.profile, rootId = historyCheckpointEnvelopeId(root);
    const derived = await deriveAdmissionIssuerEncryptionKey(privateKey);
    try { if (!Buffer.from(key).equals(derived)) throw new Error('Issuer restoration key differs from its retained RSA issuer key'); } finally { derived.fill(0); }
    const restoration = { genesis: replay.genesis, root, baseline: replay.state, replayDigest: replay.replayDigest };
    const validate = (value: unknown) => parseProtectedIssuerImage(value, { profile, authority });
    const common = { path, writerDirectory, domain: DOMAIN, encryptionKey: key, context, signingKey: signer, members, initial: undefined as unknown as State,
      validate, assertTransition: assertProtectedIssuerImageSuccessor, validateGenesis: (image: State) => assertProtectedIssuerGenesis(image, context),
      expectedRestorationDigest: replay.replayDigest, timeoutMs, transport, maxArchiveBlocks: maximumBlocks, maxArchiveBytes: maximumBytes };
    // An occupied AEAD-authenticated owner is the mandatory retained baseline.
    owner = openEncryptedLocalState<ProtectedIssuerHistoryState<State>>({ path, key, domain: DOMAIN, maxBytes: MAX_PROTECTED_ISSUER_HISTORY_BYTES, mode: 'open-existing',
      initial: undefined as unknown as ProtectedIssuerHistoryState<State>, validate(value): value is ProtectedIssuerHistoryState<State> {
        return exactWitnessFields(value, ['version', 'kind', 'context', 'root', 'image', 'applied', 'pending', 'restoration']) && value.version === 2 && value.kind === 'protected-admission-issuer';
      } });
    const saved = owner.read();
    if (saved.version !== 2) throw new Error('Issuer resumption requires an authenticated restored owner');
    if (historyCheckpointContextId(saved.context) !== replay.contextId || JSON.stringify([saved.restoration.genesis, saved.root, saved.restoration.baseline, saved.restoration.replayDigest])
      !== JSON.stringify([replay.genesis, root, replay.state, replay.replayDigest]) || JSON.stringify(await validate(saved.image)) !== JSON.stringify(replay.state)) {
      throw new Error('Retained issuer restoration differs from independently replayed selected history');
    }
    const rootPending = saved.applied === null && saved.pending && historyCheckpointEnvelopeId(saved.pending) === rootId;
    const rootApplied = saved.applied?.sequence === 0 && saved.applied.id === rootId && saved.pending === null;
    if (!rootPending && !rootApplied) throw new Error('Issuer resumption is only for the exact interrupted initial restoration');
    const initializeWriter = !existsSync(writerPath), initializeArchive = !existsSync(archivePath);
    if (existsSync(fencePath)) throw new Error('Fenced issuer history requires recovery, not restoration resumption');
    if ((initializeWriter || initializeArchive) && !rootPending) throw new Error('Missing components beside applied issuer history require complete recovery');
    if (initializeWriter && existsSync(archiveDirectory)) throw new Error('Cannot recreate missing issuer writer beside retained archive evidence');
    if (initializeWriter && existsSync(writerDirectory)) for (const name of readdirSync(writerDirectory)) {
      if (!isLocalStateOwnershipName(HISTORY_WRITER_FILENAME, name)) throw new Error('Missing issuer writer has unknown retained files');
      inspectLocalStateOwnership(join(writerDirectory, name));
    }
    if (!initializeWriter) {
      writer = createHistoryCheckpointWriter({ directory: writerDirectory, localKey: key, signingKey: signer, context, rootId, generation: root.generation, continuation: root,
        members, timeoutMs, transport, requireCurrentHead: true });
      const state = writer.read();
      if ((state.pending && historyCheckpointEnvelopeId(state.pending) !== rootId) || (state.committed && historyCheckpointEnvelopeId(state.committed.envelope) !== rootId)) throw new Error('Issuer restoration writer already contains a later accepted suffix');
      if (initializeArchive && state.committed) throw new Error('Committed issuer archive is missing; preserve it for complete recovery');
    }
    if (initializeArchive) assertHistoryWriterArchiveInitialization(archiveDirectory, writer?.read() ?? { committed: null, pending: null }, true);
    if (!initializeWriter && !initializeArchive) { release(); history = await openProtectedIssuerHistory(common); live(); }
    const files = retainedFiles();
    const details = { kind: 'protected-issuer-restoration-resumption' as const, path, writerDirectory, contextId: replay.contextId, genesisId: replay.genesisId, rootId,
      generation: root.generation, replayDigest: replay.replayDigest, stateDigest: historyDigest(JSON.stringify(replay.state)), initializeWriter, initializeArchive,
      requiresUnchangedRootQuorum: initializeWriter || initializeArchive, files, limits: { archiveBytes: maximumBytes, archiveBlocks: maximumBlocks }, members, timeoutMs,
      readiness: 'unverified' as const, startsService: false as const };
    const review = { ...details, approvalDigest: historyDigest(`resonance:protected-issuer-restoration-resumption:v1\n${JSON.stringify([details, historyDigest(key)])}`) };
    return {
      review() { live(); return structuredClone(review); },
      async apply(approvedDigest: string) { return run(async () => {
        live(); if (busy || applied || approvedDigest !== review.approvalDigest) throw new Error('Issuer resumption requires matching reviewed approval');
        checkPaths(); if (JSON.stringify(retainedFiles()) !== JSON.stringify(files)) throw new Error('Issuer restoration files changed since review');
        busy = true; const cancel = () => active?.abort(); signal?.addEventListener('abort', cancel, { once: true });
        try {
          if (initializeWriter || initializeArchive) {
            active = new AbortController();
            await collectCurrentHistoryHead({ context, key: signer, rootId, block: root, members, timeoutMs, transport, controller: active,
              isClosed: () => closed || !!signal?.aborted }); live(); checkPaths();
            if (JSON.stringify(retainedFiles()) !== JSON.stringify(files)) throw new Error('Issuer restoration files changed during fresh root confirmation');
          }
          release(); history = await openProtectedIssuerHistory({ ...common, ...(initializeWriter || initializeArchive ? {
            initializeWriter, initializeArchive, resumePristineArchive: initializeArchive, resumeRestoration: restoration } : {}) });
          live(); applied = true;
          return { result: 'protected-issuer-restoration-resumed' as const, status: history.status(), readiness: 'unverified' as const, startsService: false as const };
        } finally { signal?.removeEventListener('abort', cancel); active?.abort(); active = undefined; busy = false; }
      }); }, close,
    };
  } catch (error) { close(); throw error; }
}
