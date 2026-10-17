import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistoryFreeze, historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, parseHistoryWriteCertificate } from '@resonance/core/history-exchange';
import { createHistoryCompactionProposal, createHistoryCompactionVote } from '@resonance/core/history-compaction';
import { createRetainedHistoryCheckpointWriter } from '../history-retained-writer.js';
import { createHistoryCheckpointWriter } from '../history-checkpoint-quorum.js';
import { createHistoryCheckpointReplica, exchangeHistoryCheckpoint, listenHistoryCheckpointReplica,
  type HistoryCheckpointTransport, type HistoryExchangeFrame } from '../history-checkpoint-exchange.js';
import { openHistoryCheckpointStore, HISTORY_MANIFEST_FILENAME } from '../history-checkpoint-store.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(timeoutMs = 10000, retained = true) {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'history-current-head-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const stores = f.context.members.map((replica, i) => openHistoryCheckpointStore({ ...f.options, replica, directory: join(directory, `r${i}`), initialize: f.root }));
  stores.forEach(store => cleanup.push(store.close));
  const roles = stores.map((store, i) => createHistoryCheckpointReplica({ context: f.context, store, signingKey: f.memberKeys[i] })); roles.forEach(role => cleanup.push(role.close));
  const members = [];
  for (let i = 0; i < 5; i++) {
    const listener = await listenHistoryCheckpointReplica(roles[i]); cleanup.push(listener.close); members.push({ publicKey: f.context.members[i], endpoint: listener.endpoint });
  }
  const frames: Array<{ member: number; frame: HistoryExchangeFrame; bytes: number }> = [];
  let online = new Set([0, 1, 2, 3, 4]);
  let override: HistoryCheckpointTransport | undefined;
  const transport: HistoryCheckpointTransport = async (member, frame, signal) => {
    const i = f.context.members.indexOf(member.publicKey); frames.push({ member: i, frame: structuredClone(frame), bytes: Buffer.byteLength(JSON.stringify(frame)) });
    if (!online.has(i)) throw new Error('offline');
    return (override ?? exchangeHistoryCheckpoint)(member, frame, signal);
  };
  const options = { directory: join(directory, 'owner'), localKey: f.localKey, context: f.context, signingKey: f.owner,
    rootId: f.options.rootId, generation: 0, members, timeoutMs, transport };
  const retainedWriter = retained ? createRetainedHistoryCheckpointWriter({ ...options, initialize: true }) : undefined;
  const writer = retainedWriter ?? createHistoryCheckpointWriter({ ...options, initialize: true }); cleanup.push(writer.close);
  return { ...f, directory, stores, roles, members, options, frames, writer, retainedWriter,
    online(...indices: number[]) { online = new Set(indices); }, override(value?: HistoryCheckpointTransport) { override = value; } };
}

it.each([512 * 1024, 2 * 1024 * 1024])('observes a %i-byte committed payload using only bounded heads and unchanged owner/replica files', async bytes => {
  const n = await fixture(); await n.writer.replicate(n.root); n.frames.length = 0;
  const block = n.next(n.root, 'x'.repeat(bytes), 'checkpoint'); await n.writer.replicate(block);
  const previousRequests = n.frames.reduce((sum, request) => sum + request.bytes, 0);
  // Make the benchmark's precondition explicit: all five durable stores already
  // have the target. Repair of a lagging fourth is tested separately below.
  for (const store of n.stores) store.append(block);
  const paths = [join(n.options.directory, 'history-writer.json'), ...n.stores.map((_, i) => join(n.directory, `r${i}`, HISTORY_MANIFEST_FILENAME))];
  const before = paths.map(path => readFileSync(path)); n.frames.length = 0;
  const receipts = await n.writer.observeCurrent(), requestBytes = n.frames.reduce((sum, request) => sum + request.bytes, 0);
  expect(receipts).toHaveLength(4); expect(n.frames).toHaveLength(5);
  expect(n.frames.every(({ frame }) => frame.request.action === 'head' && frame.envelope === null)).toBe(true);
  expect(() => parseHistoryWriteCertificate({ version: 1, receipts }, block, n.options.rootId, n.context)).toThrow();
  expect(requestBytes).toBeLessThan(6000); expect(requestBytes).toBeLessThan(previousRequests / 100);
  expect(paths.map(path => readFileSync(path))).toEqual(before);
  const metrics = { event: 'history_current_head_bytes', plaintextBytes: bytes, priorWriteRequestBytes: previousRequests,
    currentHeadRequestBytes: requestBytes, fourAcceptedResponseBytes: receipts.reduce((sum, receipt) => sum + Buffer.byteLength(JSON.stringify(receipt)), 0) };
  if (process.env.RESONANCE_HEAD_METRICS_PATH) appendFileSync(process.env.RESONANCE_HEAD_METRICS_PATH, JSON.stringify(metrics) + '\n');
}, 30000);

it('repairs only the returning lagging fourth and then returns to metadata-only reads', async () => {
  const n = await fixture(); n.online(0, 1, 2, 3); await n.writer.replicate(n.root);
  const a = n.next(n.root), b = n.next(a); await n.writer.replicate(a); await n.writer.replicate(b);
  n.online(0, 1, 2, 4); n.frames.length = 0;
  const receipts = await n.writer.observeCurrent(); expect(receipts.some(receipt => receipt.request.replica === n.context.members[4])).toBe(true);
  expect(n.stores[4].describe().envelopeId).toBe(historyCheckpointEnvelopeId(b));
  const appends = n.frames.filter(({ frame }) => frame.request.action === 'append'); expect(appends.map(request => request.member)).toEqual([4, 4]);
  expect(appends.map(request => request.frame.request.sequence)).toEqual([1, 2]);
  n.frames.length = 0; await n.writer.observeCurrent(); expect(n.frames.every(({ frame }) => frame.envelope === null)).toBe(true);
});

