/** Experimental single-volunteer storage; exchange/recovery orchestration lives in separate modules. */
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { reserveHistoryStorage } from './history-storage-reservation.js';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import type { SigningKeyPair } from '@resonance/core';
import { HISTORY_AGREEMENT_MAX_VIEW, parseHistoryAgreementFrame, parseHistoryAgreementRequest } from '@resonance/core/history-agreement';
import { createHistoryAgreementDataResponse, parseHistoryAgreementDataFrame } from '@resonance/core/history-agreement-data';
import { historyContinuationRootId, parseHistoryContinuationRoot, type HistoryContinuationRoot } from '@resonance/core/history-continuation';
import type { HistoryAgreementFrame } from '@resonance/core/history-agreement';
import { advanceHistoryAgreement, parseHistoryAgreementState, type HistoryAgreementState } from './history-agreement-state.js';
import { assertHistorySuccessorChain, historySuccessorProposalId, parseHistorySuccessorProposal,
  type HistorySuccessorProposal } from '@resonance/core/history-successor';
import {
  HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId,
  historyDigest, isHistoryDigest, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, parseHistoryFreeze,
  type HistoryCheckpointContext, type HistoryCheckpointEnvelope, type HistoryFreeze,
} from '@resonance/core/history-checkpoint';

export const HISTORY_MANIFEST_FILENAME = 'history-manifest.json';
const DOMAIN = 'resonance:history-replica-manifest:v1';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_BLOCKS = 10_001;
const MAX_ANCESTRY_BYTES = 256 * 1024 * 1024;
interface Manifest {
  version: 1; contextId: string; replica: string; rootId: string; generation: number;
  blocks: string[]; freeze: HistoryFreeze | null;
  /** Missing only in pre-reservation manifests. A sealed successor is never replaced. */
  successor?: HistorySuccessorProposal | null;
  /** Opt-in is atomic with the first promise. Never combined with a legacy reservation. */
  agreement?: HistoryAgreementState | null;
  /** Descending, head-authenticated ciphertext; invisible until it joins the retained prefix. */
  transfer?: { authorization: HistoryAgreementFrame; blocks: string[] } | null;
  /** Irreversible authority for one deterministic child; every predecessor block remains indexed. */
  activation?: HistoryContinuationRoot | null;
}
export interface HistoryCheckpointAncestor {
  /** Checks the durable activation and retained parent chain, returning the child ancestry depth. */
  requireContinuation(root: HistoryContinuationRoot, replica: string): { depth: number; bytes: number };
}
export interface HistoryCheckpointStoreOptions {
  directory: string;
  /** Local manifest key. The volunteer never needs the payload decryption key. */
  localKey: Uint8Array;
  context: HistoryCheckpointContext;
  replica: string;
  /** Independently retained enrolment pins, not values learned from this directory. */
  rootId: string;
  generation: number;
  /** Only for a new, empty directory with an intact owner-authenticated checkpoint. */
  initialize?: HistoryCheckpointEnvelope;
  /** Required on creation AND reopen of a non-genesis generation. Never inferred from discovery. */
  parent?: HistoryCheckpointAncestor;
  /** Includes two maximum manifest copies plus all immutable encrypted blocks. */
  maxBytes?: number;
  maxBlocks?: number;
  /** Optional external progress anchor; complete rollback without one remains undetectable. */
  minimum?: { sequence: number; id: string; generationBarrier: number; successorId?: string; agreementView?: number };
}

export function openHistoryCheckpointStore(options: HistoryCheckpointStoreOptions) {
  return openStore(options, false);
}

/** Explicit repair of an authenticated, still-empty genesis manifest. This is
 * not an operational store and never creates/replaces a missing manifest. */
