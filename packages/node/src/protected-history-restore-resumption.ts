import type { OwnedHistoryAncestrySource } from '../../relay/src/history-ancestry-source.js';
/** Explicit completion of authenticated, pristine local restoration artifacts.
 * This workflow never establishes issuance readiness or recreates accepted history. */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { captureStorageReservationOperation } from '@resonance/core/storage-reservations';
import { assertSecureRelayTransportEndpoint, type SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState, inspectLocalStateOwnership, isLocalStateOwnershipName } from '@resonance/core/local-state';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, parseHistoryCheckpointContext, type HistoryCheckpointContext, type HistoryEncryptedEnvelope } from '@resonance/core/history-checkpoint';
import { parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import { HISTORY_RECOVERY_MAX_BLOCKS, HISTORY_RECOVERY_MAX_BYTES } from '@resonance/core/history-exchange';
import type { ProtectedCheckpointOwnerOptions, ProtectedCheckpointOwner, ProtectedCheckpointOwnerState } from '../../relay/src/protected-checkpoint-owner.js';
import { createHistoryCheckpointWriter, HISTORY_WRITER_FILENAME } from '../../relay/src/history-checkpoint-quorum.js';
import { assertHistoryWriterArchiveInitialization, HISTORY_WRITER_ARCHIVE_FILENAME } from '../../relay/src/history-writer-archive.js';
import { readOperatorFile } from '../../relay/src/admission-operator-files.js';
import { canonicalHistorySetupPath } from '../../relay/src/admission-history-setup.js';
import { collectCurrentHistoryHead } from '../../relay/src/history-current-head.js';
import { exchangeHistoryCheckpoint, type HistoryCheckpointTransport, type HistoryReplicaEndpoint } from '../../relay/src/history-checkpoint-exchange.js';

/** Internal only. Public wrappers select all role, storage and business semantics. */
export interface ProtectedHistoryRestoreResumptionOptions {
  context: HistoryCheckpointContext; authority: string; encryptionKey: Uint8Array;
  continuation: HistoryContinuationRoot; destination: { path: string; writerDirectory: string };
  signingKey: SigningKeyPair; members: HistoryReplicaEndpoint[];
  timeoutMs?: number; signal?: AbortSignal; transport?: HistoryCheckpointTransport;
  ancestry?: OwnedHistoryAncestrySource;
  maxArchiveBlocks?: number; maxArchiveBytes?: number; replayTimeoutMs?: number;
}
export interface ProtectedHistoryRestoreResumptionReplay<T> {
  state: T; genesis: HistoryEncryptedEnvelope; contextId: string; genesisId: string; replayDigest: string;
}
export interface ProtectedHistoryRestoreResumptionStrategy<T, O extends ProtectedHistoryRestoreResumptionOptions, Kind extends string, Result extends string> {
  role: HistoryCheckpointContext['role']; ownerKind: string; ownerDomain: string; maximumOwnerBytes: number; fenceFilename: string;
  reviewKind: Kind; reviewDomain: string; result: Result;
  errors: Readonly<Record<'closed' | 'pathsChanged' | 'pins' | 'bounds' | 'memberCount' | 'unknownMember' | 'endpoints' | 'keyMismatch' | 'restoredOwner' | 'differentReplay' | 'notInitial' | 'fenced' | 'missingApplied' | 'writerBesideArchive' | 'unknownWriterFiles' | 'laterWriter' | 'missingCommittedArchive' | 'approval' | 'filesChanged' | 'filesChangedDuringConfirmation', string>>;
  /** Capture mutable business pins synchronously before any parser awaits. */
  snapshot(options: O): {
    prepare(context: HistoryCheckpointContext, key: Uint8Array, root: HistoryContinuationRoot, replayTimeoutMs: number): Promise<{
      replay: ProtectedHistoryRestoreResumptionReplay<T>; validate(value: unknown): Promise<T> | T;
      ancestryFunding?: string; checkAncestry?(): void; validateProof?: ProtectedCheckpointOwnerOptions<T>['validateProof'];
    }>;
    deriveKey(): Promise<Uint8Array>;
    /** Wipe any owned business secret on failed construction and handle close. */
    dispose?(): void;
  };
  assertTransition(previous: T, next: T): Promise<void> | void;
  validateGenesis(image: T, context: HistoryCheckpointContext): Promise<void> | void;
  openHistory(options: ProtectedCheckpointOwnerOptions<T>): Promise<Pick<ProtectedCheckpointOwner<T>, 'close' | 'status'>>;
}
export async function openProtectedHistoryRestoreResumption<T, O extends ProtectedHistoryRestoreResumptionOptions, Kind extends string, Result extends string>(options: O, strategy: ProtectedHistoryRestoreResumptionStrategy<T, O, Kind, Result>) {
  const run = captureStorageReservationOperation(), ancestry = options.ancestry;
  const path = canonicalHistorySetupPath(options.destination.path), writerDirectory = canonicalHistorySetupPath(options.destination.writerDirectory);
  const context = parseHistoryCheckpointContext(structuredClone(options.context)), root = parseHistoryContinuationRoot(structuredClone(options.continuation), context);
  const authority = options.authority, preparation = strategy.snapshot(options);
  let disposed = false, releaseSetupKeys: (() => void) | undefined;
  function disposePreparation() { if (!disposed) { disposed = true; preparation.dispose?.(); ancestry?.close(); } }
  try {
  const members = structuredClone(options.members), timeoutMs = options.timeoutMs ?? 10000, replayTimeoutMs = options.replayTimeoutMs ?? 30000;
  const maximumBlocks = options.maxArchiveBlocks ?? HISTORY_RECOVERY_MAX_BLOCKS, maximumBytes = options.maxArchiveBytes ?? HISTORY_RECOVERY_MAX_BYTES;
  const key = Uint8Array.from(options.encryptionKey); releaseSetupKeys = () => key.fill(0);
  const signer = copyAdmissionSigningKey(options.signingKey); releaseSetupKeys = () => { key.fill(0); signer.secretKey.fill(0); };
  const signal = options.signal, transport = options.transport ?? exchangeHistoryCheckpoint;
  let owner: ReturnType<typeof openEncryptedLocalState<ProtectedCheckpointOwnerState<T>>> | undefined;
  let writer: ReturnType<typeof createHistoryCheckpointWriter> | undefined, history: Pick<ProtectedCheckpointOwner<T>, 'close' | 'status'> | undefined;
  let closed = false, busy = false, applied = false, active: AbortController | undefined;
  function live() { if (closed || signal?.aborted) throw new Error(strategy.errors.closed); }
  function release() { history?.close(); history = undefined; writer?.close(); writer = undefined; owner?.close(); owner = undefined; }
  function close() { if (!closed) { closed = true; active?.abort(); try { release(); } finally { key.fill(0); signer.secretKey.fill(0); disposePreparation(); } } }
  const writerPath = join(writerDirectory, HISTORY_WRITER_FILENAME), archiveDirectory = join(writerDirectory, 'payloads'), archivePath = join(archiveDirectory, HISTORY_WRITER_ARCHIVE_FILENAME);
  const fencePath = join(writerDirectory, strategy.fenceFilename);
  function digestFile(file: string, maximum: number) {
    if (!existsSync(file)) return null;
    const bytes = readOperatorFile(file, maximum); try { return historyDigest(bytes); } finally { bytes.fill(0); }
  }
  function retainedFiles() { return { owner: digestFile(path, strategy.maximumOwnerBytes), writer: digestFile(writerPath, 40 * 1024 * 1024),
    archive: digestFile(archivePath, 2 * 1024 * 1024), fenced: existsSync(fencePath),
    writerEntries: existsSync(writerDirectory) ? readdirSync(writerDirectory).sort() : null,
    archiveEntries: existsSync(archiveDirectory) ? readdirSync(archiveDirectory).sort() : null }; }
  function checkPaths() {
    if (canonicalHistorySetupPath(options.destination.path) !== path || canonicalHistorySetupPath(options.destination.writerDirectory) !== writerDirectory) throw new Error(strategy.errors.pathsChanged);
  }
  try {
    live();
    if (context.role !== strategy.role || context.authority !== authority || Buffer.from(signer.publicKey).toString('base64url') !== context.owner || key.length !== 32) throw new Error(strategy.errors.pins);
    if (![timeoutMs, maximumBlocks, maximumBytes].every(Number.isSafeInteger) || timeoutMs < 50 || timeoutMs > 30000 || maximumBlocks < 1 || maximumBlocks > HISTORY_RECOVERY_MAX_BLOCKS
      || maximumBytes < Buffer.byteLength(JSON.stringify(root)) || maximumBytes > HISTORY_RECOVERY_MAX_BYTES) throw new Error(strategy.errors.bounds);
    if (!Array.isArray(members) || members.length !== 5 || new Set(members.map(member => member.publicKey)).size !== 5) throw new Error(strategy.errors.memberCount);
    for (const member of members) { if (!context.members.includes(member.publicKey)) throw new Error(strategy.errors.unknownMember); assertSecureRelayTransportEndpoint(member.endpoint); member.endpoint = new URL(member.endpoint).href; }
    if (new Set(members.map(member => member.endpoint)).size !== 5) throw new Error(strategy.errors.endpoints);
    // Both parsers snapshot inputs before their first await. A replay digest alone cannot authorize resumption.
    const { replay, validate, validateProof, ancestryFunding, checkAncestry } = await preparation.prepare(context, key, root, replayTimeoutMs);
    live(); const rootId = historyCheckpointEnvelopeId(root);
    const derived = await preparation.deriveKey();
    try { if (!Buffer.from(key).equals(derived)) throw new Error(strategy.errors.keyMismatch); } finally { derived.fill(0); }
    const restoration = { genesis: replay.genesis, root, baseline: replay.state, replayDigest: replay.replayDigest };
    const common = { path, writerDirectory, domain: strategy.ownerDomain, encryptionKey: key, context, signingKey: signer, members, initial: undefined as unknown as T,
      validate, validateProof, ...(ancestry ? { ancestrySource: () => ancestry.blocks() } : {}), expectedAncestry: { rootId, genesisId: replay.genesisId }, assertTransition: strategy.assertTransition, validateGenesis: (image: T) => strategy.validateGenesis(image, context),
      expectedRestorationDigest: replay.replayDigest, timeoutMs, transport, maxArchiveBlocks: maximumBlocks, maxArchiveBytes: maximumBytes };
    // An occupied AEAD-authenticated owner is the mandatory retained baseline.
    owner = openEncryptedLocalState<ProtectedCheckpointOwnerState<T>>({ path, key, domain: strategy.ownerDomain, maxBytes: strategy.maximumOwnerBytes, mode: 'open-existing',
      initial: undefined as unknown as ProtectedCheckpointOwnerState<T>, validate(value): value is ProtectedCheckpointOwnerState<T> {
        return exactWitnessFields(value, ['version', 'kind', 'context', 'root', 'image', 'applied', 'pending', 'restoration']) && value.version === 2 && value.kind === strategy.ownerKind;
      } });
    const saved = owner.read();
    if (saved.version !== 2) throw new Error(strategy.errors.restoredOwner);
    if (historyCheckpointContextId(saved.context) !== replay.contextId || JSON.stringify([saved.restoration.genesis, saved.root, saved.restoration.baseline, saved.restoration.replayDigest])
      !== JSON.stringify([replay.genesis, root, replay.state, replay.replayDigest]) || JSON.stringify(await validate(saved.image)) !== JSON.stringify(replay.state)) {
      throw new Error(strategy.errors.differentReplay);
    }
    const rootPending = saved.applied === null && saved.pending && historyCheckpointEnvelopeId(saved.pending) === rootId;
    const rootApplied = saved.applied?.sequence === 0 && saved.applied.id === rootId && saved.pending === null;
    if (!rootPending && !rootApplied) throw new Error(strategy.errors.notInitial);
    const initializeWriter = !existsSync(writerPath), initializeArchive = !existsSync(archivePath);
    if (existsSync(fencePath)) throw new Error(strategy.errors.fenced);
    if ((initializeWriter || initializeArchive) && !rootPending) throw new Error(strategy.errors.missingApplied);
    if (initializeWriter && existsSync(archiveDirectory)) throw new Error(strategy.errors.writerBesideArchive);
    if (initializeWriter && existsSync(writerDirectory)) for (const name of readdirSync(writerDirectory)) {
      if (!isLocalStateOwnershipName(HISTORY_WRITER_FILENAME, name)) throw new Error(strategy.errors.unknownWriterFiles);
      inspectLocalStateOwnership(join(writerDirectory, name));
    }
    if (!initializeWriter) {
      writer = createHistoryCheckpointWriter({ directory: writerDirectory, localKey: key, signingKey: signer, context, rootId, generation: root.generation, continuation: root,
        members, timeoutMs, transport, requireCurrentHead: true });
      const state = writer.read();
      if ((state.pending && historyCheckpointEnvelopeId(state.pending) !== rootId) || (state.committed && historyCheckpointEnvelopeId(state.committed.envelope) !== rootId)) throw new Error(strategy.errors.laterWriter);
      if (initializeArchive && state.committed) throw new Error(strategy.errors.missingCommittedArchive);
    }
    if (initializeArchive) assertHistoryWriterArchiveInitialization(archiveDirectory, writer?.read() ?? { committed: null, pending: null }, true);
    if (!initializeWriter && !initializeArchive) { release(); history = await strategy.openHistory(common); live(); }
    const files = retainedFiles();
    const details = { kind: strategy.reviewKind, path, writerDirectory, contextId: replay.contextId, genesisId: replay.genesisId, rootId,
      generation: root.generation, replayDigest: replay.replayDigest, stateDigest: historyDigest(JSON.stringify(replay.state)), initializeWriter, initializeArchive,
      requiresUnchangedRootQuorum: initializeWriter || initializeArchive, files, limits: { archiveBytes: maximumBytes, archiveBlocks: maximumBlocks }, members, timeoutMs,
      ...(ancestry?.binding ? { ancestryBinding: ancestry.binding } : {}), ...(ancestryFunding ? { ancestryFunding } : {}), readiness: 'unverified' as const, startsService: false as const };
    const review = { ...details, approvalDigest: historyDigest(`${strategy.reviewDomain}\n${JSON.stringify([details, historyDigest(key)])}`) };
    return {
      review() { live(); return structuredClone(review); },
      async apply(approvedDigest: string) { return run(async () => {
        live(); if (busy || applied || approvedDigest !== review.approvalDigest) throw new Error(strategy.errors.approval);
        checkAncestry?.(); if (ancestry) for (const _ of ancestry.blocks()) { /* Recheck original ciphertext before completion. */ }
        checkPaths(); if (JSON.stringify(retainedFiles()) !== JSON.stringify(files)) throw new Error(strategy.errors.filesChanged);
        busy = true; const cancel = () => active?.abort(); signal?.addEventListener('abort', cancel, { once: true });
        try {
          if (initializeWriter || initializeArchive) {
            active = new AbortController();
            await collectCurrentHistoryHead({ context, key: signer, rootId, block: root, members, timeoutMs, transport, controller: active,
              isClosed: () => closed || !!signal?.aborted }); live(); checkPaths();
            if (JSON.stringify(retainedFiles()) !== JSON.stringify(files)) throw new Error(strategy.errors.filesChangedDuringConfirmation);
          }
          checkAncestry?.(); if (ancestry) for (const _ of ancestry.blocks()) { /* Fresh confirmation may await; recheck before writer creation. */ }
          release(); history = await strategy.openHistory({ ...common, ...(initializeWriter || initializeArchive ? {
            initializeWriter, initializeArchive, resumePristineArchive: initializeArchive, resumeRestoration: restoration } : {}) });
          live(); applied = true;
          return { result: strategy.result, status: history.status(), readiness: 'unverified' as const, startsService: false as const };
        } finally { signal?.removeEventListener('abort', cancel); active?.abort(); active = undefined; busy = false; }
      }); }, close,
    };
  } catch (error) { close(); throw error; }
  } catch (error) { releaseSetupKeys?.(); disposePreparation(); throw error; }
}