it('never treats old read receipts, another target response, or damaged signatures as fresh heads', async () => {
  const n = await fixture(); await n.writer.replicate(n.root); const old = await n.writer.observeCurrent();
  for (const fault of ['replay', 'member', 'signature']) {
    n.override(async (member, frame, signal) => {
      if (fault === 'replay') return old.find(value => value.request.replica === member.publicKey) ?? old[0];
      if (fault === 'member') return n.roles[0].exchange({ ...frame,
        request: createHistoryExchangeRequest({ ...frame.request, replica: n.context.members[0] }, n.context, n.owner) });
      const response = await exchangeHistoryCheckpoint(member, frame, signal) as Record<string, unknown>;
      return { ...response, signature: randomBytes(64).toString('base64url') };
    });
    await expect(n.writer.observeCurrent()).rejects.toThrow('Four');
  }
});

it.each([true, false])('rejects newer/frozen heads with retained repair set to %s', async retained => {
  const n = await fixture(10000, retained); await n.writer.replicate(n.root);
  expect(await n.writer.observeCurrent()).toHaveLength(4);
  const next = n.next(n.root); n.stores.slice(0, 4).forEach(store => store.append(next));
  await expect(n.writer.observeCurrent()).rejects.toThrow('Four');
  const freeze = createHistoryFreeze(n.context, 0, 1, randomBytes(32).toString('base64url'), n.owner);
  n.stores.slice(0, 4).forEach(store => store.freeze(freeze));
  await expect(n.writer.observeCurrent()).rejects.toThrow('Four');
  expect(n.writer.read().committed!.envelope).toEqual(n.root);
});

it('refuses empty/pending state and cannot replace a lost write acknowledgement with head receipts', async () => {
  const n = await fixture(); await expect(n.writer.observeCurrent()).rejects.toThrow('committed'); expect(n.frames).toHaveLength(0);
  await n.writer.replicate(n.root); const next = n.next(n.root);
  n.override(async (member, frame, signal) => { const result = await exchangeHistoryCheckpoint(member, frame, signal);
    if (frame.request.action === 'append') throw new Error('reply lost'); return result; });
  await expect(n.writer.replicate(next)).rejects.toThrow('Four'); const count = n.frames.length;
  await expect(n.writer.observeCurrent()).rejects.toThrow('pending'); expect(n.frames).toHaveLength(count);
  n.override(); await n.writer.replicate(next); expect(await n.writer.observeCurrent()).toHaveLength(4);
});

it('enforces a total deadline even if the adapter ignores cancellation', async () => {
  const n = await fixture(150); await n.writer.replicate(n.root);
  n.override(() => new Promise(() => {})); const start = performance.now();
  await expect(n.writer.observeCurrent()).rejects.toThrow('Four'); expect(performance.now() - start).toBeLessThan(1000);
});

it('cancels an active read on close and prevents simultaneous writes', async () => {
  const n = await fixture(); await n.writer.replicate(n.root); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  n.override(async (member, frame, signal) => { await gate; return exchangeHistoryCheckpoint(member, frame, signal); });
  const pending = n.writer.observeCurrent(); await expect(n.writer.replicate(n.root)).rejects.toThrow('active attempt');
  n.writer.close(); release(); await expect(pending).rejects.toThrow('cancelled');
});

it('rechecks the monotonic deadline during the fourth response instead of trusting timer dispatch', async () => {
  const n = await fixture(); await n.writer.replicate(n.root);
  const now = performance.now.bind(performance); let elapsed = 0, replies = 0;
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => now() + elapsed);
  try {
    n.override(async (member, frame, signal) => { const result = await exchangeHistoryCheckpoint(member, frame, signal);
      if (++replies === 4) elapsed = 10001; return result; });
    await expect(n.writer.observeCurrent()).rejects.toThrow(/Four|timed out|too late/);
  } finally { spy.mockRestore(); }
});

it('does not reinstall a current compaction checkpoint, but repairs a lagging fourth with its certified prefix', async () => {
  const n = await fixture(); n.online(0, 1, 2, 3); await n.writer.replicate(n.root);
  const first = n.next(n.root), checkpoint = n.next(first, 'complete checkpoint', 'checkpoint');
  await n.writer.replicate(first); await n.writer.replicate(checkpoint);
  const retained = n.retainedWriter; if (!retained) throw new Error('Retained writer fixture required');
  const issuedAt = Date.now(), proposal = createHistoryCompactionProposal({ genesisId: n.options.rootId, rootId: n.options.rootId,
    checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
  const certificate = { version: 1, kind: 'history-compaction-certificate', proposal,
    votes: n.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, n.context, n.options.rootId, key, issuedAt)) };
  retained.retainCompactionAnchor(certificate, retained.historyReviewDigest(), { reclaimReplicaPrefix: true });
  retained.retirePrefix(retained.planPrefixRetirement().approvalDigest); n.frames.length = 0;
  await n.writer.observeCurrent(); expect(n.frames.every(({ frame }) => frame.envelope === null)).toBe(true);
  n.online(0, 1, 2, 4); n.frames.length = 0; await n.writer.observeCurrent();
  expect(n.frames.filter(({ frame }) => frame.envelope !== null).map(({ member, frame }) => [member, frame.request.action])).toEqual([[4, 'install']]);
  expect(n.stores[4].describe().envelopeId).toBe(historyCheckpointEnvelopeId(checkpoint));
});