export function inspectPristineHistoryGenesis(options: Pick<HistoryCheckpointStoreOptions, 'directory' | 'localKey' | 'context' | 'replica'> & {
  genesis: HistoryCheckpointEnvelope;
}) {
  const context = parseHistoryCheckpointContext(options.context), root = parseHistoryCheckpointEnvelope(options.genesis, context);
  const rootId = historyCheckpointEnvelopeId(root), directory = options.directory;
  if (root.kind !== 'checkpoint' || root.generation !== 0 || root.sequence !== 0 || !context.members.includes(options.replica)) {
    throw new Error('Pristine enrollment needs independently pinned genesis and member');
  }
  const manifest = join(directory, HISTORY_MANIFEST_FILENAME), block = join(directory, `${rootId.slice(7)}.block`);
  const initial: Manifest = { version: 1, contextId: historyCheckpointContextId(context), replica: options.replica,
    rootId, generation: 0, blocks: [], freeze: null, successor: null };
  const allowed = new RegExp(`^(?:${HISTORY_MANIFEST_FILENAME.replace('.', '\\.')}(?:\\.lock|\\.recovery)?|\\.${HISTORY_MANIFEST_FILENAME.replace('.', '\\.')}\\.[a-f0-9]{16}\\.tmp|${rootId.slice(7)}\\.block|\\.block-[a-f0-9]{32}\\.tmp)$`);
  function contents() {
    if (!lstatSync(directory).isDirectory() || !lstatSync(manifest).isFile()) throw new Error('Retain the missing or nonregular genesis manifest for recovery');
    const entries = readdirSync(directory).sort();
    if (entries.length > 64) throw new Error('Too many interrupted enrollment files; inspect before resuming');
    const fingerprints: Array<[string, string]> = [];
    for (const name of entries) {
      const path = join(directory, name), stat = lstatSync(path);
      if (!allowed.test(name) || !stat.isFile() || stat.size > Math.max(MAX_MANIFEST_BYTES, HISTORY_ENVELOPE_MAX_BYTES)) {
        throw new Error('Unexpected interrupted enrollment contents');
      }
      // Lock ownership is checked by the encrypted-state store, not approved as data.
      if (name.endsWith('.lock') || name.endsWith('.recovery')) continue;
      const bytes = readFileSync(path);
      try {
        if (bytes.length !== stat.size) throw new Error('Interrupted enrollment file changed during inspection');
        fingerprints.push([name, historyDigest(bytes)]);
        if (path === block && historyCheckpointEnvelopeId(parseHistoryCheckpointEnvelope(JSON.parse(bytes.toString('utf8')), context)) !== rootId) {
          throw new Error('Interrupted genesis block differs from enrollment');
        }
      } finally { bytes.fill(0); }
    }
    return historyDigest(JSON.stringify(fingerprints));
  }
  contents();
  const reservation = reserveHistoryStorage({ directory, component: 'history-replica-ciphertext',
    ciphertextBytes: Buffer.byteLength(JSON.stringify(root)), manifestFilename: HISTORY_MANIFEST_FILENAME, manifestBytes: MAX_MANIFEST_BYTES });
  const storage = openEncryptedLocalState<Manifest>({ path: manifest, key: options.localKey, domain: DOMAIN, maxBytes: MAX_MANIFEST_BYTES,
    mode: 'open-existing', initial, validate: (value): value is Manifest => JSON.stringify(value) === JSON.stringify(initial) });
  let closed = false, completed = false;
  try {
    const digest = contents();
    return {
      reviewDigest() { storage.read(); return digest; },
      complete(expected: string) {
        reservation.assertWritable(); storage.read();
        if (closed || completed || expected !== digest || contents() !== digest) throw new Error('Interrupted enrollment changed; inspect again');
        if (!existsSync(block)) {
          const temporary = join(directory, `.block-${randomBytes(16).toString('hex')}.tmp`), bytes = Buffer.from(JSON.stringify(root));
          let fd: number | undefined;
          try {
            fd = openSync(temporary, 'wx', 0o600); let offset = 0;
            while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset); if (written <= 0) throw new Error('Incomplete genesis write'); offset += written; }
            fsyncSync(fd); closeSync(fd); fd = undefined;
            renameSync(temporary, block); flushDirectory(directory);
          } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); bytes.fill(0); }
        }
        // The initial manifest proves no append, promise or barrier was accepted.
        // Publish the original root only; ordinary reopening validates it next.
        storage.write({ ...initial, blocks: [rootId] }); completed = true;
      },
      close() { if (!closed) { closed = true; storage.close(); } },
    };
  } catch (error) { storage.close(); throw error; }
}

/** Internal provisioning step: ONLY an unpublished staging directory guarded by a durable creation intent.
 * This never opens an operational store. The caller must persist readiness at the pinned directory
 * before exposing append/read services. An existing manifest with accepted work is never initialized.
 */
export function prepareHistoryContinuationStore(options: HistoryCheckpointStoreOptions & { initialize: HistoryContinuationRoot }): void {
  const store = openStore(options, true);
  store.close();
}

