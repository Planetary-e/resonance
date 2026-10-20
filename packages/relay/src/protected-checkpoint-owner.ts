import { AdmissionPolicyArchiveExecutionContext } from '@resonance/core/admission-policy-archive';
/** Internal checkpoint-owner engine. Fixed role wrappers supply all storage and recovery bindings. */
import { join, resolve } from 'node:path';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { captureStorageReservationOperation } from '@resonance/core/storage-reservations';
import { canonicalHistorySetupPath } from './admission-history-setup.js';
import type { SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { HISTORY_CHECKPOINT_MAX_PAYLOAD, historyCheckpointContextId, historyCheckpointEnvelopeByteLength, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest, openHistoryCheckpoint, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, sealHistoryCheckpoint, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { historySuccessorProposalId } from '@resonance/core/history-successor';
import { HISTORY_RECOVERY_MAX_BLOCKS, HISTORY_RECOVERY_MAX_BYTES } from '@resonance/core/history-exchange';
import { createRetainedHistoryCheckpointWriter } from './history-retained-writer.js';

type Writer = ReturnType<typeof createRetainedHistoryCheckpointWriter>;
type WriterOptions = Parameters<typeof createRetainedHistoryCheckpointWriter>[0];
export const MAX_PROTECTED_CHECKPOINT_OWNER_BYTES = 32 * 1024 * 1024;
export const MAX_PROTECTED_CHECKPOINT_IMAGE_BYTES = HISTORY_CHECKPOINT_MAX_PAYLOAD;
export interface ProtectedCheckpointOwnerRestoration<T> {
  genesis: HistoryCheckpointEnvelope; root: HistoryCheckpointEnvelope; baseline: T; replayDigest: string;
}
interface ProtectedCheckpointOwnerBase<T> {
  kind: string; context: HistoryCheckpointContext;
  root: HistoryCheckpointEnvelope; image: T;
  applied: { sequence: number; id: string } | null; pending: HistoryCheckpointEnvelope | null;
}
export type ProtectedCheckpointOwnerState<T> = ProtectedCheckpointOwnerBase<T> & ({ version: 1 } | {
  version: 2; restoration: Omit<ProtectedCheckpointOwnerRestoration<T>, 'root'>;
});
/** Binds the immutable restored baseline to its original enrollment and selected proposal. */
export const checkpointOwnerReplayDigest = (domain: string, contextId: string, genesisId: string, proposalId: string, image: unknown): string =>
  historyDigest(`${domain}\n${JSON.stringify([contextId, genesisId, proposalId, image])}`);
export interface ProtectedCheckpointOwnerOptions<T> {
  /** Same file, domain and key as the local-only issuer. Its parser rejects the protected outer shape. */
  path: string; writerDirectory: string; domain: string; encryptionKey: Uint8Array;
  context: HistoryCheckpointContext; signingKey: SigningKeyPair; members: WriterOptions['members'];
  initial: T;
  /** Authenticate and normalize the complete issuer image, including its allocation and all retained decisions. */
  validate(value: unknown, operation?: object): T | Promise<T>;
  /** Trusted business semantics, used for live and retained generation transitions. */
  assertTransition?(previous: T, next: T): void | Promise<void>;
  validateGenesis?(image: T): void | Promise<void>;
  /** Original funded generations are required whenever a policy reference reaches behind this root. */
  ancestrySource?: () => Iterable<HistoryCheckpointEnvelope>;
  expectedAncestry?: { rootId: string; genesisId: string };
  validateProof?(image: T, source: () => Iterable<HistoryCheckpointEnvelope>, operation?: object): void | Promise<void>;
  /** Internal trusted restoration input. Business APIs must require their reviewed capability first. */
  restore?: ProtectedCheckpointOwnerRestoration<T>;
  /** Internal exact interrupted restoration completion, approved by the dedicated resumption workflow. */
  resumeRestoration?: ProtectedCheckpointOwnerRestoration<T>;
  resumePristineArchive?: boolean;
  expectedRestorationDigest?: string;
  initialize?: boolean; initializeWriter?: boolean; initializeArchive?: boolean;
  signal?: AbortSignal; deadline?: number;
  timeoutMs?: number; transport?: WriterOptions['transport']; maxArchiveBlocks?: number; maxArchiveBytes?: number;
}
export interface ProtectedCheckpointOwnerBinding {
  role: HistoryCheckpointContext['role']; kind: string;
  fenceFilename: string; fenceDomain: string; replayDomain: string; allowRecovery: boolean;
}
export interface ProtectedCheckpointOwnerRecoverySource<T> {
  readonly path: string; readonly writerDirectory: string; readonly contextId: string; readonly genesisId: string;
  readonly rootId: string; readonly generation: number; readonly stateDigest: string;
}
export interface ProtectedCheckpointOwnerRecoveryEvidence<T> extends ProtectedCheckpointOwnerRecoverySource<T> {
  context: HistoryCheckpointContext; genesis: HistoryCheckpointEnvelope; root: HistoryCheckpointEnvelope;
  minimumEvidence: T[]; applied: { sequence: number; id: string } | null; pending: { sequence: number; id: string } | null;
}
const recoverySources = new WeakMap<object, { evidence: unknown; fence(): Promise<void> }>();
export function readProtectedCheckpointOwnerRecoverySource<T>(source: ProtectedCheckpointOwnerRecoverySource<T>): ProtectedCheckpointOwnerRecoveryEvidence<T> {
  const record = recoverySources.get(source);
  if (!record) throw new Error('Issuer recovery requires a live authenticated source capability');
  return structuredClone(record.evidence) as ProtectedCheckpointOwnerRecoveryEvidence<T>;
}
export async function fenceProtectedCheckpointOwnerRecoverySource<T>(source: ProtectedCheckpointOwnerRecoverySource<T>): Promise<void> {
  const record = recoverySources.get(source);
  if (!record) throw new Error('Issuer recovery requires a live authenticated source capability');
  await record.fence();
}
export interface ProtectedCheckpointOwnerStatus {
  ready: boolean; busy: boolean; pending: boolean; fenced: boolean;
  applied: { sequence: number; id: string } | null; rootId: string;
  retainedBlocks: number; retainedCiphertextBytes: number; maximumBlocks: number; maximumCiphertextBytes: number;
}
export interface ProtectedCheckpointOwner<T> {
  reviewRecoverySource(): Promise<ProtectedCheckpointOwnerRecoverySource<T>>;
  read(): T; commit(value: T, assertBeforeIntent?: () => void): Promise<void>; ready(): Promise<void>; assertServing(): void;
  assertCapacity(values: readonly T[]): Promise<void>;
  status(): ProtectedCheckpointOwnerStatus;
  history(): Iterable<HistoryCheckpointEnvelope>;
  enrollment(): { context: HistoryCheckpointContext; root: HistoryCheckpointEnvelope };
  close(): void;
}
const id = historyCheckpointEnvelopeId;
function imageBytes(value: unknown): Buffer {
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || Buffer.byteLength(json) < 1 || Buffer.byteLength(json) > MAX_PROTECTED_CHECKPOINT_IMAGE_BYTES) {
    throw new Error('Protected issuer image payload capacity exceeded');
  }
  return Buffer.from(json);
}
/** Exact encrypted-local-state wire ceiling, before writing any owner intent. */
function assertOuterCapacity(value: unknown): void {
  const plaintextBytes = Buffer.byteLength(JSON.stringify(value));
  const metadataBytes = Buffer.byteLength(JSON.stringify({ version: 1, nonce: '', ciphertext: '', tag: '' })) + 16 + 22;
  if (metadataBytes + Math.ceil(plaintextBytes * 4 / 3) > MAX_PROTECTED_CHECKPOINT_OWNER_BYTES) {
    throw new Error('Protected issuer outer state capacity exceeded before intent');
  }
}
export async function openProtectedCheckpointOwner<T>(options: ProtectedCheckpointOwnerOptions<T>, binding: Readonly<ProtectedCheckpointOwnerBinding>, startupContext?: AdmissionPolicyArchiveExecutionContext): Promise<ProtectedCheckpointOwner<T>> {
  let startup: AdmissionPolicyArchiveExecutionContext | undefined = startupContext ?? new AdmissionPolicyArchiveExecutionContext({ execution: { version: 2, purpose: 'offline-startup-reconstruction', timeoutMs: 30000 }, timeoutMs: 30000, signal: options.signal, deadline: options.deadline });
  const run = captureStorageReservationOperation();
  // Capture caller-owned mutable data and both keys before the first asynchronous validator.
  const context = parseHistoryCheckpointContext(structuredClone(options.context));
  const key = Buffer.from(options.encryptionKey), signer = copyAdmissionSigningKey(options.signingKey);
  const expectedAncestry = options.expectedAncestry && { ...options.expectedAncestry };
  const restoreInput = options.restore === undefined ? undefined : structuredClone(options.restore);
  const resumeInput = options.resumeRestoration === undefined ? undefined : structuredClone(options.resumeRestoration);
  const expectedRestorationDigest = options.expectedRestorationDigest, resumePristineArchive = options.resumePristineArchive === true;
  const initialInput = structuredClone(options.initial), members = structuredClone(options.members);
  const requestedPath = resolve(options.path), requestedWriterDirectory = resolve(options.writerDirectory);
  const path = canonicalHistorySetupPath(requestedPath), writerDirectory = canonicalHistorySetupPath(requestedWriterDirectory), domain = options.domain, validate = options.validate, assertTransition = options.assertTransition, validateGenesis = options.validateGenesis;
  const initialize = options.initialize === true, initializeWriter = options.initializeWriter === true, initializeArchive = options.initializeArchive === true;
  const timeoutMs = options.timeoutMs, transport = options.transport;
  const maximumBlocks = options.maxArchiveBlocks ?? HISTORY_RECOVERY_MAX_BLOCKS, maximumBytes = options.maxArchiveBytes ?? HISTORY_RECOVERY_MAX_BYTES;
  let storage: ReturnType<typeof openEncryptedLocalState<ProtectedCheckpointOwnerState<T>>> | undefined, writer: Writer | undefined;
  let closed = false, active = false, readyConfirmed = false, fenced = false;
  let originalGenesis: HistoryCheckpointEnvelope;
  let proofOperation: object = startup;
  const wait = <R>(work: () => Promise<R>): Promise<R> => startup ? startup.wait(work) : work();
  const fencePath = join(writerDirectory, binding.fenceFilename);
  function readState(): ProtectedCheckpointOwnerState<T> {
    if (closed) throw new Error('Protected issuer history is closed');
    return storage!.read();
  }
  function close() {
    if (!closed) { closed = true; readyConfirmed = false; writer?.close(); storage?.close(); key.fill(0); signer.secretKey.fill(0); }
  }
  async function normalize(value: unknown): Promise<T> {
    const before = imageBytes(value); before.fill(0);
    const normalized = structuredClone(await wait(async () => validate(structuredClone(value), proofOperation)));
    const after = imageBytes(normalized); after.fill(0); return normalized;
  }
  function* history(): Iterable<HistoryCheckpointEnvelope> {
    readState();
    if (options.ancestrySource) yield* options.ancestrySource();
    if (writer) yield* writer.history();
  }
  async function validateProof(image: T) { await wait(async () => options.validateProof?.(structuredClone(image), history, proofOperation)); }
  async function transition(previous: T, next: T) {
    await wait(async () => assertTransition?.(structuredClone(previous), structuredClone(next)));
  }
  function baseline(state: ProtectedCheckpointOwnerState<T>): T {
    if (state.version !== 2) throw new Error('Continuation requires retained restored baseline');
    return state.restoration.baseline;
  }
  async function decode(block: HistoryCheckpointEnvelope): Promise<T> {
    const bytes = openHistoryCheckpoint(block, context, key);
    try { return await normalize(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes))); }
    finally { bytes.fill(0); }
  }
  function available() {
    const state = readState();
    if (state.pending || !state.applied) throw new Error('Protected issuer history needs durable completion');
    return state;
  }
  function assertServing() {
    readState(); if (fenced) throw new Error('Protected issuer is permanently fenced for recovery');
    if (!readyConfirmed) throw new Error('Protected issuer history needs fresh readiness confirmation');
    available();
  }
  function writerMatches() {
    const local = readState(), remote = writer!.read(), committed = remote.committed?.envelope;
    if (remote.pending && (!local.pending || id(remote.pending) !== id(local.pending))) throw new Error('Protected issuer pending histories disagree');
    if (committed ? !((local.applied?.id === id(committed) && local.applied.sequence === committed.sequence)
      || (local.pending && id(local.pending) === id(committed))) : local.applied !== null) {
      throw new Error('Protected issuer committed histories disagree');
    }
  }
  async function finishPending(): Promise<boolean> {
    const before = readState(), pending = before.pending;
    if (!pending) return false;
    const image = pending.kind === 'continuation' && pending.sequence === 0 && id(pending) === id(before.root)
      ? await normalize(baseline(before)) : await decode(pending);
    await transition(before.image, image); await validateProof(image); readState(); writerMatches();
    const committed = writer!.read().committed;
    const fresh = !committed || id(committed.envelope) !== id(pending);
    if (fresh) await writer!.replicate(pending);
    readState();
    const applied: ProtectedCheckpointOwnerState<T> = { ...before, image, applied: { sequence: pending.sequence, id: id(pending) }, pending: null };
    assertOuterCapacity(applied); storage!.write(applied);
    return fresh;
  }
  async function exclusive<R>(operation: () => Promise<R>): Promise<R> {
    readState(); if (active) throw new Error('Protected issuer history operation is in progress'); active = true; proofOperation = {};
    try { return await operation(); }
    catch (error) { readyConfirmed = false; throw error; }
    finally { active = false; }
  }
  try {
    if (context.role !== binding.role || key.length !== 32 || Buffer.from(signer.publicKey).toString('base64url') !== context.owner) {
      throw new Error('Wrong protected issuer history role, owner, or encryption key');
    }
    if (!binding.allowRecovery && (restoreInput || resumeInput || resumePristineArchive || expectedRestorationDigest !== undefined)) throw new Error('This protected owner does not support restoration or recovery overrides');
    if (resumeInput && (initialize || restoreInput)) throw new Error('Issuer restore resumption is only for retained initial restoration');
    if (resumePristineArchive && !resumeInput) throw new Error('Pristine issuer archive resumption requires authenticated restoration');
    if (expectedRestorationDigest !== undefined && (initialize || !isHistoryDigest(expectedRestorationDigest))) throw new Error('Invalid expected issuer restoration digest');
    if (restoreInput && !initialize) throw new Error('Protected issuer restoration is only for explicit fresh creation');
    if (!initialize && !resumeInput && (initializeWriter || initializeArchive)) throw new Error('Issuer writer and archive initialization require fresh owner creation');
    if (!Number.isSafeInteger(maximumBlocks) || maximumBlocks < 1 || maximumBlocks > HISTORY_RECOVERY_MAX_BLOCKS
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > HISTORY_RECOVERY_MAX_BYTES) throw new Error('Invalid protected issuer archive bounds');
    const contextId = historyCheckpointContextId(context);
    function assertSelectedDestinations() {
      if (canonicalHistorySetupPath(requestedPath) !== path || canonicalHistorySetupPath(requestedWriterDirectory) !== writerDirectory) throw new Error('Protected issuer storage destinations changed after selection');
    }
    function assertNewRestoreDestination() {
      assertSelectedDestinations();
      if (existsSync(path)) throw new Error('Protected issuer restore requires a new owner path');
      if (existsSync(writerDirectory) && (!lstatSync(writerDirectory).isDirectory() || readdirSync(writerDirectory).length)) {
        throw new Error('Protected issuer restore requires an empty new writer directory');
      }
    }
    let initial: ProtectedCheckpointOwnerState<T> | undefined;
    if (initialize) {
      if (restoreInput) {
        assertNewRestoreDestination();
        const genesis = parseHistoryCheckpointEnvelope(restoreInput.genesis, context), root = parseHistoryCheckpointEnvelope(restoreInput.root, context);
        if (genesis.kind !== 'checkpoint' || genesis.generation !== 0 || genesis.sequence !== 0 || root.kind !== 'continuation') throw new Error('Protected issuer restore needs its original genesis and certified continuation');
        await wait(async () => validateGenesis?.(await decode(genesis)));
        const image = await normalize(restoreInput.baseline), replayDigest = checkpointOwnerReplayDigest(binding.replayDomain, contextId, id(genesis), historySuccessorProposalId(root.proposal), image);
        if (restoreInput.replayDigest !== replayDigest) throw new Error('Protected issuer restore baseline differs from reviewed selected history');
        if (Buffer.byteLength(JSON.stringify(root)) > maximumBytes) throw new Error('Protected issuer root needs archive capacity before intent');
        initial = { version: 2, kind: binding.kind, context, root, image, applied: null, pending: root,
          restoration: { genesis, baseline: structuredClone(image), replayDigest } };
        assertOuterCapacity(initial);
      } else {
        const image = await normalize(initialInput); await wait(async () => validateGenesis?.(image));
        const plaintext = imageBytes(image);
        try {
          const header = { kind: 'checkpoint', generation: 0, sequence: 0, previous: null } as const;
          if (historyCheckpointEnvelopeByteLength({ context, header, plaintextBytes: plaintext.length }) > maximumBytes) {
            throw new Error('Protected issuer root needs archive capacity before intent');
          }
          const root = sealHistoryCheckpoint({ context, header, plaintext, encryptionKey: key, signingKey: signer });
          initial = { version: 1, kind: binding.kind, context, root, image, applied: null, pending: root };
          assertOuterCapacity(initial);
        } finally { plaintext.fill(0); }
      }
    }
    if (restoreInput) assertNewRestoreDestination(); // Recheck after all asynchronous validation and before the first owner intent.
    assertSelectedDestinations();
    startup.check();
    storage = openEncryptedLocalState<ProtectedCheckpointOwnerState<T>>({ path, key, domain, maxBytes: MAX_PROTECTED_CHECKPOINT_OWNER_BYTES,
      initial: initial!, mode: initialize ? 'create-new' : 'open-existing',
      validate(value): value is ProtectedCheckpointOwnerState<T> {
        return (exactWitnessFields(value, ['version', 'kind', 'context', 'root', 'image', 'applied', 'pending']) && value.version === 1
          || exactWitnessFields(value, ['version', 'kind', 'context', 'root', 'image', 'applied', 'pending', 'restoration']) && value.version === 2)
          && value.kind === binding.kind && (binding.allowRecovery || value.version === 1);
      } });
    const state = readState();
    if (historyCheckpointContextId(state.context) !== contextId) throw new Error('Protected issuer history pins changed');
    const root = parseHistoryCheckpointEnvelope(state.root, context);
    if (root.sequence !== 0 || (state.version === 1 ? root.kind !== 'checkpoint' || root.generation !== 0 : root.kind !== 'continuation')) throw new Error('Invalid protected issuer history root');
    const genesis = state.version === 2 ? parseHistoryCheckpointEnvelope(state.restoration?.genesis, context) : root;
    if (genesis.kind !== 'checkpoint' || genesis.generation !== 0 || genesis.sequence !== 0) throw new Error('Protected issuer requires its original enrolled genesis');
    if (expectedAncestry && (state.version !== 2 || id(root) !== expectedAncestry.rootId || id(genesis) !== expectedAncestry.genesisId)) throw new Error('Retained ancestry differs from the immutable owner generation or original enrollment');
    originalGenesis = genesis;
    const genesisImage = await decode(genesis); await wait(async () => validateGenesis?.(genesisImage));
    let rootImage = genesisImage;
    if (state.version === 2) {
      if (!exactWitnessFields(state.restoration, ['genesis', 'baseline', 'replayDigest']) || root.kind !== 'continuation') throw new Error('Invalid protected issuer restoration capture');
      rootImage = await normalize(state.restoration.baseline);
      if (JSON.stringify(rootImage) !== JSON.stringify(state.restoration.baseline)
        || state.restoration.replayDigest !== checkpointOwnerReplayDigest(binding.replayDomain, contextId, id(genesis), historySuccessorProposalId(root.proposal), rootImage)) {
        throw new Error('Protected issuer restored baseline differs from selected history');
      }
    }
    if (expectedRestorationDigest !== undefined && (state.version !== 2 || state.restoration.replayDigest !== expectedRestorationDigest)) throw new Error('Issuer restoration differs from its independent replay digest');
    if (resumeInput) {
      if (state.version !== 2 || JSON.stringify([resumeInput.genesis, resumeInput.root, resumeInput.baseline, resumeInput.replayDigest]) !== JSON.stringify([state.restoration.genesis, state.root, state.restoration.baseline, state.restoration.replayDigest])) throw new Error('Issuer restoration resumption differs from retained selection or baseline');
      if (state.applied !== null || !state.pending || id(state.pending) !== id(root)) throw new Error('Only an unapplied initial issuer restoration may resume missing components');
      if (existsSync(fencePath)) throw new Error('Fenced issuer history requires recovery, not restoration resumption');
    }
    const image = await normalize(state.image);
    if (JSON.stringify(image) !== JSON.stringify(state.image)) throw new Error('Noncanonical protected issuer image');
    if (state.applied === null) {
      if (!state.pending || id(parseHistoryCheckpointEnvelope(state.pending, context)) !== id(root)
        || JSON.stringify(image) !== JSON.stringify(rootImage)) throw new Error('Incomplete protected issuer root');
    } else {
      if (!exactWitnessFields(state.applied, ['sequence', 'id']) || !Number.isSafeInteger(state.applied.sequence) || state.applied.sequence < 0
        || !isHistoryDigest(state.applied.id) || (state.applied.sequence === 0 && state.applied.id !== id(root))) throw new Error('Invalid protected issuer applied head');
      if (state.pending !== null) {
        const pending = parseHistoryCheckpointEnvelope(state.pending, context);
        if (pending.kind !== 'checkpoint' || pending.generation !== root.generation || pending.sequence !== state.applied.sequence + 1
          || pending.previous !== state.applied.id) throw new Error('Invalid protected issuer pending successor');
        await transition(image, await decode(pending));
      }
    }
    assertOuterCapacity(state);
    // Creation capabilities never recreate a missing writer/archive for committed owner history.
    if ((initializeWriter || initializeArchive) && state.applied !== null) throw new Error('Cannot initialize writer or archive for applied issuer history');
    startup.check();
    writer = createRetainedHistoryCheckpointWriter({ directory: writerDirectory, localKey: key, context, signingKey: signer,
      rootId: id(root), generation: root.generation, genesisId: id(genesis), ...(root.kind === 'continuation' ? { continuation: root } : {}),
      members, requireCurrentHead: true, initialize: initializeWriter, initializeArchive, resumePristineArchive,
      timeoutMs, transport, maxArchiveBlocks: maximumBlocks, maxArchiveBytes: maximumBytes });
    writerMatches();
    // Authenticate every retained transition from this generation's immutable baseline.
    let previous = rootImage, last: HistoryCheckpointEnvelope | undefined;
    for (const block of writer.history()) {
      const blockId = id(block);
      if (!last) {
        if (blockId !== id(root)) throw new Error('Protected issuer retained history lost its generation root');
      } else {
        if (block.kind !== 'checkpoint' || block.generation !== root.generation || block.sequence !== last.sequence + 1 || block.previous !== id(last)) throw new Error('Protected issuer retained history has a gap or wrong generation');
        const next = await decode(block); await transition(previous, next); previous = next;
      }
      last = block;
    }
    // Root continuations carry a selected boundary, never replacement image ciphertext.
    if (state.applied) {
      const block = writer.historyBlock(state.applied.sequence);
      const retained = block && (id(block) === id(root) ? rootImage : await decode(block));
      if (!block || id(block) !== state.applied.id || JSON.stringify(retained) !== JSON.stringify(image)) {
        throw new Error('Protected issuer applied image does not match retained signed checkpoint');
      }
    }
    await validateProof(image);
    if (state.pending) await validateProof(state.pending.kind === 'continuation' ? rootImage : await decode(state.pending));
    if (existsSync(fencePath)) { const marker = openFence('open-existing'); marker.close(); fenced = true; }
    startup.check();
    startup = undefined; proofOperation = {};
  } catch (error) { startup?.controller.abort(); close(); throw error; }
  function retainedDigest() {
    const state = readState(); writerMatches();
    // Writer certificates/pending publication may progress while the owner retains the exact same intent.
    return historyDigest(JSON.stringify(state));
  }
  function openFence(mode: 'create-new' | 'open-existing') {
    const state = readState(), expected = { version: 1, path, writerDirectory, contextId: historyCheckpointContextId(context),
      genesisId: id(originalGenesis), rootId: id(state.root), generation: state.root.generation, retainedDigest: retainedDigest() };
    return openEncryptedLocalState<typeof expected>({ path: fencePath, key, domain: binding.fenceDomain, maxBytes: 8192,
      mode, initial: expected, validate(value): value is typeof expected {
        return exactWitnessFields(value, Object.keys(expected)) && Object.keys(expected).every(field => value[field] === expected[field as keyof typeof expected]);
      } });
  }
  return {
    reviewRecoverySource() { return exclusive(async () => {
      if (!binding.allowRecovery) throw new Error('This protected owner does not support recovery source capabilities');
      const captured = readState(), capturedDigest = retainedDigest();
      const minimumEvidence = [await normalize(captured.image)];
      if (captured.pending) {
        const pendingImage = captured.pending.kind === 'continuation' ? await normalize(baseline(captured)) : await decode(captured.pending);
        if (JSON.stringify(pendingImage) !== JSON.stringify(minimumEvidence[0])) minimumEvidence.push(pendingImage);
      }
      if (retainedDigest() !== capturedDigest) throw new Error('Issuer history changed during source review');
      const evidence: ProtectedCheckpointOwnerRecoveryEvidence<T> = { path, writerDirectory, contextId: historyCheckpointContextId(context), genesisId: id(originalGenesis),
        rootId: id(captured.root), generation: captured.root.generation, stateDigest: historyDigest(JSON.stringify(minimumEvidence)), context: structuredClone(context),
        genesis: structuredClone(originalGenesis), root: structuredClone(captured.root), minimumEvidence,
        applied: structuredClone(captured.applied), pending: captured.pending ? { sequence: captured.pending.sequence, id: id(captured.pending) } : null };
      const source = Object.freeze({ path, writerDirectory, contextId: evidence.contextId, genesisId: evidence.genesisId, rootId: evidence.rootId,
        generation: evidence.generation, stateDigest: evidence.stateDigest });
      let completedDigest: string | undefined;
      recoverySources.set(source, { evidence, fence() { return run(() => exclusive(async () => {
        if (fenced) {
          if (completedDigest && retainedDigest() === completedDigest) return;
          if (retainedDigest() === capturedDigest) return;
          throw new Error('Issuer history changed since source review');
        }
        if (retainedDigest() !== capturedDigest && retainedDigest() !== completedDigest) throw new Error('Issuer history changed since source review');
        readyConfirmed = false;
        await finishPending();
        const state = readState(), expectedHead = evidence.pending ?? evidence.applied;
        if (!expectedHead || state.pending || state.applied?.id !== expectedHead.id || state.applied.sequence !== expectedHead.sequence
          || JSON.stringify(state.image) !== JSON.stringify(minimumEvidence.at(-1))) throw new Error('Issuer pending completion differs from reviewed source');
        completedDigest = retainedDigest();
        try { const marker = openFence('create-new'); marker.close(); fenced = true; }
        catch (error) { close(); throw error; }
      })); } });
      return source;
    }); },
    read() { return structuredClone(readState().image); },
    assertServing, history,
    status() { const state = readState(); return { ready: readyConfirmed, busy: active, fenced, pending: state.pending !== null,
      applied: structuredClone(state.applied), rootId: id(state.root), ...writer!.historyUsage() }; },
    enrollment() { const state = readState(); return { context: structuredClone(context), root: structuredClone(state.root) }; },
    ready() { return exclusive(async () => {
      readyConfirmed = false;
      if (fenced) throw new Error('Protected issuer is permanently fenced for recovery');
      const fresh = await finishPending();
      if (!fresh) await writer!.replicate(writer!.read().committed!.envelope);
      readState(); available(); readyConfirmed = true;
    }); },
    assertCapacity(values: readonly T[]) {
      if (!Array.isArray(values) || values.length < 1 || values.length > 2) return Promise.reject(new Error('Issuer capacity preflight requires one or two full images'));
      const inputs = structuredClone(values);
      return exclusive(async () => {
        assertServing(); let state = available();
        const usage = writer!.historyUsage(); let blocks = usage.retainedBlocks, bytes = usage.retainedCiphertextBytes;
        for (const input of inputs) {
          const image = await normalize(input); await transition(state.image, image); await validateProof(image); assertServing();
          if (state.applied!.sequence >= Number.MAX_SAFE_INTEGER - 1) throw new Error('Protected issuer history sequence capacity exhausted');
          const plaintext = imageBytes(image);
          try {
            const header = { kind: 'checkpoint', generation: state.root.generation, sequence: state.applied!.sequence + 1, previous: state.applied!.id } as const;
            bytes += historyCheckpointEnvelopeByteLength({ context, header, plaintextBytes: plaintext.length }); blocks++;
            if (blocks > usage.maximumBlocks || bytes > usage.maximumCiphertextBytes) throw new Error('Protected issuer history archive capacity exceeded before intent');
            const pending = sealHistoryCheckpoint({ context, header, plaintext, encryptionKey: key, signingKey: signer });
            assertOuterCapacity({ ...state, pending });
            state = { ...state, image, applied: { sequence: pending.sequence, id: id(pending) }, pending: null };
            assertOuterCapacity(state);
          } finally { plaintext.fill(0); }
        }
      });
    },
    commit(value: T, assertBeforeIntent?: () => void) {
      const input = structuredClone(value);
      return exclusive(async () => {
        assertServing(); const before = available(), image = await normalize(input); await transition(before.image, image); await validateProof(image); assertServing();
        if (JSON.stringify(image) === JSON.stringify(before.image)) return;
        if (before.applied!.sequence >= Number.MAX_SAFE_INTEGER - 1) throw new Error('Protected issuer history sequence capacity exhausted');
        const plaintext = imageBytes(image); let pending: HistoryCheckpointEnvelope;
        try {
          const header = { kind: 'checkpoint', generation: before.root.generation, sequence: before.applied!.sequence + 1, previous: before.applied!.id } as const;
          const required = historyCheckpointEnvelopeByteLength({ context, header, plaintextBytes: plaintext.length }), usage = writer!.historyUsage();
          if (usage.retainedBlocks + 1 > usage.maximumBlocks || usage.retainedCiphertextBytes + required > usage.maximumCiphertextBytes) {
            throw new Error('Protected issuer history archive capacity exceeded before intent');
          }
          pending = sealHistoryCheckpoint({ context, header, plaintext, encryptionKey: key, signingKey: signer });
        } finally { plaintext.fill(0); }
        const intent = { ...before, pending };
        assertOuterCapacity(intent); assertOuterCapacity({ ...before, image, applied: { sequence: pending.sequence, id: id(pending) }, pending: null });
        // Trusted business gate runs after every asynchronous image verifier and before the first durable intent.
        assertBeforeIntent?.();
        storage!.write(intent);
        await finishPending(); assertServing();
      });
    },
    close,
  };
}
