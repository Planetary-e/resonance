/** Durable current-generation ciphertext, anchored by the separately locked writer intent. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId, isHistoryDigest,
  parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { HISTORY_RECOVERY_MAX_BLOCKS, HISTORY_RECOVERY_MAX_BYTES } from '@resonance/core/history-exchange';
import type { createHistoryCheckpointWriter } from './history-checkpoint-quorum.js';
import { registerHistoryWriterPrefix } from './history-writer-prefix.js';

export const HISTORY_WRITER_ARCHIVE_FILENAME = 'history-writer-payloads.json';
const MANIFEST_BYTES = 2 * 1024 * 1024;
interface State { version: 1; contextId: string; rootId: string; generation: number; blocks: string[] }

export function openHistoryWriterArchive(options: {
  directory: string; localKey: Uint8Array; context: HistoryCheckpointContext; rootId: string; generation: number;
  readWriter: ReturnType<typeof createHistoryCheckpointWriter>['read']; initialize?: boolean;
  /** Explicitly reviewed retry of first initialization; no committed/pending writer or unknown files. */
  resumePristine?: boolean;
  maxBlocks?: number; maxBytes?: number;
}) {
  const context = parseHistoryCheckpointContext(options.context), contextId = historyCheckpointContextId(context);
  const { directory, rootId, generation } = options;
  const maxBlocks = options.maxBlocks ?? HISTORY_RECOVERY_MAX_BLOCKS, maxBytes = options.maxBytes ?? HISTORY_RECOVERY_MAX_BYTES;
  if (!isHistoryDigest(rootId) || !Number.isSafeInteger(generation) || generation < 0
    || !Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > HISTORY_RECOVERY_MAX_BLOCKS
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HISTORY_RECOVERY_MAX_BYTES) throw new Error('Invalid writer archive bounds or pins');
  const initial: State = { version: 1, contextId, rootId, generation, blocks: [] };
  function writerState() {
    const state = options.readWriter();
    if (state.contextId !== contextId || state.rootId !== rootId || state.generation !== generation) throw new Error('Writer archive belongs to another writer');
    return state;
  }
  function validate(raw: unknown): raw is State {
    return exactWitnessFields(raw, Object.keys(initial)) && raw.version === 1 && raw.contextId === contextId
      && raw.rootId === rootId && raw.generation === generation && Array.isArray(raw.blocks)
      && raw.blocks.length <= maxBlocks && raw.blocks.every(isHistoryDigest) && new Set(raw.blocks).size === raw.blocks.length;
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
    if (block.generation !== generation || block.sequence !== sequence || block.previous !== previous
      || (!sequence && historyCheckpointEnvelopeId(block) !== rootId)) throw new Error('Writer archive has a gap, fork or different root');
  }
  function anchor() {
    const writer = writerState(), ids = storage.read().blocks, count = writer.committed ? writer.committed.envelope.sequence + 1 : 0;
    if (ids.length < count || (count && ids[count - 1] !== historyCheckpointEnvelopeId(writer.committed!.envelope))
      || (ids.length > count && (!writer.pending || ids.length !== count + 1 || ids[count] !== historyCheckpointEnvelopeId(writer.pending)))) {
      throw new Error('Writer archive does not match its committed and pending anchors');
    }
    return writer;
  }
  try {
    const writer = writerState();
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
    const ids = storage.read().blocks;
    for (let i = 0; i < ids.length; i++) {
      const saved = readBlock(ids[i]); consecutive(saved.block, i, i ? ids[i - 1] : null); bytes += saved.bytes;
      if (bytes > maxBytes) throw new Error('Writer archive byte capacity exceeded');
    }
    const current = anchor(), pendingId = current.pending && historyCheckpointEnvelopeId(current.pending);
    const allowed = new Set([...ids, ...(pendingId ? [pendingId] : [])].map(id => `${id.slice(7)}.block`));
    for (const name of readdirSync(directory)) {
      if (/^[a-f0-9]{64}\.block$/.test(name) && !allowed.has(name)) throw new Error('Unregistered writer archive block');
    }
    if (pendingId && !ids.includes(pendingId) && existsSync(path(pendingId))) {
      const saved = readBlock(pendingId); consecutive(saved.block, ids.length, ids.at(-1) ?? null);
      if (ids.length >= maxBlocks || bytes + saved.bytes > maxBytes) throw new Error('Writer archive capacity exceeded');
    }
    // Only after authenticating indexed/pending data may uncommitted temporary files be discarded.
    for (const name of readdirSync(directory)) if (/^\.writer-payload-[a-f0-9]{32}\.tmp$/.test(name)) rmSync(join(directory, name));
  } catch (error) { storage!?.close(); throw error; }
  function open() {
    if (closed || failed) throw new Error('Writer archive closed or write failed; reopen before reuse');
    storage.read();
  }
  function retainPending() {
    open(); const writer = anchor(), pending = writer.pending;
    if (!pending) return;
    const state = storage.read(), id = historyCheckpointEnvelopeId(pending);
    if (state.blocks[pending.sequence] === id) return;
    consecutive(pending, state.blocks.length, state.blocks.at(-1) ?? null);
    const encoded = Buffer.from(JSON.stringify(pending));
    const existing = existsSync(path(id)) ? readBlock(id) : null, size = existing?.bytes ?? encoded.length;
    if (state.blocks.length >= maxBlocks || bytes + size > maxBytes) throw new Error('Writer archive capacity exceeded');
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
      storage.write({ ...state, blocks: [...state.blocks, id] }); bytes += size;
    } catch (error) { failed = true; throw error; }
    finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
  }
  return {
    retainPending,
    read() { open(); anchor(); return { blocks: storage.read().blocks.length, bytes }; },
    /** Cached allocation counters only; no network checks or payload/index copies. */
    usage() { open(); return { retainedBlocks: storage.read().blocks.length, retainedCiphertextBytes: bytes,
      maximumBlocks: maxBlocks, maximumCiphertextBytes: maxBytes }; },
    prefix() {
      open(); anchor();
      const ids = storage.read().blocks; // Snapshot arrays are replaced, never mutated or exposed.
      return registerHistoryWriterPrefix({ contextId, rootId, generation, count: ids.length, bytes,
        idAt(sequence) { open(); return Number.isSafeInteger(sequence) && sequence >= 0 ? ids[sequence] ?? null : null; },
        blockAt(sequence) {
          open(); if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= ids.length) throw new Error('Writer archive sequence unavailable');
          const saved = readBlock(ids[sequence]); consecutive(saved.block, sequence, sequence ? ids[sequence - 1] : null); return saved.block;
        } });
    },
    *blocks(): Generator<HistoryCheckpointEnvelope> {
      open(); anchor(); const ids = storage.read().blocks;
      for (let i = 0; i < ids.length; i++) { open(); const saved = readBlock(ids[i]); consecutive(saved.block, i, i ? ids[i - 1] : null); yield saved.block; }
    },
    close() { if (!closed) { closed = true; storage.close(); } },
  };
}
function flush(directory: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
