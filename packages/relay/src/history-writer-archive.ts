/** Durable current-generation ciphertext, anchored by the separately locked writer intent. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest,
  parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { HISTORY_RECOVERY_MAX_BLOCKS, HISTORY_RECOVERY_MAX_BYTES } from '@resonance/core/history-exchange';
import type { createHistoryCheckpointWriter } from './history-checkpoint-quorum.js';
import { reserveHistoryStorage } from './history-storage-reservation.js';
import { registerHistoryWriterPrefix } from './history-writer-prefix.js';
import { readHistorySequenceIndex, type StoredHistorySequenceIndex } from './history-sequence-index.js';
import { parseHistoryCompactionAttestation, parseHistoryCompactionCertificate, type HistoryCompactionCertificate } from '@resonance/core/history-compaction';

export const HISTORY_WRITER_ARCHIVE_FILENAME = 'history-writer-payloads.json';
const MANIFEST_BYTES = 2 * 1024 * 1024;
interface State { version: 1; contextId: string; rootId: string; generation: number; blocks: StoredHistorySequenceIndex; compaction?: HistoryCompactionCertificate }

export function openHistoryWriterArchive(options: {
  directory: string; localKey: Uint8Array; context: HistoryCheckpointContext; rootId: string; generation: number;
  readWriter: ReturnType<typeof createHistoryCheckpointWriter>['read']; initialize?: boolean;
  /** Explicitly reviewed retry of first initialization; no committed/pending writer or unknown files. */
  resumePristine?: boolean;
  maxBlocks?: number; maxBytes?: number;
  /** Original independently pinned genesis is required for certified repair in later generations. */
  genesisId?: string;
}) {
  const context = parseHistoryCheckpointContext(options.context), contextId = historyCheckpointContextId(context);
  const { directory, rootId, generation } = options;
  const genesisId = generation === 0 ? rootId : options.genesisId;
  const maxBlocks = options.maxBlocks ?? HISTORY_RECOVERY_MAX_BLOCKS, maxBytes = options.maxBytes ?? HISTORY_RECOVERY_MAX_BYTES;
  if (!isHistoryDigest(rootId) || !Number.isSafeInteger(generation) || generation < 0
    || (options.genesisId !== undefined && (!isHistoryDigest(options.genesisId) || generation === 0 && options.genesisId !== rootId))
    || !Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > HISTORY_RECOVERY_MAX_BLOCKS
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HISTORY_RECOVERY_MAX_BYTES) throw new Error('Invalid writer archive bounds or pins');
  const initial: State = { version: 1, contextId, rootId, generation, blocks: [] };
  const index = (state: State) => readHistorySequenceIndex(state.blocks, maxBlocks);
  function writerState() {
    const state = options.readWriter();
    if (state.contextId !== contextId || state.rootId !== rootId || state.generation !== generation) throw new Error('Writer archive belongs to another writer');
    return state;
  }
  function validate(raw: unknown): raw is State {
    const compacted = !!raw && typeof raw === 'object' && Object.hasOwn(raw, 'compaction');
    if (!exactWitnessFields(raw, [...Object.keys(initial), ...(compacted ? ['compaction'] : [])]) || raw.version !== 1 || raw.contextId !== contextId
      || raw.rootId !== rootId || raw.generation !== generation) return false;
    try {
      const ids = index(raw as unknown as State);
      if (ids.count && ids.get(0) !== rootId) return false;
      if (compacted) {
        const p = parseHistoryCompactionAttestation(raw.compaction, context, genesisId!).proposal;
        if (p.rootId !== rootId || p.generation !== generation || ids.get(p.sequence) !== p.envelopeId) return false;
        ids.suffix(p.sequence);
      } else if (ids.hasGaps) return false;
      return true;
    } catch { return false; }
  }
  const path = (id: string) => join(directory, `${id.slice(7)}.block`);
  let storage: ReturnType<typeof openEncryptedLocalState<State>>, bytes = 0, closed = false, failed = false;
  function readBlock(id: string) {
    const file = path(id), stat = lstatSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > HISTORY_ENVELOPE_MAX_BYTES) throw new Error('Invalid writer archive block size/type');
    const encoded = readFileSync(file);
    if (encoded.length !== stat.size) throw new Error('Writer archive block changed during read');
    const block = parseHistoryCheckpointEnvelope(JSON.parse(encoded.toString('utf8')), context);
    if (historyCheckpointEnvelopeId(block) !== id) throw new Error('Writer archive block digest mismatch');
    return { block, bytes: encoded.length };
  }
  function consecutive(block: HistoryCheckpointEnvelope, sequence: number, previous: string | null) {
    const certifiedGap = sequence > 0 && previous === null && sequence <= (storage.read().compaction?.proposal.sequence ?? 0);
    if (block.generation !== generation || block.sequence !== sequence || (certifiedGap ? block.kind !== 'checkpoint' : block.previous !== previous)
      || (!sequence && historyCheckpointEnvelopeId(block) !== rootId)) throw new Error('Writer archive has a gap, fork or different root');
  }
  function anchor() {
    const writer = writerState(), ids = index(storage.read()), committed = writer.committed?.envelope.sequence ?? -1;
    if (ids.headSequence < committed || (writer.committed && ids.get(committed) !== historyCheckpointEnvelopeId(writer.committed.envelope))
      || (ids.headSequence > committed && (!writer.pending || ids.headSequence !== committed + 1
        || ids.headId !== historyCheckpointEnvelopeId(writer.pending)))) {
      throw new Error('Writer archive does not match its committed and pending anchors');
    }
    return writer;
  }
  let reservation: ReturnType<typeof reserveHistoryStorage>;
  try {
    const writer = writerState();
    reservation = reserveHistoryStorage({ directory, component: 'history-writer-ciphertext', ciphertextBytes: maxBytes,
      manifestFilename: HISTORY_WRITER_ARCHIVE_FILENAME, manifestBytes: MANIFEST_BYTES });
    if (options.initialize) {
      if (writer.committed) throw new Error('Cannot initialize an archive for an already committed writer');
      if (existsSync(directory)) {
        const entries = readdirSync(directory);
        const initialTemporary = (name: string) => name === `${HISTORY_WRITER_ARCHIVE_FILENAME}.lock`
          || /^\.history-writer-payloads\.json\.[a-f0-9]{16}\.tmp$/.test(name);
        if (entries.length && (!options.resumePristine || writer.pending
          || entries.some(name => !initialTemporary(name) || !lstatSync(join(directory, name)).isFile()))) {
          throw new Error('Writer archive directory is not empty');
        }
        // The encrypted-state lock still refuses live/uncertain ownership. Only
        // that lock owner may remove recognized unpublished encrypted snapshots.
      }
      if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
      flush(dirname(directory));
    }
    if (!lstatSync(directory).isDirectory()) throw new Error('Writer archive needs a real directory');
    storage = openEncryptedLocalState<State>({ path: join(directory, HISTORY_WRITER_ARCHIVE_FILENAME), key: options.localKey,
      domain: 'resonance:history-writer-archive:v1', maxBytes: MANIFEST_BYTES, initial, validate,
      mode: options.initialize ? 'create-new' : 'open-existing' });
    const ids = index(storage.read());
    for (const [sequence, id] of ids.records) {
      const saved = readBlock(id); consecutive(saved.block, sequence, ids.get(sequence - 1)); bytes += saved.bytes;
      if (bytes > maxBytes) throw new Error('Writer archive byte capacity exceeded');
    }
    const proof = storage.read().compaction;
    if (proof) parseHistoryCompactionCertificate(proof, context, genesisId!, readBlock(proof.proposal.envelopeId).block);
    const current = anchor(), pendingId = current.pending && historyCheckpointEnvelopeId(current.pending);
    const allowed = new Set([...ids.records.map(([, id]) => id), ...(pendingId ? [pendingId] : [])].map(id => `${id.slice(7)}.block`));
    for (const name of readdirSync(directory)) {
      if (/^[a-f0-9]{64}\.block$/.test(name) && !allowed.has(name)) {
        // Only a validated owner-signed block in a committed retired slot may
        // be cleaned after a crash; arbitrary extra payloads still fail closed.
        const extra = readBlock(`sha256:${name.slice(0, -6)}`).block;
        if (extra.generation !== generation || extra.sequence === 0 || ids.get(extra.sequence) !== null
          || extra.sequence >= (proof?.proposal.sequence ?? 0)) throw new Error('Unregistered writer archive block');
      }
    }
    if (pendingId && ids.get(current.pending!.sequence) !== pendingId && existsSync(path(pendingId))) {
      const saved = readBlock(pendingId); consecutive(saved.block, ids.headSequence + 1, ids.headId);
      if (ids.count >= maxBlocks || bytes + saved.bytes > maxBytes) throw new Error('Writer archive capacity exceeded');
    }
    // Only after authenticating indexed/pending data may uncommitted temporary files be discarded.
    let cleaned = false;
    for (const name of readdirSync(directory)) {
      if (/^\.writer-payload-[a-f0-9]{32}\.tmp$/.test(name) || /^[a-f0-9]{64}\.block$/.test(name) && !allowed.has(name)) {
        rmSync(join(directory, name)); cleaned = true;
      }
    }
    if (cleaned) flush(directory);
  } catch (error) { storage!?.close(); throw error; }
  function open() {
    if (closed || failed) throw new Error('Writer archive closed or write failed; reopen before reuse');
    reservation.assertWritable(); storage.read();
  }
  function retainPending() {
    open(); const writer = anchor(), pending = writer.pending;
    if (!pending) return;
    const state = storage.read(), ids = index(state), id = historyCheckpointEnvelopeId(pending);
    if (ids.get(pending.sequence) === id) return;
    consecutive(pending, ids.headSequence + 1, ids.headId);
    const encoded = Buffer.from(JSON.stringify(pending));
    const existing = existsSync(path(id)) ? readBlock(id) : null, size = existing?.bytes ?? encoded.length;
    if (ids.count >= maxBlocks || bytes + size > maxBytes) throw new Error('Writer archive capacity exceeded');
    const next = { ...state, blocks: ids.extend(pending.sequence, id) };
    if (!validate(next)) throw new Error('Invalid outgoing writer archive index');
    let fd: number | undefined;
    const temporary = join(directory, `.writer-payload-${randomBytes(16).toString('hex')}.tmp`);
    try {
      if (!existing) {
        fd = openSync(temporary, 'wx', 0o600); let offset = 0;
        while (offset < encoded.length) {
          const count = writeSync(fd, encoded, offset, encoded.length - offset);
          if (count <= 0) throw new Error('Incomplete writer archive write'); offset += count;
        }
        fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, path(id)); flush(directory);
      }
      storage.write(next); bytes += size;
    } catch (error) { failed = true; throw error; }
    finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
  }
  function prefixRetirement() {
    open(); const writer = anchor(), state = storage.read(), proof = state.compaction, ids = index(state);
    if (!proof) throw new Error('Writer prefix retirement requires its durably retained checkpoint proof');
    if (writer.pending) throw new Error('Complete the pending history write before retiring its prefix');
    parseHistoryCompactionCertificate(proof, context, genesisId!, readBlock(proof.proposal.envelopeId).block);
    const removed = ids.records.filter(([sequence]) => sequence > 0 && sequence < proof.proposal.sequence).map(([sequence, id]) => {
      const saved = readBlock(id); consecutive(saved.block, sequence, ids.get(sequence - 1));
      return { sequence, id, bytes: saved.bytes };
    });
    const bytesReclaimed = removed.reduce((sum, block) => sum + block.bytes, 0);
    if (bytesReclaimed > bytes) throw new Error('Retiring writer history exceeds retained accounting');
    return { state, removed, plan: { kind: 'history-writer-prefix-retirement' as const, contextId, rootId, generation,
      checkpointSequence: proof.proposal.sequence, checkpointId: proof.proposal.envelopeId,
      headSequence: ids.headSequence, headId: ids.headId!, filesRemoved: removed.length, bytesReclaimed,
      approvalDigest: historyDigest(`resonance:history-writer-prefix-retirement:v1\n${JSON.stringify([directory, state, writer, removed])}`),
      notice: 'Retires ciphertext strictly before the certified checkpoint, preserving the root and committed suffix. Storage promises and sequence limits remain unchanged.' } };
  }
  return {
    retainPending,
    /** Local proof publication changes repair strategy only; all accepted bytes remain retained. */
    retainCompactionAnchor(value: unknown, approvedDigest: string): HistoryCompactionCertificate {
      open(); const writer = anchor(), state = storage.read(), ids = index(state);
      const proof = parseHistoryCompactionAttestation(value, context, genesisId!), p = proof.proposal;
      if (writer.pending || !writer.committed || p.rootId !== rootId || p.generation !== generation
        || p.sequence > writer.committed.envelope.sequence || ids.get(p.sequence) !== p.envelopeId) {
        throw new Error('Writer checkpoint proof must match committed retained history without pending work');
      }
      parseHistoryCompactionCertificate(proof, context, genesisId!, readBlock(p.envelopeId).block);
      if (state.compaction?.proposal.envelopeId === p.envelopeId) return structuredClone(state.compaction);
      if (state.compaction && state.compaction.proposal.sequence > p.sequence) throw new Error('Writer checkpoint proof cannot regress');
      if (approvedDigest !== historyDigest(JSON.stringify([state, writer]))) throw new Error('Writer checkpoint proof needs current local review');
      storage.write({ ...state, compaction: proof }); return structuredClone(proof);
    },
    reviewDigest() { open(); return historyDigest(JSON.stringify([storage.read(), anchor()])); },
    compactionAnchor() { open(); anchor(); return structuredClone(storage.read().compaction ?? null); },
    planPrefixRetirement() { return prefixRetirement().plan; },
    retirePrefix(approvedDigest: string) {
      const { state, removed, plan } = prefixRetirement();
      if (approvedDigest !== plan.approvalDigest) throw new Error('Writer prefix changed; review retirement again');
      if (!removed.length) return plan;
      const blocks = index(state).retireBefore(state.compaction!.proposal.sequence);
      const next = { ...state, blocks }; if (!validate(next)) throw new Error('Invalid outgoing writer prefix boundary');
      try {
        storage.write(next);
        for (const block of removed) rmSync(path(block.id));
        flush(directory); bytes -= plan.bytesReclaimed;
      } catch (error) { failed = true; throw error; }
      return plan;
    },
    read() { open(); anchor(); const ids = index(storage.read()); return { blocks: ids.count, sequenceSlots: ids.headSequence + 1, bytes }; },
    /** Cached allocation counters only; no network checks or payload/index copies. */
    usage() { open(); return { retainedBlocks: index(storage.read()).count, retainedCiphertextBytes: bytes,
      maximumBlocks: maxBlocks, maximumCiphertextBytes: maxBytes }; },
    prefix() {
      open(); anchor();
      const state = storage.read(), ids = index(state);
      return registerHistoryWriterPrefix({ contextId, rootId, generation, count: ids.headSequence + 1, retainedCount: ids.count, bytes,
        ...(state.compaction ? { compaction: { genesisId: genesisId!, certificate: structuredClone(state.compaction) } } : {}),
        idAt(sequence) { open(); return ids.get(sequence); },
        blockAt(sequence) {
          open(); if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > ids.headSequence) throw new Error('Writer archive sequence unavailable');
          const id = ids.get(sequence); if (id === null) throw new Error('Writer archive sequence retired');
          const saved = readBlock(id); consecutive(saved.block, sequence, ids.get(sequence - 1)); return saved.block;
        } });
    },
    *blocks(): Generator<HistoryCheckpointEnvelope> {
      open(); anchor(); const ids = index(storage.read());
      for (const [sequence, id] of ids.records) {
        open(); const saved = readBlock(id); consecutive(saved.block, sequence, ids.get(sequence - 1)); yield saved.block;
      }
    },
    close() { if (!closed) { closed = true; storage.close(); } },
  };
}
function flush(directory: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
