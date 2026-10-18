/** Append-only full issuer images: exact durable intent, four retained copies, then local apply. */
import { resolve } from 'node:path';
import type { SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { HISTORY_CHECKPOINT_MAX_PAYLOAD, historyCheckpointContextId, historyCheckpointEnvelopeByteLength, historyCheckpointEnvelopeId,
  isHistoryDigest, openHistoryCheckpoint, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, sealHistoryCheckpoint,
  type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { HISTORY_RECOVERY_MAX_BLOCKS, HISTORY_RECOVERY_MAX_BYTES } from '@resonance/core/history-exchange';
import { createRetainedHistoryCheckpointWriter } from './history-retained-writer.js';

type Writer = ReturnType<typeof createRetainedHistoryCheckpointWriter>;
type WriterOptions = Parameters<typeof createRetainedHistoryCheckpointWriter>[0];
export const MAX_PROTECTED_ISSUER_HISTORY_BYTES = 32 * 1024 * 1024;
export const MAX_PROTECTED_ISSUER_IMAGE_BYTES = HISTORY_CHECKPOINT_MAX_PAYLOAD;
export interface ProtectedIssuerHistoryState<T> {
  version: 1; kind: 'protected-admission-issuer'; context: HistoryCheckpointContext;
  root: HistoryCheckpointEnvelope; image: T;
  applied: { sequence: number; id: string } | null; pending: HistoryCheckpointEnvelope | null;
}
export interface ProtectedIssuerHistoryOptions<T> {
  /** Same file, domain and key as the local-only issuer. Its parser rejects the protected outer shape. */
  path: string; writerDirectory: string; domain: string; encryptionKey: Uint8Array;
  context: HistoryCheckpointContext; signingKey: SigningKeyPair; members: WriterOptions['members'];
  initial: T;
  /** Authenticate and normalize the complete issuer image, including its allocation and all retained decisions. */
  validate(value: unknown): T | Promise<T>;
  initialize?: boolean; initializeWriter?: boolean; initializeArchive?: boolean;
  timeoutMs?: number; transport?: WriterOptions['transport']; maxArchiveBlocks?: number; maxArchiveBytes?: number;
}
export interface ProtectedIssuerHistoryStatus {
  ready: boolean; busy: boolean; pending: boolean;
  applied: { sequence: number; id: string } | null; rootId: string;
  retainedBlocks: number; retainedCiphertextBytes: number; maximumBlocks: number; maximumCiphertextBytes: number;
}
export interface ProtectedIssuerHistory<T> {
  read(): T; commit(value: T): Promise<void>; ready(): Promise<void>; assertServing(): void;
  assertCapacity(values: readonly T[]): Promise<void>;
  status(): ProtectedIssuerHistoryStatus;
  enrollment(): { context: HistoryCheckpointContext; root: HistoryCheckpointEnvelope };
  close(): void;
}
const id = historyCheckpointEnvelopeId;
function imageBytes(value: unknown): Buffer {
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || Buffer.byteLength(json) < 1 || Buffer.byteLength(json) > MAX_PROTECTED_ISSUER_IMAGE_BYTES) {
    throw new Error('Protected issuer image payload capacity exceeded');
  }
  return Buffer.from(json);
}
/** Exact encrypted-local-state wire ceiling, before writing any owner intent. */
function assertOuterCapacity(value: unknown): void {
  const plaintextBytes = Buffer.byteLength(JSON.stringify(value));
  const metadataBytes = Buffer.byteLength(JSON.stringify({ version: 1, nonce: '', ciphertext: '', tag: '' })) + 16 + 22;
  if (metadataBytes + Math.ceil(plaintextBytes * 4 / 3) > MAX_PROTECTED_ISSUER_HISTORY_BYTES) {
    throw new Error('Protected issuer outer state capacity exceeded before intent');
  }
}
export async function openProtectedIssuerHistory<T>(options: ProtectedIssuerHistoryOptions<T>): Promise<ProtectedIssuerHistory<T>> {
  // Capture caller-owned mutable data and both keys before the first asynchronous validator.
  const context = parseHistoryCheckpointContext(structuredClone(options.context));
  const key = Buffer.from(options.encryptionKey), signer = copyAdmissionSigningKey(options.signingKey);
  const initialInput = structuredClone(options.initial), members = structuredClone(options.members);
  const path = resolve(options.path), writerDirectory = resolve(options.writerDirectory), domain = options.domain, validate = options.validate;
  const initialize = options.initialize === true, initializeWriter = options.initializeWriter === true, initializeArchive = options.initializeArchive === true;
  const timeoutMs = options.timeoutMs, transport = options.transport;
  const maximumBlocks = options.maxArchiveBlocks ?? HISTORY_RECOVERY_MAX_BLOCKS, maximumBytes = options.maxArchiveBytes ?? HISTORY_RECOVERY_MAX_BYTES;
  let storage: ReturnType<typeof openEncryptedLocalState<ProtectedIssuerHistoryState<T>>> | undefined, writer: Writer | undefined;
  let closed = false, active = false, readyConfirmed = false;
  function readState(): ProtectedIssuerHistoryState<T> {
    if (closed) throw new Error('Protected issuer history is closed');
    return storage!.read();
  }
  function close() {
    if (!closed) { closed = true; readyConfirmed = false; writer?.close(); storage?.close(); key.fill(0); signer.secretKey.fill(0); }
  }
  async function normalize(value: unknown): Promise<T> {
    const before = imageBytes(value); before.fill(0);
    const normalized = structuredClone(await validate(structuredClone(value)));
    const after = imageBytes(normalized); after.fill(0); return normalized;
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
    readState(); if (!readyConfirmed) throw new Error('Protected issuer history needs fresh readiness confirmation');
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
    const image = await decode(pending); readState(); writerMatches();
    const committed = writer!.read().committed;
    const fresh = !committed || id(committed.envelope) !== id(pending);
    if (fresh) await writer!.replicate(pending);
    readState();
    const applied: ProtectedIssuerHistoryState<T> = { ...before, image, applied: { sequence: pending.sequence, id: id(pending) }, pending: null };
    assertOuterCapacity(applied); storage!.write(applied);
    return fresh;
  }
  async function exclusive<R>(operation: () => Promise<R>): Promise<R> {
    readState(); if (active) throw new Error('Protected issuer history operation is in progress'); active = true;
    try { return await operation(); }
    catch (error) { readyConfirmed = false; throw error; }
    finally { active = false; }
  }
  try {
    if (context.role !== 'admission-issuer' || key.length !== 32 || Buffer.from(signer.publicKey).toString('base64url') !== context.owner) {
      throw new Error('Wrong protected issuer history role, owner, or encryption key');
    }
    if (!initialize && (initializeWriter || initializeArchive)) throw new Error('Issuer writer and archive initialization require fresh owner creation');
    if (!Number.isSafeInteger(maximumBlocks) || maximumBlocks < 1 || maximumBlocks > HISTORY_RECOVERY_MAX_BLOCKS
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > HISTORY_RECOVERY_MAX_BYTES) throw new Error('Invalid protected issuer archive bounds');
    const contextId = historyCheckpointContextId(context);
    let initial: ProtectedIssuerHistoryState<T> | undefined;
    if (initialize) {
      const image = await normalize(initialInput), plaintext = imageBytes(image);
      try {
        const header = { kind: 'checkpoint', generation: 0, sequence: 0, previous: null } as const;
        if (historyCheckpointEnvelopeByteLength({ context, header, plaintextBytes: plaintext.length }) > maximumBytes) {
          throw new Error('Protected issuer root needs archive capacity before intent');
        }
        const root = sealHistoryCheckpoint({ context, header, plaintext, encryptionKey: key, signingKey: signer });
        initial = { version: 1, kind: 'protected-admission-issuer', context, root, image, applied: null, pending: root };
        assertOuterCapacity(initial);
      } finally { plaintext.fill(0); }
    }
    storage = openEncryptedLocalState<ProtectedIssuerHistoryState<T>>({ path, key, domain, maxBytes: MAX_PROTECTED_ISSUER_HISTORY_BYTES,
      initial: initial!, mode: initialize ? 'create-new' : 'open-existing',
      validate(value): value is ProtectedIssuerHistoryState<T> {
        return exactWitnessFields(value, ['version', 'kind', 'context', 'root', 'image', 'applied', 'pending'])
          && value.version === 1 && value.kind === 'protected-admission-issuer';
      } });
    const state = readState();
    if (historyCheckpointContextId(state.context) !== contextId) throw new Error('Protected issuer history pins changed');
    const root = parseHistoryCheckpointEnvelope(state.root, context);
    if (root.kind !== 'checkpoint' || root.generation !== 0 || root.sequence !== 0) throw new Error('Invalid protected issuer history root');
    const rootImage = await decode(root), image = await normalize(state.image);
    if (JSON.stringify(image) !== JSON.stringify(state.image)) throw new Error('Noncanonical protected issuer image');
    if (state.applied === null) {
      if (!state.pending || id(parseHistoryCheckpointEnvelope(state.pending, context)) !== id(root)
        || JSON.stringify(image) !== JSON.stringify(rootImage)) throw new Error('Incomplete protected issuer root');
    } else {
      if (!exactWitnessFields(state.applied, ['sequence', 'id']) || !Number.isSafeInteger(state.applied.sequence) || state.applied.sequence < 0
        || !isHistoryDigest(state.applied.id) || (state.applied.sequence === 0 && state.applied.id !== id(root))) throw new Error('Invalid protected issuer applied head');
      if (state.pending !== null) {
        const pending = parseHistoryCheckpointEnvelope(state.pending, context);
        if (pending.kind !== 'checkpoint' || pending.generation !== 0 || pending.sequence !== state.applied.sequence + 1
          || pending.previous !== state.applied.id) throw new Error('Invalid protected issuer pending successor');
        await decode(pending);
      }
    }
    assertOuterCapacity(state);
    // Creation capabilities never recreate a missing writer/archive for committed owner history.
    if ((initializeWriter || initializeArchive) && state.applied !== null) throw new Error('Cannot initialize writer or archive for applied issuer history');
    writer = createRetainedHistoryCheckpointWriter({ directory: writerDirectory, localKey: key, context, signingKey: signer,
      rootId: id(root), generation: 0, members, requireCurrentHead: true, initialize: initializeWriter, initializeArchive,
      timeoutMs, transport, maxArchiveBlocks: maximumBlocks, maxArchiveBytes: maximumBytes });
    writerMatches();
    // Full checkpoints let the local image be checked against owner-signed ciphertext on every reopen.
    if (state.applied) {
      const block = writer.historyBlock(state.applied.sequence);
      if (!block || id(block) !== state.applied.id || JSON.stringify(await decode(block)) !== JSON.stringify(image)) {
        throw new Error('Protected issuer applied image does not match retained signed checkpoint');
      }
    }
  } catch (error) { close(); throw error; }
  return {
    read() { return structuredClone(readState().image); },
    assertServing,
    status() { const state = readState(); return { ready: readyConfirmed, busy: active, pending: state.pending !== null,
      applied: structuredClone(state.applied), rootId: id(state.root), ...writer!.historyUsage() }; },
    enrollment() { const state = readState(); return { context: structuredClone(context), root: structuredClone(state.root) }; },
    ready() { return exclusive(async () => {
      readyConfirmed = false;
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
          const image = await normalize(input); assertServing();
          if (state.applied!.sequence >= Number.MAX_SAFE_INTEGER - 1) throw new Error('Protected issuer history sequence capacity exhausted');
          const plaintext = imageBytes(image);
          try {
            const header = { kind: 'checkpoint', generation: 0, sequence: state.applied!.sequence + 1, previous: state.applied!.id } as const;
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
    commit(value: T) {
      const input = structuredClone(value);
      return exclusive(async () => {
        assertServing(); const before = available(), image = await normalize(input); assertServing();
        if (JSON.stringify(image) === JSON.stringify(before.image)) return;
        if (before.applied!.sequence >= Number.MAX_SAFE_INTEGER - 1) throw new Error('Protected issuer history sequence capacity exhausted');
        const plaintext = imageBytes(image); let pending: HistoryCheckpointEnvelope;
        try {
          const header = { kind: 'checkpoint', generation: 0, sequence: before.applied!.sequence + 1, previous: before.applied!.id } as const;
          const required = historyCheckpointEnvelopeByteLength({ context, header, plaintextBytes: plaintext.length }), usage = writer!.historyUsage();
          if (usage.retainedBlocks + 1 > usage.maximumBlocks || usage.retainedCiphertextBytes + required > usage.maximumCiphertextBytes) {
            throw new Error('Protected issuer history archive capacity exceeded before intent');
          }
          pending = sealHistoryCheckpoint({ context, header, plaintext, encryptionKey: key, signingKey: signer });
        } finally { plaintext.fill(0); }
        const intent = { ...before, pending };
        assertOuterCapacity(intent); assertOuterCapacity({ ...before, image, applied: { sequence: pending.sequence, id: id(pending) }, pending: null });
        storage!.write(intent);
        await finishPending(); assertServing();
      });
    },
    close,
  };
}
