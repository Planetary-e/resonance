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
import { parseHistoryCompactionAttestation, parseHistoryCompactionCertificate, type HistoryCompactionCertificate } from '@resonance/core/history-compaction';
import { assertHistoryCompactedSuccessorIds } from '@resonance/core/history-compacted-chain';
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
  /** Absolute sequence slots. Null is permitted only for unavailable intervals
   * below a certified checkpoint; previously accepted local blocks stay indexed. */
  blocks: Array<string | null>; freeze: HistoryFreeze | null;
  /** Missing only in pre-reservation manifests. A sealed successor is never replaced. */
  successor?: HistorySuccessorProposal | null;
  /** Opt-in is atomic with the first promise. Never combined with a legacy reservation. */
  agreement?: HistoryAgreementState | null;
  /** Descending, head-authenticated ciphertext; invisible until it joins the retained prefix. */
  transfer?: { authorization: HistoryAgreementFrame; blocks: string[] } | null;
  /** Irreversible authority for one deterministic child; every predecessor block remains indexed. */
  activation?: HistoryContinuationRoot | null;
  /** Monotone certified checkpoint. Locally accepted prefix bytes are still retained. */
  compaction?: HistoryCompactionCertificate | null;
}
export interface HistoryCheckpointAncestor {
  /** Propagated from the original independently pinned genesis, never from a received certificate. */
  readonly genesisId?: string;
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
  minimum?: { sequence: number; id: string; generationBarrier: number; successorId?: string; agreementView?: number;
    compaction?: { sequence: number; envelopeId: string } };
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
  const genesisId = generation === 0 ? rootId : parent?.genesisId;
  let ancestryDepth = 0;
  let ancestorBytes = 0;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024, maxBlocks = options.maxBlocks ?? MAX_BLOCKS;
  const minimum = options.minimum ? structuredClone(options.minimum) : undefined;
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!context.members.includes(replica) || !isHistoryDigest(rootId) || !integer(generation)
    || !integer(maxBytes) || maxBytes <= 2 * MAX_MANIFEST_BYTES || maxBytes > 256 * 1024 * 1024
    || !integer(maxBlocks) || maxBlocks < 1 || maxBlocks > MAX_BLOCKS
    || (minimum && (!integer(minimum.sequence) || !isHistoryDigest(minimum.id) || !integer(minimum.generationBarrier)
      || (minimum.successorId !== undefined && !isHistoryDigest(minimum.successorId))
      || (minimum.agreementView !== undefined && (!integer(minimum.agreementView) || minimum.agreementView < 1
        || minimum.agreementView > HISTORY_AGREEMENT_MAX_VIEW))
      || (minimum.compaction !== undefined && (!exactWitnessFields(minimum.compaction, ['sequence', 'envelopeId'])
        || !integer(minimum.compaction.sequence) || minimum.compaction.sequence < 1 || !isHistoryDigest(minimum.compaction.envelopeId)))))) {
    throw new Error('Invalid history store pins or capacity');
  }
  const initial: Manifest = { version: 1, contextId, replica, rootId, generation, blocks: [], freeze: null, successor: null };
  function assertStoreChain(proposal: HistorySuccessorProposal, state: Manifest) {
    if (!state.blocks.includes(null)) { assertHistorySuccessorChain(proposal, state.blocks as string[]); return; }
    if (!state.compaction || !genesisId) throw new Error('History gap needs its independently pinned checkpoint proof');
    const start = state.compaction.proposal.sequence;
    assertHistoryCompactedSuccessorIds({ proposal, ids: state.blocks.slice(start) as string[],
      certificate: state.compaction, context, genesisId });
    // Retained earlier evidence can still detect a conflict; never discard that comparison.
    if (proposal.freezes.some(r => state.blocks[r.head.sequence] !== null && state.blocks[r.head.sequence] !== r.head.envelopeId)) {
      throw new Error('Compacted transfer conflicts with retained frozen history');
    }
  }
  function validManifest(value: unknown): value is Manifest {
    // This intermediate manifest can only exist inside the provisioner's unpublished directory.
    if (preparing && JSON.stringify(value) === JSON.stringify(initial)) return true;
    const optional = ['successor', 'agreement', 'transfer', 'activation', 'compaction'].filter(key => value !== null && typeof value === 'object' && Object.hasOwn(value, key));
    if (!exactWitnessFields(value, ['version', 'contextId', 'replica', 'rootId', 'generation', 'blocks', 'freeze', ...optional])
      || value.version !== 1 || value.contextId !== contextId || value.replica !== replica || value.rootId !== rootId
      || value.generation !== generation || !Array.isArray(value.blocks) || !value.blocks.length
      || value.blocks.length > maxBlocks || !value.blocks.every(id => id === null || isHistoryDigest(id))
      || value.blocks[0] !== rootId || !isHistoryDigest(value.blocks.at(-1))
      || new Set(value.blocks.filter(id => id !== null)).size !== value.blocks.filter(id => id !== null).length) return false;
    if (value.compaction !== undefined && value.compaction !== null) {
      try {
        if (!genesisId) return false;
        const p = parseHistoryCompactionAttestation(value.compaction, context, genesisId).proposal;
        if (p.rootId !== rootId || p.generation !== generation || value.blocks[p.sequence] !== p.envelopeId
          || value.blocks.slice(p.sequence).includes(null)) return false;
        // A later certified full-state checkpoint covers earlier unavailable
        // intervals too. All locally accepted segments remain indexed, and the
        // complete suffix from this latest anchor must remain contiguous.
      } catch { return false; }
    } else if (value.blocks.includes(null)) return false;
    if (value.freeze !== null) {
      try { if (parseHistoryFreeze(value.freeze, context).generation !== generation) return false; }
      catch { return false; }
    }
    if (value.successor !== undefined && value.successor !== null) {
      try {
        const p = parseHistorySuccessorProposal(value.successor, context);
        if (p.rootId !== rootId || p.generation !== generation || !value.freeze
          || p.nextGeneration !== parseHistoryFreeze(value.freeze, context).nextGeneration) return false;
        assertStoreChain(p, value as unknown as Manifest);
      } catch { return false; }
    }
    if (value.agreement !== undefined && value.agreement !== null) {
      try {
        const agreement = parseHistoryAgreementState(value.agreement, context, replica), r = agreement.report.request;
        if (value.successor || r.rootId !== rootId || r.generation !== generation || !value.freeze
          || r.nextGeneration !== parseHistoryFreeze(value.freeze, context).nextGeneration) return false;
        for (const record of [agreement.prepared, agreement.confirmed]) {
          if (record) assertStoreChain(record.frame.proposal!, value as unknown as Manifest);
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
          || new Set([...value.blocks.filter(id => id !== null), ...ids]).size !== value.blocks.filter(id => id !== null).length + ids.length
          || value.blocks.length + ids.length > maxBlocks) return false;
      } catch { return false; }
    }
    if (value.activation !== undefined && value.activation !== null) {
      try {
        const root = parseHistoryContinuationRoot(value.activation, context), p = root.proposal;
        if (value.successor || value.transfer || p.rootId !== rootId || p.generation !== generation
          || !value.freeze || p.nextGeneration !== parseHistoryFreeze(value.freeze, context).nextGeneration) return false;
        assertStoreChain(p, value as unknown as Manifest);
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
  const envelopes: Array<HistoryCheckpointEnvelope | null> = [];
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
  function prefixRetirement() {
    ensureOpen(); const state = storage.read(), proof = state.compaction;
    if (!proof || !genesisId) throw new Error('Prefix retirement requires a durably retained checkpoint certificate');
    parseHistoryCompactionCertificate(proof, context, genesisId, envelopes[proof.proposal.sequence]);
    const boundary = proof.proposal.sequence;
    const removed = state.blocks.slice(1, boundary).flatMap((id, offset) => {
      if (id === null) return [];
      const stat = lstatSync(blockPath(id));
      if (!stat.isFile() || stat.size <= 0 || stat.size > HISTORY_ENVELOPE_MAX_BYTES) throw new Error('Invalid retiring history payload');
      return [{ sequence: offset + 1, id, bytes: stat.size }];
    });
    const bytesReclaimed = removed.reduce((sum, block) => sum + block.bytes, 0);
    if (bytesReclaimed > blockBytes) throw new Error('Retiring history exceeds retained accounting');
    const plan = { kind: 'history-replica-prefix-retirement' as const, contextId, rootId, generation,
      checkpointSequence: boundary, checkpointId: proof.proposal.envelopeId, headSequence: state.blocks.length - 1,
      headId: state.blocks.at(-1)!, filesRemoved: removed.length, bytesReclaimed,
      approvalDigest: historyDigest(`resonance:history-replica-prefix-retirement:v1\n${JSON.stringify([directory, state, removed])}`),
      notice: 'Retires ciphertext strictly before the certified checkpoint, preserving the root, suffix and all barriers. Storage promises and sequence limits remain unchanged.' };
    return { state, removed, plan };
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
        if (id === null) { envelopes.push(null); continue; }
        const envelope = loadBlock(id);
        if (sequence === 0) validateParent(envelope);
        const previous = sequence ? state.blocks[sequence - 1] : null;
        const certifiedGap = sequence > 0 && previous === null && !!state.compaction
          && sequence <= state.compaction.proposal.sequence;
        if (envelope.sequence !== sequence || (certifiedGap ? envelope.kind !== 'checkpoint' : envelope.previous !== previous)) {
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
    validateParent(envelopes[0]!);
    if (state.compaction) parseHistoryCompactionCertificate(state.compaction, context, genesisId!, envelopes[state.compaction.proposal.sequence]);
    fits(0, envelopes.length + staged.length);
    if (minimum && (state.blocks[minimum.sequence] !== minimum.id
      || (state.freeze?.nextGeneration ?? generation) < minimum.generationBarrier
      || (minimum.successorId !== undefined && (!state.successor || historySuccessorProposalId(state.successor) !== minimum.successorId))
      || (minimum.agreementView !== undefined && (state.agreement?.report.request.view ?? 0) < minimum.agreementView)
      || (minimum.compaction && (!state.compaction || state.compaction.proposal.sequence < minimum.compaction.sequence
        || state.blocks[minimum.compaction.sequence] !== minimum.compaction.envelopeId)))) {
      throw new Error('History is behind the external progress anchor');
    }
    // Only unreferenced ciphertext is discarded. Validate the entire retained chain first.
    const retained = new Set([...state.blocks, ...(state.transfer?.blocks ?? [])].filter((id): id is string => id !== null).map(id => `${id.slice(7)}.block`));
    let cleaned = false;
    for (const name of readdirSync(directory)) {
      if ((/^[a-f0-9]{64}\.block$/.test(name) && !retained.has(name)) || /^\.block-[a-f0-9]{32}\.tmp$/.test(name)) {
        rmSync(join(directory, name)); cleaned = true;
      }
    }
    if (cleaned) flushDirectory(directory);
  } catch (error) { storage.close(); throw error; }

  return {
    get genesisId(): string | undefined { ensureOpen(); return genesisId; },
    /** Explicit local maintenance. Commits proof with the authoritative manifest;
     * keeps every ciphertext block, reservation, suffix and generation barrier. */
    retainCompactionAnchor(value: unknown, approvedReviewDigest: string): HistoryCompactionCertificate {
      ensureOpen();
      if (!genesisId) throw new Error('Compaction anchor needs its independently retained genesis');
      const evidence = parseHistoryCompactionAttestation(value, context, genesisId), p = evidence.proposal, state = storage.read();
      if (p.rootId !== rootId || p.generation !== generation || state.blocks[p.sequence] !== p.envelopeId) {
        throw new Error('Compaction anchor does not match retained history');
      }
      const certificate = parseHistoryCompactionCertificate(evidence, context, genesisId, envelopes[p.sequence]);
      // Exact-anchor retry may report historical success after a later freeze;
      // it neither replaces proof nor needs another manifest write.
      if (state.compaction?.proposal.sequence === p.sequence && state.compaction.proposal.envelopeId === p.envelopeId) {
        return structuredClone(state.compaction);
      }
      if (state.compaction && state.compaction.proposal.sequence > p.sequence) throw new Error('Compaction anchor cannot regress');
      if (approvedReviewDigest !== historyDigest(JSON.stringify(state))) throw new Error('Compaction anchor needs current local review');
      if (state.freeze || state.agreement || state.transfer || state.successor || state.activation) throw new Error('Frozen or committed generation cannot advance its compaction anchor');
      const next: Manifest = { ...state, compaction: certificate };
      if (!validManifest(next)) throw new Error('Invalid outgoing compaction anchor');
      storage.write(next);
      return structuredClone(certificate);
    },
    compactionAnchor(): HistoryCompactionCertificate | null { ensureOpen(); return structuredClone(storage.read().compaction ?? null); },
    planPrefixRetirement() { return prefixRetirement().plan; },
    /** Commit the authoritative boundary before unlinking redundant payloads.
     * Reopen resumes cleanup; no accepted suffix or durable barrier is removed. */
    retirePrefix(approvedDigest: string) {
      const { state, removed, plan } = prefixRetirement();
      if (approvedDigest !== plan.approvalDigest) throw new Error('History prefix changed; review retirement again');
      if (!removed.length) return plan;
      const blocks = [...state.blocks]; for (const block of removed) blocks[block.sequence] = null;
      const next = { ...state, blocks };
      if (!validManifest(next)) throw new Error('Invalid outgoing prefix retirement boundary');
      try {
        storage.write(next); // Only the durable manifest makes these files unnecessary.
        for (const block of removed) { envelopes[block.sequence] = null; rmSync(blockPath(block.id)); }
        flushDirectory(directory); blockBytes -= plan.bytesReclaimed;
      } catch (error) { failed = true; throw error; }
      return plan;
    },
    /** Install a certified full-state checkpoint on an unfrozen lagging member.
     * Preserves every accepted local block; this is not a fresh writer receipt. */
    installCheckpoint(value: unknown, proof: unknown, approvedReviewDigest: string): string {
      ensureOpen();
      if (!genesisId) throw new Error('Checkpoint installation needs its independently retained genesis');
      const block = parseHistoryCheckpointEnvelope(value, context), id = historyCheckpointEnvelopeId(block);
      const certificate = parseHistoryCompactionCertificate(proof, context, genesisId, block), p = certificate.proposal;
      const state = storage.read(), head = state.blocks.length - 1;
      if (p.rootId !== rootId || p.generation !== generation) throw new Error('Checkpoint installation belongs to another generation');
      if (state.freeze || state.agreement || state.transfer || state.successor || state.activation) {
        throw new Error('Frozen or committed generation cannot install a checkpoint');
      }
      if (block.sequence < head || (block.sequence === head && state.blocks[head] !== id)) {
        throw new Error('Checkpoint installation cannot replace accepted history');
      }
      if (state.compaction && state.compaction.proposal.sequence > block.sequence) throw new Error('Compaction anchor cannot regress');
      if (block.sequence === head && state.compaction?.proposal.envelopeId === id) return id;
      if (approvedReviewDigest !== historyDigest(JSON.stringify(state))) throw new Error('Checkpoint installation needs current local review');
      if (block.sequence === head + 1 && block.previous !== state.blocks[head]) throw new Error('Checkpoint installation conflicts with retained predecessor');
      // Bound the allocation before constructing absolute missing slots. A
      // valid owner signature alone does not make an arbitrarily large index safe.
      if (block.sequence >= maxBlocks) throw new Error('History storage capacity exceeded');
      const missing = block.sequence - head - 1;
      const next: Manifest = { ...state, compaction: certificate, blocks: block.sequence === head ? state.blocks
        : [...state.blocks, ...Array<string | null>(missing).fill(null), id] };
      fits(block.sequence === head ? 0 : Buffer.byteLength(JSON.stringify(block)), next.blocks.length);
      if (!validManifest(next)) throw new Error('Invalid outgoing checkpoint installation');
      try {
        const bytes = block.sequence === head ? 0 : writeImmutable(block);
        storage.write(next);
        if (block.sequence !== head) { blockBytes += bytes; envelopes.push(...Array<null>(missing).fill(null), block); }
      } catch (error) { failed = true; throw error; }
      return id;
    },
    /** Explicit local activation only. The proof does not certify current network readiness. */
    activateContinuation(value: unknown): HistoryContinuationRoot {
      ensureOpen();
      const root = parseHistoryContinuationRoot(value, context), p = root.proposal, state = storage.read();
      if (state.successor || state.transfer || p.rootId !== rootId || p.generation !== generation
        || p.nextGeneration !== state.freeze?.nextGeneration) throw new Error('Continuation does not match an eligible frozen predecessor');
      assertStoreChain(p, state);
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
      assertStoreChain(root.proposal, state);
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
      return { retainedBlocks: envelopes.filter(Boolean).length, stagedBlocks: staged.length, retainedCiphertextBytes: blockBytes,
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
      if (frame.proposal) assertStoreChain(frame.proposal, state);
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
      const frame = parseHistoryAgreementDataFrame(value, context, now(), genesisId), auth = frame.authorization;
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
        if (state.blocks.length === proposal.sequence + 1) assertStoreChain(proposal, state);
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
            const jump = frame.compaction && incoming.sequence > state.blocks.length;
            const complete = !!jump || incoming.sequence === state.blocks.length;
            if (incoming.sequence < state.blocks.length) throw new Error('Transfer would replace accepted history');
            if (frame.compaction && state.compaction && frame.compaction.proposal.sequence < state.compaction.proposal.sequence) {
              throw new Error('Compacted transfer would regress the retained checkpoint');
            }
            const ids = descending.map(historyCheckpointEnvelopeId);
            const gap: null[] = jump ? Array.from({ length: incoming.sequence - state.blocks.length }, () => null) : [];
            const next: Manifest = complete ? { ...state, blocks: [...state.blocks, ...gap, ...[...ids].reverse()], transfer: null,
              ...(frame.compaction ? { compaction: frame.compaction } : {}) }
              : { ...state, transfer: { authorization: auth, blocks: ids } };
            if (complete) {
              if (!jump && incoming.previous !== state.blocks.at(-1)) throw new Error('Transfer forks from retained history');
              assertStoreChain(proposal, next);
            }
            if (!validManifest(next)) throw new Error('Invalid outgoing transfer manifest');
            fits(Buffer.byteLength(JSON.stringify(incoming)), state.blocks.length + descending.length);
            // Every block is durable before either a staging index or the accepted index names it.
            try {
              const size = writeImmutable(incoming); storage.write(next); blockBytes += size;
              if (complete) { envelopes.push(...gap, ...[...descending].reverse()); staged = []; } else staged = descending;
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
      assertStoreChain(p, state);
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
    read(): { generation: number; freeze: HistoryFreeze | null; envelopes: HistoryCheckpointEnvelope[]; compaction?: HistoryCompactionCertificate } {
      ensureOpen();
      const state = storage.read();
      return structuredClone({ generation, freeze: state.freeze, envelopes: envelopes.filter((b): b is HistoryCheckpointEnvelope => b !== null),
        ...(state.blocks.includes(null) ? { compaction: state.compaction! } : {}) });
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
