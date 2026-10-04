/** Experimental single-volunteer storage. No quorum receipt, network endpoint or restore command. */
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import {
  HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId,
  isHistoryDigest, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, parseHistoryFreeze,
  type HistoryCheckpointContext, type HistoryCheckpointEnvelope, type HistoryFreeze,
} from '@resonance/core/history-checkpoint';

export const HISTORY_MANIFEST_FILENAME = 'history-manifest.json';
const DOMAIN = 'resonance:history-replica-manifest:v1';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_BLOCKS = 10_001;
interface Manifest {
  version: 1; contextId: string; replica: string; rootId: string; generation: number;
  blocks: string[]; freeze: HistoryFreeze | null;
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
  /** Includes two maximum manifest copies plus all immutable encrypted blocks. */
  maxBytes?: number;
  maxBlocks?: number;
  /** Optional external progress anchor; complete rollback without one remains undetectable. */
  minimum?: { sequence: number; id: string; generationBarrier: number };
}

export function openHistoryCheckpointStore(options: HistoryCheckpointStoreOptions) {
  const context = parseHistoryCheckpointContext(options.context);
  const contextId = historyCheckpointContextId(context);
  const { directory, replica, rootId, generation } = options;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024, maxBlocks = options.maxBlocks ?? MAX_BLOCKS;
  const minimum = options.minimum ? { ...options.minimum } : undefined;
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!context.members.includes(replica) || !isHistoryDigest(rootId) || !integer(generation)
    || !integer(maxBytes) || maxBytes <= 2 * MAX_MANIFEST_BYTES || maxBytes > 256 * 1024 * 1024
    || !integer(maxBlocks) || maxBlocks < 1 || maxBlocks > MAX_BLOCKS
    || (minimum && (!integer(minimum.sequence) || !isHistoryDigest(minimum.id) || !integer(minimum.generationBarrier)))) {
    throw new Error('Invalid history store pins or capacity');
  }
  const initial: Manifest = { version: 1, contextId, replica, rootId, generation, blocks: [], freeze: null };
  function validManifest(value: unknown): value is Manifest {
    if (!exactWitnessFields(value, ['version', 'contextId', 'replica', 'rootId', 'generation', 'blocks', 'freeze'])
      || value.version !== 1 || value.contextId !== contextId || value.replica !== replica || value.rootId !== rootId
      || value.generation !== generation || !Array.isArray(value.blocks) || !value.blocks.length
      || value.blocks.length > maxBlocks || !value.blocks.every(isHistoryDigest)
      || value.blocks[0] !== rootId || new Set(value.blocks).size !== value.blocks.length) return false;
    if (value.freeze !== null) {
      try { if (parseHistoryFreeze(value.freeze, context).generation !== generation) return false; }
      catch { return false; }
    }
    return true;
  }
  let root: HistoryCheckpointEnvelope | undefined;
  if (options.initialize) {
    root = parseHistoryCheckpointEnvelope(options.initialize, context);
    if (root.sequence !== 0 || root.generation !== generation || historyCheckpointEnvelopeId(root) !== rootId) {
      throw new Error('History enrolment checkpoint does not match pins');
    }
    // Never reinterpret an incomplete or damaged directory as a new history.
    if (existsSync(directory) && readdirSync(directory).length) throw new Error('History enrolment directory is not empty');
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    flushDirectory(dirname(directory));
  }
  const storage = openEncryptedLocalState<Manifest>({
    path: join(directory, HISTORY_MANIFEST_FILENAME), key: options.localKey, domain: DOMAIN,
    maxBytes: MAX_MANIFEST_BYTES, mode: root ? 'create-new' : 'open-existing', initial, validate: validManifest,
  });
  let failed = false;
  let blockBytes = 0;
  const envelopes: HistoryCheckpointEnvelope[] = [];
  const blockPath = (id: string) => join(directory, `${id.slice(7)}.block`);
  function ensureOpen() {
    storage.read();
    if (failed) throw new Error('History storage write failed; close and reopen before reuse');
  }
  function fits(bytes: number, count: number) {
    if (count > maxBlocks || blockBytes + bytes + 2 * MAX_MANIFEST_BYTES > maxBytes) throw new Error('History storage capacity exceeded');
  }
  function writeBlock(envelope: HistoryCheckpointEnvelope): void {
    const bytes = Buffer.from(JSON.stringify(envelope));
    const id = historyCheckpointEnvelopeId(envelope);
    const state = storage.read();
    fits(bytes.length, state.blocks.length + 1);
    const temporary = join(directory, `.block-${randomBytes(16).toString('hex')}.tmp`);
    let fd: number | undefined;
    try {
      // The lock serializes this directory. Unexpected existing content needs inspection.
      if (existsSync(blockPath(id))) throw new Error('Unindexed history block requires reopen');
      fd = openSync(temporary, 'wx', 0o600);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('Incomplete history block write');
        offset += written;
      }
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, blockPath(id));
      flushDirectory(directory);
      // The index never refers to a block before its file and directory are flushed.
      const next = { ...state, blocks: [...state.blocks, id] };
      if (!validManifest(next)) throw new Error('Invalid outgoing history manifest');
      storage.write(next);
      blockBytes += bytes.length;
      envelopes.push(envelope);
    } catch (error) { failed = true; throw error; }
    finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
  }
  try {
    if (root) writeBlock(root);
    else {
      const state = storage.read();
      for (const [sequence, id] of state.blocks.entries()) {
        const path = blockPath(id), stat = lstatSync(path);
        if (!stat.isFile() || stat.size <= 0 || stat.size > HISTORY_ENVELOPE_MAX_BYTES) throw new Error('Invalid history block size or type');
        fits(stat.size, sequence + 1);
        const bytes = readFileSync(path);
        if (bytes.length !== stat.size) throw new Error('History block changed during read');
        let value: unknown;
        try { value = JSON.parse(bytes.toString('utf8')); }
        catch { throw new Error('Invalid history block encoding'); }
        const envelope = parseHistoryCheckpointEnvelope(value, context);
        if (historyCheckpointEnvelopeId(envelope) !== id || envelope.generation !== generation
          || envelope.sequence !== sequence || envelope.previous !== (sequence ? state.blocks[sequence - 1] : null)) {
          throw new Error('History chain is incomplete or conflicting');
        }
        blockBytes += bytes.length; envelopes.push(envelope);
      }
    }
    const state = storage.read();
    if (minimum && (state.blocks[minimum.sequence] !== minimum.id
      || (state.freeze?.nextGeneration ?? generation) < minimum.generationBarrier)) throw new Error('History is behind the external progress anchor');
    // Only unreferenced ciphertext is discarded. Validate the entire retained chain first.
    const retained = new Set(state.blocks.map(id => `${id.slice(7)}.block`));
    for (const name of readdirSync(directory)) {
      if ((/^[a-f0-9]{64}\.block$/.test(name) && !retained.has(name)) || /^\.block-[a-f0-9]{32}\.tmp$/.test(name)) {
        rmSync(join(directory, name));
      }
    }
  } catch (error) { storage.close(); throw error; }

  return {
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
    /** One-way local barrier; activation of a successor requires a future reviewed quorum protocol. */
    freeze(value: unknown): void {
      ensureOpen();
      const request = parseHistoryFreeze(value, context), state = storage.read();
      if (request.generation !== generation || request.nextGeneration < (state.freeze?.nextGeneration ?? generation)) {
        throw new Error('Stale history generation barrier');
      }
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