function openStore(options: HistoryCheckpointStoreOptions, preparing: boolean) {
  const context = parseHistoryCheckpointContext(options.context);
  const contextId = historyCheckpointContextId(context);
  const { directory, replica, rootId, generation } = options;
  const parent = options.parent;
  let ancestryDepth = 0;
  let ancestorBytes = 0;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024, maxBlocks = options.maxBlocks ?? MAX_BLOCKS;
  const minimum = options.minimum ? { ...options.minimum } : undefined;
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!context.members.includes(replica) || !isHistoryDigest(rootId) || !integer(generation)
    || !integer(maxBytes) || maxBytes <= 2 * MAX_MANIFEST_BYTES || maxBytes > 256 * 1024 * 1024
    || !integer(maxBlocks) || maxBlocks < 1 || maxBlocks > MAX_BLOCKS
    || (minimum && (!integer(minimum.sequence) || !isHistoryDigest(minimum.id) || !integer(minimum.generationBarrier)
      || (minimum.successorId !== undefined && !isHistoryDigest(minimum.successorId))
      || (minimum.agreementView !== undefined && (!integer(minimum.agreementView) || minimum.agreementView < 1
        || minimum.agreementView > HISTORY_AGREEMENT_MAX_VIEW))))) {
    throw new Error('Invalid history store pins or capacity');
  }
  const initial: Manifest = { version: 1, contextId, replica, rootId, generation, blocks: [], freeze: null, successor: null };
  function validManifest(value: unknown): value is Manifest {
    // This intermediate manifest can only exist inside the provisioner's unpublished directory.
    if (preparing && JSON.stringify(value) === JSON.stringify(initial)) return true;
    const optional = ['successor', 'agreement', 'transfer', 'activation'].filter(key => value !== null && typeof value === 'object' && Object.hasOwn(value, key));
    if (!exactWitnessFields(value, ['version', 'contextId', 'replica', 'rootId', 'generation', 'blocks', 'freeze', ...optional])
      || value.version !== 1 || value.contextId !== contextId || value.replica !== replica || value.rootId !== rootId
      || value.generation !== generation || !Array.isArray(value.blocks) || !value.blocks.length
      || value.blocks.length > maxBlocks || !value.blocks.every(isHistoryDigest)
      || value.blocks[0] !== rootId || new Set(value.blocks).size !== value.blocks.length) return false;
    if (value.freeze !== null) {
      try { if (parseHistoryFreeze(value.freeze, context).generation !== generation) return false; }
      catch { return false; }
    }
    if (value.successor !== undefined && value.successor !== null) {
      try {
        const p = parseHistorySuccessorProposal(value.successor, context);
        if (p.rootId !== rootId || p.generation !== generation || !value.freeze
          || p.nextGeneration !== parseHistoryFreeze(value.freeze, context).nextGeneration) return false;
        assertHistorySuccessorChain(p, value.blocks);
      } catch { return false; }
    }
    if (value.agreement !== undefined && value.agreement !== null) {
      try {
        const agreement = parseHistoryAgreementState(value.agreement, context, replica), r = agreement.report.request;
        if (value.successor || r.rootId !== rootId || r.generation !== generation || !value.freeze
          || r.nextGeneration !== parseHistoryFreeze(value.freeze, context).nextGeneration) return false;
        for (const record of [agreement.prepared, agreement.confirmed]) {
          if (record) assertHistorySuccessorChain(record.frame.proposal!, value.blocks);
        }
      } catch { return false; }
    }
    if (value.transfer !== undefined && value.transfer !== null) {
      try {
        if (!exactWitnessFields(value.transfer, ['authorization', 'blocks'])) return false;
        const f = parseHistoryAgreementFrame(value.transfer.authorization, context), ids = value.transfer.blocks;
        const a = parseHistoryAgreementState(value.agreement, context, replica);
        if (f.request.action !== 'prepare' || f.request.replica !== replica || f.request.rootId !== rootId
          || f.request.generation !== generation || f.request.nextGeneration !== a.report.request.nextGeneration
          || f.request.view !== a.report.request.view || value.successor || a.prepared || a.confirmed
          || !Array.isArray(ids) || !ids.length || !ids.every(isHistoryDigest) || ids[0] !== f.proposal!.envelopeId
          || ids.length >= f.proposal!.sequence + 1 - value.blocks.length
          || new Set([...value.blocks, ...ids]).size !== value.blocks.length + ids.length
          || value.blocks.length + ids.length > maxBlocks) return false;
      } catch { return false; }
    }
    if (value.activation !== undefined && value.activation !== null) {
      try {
        const root = parseHistoryContinuationRoot(value.activation, context), p = root.proposal;
        if (value.successor || value.transfer || p.rootId !== rootId || p.generation !== generation
          || !value.freeze || p.nextGeneration !== parseHistoryFreeze(value.freeze, context).nextGeneration) return false;
        assertHistorySuccessorChain(p, value.blocks);
      } catch { return false; }
    }
    return true;
  }
  function validateParent(root: HistoryCheckpointEnvelope) {
    if (generation === 0) {
      if (root.kind === 'continuation' || parent) throw new Error('Genesis cannot replace another history generation');
    } else {
      if (root.kind !== 'continuation' || !parent) throw new Error('Continuation requires its retained activated predecessor');
      const ancestry = parent.requireContinuation(root, replica);
      ancestryDepth = ancestry.depth; ancestorBytes = ancestry.bytes;
      if (!Number.isSafeInteger(ancestryDepth) || ancestryDepth < 1 || ancestryDepth > 64
        || !Number.isSafeInteger(ancestorBytes) || ancestorBytes < 0
        || ancestorBytes + 2 * MAX_MANIFEST_BYTES + Buffer.byteLength(JSON.stringify(root)) > MAX_ANCESTRY_BYTES) {
        throw new Error('History ancestry capacity exceeded');
      }
    }
  }
  const reservation = reserveHistoryStorage({ directory, component: 'history-replica-ciphertext', ciphertextBytes: maxBytes - 2 * MAX_MANIFEST_BYTES,
    manifestFilename: HISTORY_MANIFEST_FILENAME, manifestBytes: MAX_MANIFEST_BYTES });
  let root: HistoryCheckpointEnvelope | undefined;
  if (options.initialize) {
    root = parseHistoryCheckpointEnvelope(options.initialize, context);
    if (root.sequence !== 0 || root.generation !== generation || historyCheckpointEnvelopeId(root) !== rootId) {
      throw new Error('History enrolment checkpoint does not match pins');
    }
    validateParent(root);
    if (preparing && root.kind !== 'continuation') throw new Error('Only certified continuations can be provisioned');
    // Never reinterpret an incomplete or damaged directory as a new history.
    if (existsSync(directory) && readdirSync(directory).length) {
      if (!preparing) throw new Error('History enrolment directory is not empty');
      const allowed = new RegExp(`^(?:${HISTORY_MANIFEST_FILENAME.replace('.', '\\.')}(?:\\.lock|\\.recovery)?|\\.${HISTORY_MANIFEST_FILENAME.replace('.', '\\.')}\\.[a-f0-9]{16}\\.tmp|${rootId.slice(7)}\\.block|\\.block-[a-f0-9]{32}\\.tmp)$`);
      for (const name of readdirSync(directory)) {
        if (!allowed.test(name) || !lstatSync(join(directory, name)).isFile()) throw new Error('Unexpected provision staging contents');
      }
    }
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    flushDirectory(dirname(directory));
  }
  const storage = openEncryptedLocalState<Manifest>({
    path: join(directory, HISTORY_MANIFEST_FILENAME), key: options.localKey, domain: DOMAIN,
    maxBytes: MAX_MANIFEST_BYTES, mode: root && !(preparing && existsSync(join(directory, HISTORY_MANIFEST_FILENAME)))
      ? 'create-new' : 'open-existing', initial, validate: validManifest,
  });
  let failed = false;
  let blockBytes = 0;
  const envelopes: HistoryCheckpointEnvelope[] = [];
  let staged: HistoryCheckpointEnvelope[] = [];
  const blockPath = (id: string) => join(directory, `${id.slice(7)}.block`);
  function ensureOpen() {
    reservation.assertWritable(); storage.read();
    if (failed) throw new Error('History storage write failed; close and reopen before reuse');
  }
  function fits(bytes: number, count: number) {
    if (count > maxBlocks || blockBytes + bytes + 2 * MAX_MANIFEST_BYTES > maxBytes
      || ancestorBytes + blockBytes + bytes + 2 * MAX_MANIFEST_BYTES > MAX_ANCESTRY_BYTES) throw new Error('History storage capacity exceeded');
  }
  function writeImmutable(envelope: HistoryCheckpointEnvelope): number {
    reservation.assertWritable();
    const bytes = Buffer.from(JSON.stringify(envelope)), id = historyCheckpointEnvelopeId(envelope);
    const temporary = join(directory, `.block-${randomBytes(16).toString('hex')}.tmp`);
    let fd: number | undefined;
    try {
      if (existsSync(blockPath(id))) throw new Error('Unindexed history block requires reopen');
      fd = openSync(temporary, 'wx', 0o600);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('Incomplete history block write');
        offset += written;
      }
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, blockPath(id)); flushDirectory(directory);
      return bytes.length;
    } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
  }
  function writeBlock(envelope: HistoryCheckpointEnvelope): void {
    const state = storage.read(), next = { ...state, blocks: [...state.blocks, historyCheckpointEnvelopeId(envelope)] };
    fits(Buffer.byteLength(JSON.stringify(envelope)), next.blocks.length);
    if (!validManifest(next)) throw new Error('Invalid outgoing history manifest');
    try {
      const size = writeImmutable(envelope);
      storage.write(next); blockBytes += size; envelopes.push(envelope);
    } catch (error) { failed = true; throw error; }
  }
  function loadBlock(id: string): HistoryCheckpointEnvelope {
    const path = blockPath(id), stat = lstatSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > HISTORY_ENVELOPE_MAX_BYTES) throw new Error('Invalid history block size or type');
    fits(stat.size, envelopes.length + staged.length + 1);
    const bytes = readFileSync(path);
    if (bytes.length !== stat.size) throw new Error('History block changed during read');
    const envelope = parseHistoryCheckpointEnvelope(JSON.parse(bytes.toString('utf8')), context);
    if (historyCheckpointEnvelopeId(envelope) !== id || envelope.generation !== generation) throw new Error('History block binding mismatch');
    blockBytes += bytes.length; return envelope;
  }
  try {
    if (root && preparing) {
      const state = storage.read();
      if (state.blocks.length) {
        if (state.blocks.length !== 1 || state.freeze || state.successor || state.agreement || state.transfer || state.activation) {
          throw new Error('Provision staging contains operational history');
        }
        envelopes.push(loadBlock(rootId));
      } else if (existsSync(blockPath(rootId))) {
        // A crash may leave the flushed root just before the manifest's atomic replacement.
        const retained = loadBlock(rootId);
        if (retained.sequence !== 0 || retained.previous !== null) throw new Error('Invalid provisioned root');
        storage.write({ ...initial, blocks: [rootId] }); envelopes.push(retained);
      } else writeBlock(root);
    }
    else if (root) writeBlock(root);
    else {
      const state = storage.read();
      for (const [sequence, id] of state.blocks.entries()) {
        const envelope = loadBlock(id);
        if (sequence === 0) validateParent(envelope);
        if (envelope.sequence !== sequence || envelope.previous !== (sequence ? state.blocks[sequence - 1] : null)) {
          throw new Error('History chain is incomplete or conflicting');
        }
        envelopes.push(envelope);
      }
      if (state.transfer) {
        for (const [offset, id] of state.transfer.blocks.entries()) {
          const envelope = loadBlock(id);
          if (envelope.sequence !== state.transfer.authorization.proposal!.sequence - offset
            || (offset && staged[offset - 1].previous !== id)) throw new Error('Staged history chain is incomplete or conflicting');
          staged.push(envelope);
        }
      }
    }
    const state = storage.read();
    validateParent(envelopes[0]);
    fits(0, envelopes.length + staged.length);
    if (minimum && (state.blocks[minimum.sequence] !== minimum.id
      || (state.freeze?.nextGeneration ?? generation) < minimum.generationBarrier
      || (minimum.successorId !== undefined && (!state.successor || historySuccessorProposalId(state.successor) !== minimum.successorId))
      || (minimum.agreementView !== undefined && (state.agreement?.report.request.view ?? 0) < minimum.agreementView))) {
      throw new Error('History is behind the external progress anchor');
    }
    // Only unreferenced ciphertext is discarded. Validate the entire retained chain first.
    const retained = new Set([...state.blocks, ...(state.transfer?.blocks ?? [])].map(id => `${id.slice(7)}.block`));
    for (const name of readdirSync(directory)) {
      if ((/^[a-f0-9]{64}\.block$/.test(name) && !retained.has(name)) || /^\.block-[a-f0-9]{32}\.tmp$/.test(name)) {
        rmSync(join(directory, name));
      }
    }
  } catch (error) { storage.close(); throw error; }

  return {
    /** Explicit local activation only. The proof does not certify current network readiness. */
    activateContinuation(value: unknown): HistoryContinuationRoot {
      ensureOpen();
      const root = parseHistoryContinuationRoot(value, context), p = root.proposal, state = storage.read();
      if (state.successor || state.transfer || p.rootId !== rootId || p.generation !== generation
        || p.nextGeneration !== state.freeze?.nextGeneration) throw new Error('Continuation does not match an eligible frozen predecessor');
      assertHistorySuccessorChain(p, state.blocks);
      if (state.activation) {
        if (historyContinuationRootId(state.activation) !== historyContinuationRootId(root)) throw new Error('Another continuation is already activated');
        return structuredClone(state.activation);
      }
      if (ancestryDepth >= 64) throw new Error('History ancestry capacity exceeded');
      const next = { ...state, activation: root };
      if (!validManifest(next)) throw new Error('Invalid outgoing activation manifest');
      storage.write(next); // No child can be opened through this API before durable parent authority.
      return structuredClone(root);
    },
    activatedContinuation(): HistoryContinuationRoot | null { ensureOpen(); return structuredClone(storage.read().activation ?? null); },
    requireContinuation(value: HistoryContinuationRoot, member: string): { depth: number; bytes: number } {
      ensureOpen();
      const root = parseHistoryContinuationRoot(value, context), state = storage.read();
      if (member !== replica || !state.activation || historyContinuationRootId(state.activation) !== historyContinuationRootId(root)) {
        throw new Error('Retained predecessor has not activated this continuation for this replica');
      }
      assertHistorySuccessorChain(root.proposal, state.blocks);
      return { depth: ancestryDepth + 1, bytes: ancestorBytes + blockBytes + 2 * MAX_MANIFEST_BYTES };
    },
    matches(candidate: HistoryCheckpointContext, member: string): boolean {
      ensureOpen();
      return historyCheckpointContextId(candidate) === contextId && member === replica;
    },
    envelopeIdAt(sequence: number): string | null {
      ensureOpen();
      if (!integer(sequence)) throw new Error('Invalid history block sequence');
      return storage.read().blocks[sequence] ?? null;
    },
    describe() {
      ensureOpen();
      const state = storage.read();
      return structuredClone({ generation, rootId, sequence: state.blocks.length - 1,
        envelopeId: state.blocks.at(-1)!, freeze: state.freeze });
    },
    /** Local maintenance approval only; includes promises, staging and activation
     * as well as the visible head. Never publish this as network health. */
    reviewDigest() { ensureOpen(); return historyDigest(JSON.stringify(storage.read())); },
    /** Cached local allocation accounting; excludes provisioner journals and temporary files. */
    storageUsage() {
      ensureOpen();
      return { retainedBlocks: envelopes.length, stagedBlocks: staged.length, retainedCiphertextBytes: blockBytes,
        manifestReserveBytes: 2 * MAX_MANIFEST_BYTES, reservedBytes: blockBytes + 2 * MAX_MANIFEST_BYTES,
        maximumBytes: maxBytes, maximumBlocks: maxBlocks, maximumAncestryBytes: MAX_ANCESTRY_BYTES };
    },
    envelopeAt(sequence: number): HistoryCheckpointEnvelope | null {
      ensureOpen();
      if (!integer(sequence)) throw new Error('Invalid history block sequence');
      return structuredClone(envelopes[sequence] ?? null);
    },
    reservedSuccessor(): HistorySuccessorProposal | null {
      ensureOpen(); return structuredClone(storage.read().successor ?? null);
    },
    agreementState(): HistoryAgreementState | null {
      ensureOpen(); return structuredClone(storage.read().agreement ?? null);
    },
    /** Experimental signed agreement. No response escapes before the manifest is durable. */
    exchangeAgreement(value: unknown, key: SigningKeyPair, now: () => number = Date.now) {
      ensureOpen();
      const frame = parseHistoryAgreementFrame(value, context, now()), request = frame.request, state = storage.read();
      if (state.activation) throw new Error('History already has an activated continuation');
      if (request.replica !== replica || request.rootId !== rootId || request.generation !== generation
        || request.nextGeneration !== state.freeze?.nextGeneration) throw new Error('Agreement does not match frozen store pins');
      if (state.successor) throw new Error('Legacy successor reservation cannot become a provisional vote');
      // A signature never substitutes for possession of every retained ciphertext block.
      if (frame.proposal) assertHistorySuccessorChain(frame.proposal, state.blocks);
      const next = advanceHistoryAgreement(state.agreement ?? null, frame, context, key);
      // A new view can discard only the uncommitted transfer, never accepted blocks or votes.
      const dropTransfer = state.transfer && request.view > state.transfer.authorization.request.view;
      if (state.transfer && !dropTransfer && request.action !== 'promise') throw new Error('History transfer is incomplete');
      storage.write({ ...state, agreement: next.state, ...(dropTransfer ? { transfer: null } : {}) });
      if (dropTransfer) {
        try {
          for (const envelope of staged) { rmSync(blockPath(historyCheckpointEnvelopeId(envelope))); blockBytes -= Buffer.byteLength(JSON.stringify(envelope)); }
          staged = []; flushDirectory(directory);
        } catch (error) { failed = true; throw error; }
      }
      // Expiration during fsync suppresses the response, but never rolls back a durable vote.
      parseHistoryAgreementRequest(request, context, now());
      return structuredClone(next.response);
    },
    /** Head-authenticated backwards transfer. Installation publishes the complete suffix atomically. */
    exchangeAgreementData(value: unknown, key: SigningKeyPair, now: () => number = Date.now) {
      ensureOpen();
      const frame = parseHistoryAgreementDataFrame(value, context, now()), auth = frame.authorization;
      const request = auth.request, proposal = auth.proposal!;
      let state = storage.read();
      if (request.replica !== replica || request.rootId !== rootId || request.generation !== generation
        || request.nextGeneration !== state.freeze?.nextGeneration) throw new Error('Data request does not match frozen store pins');
      let envelope: HistoryCheckpointEnvelope | null = null;
      if (frame.action === 'read') {
        envelope = envelopes[frame.sequence] ?? null; // Staged ciphertext is not accepted history.
        if (!envelope || historyCheckpointEnvelopeId(envelope) !== frame.envelopeId) throw new Error('Requested history block unavailable');
      } else if (frame.action === 'stage') {
        if (state.activation) throw new Error('History already has an activated continuation');
        if (state.successor || !state.agreement || state.agreement.report.request.view !== request.view) throw new Error('Transfer requires the current provisional agreement');
        if (state.blocks.length > proposal.sequence + 1) throw new Error('Replica retains newer history');
        if (state.blocks.length === proposal.sequence + 1) assertHistorySuccessorChain(proposal, state.blocks);
        else {
          if (state.agreement.prepared || state.agreement.confirmed) throw new Error('Transfer cannot extend voted history');
          if (state.transfer && state.transfer.authorization.request.proposalId !== request.proposalId) throw new Error('Another transfer is pending in this view');
          const expectedId = staged.at(-1)?.previous ?? proposal.envelopeId;
          const expectedSequence = proposal.sequence - staged.length;
          if (state.transfer?.blocks.includes(frame.envelopeId)) {
            // Lost acknowledgement: the already durable block needs no rewrite.
          } else {
            if (frame.envelopeId !== expectedId || frame.sequence !== expectedSequence) throw new Error('Transfer does not follow the selected head');
            const incoming = frame.envelope!, descending = [...staged, incoming];
            const complete = incoming.sequence === state.blocks.length;
            if (incoming.sequence < state.blocks.length) throw new Error('Transfer would replace accepted history');
            const ids = descending.map(historyCheckpointEnvelopeId);
            const next: Manifest = complete ? { ...state, blocks: [...state.blocks, ...[...ids].reverse()], transfer: null }
              : { ...state, transfer: { authorization: auth, blocks: ids } };
            if (complete) {
              if (incoming.previous !== state.blocks.at(-1)) throw new Error('Transfer forks from retained history');
              assertHistorySuccessorChain(proposal, next.blocks);
            }
            if (!validManifest(next)) throw new Error('Invalid outgoing transfer manifest');
            fits(Buffer.byteLength(JSON.stringify(incoming)), state.blocks.length + descending.length);
            // Every block is durable before either a staging index or the accepted index names it.
            try {
              const size = writeImmutable(incoming); storage.write(next); blockBytes += size;
              if (complete) { envelopes.push(...[...descending].reverse()); staged = []; } else staged = descending;
            } catch (error) { failed = true; throw error; }
            state = next;
          }
        }
      }
      // The frame was authenticated before this synchronous operation. Recheck expiry,
      // without re-verifying the entire immutable view certificate after every block.
      parseHistoryAgreementRequest(request, context, now());
      const last = staged.at(-1), sameTransfer = state.transfer?.authorization.request.proposalId === request.proposalId;
      return createHistoryAgreementDataResponse(frame, {
        head: { sequence: state.blocks.length - 1, envelopeId: state.blocks.at(-1)! },
        pending: sameTransfer && last ? { sequence: last.sequence - 1, envelopeId: last.previous! } : null, envelope,
      }, key);
    },
    /** Copy accepted historical ciphertext while frozen; never issues an ordinary write receipt. */
    repair(value: unknown, successor: unknown): string {
      ensureOpen();
      const p = parseHistorySuccessorProposal(successor, context), state = storage.read();
      if (state.agreement || state.activation) throw new Error('Legacy repair is disabled after agreement opt-in or activation');
      if (p.rootId !== rootId || p.generation !== generation || state.freeze?.nextGeneration !== p.nextGeneration) {
        throw new Error('Successor repair does not match the frozen generation');
      }
      if (state.successor && historySuccessorProposalId(state.successor) !== historySuccessorProposalId(p)) {
        throw new Error('Another successor is already reserved');
      }
      const block = parseHistoryCheckpointEnvelope(value, context), id = historyCheckpointEnvelopeId(block);
      if (block.generation !== generation || block.sequence > p.sequence
        || (block.sequence === p.sequence && id !== p.envelopeId)) throw new Error('Wrong successor repair block');
      if (state.blocks[block.sequence] === id) return id;
      if (state.successor || block.sequence !== state.blocks.length || block.previous !== state.blocks.at(-1)) {
        throw new Error('Successor repair has a gap, fork or sealed predecessor');
      }
      writeBlock(block); return id;
    },
    /** One irrevocable choice per predecessor. This is a reservation, not activation. */
    seal(successor: unknown): string {
      ensureOpen();
      const p = parseHistorySuccessorProposal(successor, context), state = storage.read(), id = historySuccessorProposalId(p);
      if (state.agreement || state.activation) throw new Error('Legacy sealing is disabled after agreement opt-in or activation');
      if (p.rootId !== rootId || p.generation !== generation || state.freeze?.nextGeneration !== p.nextGeneration) {
        throw new Error('Successor does not match the frozen generation');
      }
      assertHistorySuccessorChain(p, state.blocks);
      if (state.successor) {
        if (historySuccessorProposalId(state.successor) !== id) throw new Error('Another successor is already reserved');
        return id;
      }
      storage.write({ ...state, successor: p });
      return id;
    },
    /** Local durability only. This return value is not a four-volunteer certificate. */
    append(value: unknown): string {
      ensureOpen();
      const state = storage.read();
      if (state.freeze) throw new Error('History generation is frozen');
      const envelope = parseHistoryCheckpointEnvelope(value, context);
      if (envelope.generation !== generation) throw new Error('Wrong history generation');
      const id = historyCheckpointEnvelopeId(envelope);
      if (state.blocks[envelope.sequence] === id) return id;
      if (envelope.sequence !== state.blocks.length || envelope.previous !== state.blocks.at(-1)) {
        throw new Error('History append has a gap, fork or stale predecessor');
      }
      writeBlock(envelope);
      return id;
    },
    /** One-way local barrier; an activated continuation permanently pins its successor. */
    freeze(value: unknown): void {
      ensureOpen();
      const request = parseHistoryFreeze(value, context), state = storage.read();
      if (request.generation !== generation || request.nextGeneration < (state.freeze?.nextGeneration ?? generation)) {
        throw new Error('Stale history generation barrier');
      }
      if (state.successor && request.nextGeneration !== state.successor.nextGeneration) throw new Error('Successor reservation cannot be replaced');
      if (state.agreement && request.nextGeneration !== state.agreement.report.request.nextGeneration) throw new Error('Agreement slot cannot be replaced');
      if (state.activation && request.nextGeneration !== state.activation.generation) throw new Error('Activated continuation cannot be replaced');
      if (request.nextGeneration === state.freeze?.nextGeneration) return;
      storage.write({ ...state, freeze: request });
    },
    read(): { generation: number; freeze: HistoryFreeze | null; envelopes: HistoryCheckpointEnvelope[] } {
      ensureOpen();
      return structuredClone({ generation, freeze: storage.read().freeze, envelopes });
    },
    close(): void { storage.close(); },
  };
}

function flushDirectory(path: string): void {
  // Windows flushes files but cannot fsync directory handles through this API.
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
