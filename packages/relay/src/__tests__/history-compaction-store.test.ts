import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, renameSync, fsyncSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createHistoryFreeze, historyCheckpointEnvelopeId, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryCompactionProposal, createHistoryCompactionVote } from '@resonance/core/history-compaction';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
import { HISTORY_MANIFEST_FILENAME, openHistoryCheckpointStore } from '../history-checkpoint-store.js';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: vi.fn(fs.renameSync), fsyncSync: vi.fn(fs.fsyncSync) };
});
const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.mocked(renameSync).mockReset().mockImplementation(fs.renameSync); vi.mocked(fsyncSync).mockReset().mockImplementation(fs.fsyncSync);
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'compaction-store-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const options = { ...f.options, directory }, path = join(directory, HISTORY_MANIFEST_FILENAME);
  const open = (initialize = false, minimum?: Parameters<typeof openHistoryCheckpointStore>[0]['minimum']) => {
    const store = openHistoryCheckpointStore({ ...options, minimum, ...(initialize ? { initialize: f.root } : {}) });
    cleanup.push(store.close); return store;
  };
  const first = f.next(f.root, 'first complete state', 'checkpoint'), middle = f.next(first);
  const second = f.next(middle, 'second complete state', 'checkpoint'), tail = f.next(second);
  const certificate = (checkpoint: HistoryCheckpointEnvelope) => {
    const issuedAt = Date.now(), proposal = createHistoryCompactionProposal({ genesisId: options.rootId, rootId: options.rootId,
      checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, f.context, f.owner);
    return { version: 1, kind: 'history-compaction-certificate', proposal,
      votes: f.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, f.context, options.rootId, key, issuedAt)) };
  };
  const store = open(true); [first, middle, second, tail].forEach(b => store.append(b));
  return { ...f, options, directory, path, open, first, second, tail, store, certificate,
    files: () => Object.fromEntries(readdirSync(directory).filter(n => n.endsWith('.block')).map(n => [n, readFileSync(join(directory, n))])) };
}
it('retains a monotone encrypted proof atomically while preserving every block, accepted tail and reservation', () => {
  const f = fixture(), before = f.files(), health = f.store.storageUsage(), head = f.store.describe(), proof = f.certificate(f.first);
  const review = f.store.reviewDigest();
  expect(f.store.retainCompactionAnchor(proof, review)).toEqual(proof); expect(f.store.reviewDigest()).not.toBe(review);
  expect(f.files()).toEqual(before); expect(f.store.describe()).toEqual(head); expect(f.store.storageUsage()).toEqual(health);
  expect(readFileSync(f.path, 'utf8')).not.toContain(proof.proposal.envelopeId);
  const bytes = readFileSync(f.path);
  expect(f.store.retainCompactionAnchor(f.certificate(f.first), review)).toEqual(proof); expect(readFileSync(f.path)).toEqual(bytes);
  const later = f.certificate(f.second); f.store.retainCompactionAnchor(later, f.store.reviewDigest());
  expect(() => f.store.retainCompactionAnchor(proof, f.store.reviewDigest())).toThrow('regress');
  f.store.close(); const reopened = f.open();
  expect(reopened.compactionAnchor()).toEqual(later); expect(reopened.describe()).toEqual(head); expect(f.files()).toEqual(before);
  expect(reopened.genesisId).toBe(f.options.rootId);
  reopened.append(f.next(f.tail)); expect(reopened.compactionAnchor()).toEqual(later);
});

it('reviews and retires only certified prefix payloads, preserving the root, later accepted tail and a durable freeze', () => {
  const f = fixture(), proof = f.certificate(f.second), before = f.files(), usage = f.store.storageUsage();
  expect(() => f.store.planPrefixRetirement()).toThrow('certificate');
  f.store.retainCompactionAnchor(proof, f.store.reviewDigest());
  const oldReview = f.store.planPrefixRetirement();
  const freeze = createHistoryFreeze(f.context, 0, 1, randomBytes(32).toString('base64url'), f.owner); f.store.freeze(freeze);
  expect(() => f.store.retirePrefix(oldReview.approvalDigest)).toThrow('review'); expect(f.files()).toEqual(before);
  const plan = f.store.planPrefixRetirement();
  expect(plan.filesRemoved).toBe(2); expect(plan.bytesReclaimed).toBeGreaterThan(0);
  expect(f.store.retirePrefix(plan.approvalDigest)).toEqual(plan);
  const expected = [f.root, f.second, f.tail];
  expect(f.store.read().envelopes).toEqual(expected); expect(f.store.compactionAnchor()).toEqual(proof);
  expect(Object.keys(f.files())).toHaveLength(3);
  for (const [name, bytes] of Object.entries(f.files())) expect(bytes).toEqual(before[name]);
  expect(f.store.storageUsage()).toMatchObject({ retainedBlocks: 3,
    retainedCiphertextBytes: usage.retainedCiphertextBytes - plan.bytesReclaimed,
    maximumBytes: usage.maximumBytes, maximumBlocks: usage.maximumBlocks, manifestReserveBytes: usage.manifestReserveBytes });
  expect(f.store.describe()).toMatchObject({ sequence: 4, freeze });
  const emptyPlan = f.store.planPrefixRetirement(), manifest = readFileSync(f.path);
  expect(f.store.retirePrefix(emptyPlan.approvalDigest).filesRemoved).toBe(0); expect(readFileSync(f.path)).toEqual(manifest);
  f.store.close(); const reopened = f.open();
  expect(reopened.read().envelopes).toEqual(expected); expect(reopened.describe().freeze).toEqual(freeze);
  expect(() => reopened.append(f.next(f.tail))).toThrow('frozen');
});

