import { afterEach, expect, it, vi } from 'vitest';
import { fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createHistoryCompactionProposal, createHistoryCompactionVote } from '@resonance/core/history-compaction';
import { acquireLocalStateLock, openEncryptedLocalState } from '@resonance/core/local-state';
import { createHistoryCheckpointWriter, HISTORY_WRITER_FILENAME } from '../history-checkpoint-quorum.js';
import { createRetainedHistoryCheckpointWriter } from '../history-retained-writer.js';
import { HISTORY_WRITER_ARCHIVE_FILENAME } from '../history-writer-archive.js';
import { createHistoryCheckpointReplica, type HistoryCheckpointTransport } from '../history-checkpoint-exchange.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), openSync: vi.fn(fs.openSync), readFileSync: vi.fn(fs.readFileSync) };
});
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.mocked(fsyncSync).mockReset().mockImplementation(actual.fsyncSync);
  vi.mocked(openSync).mockReset().mockImplementation(actual.openSync);
  vi.mocked(readFileSync).mockClear();
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'retained-writer-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const stores = f.context.members.map((replica, i) => openHistoryCheckpointStore({ ...f.options, replica, directory: join(directory, `r${i}`), initialize: f.root }));
  stores.forEach(s => cleanup.push(() => s.close()));
  const roles = stores.map((store, i) => createHistoryCheckpointReplica({ context: f.context, store, signingKey: f.memberKeys[i] }));
  roles.forEach(r => cleanup.push(() => r.close()));
  const members = f.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${27000 + i}/history-checkpoint` }));
  let calls = 0;
  const transport: HistoryCheckpointTransport = async (member, frame) => { calls++; return roles[f.context.members.indexOf(member.publicKey)].exchange(frame); };
  const options = { ...f.options, directory: join(directory, 'writer'), signingKey: f.owner, members, transport };
  function writer(initialize = true, changes: Partial<Parameters<typeof createRetainedHistoryCheckpointWriter>[0]> = {}) {
    const w = createRetainedHistoryCheckpointWriter({ ...options, initialize, ...changes }); cleanup.push(() => w.close()); return w;
  }
  const payloadDirectory = join(options.directory, 'payloads');
  const payloadPath = (id: string) => join(payloadDirectory, `${id.slice(7)}.block`);
  return { ...f, options, directory, payloadDirectory, payloadPath, stores, roles, writer, transport, calls: () => calls };
}

it('retains ciphertext before sending, validates it on reopen and repairs a returning fourth member without an in-memory source', async () => {
  const n = fixture(); let offline = 4;
  const transport: HistoryCheckpointTransport = async (member, frame, signal) => {
    if (n.context.members.indexOf(member.publicKey) === offline) throw new Error('offline');
    if (frame.request.action === 'append') {
      expect(JSON.parse(readFileSync(n.payloadPath(historyCheckpointEnvelopeId(frame.envelope!)), 'utf8'))).toEqual(frame.envelope);
    }
    return n.transport(member, frame, signal);
  };
  let writer = n.writer(true, { transport }); const a = n.next(n.root), b = n.next(a);
  for (const block of [n.root, a, b]) await writer.replicate(block);
  const before = n.calls(); writer.close(); writer = n.writer(false, { transport }); expect(n.calls()).toBe(before);
  expect([...writer.history()]).toEqual([n.root, a, b]);
  offline = 3; const c = n.next(b); const certificate = await writer.replicate(c);
  expect(certificate.receipts.some(r => r.request.replica === n.context.members[4])).toBe(true);
  expect(n.stores[4].read().envelopes).toEqual([n.root, a, b, c]); expect(writer.historyStatus().blocks).toBe(4);
});

it('uses the authenticated digest index instead of re-reading the full payload prefix on every healthy write', async () => {
  const n = fixture(); let writer = n.writer(), block = n.root;
  for (let i = 0; i < 12; i++) { await writer.replicate(block); block = n.next(block); }
  vi.mocked(readFileSync).mockClear(); await writer.replicate(block);
  const localReads = () => vi.mocked(readFileSync).mock.calls.filter(([path]) => String(path).startsWith(n.payloadDirectory) && String(path).endsWith('.block'));
  expect(localReads()).toHaveLength(0); expect(writer.historyStatus().blocks).toBe(13);
  writer.close(); vi.mocked(readFileSync).mockClear(); writer = n.writer(false);
  expect(localReads()).toHaveLength(13); expect(writer.read().committed?.envelope).toEqual(block);
}, 30000);

it('reuses a four-payload writer budget across repeated retirement cycles without retaining empty index slots', async () => {
  const n = fixture(); let writer = n.writer(true, { maxArchiveBlocks: 4 }), block = n.root;
  await writer.replicate(block);
  for (let cycle = 0; cycle < 6; cycle++) {
    block = n.next(block); await writer.replicate(block);
    block = n.next(block, 'complete state', 'checkpoint'); await writer.replicate(block);
    const issuedAt = Date.now(), proposal = createHistoryCompactionProposal({ genesisId: n.options.rootId,
      rootId: n.options.rootId, checkpoint: block, issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
    writer.retainCompactionAnchor({ version: 1, kind: 'history-compaction-certificate', proposal,
      votes: n.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, n.context, n.options.rootId, key, issuedAt)) }, writer.historyReviewDigest());
    writer.retirePrefix(writer.planPrefixRetirement().approvalDigest);
    expect(writer.historyUsage().retainedBlocks).toBe(2); writer.close();
    writer = n.writer(false, { maxArchiveBlocks: 4 }); expect([...writer.history()]).toEqual([n.root, block]);
  }
  expect(writer.historyStatus()).toMatchObject({ blocks: 2, sequenceSlots: 13 }); writer.close();
  const state = openEncryptedLocalState<any>({ path: join(n.payloadDirectory, HISTORY_WRITER_ARCHIVE_FILENAME), key: n.localKey,
    domain: 'resonance:history-writer-archive:v1', maxBytes: 2 * 1024 * 1024, mode: 'open-existing', initial: null, validate: (_v): _v is any => true });
  try { expect(state.read().blocks).toEqual({ version: 1, entries: [[0, n.options.rootId], [12, historyCheckpointEnvelopeId(block)]] }); }
  finally { state.close(); }
}, 30000);

it('opens an existing absolute-slot writer archive offline and changes representation only on an explicit write', async () => {
  const n = fixture(); let writer = n.writer(); await writer.replicate(n.root);
  const first = n.next(n.root); await writer.replicate(first); writer.close();
  const path = join(n.payloadDirectory, HISTORY_WRITER_ARCHIVE_FILENAME);
  const state = openEncryptedLocalState<any>({ path, key: n.localKey, domain: 'resonance:history-writer-archive:v1',
    maxBytes: 2 * 1024 * 1024, mode: 'open-existing', initial: null, validate: (_v): _v is any => true });
  state.write({ ...state.read(), blocks: [n.options.rootId, historyCheckpointEnvelopeId(first)] }); state.close();
  const before = readFileSync(path), calls = n.calls(); writer = n.writer(false);
  expect(readFileSync(path)).toEqual(before); expect(n.calls()).toBe(calls); expect([...writer.history()]).toEqual([n.root, first]);
  const second = n.next(first); await writer.replicate(second); expect([...writer.history()]).toEqual([n.root, first, second]);
});

it('requires current checkpoint review to expand existing repair permission and retains that choice across restart', async () => {
  const n = fixture(); let writer = n.writer(); await writer.replicate(n.root);
  const checkpoint = n.next(n.root, 'complete state', 'checkpoint'); await writer.replicate(checkpoint);
  const issuedAt = Date.now(), proposal = createHistoryCompactionProposal({ genesisId: n.options.rootId,
    rootId: n.options.rootId, checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
  const proof = { version: 1, kind: 'history-compaction-certificate', proposal,
    votes: n.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, n.context, n.options.rootId, key, issuedAt)) };
  const oldReview = writer.historyReviewDigest(); writer.retainCompactionAnchor(proof, oldReview);
  expect(() => writer.retainCompactionAnchor(proof, oldReview, { reclaimReplicaPrefix: true })).toThrow('review');
  writer.retainCompactionAnchor(proof, writer.historyReviewDigest(), { reclaimReplicaPrefix: true }); writer.close();
  const state = openEncryptedLocalState<any>({ path: join(n.payloadDirectory, HISTORY_WRITER_ARCHIVE_FILENAME), key: n.localKey,
    domain: 'resonance:history-writer-archive:v1', maxBytes: 2 * 1024 * 1024, mode: 'open-existing', initial: null,
    validate: (_value): _value is any => true });
  expect(state.read().reclaimReplicaPrefix).toBe(true); state.close(); writer = n.writer(false);
  await writer.replicate(n.next(checkpoint));
  expect(writer.compactionAnchor()).toEqual(proof);
});

it.each(['flush', 'proof', 'payload'] as const)('fails closed on checkpoint-repair %s damage without discarding accepted ciphertext', async damage => {
  const n = fixture(); let writer = n.writer(); await writer.replicate(n.root);
  const checkpoint = n.next(n.root, 'complete state', 'checkpoint'); await writer.replicate(checkpoint);
  const issuedAt = Date.now(), proposal = createHistoryCompactionProposal({ genesisId: n.options.rootId,
    rootId: n.options.rootId, checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
  const proof = { version: 1, kind: 'history-compaction-certificate', proposal,
    votes: n.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, n.context, n.options.rootId, key, issuedAt)) };
  const before = n.calls(), files = readdirSync(n.payloadDirectory).filter(name => name.endsWith('.block'));
  if (damage === 'flush') {
    vi.mocked(fsyncSync).mockImplementation(() => { throw new Error('injected proof flush failure'); });
    expect(() => writer.retainCompactionAnchor(proof, writer.historyReviewDigest())).toThrow('flush failure');
    expect(() => writer.historyStatus()).toThrow('write failed'); writer.close();
    vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync); writer = n.writer(false);
    expect(writer.compactionAnchor()).toBeNull(); expect([...writer.history()]).toEqual([n.root, checkpoint]);
  } else {
    writer.retainCompactionAnchor(proof, writer.historyReviewDigest()); writer.close();
    if (damage === 'proof') {
      const state = openEncryptedLocalState<any>({ path: join(n.payloadDirectory, HISTORY_WRITER_ARCHIVE_FILENAME), key: n.localKey,
        domain: 'resonance:history-writer-archive:v1', maxBytes: 2 * 1024 * 1024, mode: 'open-existing',
        initial: null, validate: (_v): _v is any => true });
      state.write({ ...state.read(), compaction: { ...proof, votes: proof.votes.slice(0, 3) } }); state.close();
    } else writeFileSync(n.payloadPath(historyCheckpointEnvelopeId(checkpoint)), JSON.stringify(n.next(checkpoint)));
    expect(() => n.writer(false)).toThrow();
  }
  expect(n.calls()).toBe(before);
  expect(readdirSync(n.payloadDirectory).filter(name => name.endsWith('.block'))).toEqual(files);
});

it.each(['payload', 'payload-directory', 'manifest', 'manifest-directory'] as const)(
  'sends nothing after an uncertain %s flush, preserves prior history and resumes the exact pending block', async boundary => {
    const n = fixture(); let writer = n.writer(); await writer.replicate(n.root);
    const paths = new Map<number, string>(); let directories = 0, fired = false;
    vi.mocked(openSync).mockImplementation((...args) => { const fd = actual.openSync(...args); paths.set(fd, String(args[0])); return fd; });
    vi.mocked(fsyncSync).mockImplementation(fd => {
      const path = paths.get(fd) ?? '';
      if (path === n.payloadDirectory) directories++;
      const matches = boundary === 'payload' ? /\.writer-payload-[a-f0-9]+\.tmp$/.test(path)
        : boundary === 'manifest' ? /\.history-writer-payloads\.json\.[a-f0-9]+\.tmp$/.test(path)
          : path === n.payloadDirectory && directories === (boundary === 'payload-directory' ? 1 : 2);
      if (matches && !fired) { fired = true; throw new Error('archive flush failed'); }
      actual.fsyncSync(fd);
    });
    const before = n.calls(), delta = n.next(n.root);
    await expect(writer.replicate(delta)).rejects.toThrow('archive flush failed'); expect(fired).toBe(true); expect(n.calls()).toBe(before);
    expect(writer.read().pending).toEqual(delta); expect(writer.read().committed?.envelope).toEqual(n.root);
    await expect(writer.replicate(delta)).rejects.toThrow('write failed');
    writer.close(); vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync); writer = n.writer(false);
    await writer.replicate(writer.read().pending); expect([...writer.history()]).toEqual([n.root, delta]);
    expect(readdirSync(n.payloadDirectory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  },
);

it.each(['missing', 'corrupt', 'unregistered', 'writer-rollback'] as const)('refuses %s state without resetting accepted history', async damage => {
  const n = fixture(); let writer = n.writer(); await writer.replicate(n.root);
  const priorWriter = readFileSync(join(n.options.directory, HISTORY_WRITER_FILENAME));
  const delta = n.next(n.root); await writer.replicate(delta); writer.close();
  if (damage === 'missing') rmSync(n.payloadPath(historyCheckpointEnvelopeId(n.root)));
  if (damage === 'corrupt') writeFileSync(n.payloadPath(historyCheckpointEnvelopeId(n.root)), '{}');
  if (damage === 'unregistered') { const extra = n.next(delta); writeFileSync(n.payloadPath(historyCheckpointEnvelopeId(extra)), JSON.stringify(extra)); }
  if (damage === 'writer-rollback') writeFileSync(join(n.options.directory, HISTORY_WRITER_FILENAME), priorWriter);
  expect(() => n.writer(false)).toThrow(); expect(n.stores.every(s => s.describe().sequence === 1)).toBe(true);
  expect(() => n.writer(false, { initializeArchive: true })).toThrow('already committed');
});

it.each(['blocks', 'bytes'] as const)('keeps pending intent and accepted data when the archive reaches its %s budget', async limit => {
  const n = fixture(), delta = n.next(n.root);
  const limits = limit === 'blocks' ? { maxArchiveBlocks: 1 } : { maxArchiveBytes: Buffer.byteLength(JSON.stringify(n.root)) };
  let writer = n.writer(true, limits); await writer.replicate(n.root); const before = n.calls();
  await expect(writer.replicate(delta)).rejects.toThrow('capacity'); expect(n.calls()).toBe(before);
  expect(writer.read().pending).toEqual(delta); expect([...writer.history()]).toEqual([n.root]);
  writer.close(); writer = n.writer(false); await writer.replicate(writer.read().pending);
  expect([...writer.history()]).toEqual([n.root, delta]);
});

it('requires explicit archive initialization after interrupted initial setup and refuses retroactive empty archives for committed writers', async () => {
  const n = fixture(); const raw = createHistoryCheckpointWriter({ ...n.options, initialize: true }); raw.close();
  expect(() => n.writer(false)).toThrow();
  const writer = n.writer(false, { initializeArchive: true }); await writer.replicate(n.root); writer.close();
  rmSync(n.payloadDirectory, { recursive: true });
  expect(() => n.writer(false)).toThrow(); expect(() => n.writer(false, { initializeArchive: true })).toThrow('already committed');
});

it('resumes only explicitly reviewed pristine manifest temporaries after exclusive ownership is available', async () => {
  const n = fixture(), raw = createHistoryCheckpointWriter({ ...n.options, initialize: true }); raw.close();
  mkdirSync(n.payloadDirectory);
  const path = join(n.payloadDirectory, '.history-writer-payloads.json.0123456789abcdef.tmp');
  const encrypted = readFileSync(join(n.options.directory, HISTORY_WRITER_FILENAME)); writeFileSync(path, encrypted);
  expect(() => n.writer(false, { initializeArchive: true })).toThrow('not empty'); expect(readFileSync(path)).toEqual(encrypted);
  const release = acquireLocalStateLock(join(n.payloadDirectory, 'history-writer-payloads.json'));
  try { expect(() => n.writer(false, { initializeArchive: true, resumePristineArchive: true })).toThrow('already open'); }
  finally { release(); }
  expect(readFileSync(path)).toEqual(encrypted); expect(n.calls()).toBe(0);
  const writer = n.writer(false, { initializeArchive: true, resumePristineArchive: true });
  expect(readdirSync(n.payloadDirectory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  await writer.replicate(n.root); expect([...writer.history()]).toEqual([n.root]);
});

it.each(['unknown', 'pending', 'recovery-guard'])('preserves %s evidence instead of using pristine archive resumption', async condition => {
  const n = fixture(), raw = createHistoryCheckpointWriter({ ...n.options, initialize: true, transport: async () => { throw new Error('offline'); } });
  if (condition === 'pending') await expect(raw.replicate(n.root)).rejects.toThrow('Four'); raw.close();
  mkdirSync(n.payloadDirectory);
  const name = condition === 'unknown' ? 'retained-evidence' : condition === 'recovery-guard' ? 'history-writer-payloads.json.recovery'
    : '.history-writer-payloads.json.0123456789abcdef.tmp';
  const path = join(n.payloadDirectory, name); writeFileSync(path, 'retain this evidence');
  expect(() => n.writer(false, { initializeArchive: true, resumePristineArchive: true })).toThrow('not empty');
  expect(readFileSync(path, 'utf8')).toBe('retain this evidence'); expect(n.calls()).toBe(0);
});

it.skipIf(process.platform === 'win32')('refuses a symlink posing as a pristine manifest temporary', () => {
  const n = fixture(), raw = createHistoryCheckpointWriter({ ...n.options, initialize: true }); raw.close(); mkdirSync(n.payloadDirectory);
  const original = join(n.options.directory, HISTORY_WRITER_FILENAME), bytes = readFileSync(original);
  symlinkSync(original, join(n.payloadDirectory, '.history-writer-payloads.json.0123456789abcdef.tmp'));
  expect(() => n.writer(false, { initializeArchive: true, resumePristineArchive: true })).toThrow('not empty'); expect(readFileSync(original)).toEqual(bytes);
});
