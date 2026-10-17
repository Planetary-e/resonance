/** Resumable historical ciphertext download. Completion never authorizes restore or proves freshness. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertSecureRelayTransportEndpoint, type SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { HISTORY_ENVELOPE_MAX_BYTES, historyCheckpointContextId, historyCheckpointEnvelopeId, isHistoryDigest,
  parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { historySuccessorProposalId, parseHistorySuccessorProposal, type HistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryExchangeRequest, parseHistoryExchangeRequest, parseHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { reserveHistoryStorage } from './history-storage-reservation.js';
import { exchangeHistoryCheckpoint, type HistoryCheckpointTransport, type HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';

export const HISTORY_DOWNLOAD_FILENAME = 'history-download.json';
const MANIFEST_BYTES = 2 * 1024 * 1024, MAX_BYTES = 256 * 1024 * 1024, MAX_BLOCKS = 10_001;
interface State { version: 1; contextId: string; proposal: HistorySuccessorProposal; blocks: string[] }
interface Cursor { proposal: HistorySuccessorProposal; sequence: number; envelopeId: string; generationBytes: number; depth: number }

export function createHistoryAncestryDownload(options: {
  directory: string; localKey: Uint8Array; context: HistoryCheckpointContext; signingKey: SigningKeyPair;
  /** Independently retained selection. Its four frozen receipts pin every selected parent head. */
  proposal: HistorySuccessorProposal; members: HistoryReplicaEndpoint[]; initialize?: boolean;
  maxBytes?: number; maxBlocks?: number; timeoutMs?: number; transport?: HistoryCheckpointTransport;
}) {
  const context = parseHistoryCheckpointContext(options.context), contextId = historyCheckpointContextId(context);
  const proposal = parseHistorySuccessorProposal(options.proposal, context), proposalId = historySuccessorProposalId(proposal);
  const maxBytes = options.maxBytes ?? MAX_BYTES, maxBlocks = options.maxBlocks ?? MAX_BLOCKS, timeoutMs = options.timeoutMs ?? 30_000;
  if (![maxBytes, maxBlocks, timeoutMs].every(Number.isSafeInteger) || maxBytes <= 2 * MANIFEST_BYTES || maxBytes > MAX_BYTES
    || maxBlocks < 1 || maxBlocks > MAX_BLOCKS || timeoutMs < 50 || timeoutMs > 30_000 || options.members.length !== 5) throw new Error('Invalid history download bounds');
  const members = options.members.map(member => {
    if (!context.members.includes(member.publicKey)) throw new Error('Unknown history download member');
    assertSecureRelayTransportEndpoint(member.endpoint);
    return { publicKey: member.publicKey, endpoint: new URL(member.endpoint).href };
  });
  if (new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5) throw new Error('History download needs five distinct pinned sources');
  const directory = options.directory, transport = options.transport ?? exchangeHistoryCheckpoint, key = copyAdmissionSigningKey(options.signingKey);
  const initial: State = { version: 1, contextId, proposal, blocks: [] };
  const validate = (raw: unknown): raw is State => {
    if (!exactWitnessFields(raw, Object.keys(initial)) || raw.version !== 1 || raw.contextId !== contextId
      || !Array.isArray(raw.blocks) || raw.blocks.length > maxBlocks || !raw.blocks.every(isHistoryDigest)
      || new Set(raw.blocks).size !== raw.blocks.length) return false;
    try { return historySuccessorProposalId(parseHistorySuccessorProposal(raw.proposal, context)) === proposalId; } catch { return false; }
  };
  const start = (p: HistorySuccessorProposal, depth: number): Cursor => ({ proposal: p, sequence: p.sequence, envelopeId: p.envelopeId, generationBytes: 0, depth });
  let cursor: Cursor | null = start(proposal, 0), blockBytes = 0, failed = false, closed = false, active: AbortController | undefined;
  const path = (id: string) => join(directory, `${id.slice(7)}.block`);
  function advance(current: Cursor, block: HistoryCheckpointEnvelope, size: number): Cursor | null {
    const id = historyCheckpointEnvelopeId(block), p = current.proposal, generationBytes = current.generationBytes + size;
    if (id !== current.envelopeId || block.generation !== p.generation || block.sequence !== current.sequence
      || generationBytes > 64 * 1024 * 1024 || p.freezes.some(r => r.head.sequence === block.sequence && r.head.envelopeId !== id)) {
      throw new Error('History download does not match its selected ancestry');
    }
    if (current.sequence) return { ...current, sequence: current.sequence - 1, envelopeId: block.previous!, generationBytes };
    // Every predecessor and shorter freeze anchor was checked while walking exact consecutive
    // sequences from the selected head. Finish by binding the root, without copying each prefix.
    if (id !== p.rootId) throw new Error('History download root does not match its selected ancestry');
    if (block.kind !== 'continuation') {
      if (block.generation !== 0) throw new Error('History ancestry does not terminate at genesis');
      return null;
    }
    if (current.depth >= 64) throw new Error('History ancestry depth exceeded');
    return start(block.proposal, current.depth + 1);
  }
  function readBlock(id: string): { block: HistoryCheckpointEnvelope; size: number } {
    const file = path(id), stat = lstatSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > HISTORY_ENVELOPE_MAX_BYTES) throw new Error('Invalid cached history block size/type');
    const bytes = readFileSync(file);
    if (bytes.length !== stat.size) throw new Error('Cached history changed during read');
    const block = parseHistoryCheckpointEnvelope(JSON.parse(bytes.toString('utf8')), context);
    if (historyCheckpointEnvelopeId(block) !== id) throw new Error('Cached history digest mismatch');
    return { block, size: bytes.length };
  }
  let storage: ReturnType<typeof openEncryptedLocalState<State>>, reservation: ReturnType<typeof reserveHistoryStorage>;
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong history download owner');
    reservation = reserveHistoryStorage({ directory, component: 'history-download-ciphertext', ciphertextBytes: maxBytes - 2 * MANIFEST_BYTES,
      manifestFilename: HISTORY_DOWNLOAD_FILENAME, manifestBytes: MANIFEST_BYTES });
    if (options.initialize) {
      if (existsSync(directory) && readdirSync(directory).length) throw new Error('History download directory is not empty');
      if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
      flush(dirname(directory));
    }
    if (!lstatSync(directory).isDirectory()) throw new Error('History download needs a real directory');
    storage = openEncryptedLocalState<State>({ path: join(directory, HISTORY_DOWNLOAD_FILENAME), key: options.localKey,
      domain: 'resonance:history-ancestry-download:v1', maxBytes: MANIFEST_BYTES, initial, validate,
      mode: options.initialize ? 'create-new' : 'open-existing' });
    for (const id of storage.read().blocks) {
      if (!cursor) throw new Error('History download continues past genesis');
      const { block, size } = readBlock(id); blockBytes += size;
      if (blockBytes + 2 * MANIFEST_BYTES > maxBytes) throw new Error('History download capacity exceeded');
      cursor = advance(cursor, block, size);
    }
    // Only the next authenticated block may be unindexed after a crash. Keep it for explicit resume.
    const allowed = new Set([...storage.read().blocks, ...(cursor ? [cursor.envelopeId] : [])].map(id => `${id.slice(7)}.block`));
    for (const name of readdirSync(directory)) {
      if (/^[a-f0-9]{64}\.block$/.test(name) && !allowed.has(name)) throw new Error('Unregistered history download block');
      if (/^\.download-[a-f0-9]{32}\.tmp$/.test(name)) rmSync(join(directory, name));
    }
    if (cursor && existsSync(path(cursor.envelopeId))) {
      const { block, size } = readBlock(cursor.envelopeId); advance(cursor, block, size);
      if (blockBytes + size + 2 * MANIFEST_BYTES > maxBytes) throw new Error('History download capacity exceeded');
    }
  } catch (error) { storage!?.close(); key.secretKey.fill(0); throw error; }
  function ensureOpen() {
    if (closed || failed) throw new Error('History download closed or write failed; reopen before reuse');
    reservation.assertWritable(); storage.read();
  }
  function status() {
    ensureOpen();
    return { complete: cursor === null, blocks: storage.read().blocks.length, bytes: blockBytes,
      next: cursor && { rootId: cursor.proposal.rootId, generation: cursor.proposal.generation, sequence: cursor.sequence, envelopeId: cursor.envelopeId } };
  }
  function retain(block: HistoryCheckpointEnvelope) {
    ensureOpen(); if (!cursor) throw new Error('History download already complete');
    const id = historyCheckpointEnvelopeId(block), encoded = Buffer.from(JSON.stringify(block));
    const saved = existsSync(path(id)) ? readBlock(id) : { block, size: encoded.length };
    const next = advance(cursor, saved.block, saved.size), state = storage.read();
    if (state.blocks.length >= maxBlocks || blockBytes + saved.size + 2 * MANIFEST_BYTES > maxBytes) throw new Error('History download capacity exceeded');
    let fd: number | undefined;
    const temporary = join(directory, `.download-${randomBytes(16).toString('hex')}.tmp`);
    try {
      if (!existsSync(path(id))) {
        fd = openSync(temporary, 'wx', 0o600); let offset = 0;
        while (offset < encoded.length) {
          const written = writeSync(fd, encoded, offset, encoded.length - offset);
          if (written <= 0) throw new Error('Incomplete history download write'); offset += written;
        }
        fsyncSync(fd); closeSync(fd); fd = undefined;
        renameSync(temporary, path(id)); flush(directory);
      }
      storage.write({ ...state, blocks: [...state.blocks, id] }); // Progress only follows durable ciphertext.
      cursor = next; blockBytes += saved.size;
    } catch (error) { failed = true; throw error; }
    finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
  }
  return {
    read: status,
    /** Bounded progress per explicit attempt; no network on construction, reopen, read or iteration. */
    async run(options: { signal?: AbortSignal; maxBlocks?: number } = {}) {
      ensureOpen();
      const limit = options.maxBlocks ?? 64;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BLOCKS || active || options.signal?.aborted) throw new Error('Invalid or overlapping history download attempt');
      if (!cursor) return status();
      const controller = new AbortController(); active = controller;
      const started = performance.now(), issuedAt = Date.now(), expiresAt = issuedAt + timeoutMs;
      const cancel = () => controller.abort(); options.signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, timeoutMs);
      const live = () => {
        ensureOpen(); if (controller.signal.aborted || Date.now() >= expiresAt || performance.now() - started >= timeoutMs) throw new Error('History download cancelled or timed out');
      };
      try {
        for (let count = 0; cursor && count < limit; count++) {
          live(); const position = cursor;
          if (existsSync(path(position.envelopeId))) { retain(readBlock(position.envelopeId).block); live(); continue; }
          const block = await new Promise<HistoryCheckpointEnvelope>((resolve, reject) => {
            const group = new AbortController(); let settled = false, remaining = 5;
            const finish = (value?: HistoryCheckpointEnvelope) => {
              if (settled) return; settled = true; controller.signal.removeEventListener('abort', abort); group.abort();
              if (value) resolve(value); else reject(new Error('Selected ancestry unavailable or download cancelled/timed out'));
            };
            const abort = () => finish(); controller.signal.addEventListener('abort', abort, { once: true });
            const challenge = randomBytes(32).toString('base64url');
            for (const member of members) void Promise.resolve().then(async () => {
              live(); if (group.signal.aborted) return;
              const request = createHistoryExchangeRequest({ action: 'read', rootId: position.proposal.rootId, generation: position.proposal.generation,
                replica: member.publicKey, challenge, issuedAt, expiresAt, sequence: position.sequence, envelopeId: null }, context, key);
              const raw = await transport(member, { request: structuredClone(request), envelope: null }, group.signal);
              live(); if (group.signal.aborted) return;
              const response = parseHistoryExchangeResponse(raw, request, context);
              parseHistoryExchangeRequest(request, context, Date.now());
              if (!response.envelope) throw new Error('Selected ancestry block missing');
              advance(position, response.envelope, Buffer.byteLength(JSON.stringify(response.envelope)));
              live(); finish(response.envelope);
            }).catch(() => {}).finally(() => { if (--remaining === 0) finish(); });
          });
          live(); retain(block); live();
        }
        return status();
      } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); controller.abort(); if (active === controller) active = undefined; }
    },
    /** Complete authenticated history in chronological order, one immutable ciphertext block at a time. */
    *blocks(): Generator<HistoryCheckpointEnvelope> {
      ensureOpen(); if (cursor) throw new Error('History ancestry download is incomplete');
      for (const id of storage.read().blocks.slice().reverse()) { ensureOpen(); yield readBlock(id).block; }
    },
    close() { if (!closed) { closed = true; active?.abort(); storage.close(); key.secretKey.fill(0); } },
  };
}
function flush(directory: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