it('keeps an unfrozen compacted suffix writable and preserves a second partially accepted tail through later retirement', () => {
  const f = fixture(); f.store.retainCompactionAnchor(f.certificate(f.second), f.store.reviewDigest());
  f.store.retirePrefix(f.store.planPrefixRetirement().approvalDigest);
  const checkpoint = f.next(f.tail, 'later full state', 'checkpoint'), partial = f.next(checkpoint);
  f.store.append(checkpoint); f.store.append(partial);
  f.store.retainCompactionAnchor(f.certificate(checkpoint), f.store.reviewDigest());
  expect(f.store.retirePrefix(f.store.planPrefixRetirement().approvalDigest).filesRemoved).toBe(2);
  expect(f.store.read().envelopes).toEqual([f.root, checkpoint, partial]);
  f.store.close(); const reopened = f.open(); reopened.append(f.next(partial)); expect(reopened.describe().sequence).toBe(7);
});

it.each(['before-write', 'after-file-flush', 'before-rename', 'after-rename', 'before-unlink', 'after-unlink', 'durable'] as const)(
  'resumes prefix cleanup without restoring removed history after real SIGKILL at %s', async boundary => {
    const f = fixture(), proof = f.certificate(f.second); f.store.retainCompactionAnchor(proof, f.store.reviewDigest());
    const before = f.files(), retained = [f.root, f.second, f.tail]; f.store.close();
    const child = fork(new URL('./fixtures/history-compaction-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', value => messages.push(value));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    child.send({ options: { ...f.options, localKey: f.localKey.toString('hex') }, retire: true, boundary });
    await exited; expect(messages).toEqual(['ready']); expect(child.signalCode).toBe('SIGKILL');
    const reopened = f.open(), committed = ['after-rename', 'before-unlink', 'after-unlink', 'durable'].includes(boundary);
    expect(reopened.read().envelopes).toHaveLength(committed ? 3 : 5);
    expect(Object.keys(f.files())).toHaveLength(committed ? 3 : 5); expect(reopened.compactionAnchor()).toEqual(proof);
    expect(reopened.describe().sequence).toBe(f.tail.sequence);
    for (const [name, bytes] of Object.entries(f.files())) expect(bytes).toEqual(before[name]);
    reopened.retirePrefix(reopened.planPrefixRetirement().approvalDigest); expect(reopened.read().envelopes).toEqual(retained);
    reopened.append(f.next(f.tail)); expect(reopened.describe().sequence).toBe(5);
  }, 15000);
it('refuses stale review and unavailable/invalid checkpoints without changing retained state', () => {
  const f = fixture(), proof = f.certificate(f.first), before = readFileSync(f.path), review = f.store.reviewDigest();
  expect(() => f.store.retainCompactionAnchor(proof, 'stale')).toThrow('review');
  expect(() => f.store.retainCompactionAnchor({ ...proof, votes: proof.votes.slice(0, 3) }, review)).toThrow();
  expect(() => f.store.retainCompactionAnchor(f.certificate(f.next(f.tail, 'not retained', 'checkpoint')), review)).toThrow('retained');
  expect(readFileSync(f.path)).toEqual(before);
  f.store.append(f.next(f.tail));
  expect(() => f.store.retainCompactionAnchor(proof, review)).toThrow('review');
  expect(f.store.compactionAnchor()).toBeNull();
});
it('keeps a historical anchor through freeze but refuses a higher anchor and all subsequent writes', () => {
  const f = fixture(), proof = f.certificate(f.first); f.store.retainCompactionAnchor(proof, f.store.reviewDigest());
  const freeze = createHistoryFreeze(f.context, 0, 1, randomBytes(32).toString('base64url'), f.owner); f.store.freeze(freeze);
  const bytes = readFileSync(f.path); expect(f.store.retainCompactionAnchor(proof, 'old-review')).toEqual(proof);
  expect(() => f.store.retainCompactionAnchor(f.certificate(f.second), f.store.reviewDigest())).toThrow('Frozen');
  expect(() => f.store.append(f.next(f.tail))).toThrow('frozen'); expect(readFileSync(f.path)).toEqual(bytes);
  f.store.close(); const reopened = f.open(); expect(reopened.compactionAnchor()).toEqual(proof); expect(reopened.describe().freeze).toEqual(freeze);
});
it('detects certificate rollback when the independently retained progress anchor requires it', () => {
  const f = fixture(), backup = readFileSync(f.path), proof = f.certificate(f.second);
  f.store.retainCompactionAnchor(proof, f.store.reviewDigest()); f.store.close();
  const minimum = { sequence: f.tail.sequence, id: historyCheckpointEnvelopeId(f.tail), generationBarrier: 0,
    compaction: { sequence: f.second.sequence, envelopeId: historyCheckpointEnvelopeId(f.second) } };
  f.open(false, minimum).close(); writeFileSync(f.path, backup);
  expect(() => f.open(false, minimum)).toThrow('progress anchor');
  // Complete filesystem rollback without external progress remains undetectable.
  expect(f.open().compactionAnchor()).toBeNull();
});
it.each(['proof', 'missing-checkpoint', 'changed-checkpoint'] as const)('refuses reopen with %s damage instead of silently losing the anchor', damage => {
  const f = fixture(), proof = f.certificate(f.first); f.store.retainCompactionAnchor(proof, f.store.reviewDigest()); f.store.close();
  if (damage === 'proof') {
    const state = openEncryptedLocalState<any>({ path: f.path, key: f.localKey, domain: 'resonance:history-replica-manifest:v1',
      maxBytes: 2 * 1024 * 1024, mode: 'open-existing', initial: null, validate: (_v): _v is any => true });
    state.write({ ...state.read(), compaction: { ...proof, votes: proof.votes.slice(0, 3) } }); state.close();
  } else {
    const path = join(f.directory, `${historyCheckpointEnvelopeId(f.first).slice(7)}.block`);
    if (damage === 'missing-checkpoint') rmSync(path); else writeFileSync(path, JSON.stringify(f.second));
  }
  expect(() => f.open()).toThrow();
});
it.each(['before-rename', 'after-rename', 'file-flush', 'directory-flush'] as const)('fails closed on %s uncertainty and reopens the authoritative proof with all payloads', boundary => {
  const f = fixture(), proof = f.certificate(f.first), before = f.files();
  if (boundary.endsWith('rename')) vi.mocked(renameSync).mockImplementation((from, to) => {
    if (boundary === 'before-rename') throw new Error('injected rename failure');
    fs.renameSync(from, to); throw new Error('injected after-rename failure');
  });
  else {
    let count = 0; vi.mocked(fsyncSync).mockImplementation(fd => {
      if (++count === (boundary === 'file-flush' ? 1 : 2)) throw new Error('injected flush failure'); fs.fsyncSync(fd);
    });
  }
  expect(() => f.store.retainCompactionAnchor(proof, f.store.reviewDigest())).toThrow('injected');
  expect(() => f.store.describe()).toThrow('write failed'); f.store.close();
  vi.mocked(renameSync).mockImplementation(fs.renameSync); vi.mocked(fsyncSync).mockImplementation(fs.fsyncSync);
  const reopened = f.open(); expect(f.files()).toEqual(before); expect(reopened.describe().sequence).toBe(f.tail.sequence);
  expect(reopened.compactionAnchor()).toEqual(['after-rename', 'directory-flush'].includes(boundary) ? proof : null);
});
it.each(['before-write', 'after-file-flush', 'before-rename', 'after-rename', 'durable'] as const)('preserves an authoritative manifest across real SIGKILL at %s', async boundary => {
  const f = fixture(), proof = f.certificate(f.first), before = f.files(); f.store.close();
  const child = fork(new URL('./fixtures/history-compaction-crash.ts', import.meta.url), [],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', value => messages.push(value));
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  child.send({ options: { ...f.options, localKey: f.localKey.toString('hex') }, certificate: proof, boundary });
  await exited; expect(messages).toEqual(['ready']); expect(child.signalCode).toBe('SIGKILL');
  const reopened = f.open(); expect(f.files()).toEqual(before); expect(reopened.describe().sequence).toBe(f.tail.sequence);
  expect(reopened.compactionAnchor()).toEqual(['after-rename', 'durable'].includes(boundary) ? proof : null);
}, 15000);
