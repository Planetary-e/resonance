import { afterEach, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historyCheckpointEnvelopeId, historyDigest, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, parseHistoryWriteCertificate } from '@resonance/core/history-exchange';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { HISTORY_WRITER_FILENAME } from '../history-checkpoint-quorum.js';
import { HISTORY_WRITER_ARCHIVE_FILENAME } from '../history-writer-archive.js';
import { randomBytes } from 'node:crypto';
import { createHistoryCompactionProposal, createHistoryCompactionVote } from '@resonance/core/history-compaction';
import { createRetainedHistoryCheckpointWriter } from '../history-retained-writer.js';
import { createHistoryCheckpointReplica, exchangeHistoryCheckpoint, listenHistoryCheckpointReplica, type HistoryCheckpointTransport } from '../history-checkpoint-exchange.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function network(blockLimits?: number[]) {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'retained-writer-network-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const stores = f.context.members.map((replica, i) => openHistoryCheckpointStore({ ...f.options, replica,
    directory: join(directory, `r${i}`), initialize: f.root, maxBlocks: blockLimits?.[i] }));
  stores.forEach(s => cleanup.push(() => s.close()));
  const roles = stores.map((store, i) => createHistoryCheckpointReplica({ context: f.context, store, signingKey: f.memberKeys[i] }));
  roles.forEach(r => cleanup.push(() => r.close()));
  const listeners: Awaited<ReturnType<typeof listenHistoryCheckpointReplica>>[] = [], members = f.context.members.map(publicKey => ({ publicKey, endpoint: '' }));
  let calls = 0;
  async function start(i: number) {
    const listener = await listenHistoryCheckpointReplica({ ...roles[i], exchange(value) { calls++; return roles[i].exchange(value); } },
      { port: listeners[i] ? Number(new URL(listeners[i].endpoint).port) : 0 });
    listeners[i] = listener; members[i].endpoint = listener.endpoint; cleanup.push(() => listener.close());
  }
  for (let i = 0; i < 5; i++) await start(i);
  async function resize(i: number, maxBlocks: number) {
    await listeners[i].close(); roles[i].close(); stores[i].close();
    stores[i] = openHistoryCheckpointStore({ ...f.options, replica: f.context.members[i], directory: join(directory, `r${i}`), maxBlocks });
    const store = stores[i]; cleanup.push(() => store.close());
    roles[i] = createHistoryCheckpointReplica({ context: f.context, store, signingKey: f.memberKeys[i] });
    const role = roles[i]; cleanup.push(() => role.close()); await start(i);
  }
  const options = { directory: join(directory, 'writer'), context: f.context, localKey: f.localKey, signingKey: f.owner,
    rootId: f.options.rootId, generation: 0, members, timeoutMs: 30000 };
  function writer(initialize = false, changes: Partial<Parameters<typeof createRetainedHistoryCheckpointWriter>[0]> = {}) {
    const w = createRetainedHistoryCheckpointWriter({ ...options, initialize, ...changes }); cleanup.push(() => w.close()); return w;
  }
  return { ...f, directory, stores, listeners, options, writer, start, resize, calls: () => calls };
}

it('requires four volunteers with checkpoint headroom and consumes their retained reservation after exact pending retry', async () => {
  const n = await network([3, 3, 3, 2, 2]); let writer = n.writer(true); await writer.replicate(n.root);
  const delta = sealHistoryCheckpoint({ context: n.context, header: { kind: 'delta', generation: 0, sequence: 1,
    previous: n.options.rootId, checkpointReserveBytes: 4096 }, plaintext: Buffer.from('accepted record'), encryptionKey: n.key, signingKey: n.owner });
  await expect(writer.replicate(delta)).rejects.toThrow('Four');
  expect(writer.read().committed?.envelope).toEqual(n.root); expect(writer.read().pending).toEqual(delta);
  expect(n.stores.map(store => store.describe().sequence)).toEqual([1, 1, 1, 0, 0]); writer.close();
  await n.resize(3, 3); writer = n.writer();
  const receipt = await writer.replicate(delta); expect(receipt.receipts).toHaveLength(4);
  expect(receipt.receipts.some(r => r.request.replica === n.context.members[3])).toBe(true);
  const checkpoint = n.next(delta, 'complete state'.repeat(100), 'checkpoint');
  expect(Buffer.byteLength(JSON.stringify(checkpoint))).toBeLessThan(4096);
  await writer.replicate(checkpoint);
  expect(n.stores.slice(0, 4).map(store => store.describe().sequence)).toEqual([2, 2, 2, 2]);
  expect(writer.read().pending).toBeNull(); expect([...writer.history()]).toEqual([n.root, delta, checkpoint]);
}, 30000);

it('reclaims a returning fourth volunteer within four slots after approved repair and a lost installation reply', async () => {
  const n = await network([4, 4, 4, 4, 4]); await n.listeners[4].close();
  let loseReply = true; const authorizations: boolean[] = [];
  const transport: HistoryCheckpointTransport = async (member, frame, signal) => {
    const result = await exchangeHistoryCheckpoint(member, frame, signal);
    if (member.publicKey === n.context.members[4] && frame.request.action === 'install') {
      authorizations.push(frame.request.reclaimPrefix === true);
      if (loseReply) { loseReply = false; throw new Error('lost installation reply'); }
    }
    return result;
  };
  let writer = n.writer(true, { maxArchiveBlocks: 4, transport }); await writer.replicate(n.root);
  const first = n.next(n.root), checkpoint = n.next(first, 'complete state', 'checkpoint');
  await writer.replicate(first); n.stores[4].append(first); await writer.replicate(checkpoint);
  const issuedAt = Date.now(), proposal = createHistoryCompactionProposal({ genesisId: n.options.rootId, rootId: n.options.rootId,
    checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
  const proof = { version: 1, kind: 'history-compaction-certificate', proposal,
    votes: n.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, n.context, n.options.rootId, key, issuedAt)) };
  writer.retainCompactionAnchor(proof, writer.historyReviewDigest(), { reclaimReplicaPrefix: true });
  writer.retirePrefix(writer.planPrefixRetirement().approvalDigest); writer.close();
  await n.listeners[3].close(); await n.start(4); writer = n.writer(false, { maxArchiveBlocks: 4, transport });
  const tail = sealHistoryCheckpoint({ context: n.context, header: { kind: 'delta', generation: 0, sequence: 3,
    previous: historyCheckpointEnvelopeId(checkpoint), checkpointReserveBytes: 4096 },
    plaintext: Buffer.from('next accepted record'), encryptionKey: n.key, signingKey: n.owner });
  await expect(writer.replicate(tail)).rejects.toThrow('Four');
  expect(n.stores[4].read().envelopes).toEqual([n.root, checkpoint]); expect(writer.read().pending).toEqual(tail);
  writer.close(); writer = n.writer(false, { maxArchiveBlocks: 4, transport });
  expect((await writer.replicate(tail)).receipts).toHaveLength(4);
  expect(authorizations).toEqual([true, true]); expect(n.stores[4].read().envelopes).toEqual([n.root, checkpoint, tail]);
  await writer.replicate(n.next(tail, 'next complete state', 'checkpoint'));
  expect(n.stores[4].storageUsage().retainedBlocks).toBe(4); expect(writer.read().pending).toBeNull();
}, 30000);

it('reopens the complete owner ciphertext and repairs a different fourth volunteer over real sockets', async () => {
  const n = await network(); await n.listeners[4].close(); let writer = n.writer(true);
  const a = n.next(n.root), b = n.next(a); for (const block of [n.root, a, b]) await writer.replicate(block);
  writer.close(); await n.listeners[3].close(); await n.start(4);
  const before = n.calls(); writer = n.writer(); expect(n.calls()).toBe(before);
  const c = n.next(b), certificate = await writer.replicate(c);
  expect(certificate.receipts.some(r => r.request.replica === n.context.members[4])).toBe(true);
  expect(n.stores[4].read().envelopes).toEqual([n.root, a, b, c]); expect([...writer.history()]).toEqual([n.root, a, b, c]);
}, 30000);

it.each([1_000_000_000, Number.MAX_SAFE_INTEGER - 1])('bounds repair and numeric exhaustion from a seeded high-sequence writer at %s', async sequence => {
  const n = await network(), initial = n.writer(true); await initial.replicate(n.root); initial.close();
  const checkpoint = sealHistoryCheckpoint({ context: n.context, encryptionKey: n.key, signingKey: n.owner,
    header: { kind: 'checkpoint', generation: 0, sequence, previous: historyDigest('omitted immediate predecessor') },
    plaintext: Buffer.from('certified complete state fixture') });
  const issuedAt = Date.now(), proposal = createHistoryCompactionProposal({ genesisId: n.options.rootId, rootId: n.options.rootId,
    checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
  const proof = { version: 1, kind: 'history-compaction-certificate', proposal,
    votes: n.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, n.context, n.options.rootId, key, issuedAt)) };
  for (const store of n.stores.slice(0, 4)) store.installCheckpoint(checkpoint, proof, store.reviewDigest());
  const challenge = randomBytes(32).toString('base64url'), receipts = [];
  for (const member of n.options.members.slice(0, 4)) {
    const request = createHistoryExchangeRequest({ action: 'append', rootId: n.options.rootId, generation: 0,
      replica: member.publicKey, challenge, issuedAt, expiresAt: issuedAt + 30000,
      sequence: checkpoint.sequence, envelopeId: historyCheckpointEnvelopeId(checkpoint) }, n.context, n.owner);
    receipts.push(await exchangeHistoryCheckpoint(member, { request, envelope: checkpoint }, AbortSignal.timeout(10000)));
  }
  const certificate = parseHistoryWriteCertificate({ version: 1, receipts }, checkpoint, n.options.rootId, n.context);
  // Seed an authenticated retained snapshot instead of issuing a billion writes.
  // Production opening still validates the exact payload, proof and writer certificate.
  for (const [path, domain, update] of [
    [join(n.options.directory, HISTORY_WRITER_FILENAME), 'resonance:history-checkpoint-writer:v1',
      (state: any) => ({ ...state, committed: { envelope: checkpoint, certificate }, pending: null })],
    [join(n.options.directory, 'payloads', HISTORY_WRITER_ARCHIVE_FILENAME), 'resonance:history-writer-archive:v1',
      (state: any) => ({ ...state, blocks: { version: 1, entries: [[0, n.options.rootId], [checkpoint.sequence, historyCheckpointEnvelopeId(checkpoint)]] }, compaction: proof })],
  ] as const) {
    const state = openEncryptedLocalState<any>({ path, key: n.localKey, domain, maxBytes: 40 * 1024 * 1024,
      mode: 'open-existing', initial: null, validate: (_v): _v is any => true });
    state.write(update(state.read())); state.close();
  }
  writeFileSync(join(n.options.directory, 'payloads', `${historyCheckpointEnvelopeId(checkpoint).slice(7)}.block`), JSON.stringify(checkpoint));
  await n.listeners[3].close(); const writer = n.writer(false, { maxArchiveBlocks: 4, requireCurrentHead: true });
  const tail = n.next(checkpoint);
  if (sequence === Number.MAX_SAFE_INTEGER - 1) {
    const before = n.calls(); await expect(writer.replicate(tail)).rejects.toThrow('writer pins');
    expect(n.calls()).toBe(before); expect(writer.read().pending).toBeNull();
    expect(writer.read().committed?.envelope).toEqual(checkpoint); return;
  }
  const result = await writer.replicate(tail);
  expect(result.receipts).toHaveLength(4); expect(result.receipts.some(r => r.request.replica === n.context.members[4])).toBe(true);
  expect(n.stores[4].read().envelopes).toEqual([n.root, checkpoint, tail]);
  expect(writer.historyUsage().retainedBlocks).toBe(3); expect(writer.read().committed?.envelope).toEqual(tail);
}, 30000);

it('repairs from a durable checkpoint proof after owner reopen, survives a lost install reply, and still requires four fresh target appends', async () => {
  const n = await network(); await n.listeners[4].close();
  let loseInstall = true, refuseTarget = false;
  const actions: string[] = [];
  const transport: HistoryCheckpointTransport = async (member, frame, signal) => {
    const returning = member.publicKey === n.context.members[4];
    if (returning) actions.push(`${frame.request.action}:${frame.request.sequence}`);
    if (returning && refuseTarget && frame.request.action === 'append' && frame.request.sequence === 6) throw new Error('Target unavailable');
    const result = await exchangeHistoryCheckpoint(member, frame, signal);
    if (returning && loseInstall && frame.request.action === 'install') throw new Error('Lost install acknowledgement');
    return result;
  };
  let writer = n.writer(true, { transport, requireCurrentHead: true }), block = n.root;
  const blocks = [block]; await writer.replicate(block);
  for (let i = 1; i <= 5; i++) { block = n.next(block, `state ${i}`, i === 4 ? 'checkpoint' : 'delta'); blocks.push(block); await writer.replicate(block); }
  const checkpoint = blocks[4], issuedAt = Date.now();
  const proposal = createHistoryCompactionProposal({ genesisId: n.options.rootId, rootId: n.options.rootId,
    checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
  const proof = { version: 1, kind: 'history-compaction-certificate', proposal,
    votes: n.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, n.context, n.options.rootId, key, issuedAt)) };
  expect(() => writer.retainCompactionAnchor(proof, 'stale')).toThrow('review');
  const usage = writer.historyUsage(); writer.retainCompactionAnchor(proof, writer.historyReviewDigest());
  expect(writer.historyUsage()).toEqual(usage); expect([...writer.history()]).toEqual(blocks);
  const retirement = writer.planPrefixRetirement(); expect(retirement.filesRemoved).toBe(3);
  const beforeRetirement = n.calls(); writer.retirePrefix(retirement.approvalDigest); expect(n.calls()).toBe(beforeRetirement);
  expect(writer.historyUsage().retainedCiphertextBytes).toBe(usage.retainedCiphertextBytes - retirement.bytesReclaimed);
  expect(writer.historyStatus()).toMatchObject({ blocks: 3, sequenceSlots: 6 });
  expect([...writer.history()]).toEqual([n.root, checkpoint, block]);
  writer.close(); const before = n.calls(); writer = n.writer(false, { transport, requireCurrentHead: true });
  expect(n.calls()).toBe(before); expect(writer.compactionAnchor()).toEqual(proof);
  await n.listeners[3].close(); await n.start(4); actions.length = 0;
  const target = n.next(block); await expect(writer.replicate(target)).rejects.toThrow('Four');
  expect(actions).toEqual(['head:0', 'install:4']); expect(n.stores[4].describe().sequence).toBe(4);
  expect(n.stores[4].read().envelopes).toEqual([n.root, checkpoint]); expect(writer.read().pending).toEqual(target);
  expect(() => writer.planPrefixRetirement()).toThrow('pending');
  loseInstall = false; refuseTarget = true; actions.length = 0;
  await expect(writer.replicate(target)).rejects.toThrow('Four');
  expect(actions).toEqual(['head:0', 'append:5', 'append:6']); expect(writer.read().committed?.envelope).toEqual(block);
  refuseTarget = false; actions.length = 0;
  const certificate = await writer.replicate(writer.read().pending);
  expect(actions).toEqual(['head:0', 'append:6']);
  expect(certificate.receipts.every(r => r.request.action === 'append' && r.request.sequence === 6)).toBe(true);
  expect(certificate.receipts.some(r => r.request.replica === n.context.members[4])).toBe(true);
  expect(n.stores[4].read().envelopes).toEqual([n.root, checkpoint, block, target]);
  expect([...writer.history()]).toEqual([n.root, checkpoint, block, target]);
}, 30000);

it.each(['before-file-flush', 'after-file-flush', 'before-index', 'after-index', 'before-unlink', 'after-unlink', 'durable'] as const)(
  'reopens the writer prefix boundary and resumes cleanup after SIGKILL at %s', async boundary => {
    const n = await network(), initial = n.writer(true);
    const a = n.next(n.root), b = n.next(a), checkpoint = n.next(b, 'full state', 'checkpoint'), tail = n.next(checkpoint);
    for (const block of [n.root, a, b, checkpoint, tail]) await initial.replicate(block);
    const issuedAt = Date.now(), proposal = createHistoryCompactionProposal({ genesisId: n.options.rootId, rootId: n.options.rootId,
      checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
    initial.retainCompactionAnchor({ version: 1, kind: 'history-compaction-certificate', proposal,
      votes: n.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, n.context, n.options.rootId, key, issuedAt)) }, initial.historyReviewDigest());
    initial.close();
    const child = fork(new URL('./fixtures/history-retained-writer-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', value => messages.push(value));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    expect((await once(child, 'message'))[0]).toBe('ready');
    const { localKey, signingKey, ...publicOptions } = n.options;
    child.send({ options: publicOptions, localKey: localKey.toString('hex'), owner: {
      publicKey: Buffer.from(signingKey.publicKey).toString('hex'), secretKey: Buffer.from(signingKey.secretKey).toString('hex') }, retire: true, boundary });
    await exited; expect(messages).toEqual(['ready']); expect(child.signalCode).toBe('SIGKILL');
    // An earlier fifth append may finish while the child exits. Opening itself is synchronous and offline.
    const beforeOpen = n.calls(), writer = n.writer(); expect(n.calls()).toBe(beforeOpen);
    const committed = ['after-index', 'before-unlink', 'after-unlink', 'durable'].includes(boundary);
    expect([...writer.history()]).toEqual(committed ? [n.root, checkpoint, tail] : [n.root, a, b, checkpoint, tail]);
    writer.retirePrefix(writer.planPrefixRetirement().approvalDigest);
    expect([...writer.history()]).toEqual([n.root, checkpoint, tail]);
    const next = n.next(tail); await writer.replicate(next); expect(writer.read().committed?.envelope).toEqual(next);
  }, 30000);

it.each(['before-pending', 'after-pending', 'before-payload', 'after-payload', 'before-index', 'after-index',
  'before-certificate', 'after-certificate', 'durable'] as const)(
  'preserves accepted history and the exact retry across SIGKILL at %s', async boundary => {
    const n = await network(), initial = n.writer(true); await initial.replicate(n.root); initial.close();
    const delta = n.next(n.root), child = fork(new URL('./fixtures/history-retained-writer-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'), messages: unknown[] = [];
    child.on('message', value => messages.push(value));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Writer process exited before ready'); })]))[0]).toBe('ready');
    const { localKey, signingKey, ...publicOptions } = n.options;
    child.send({ options: publicOptions, localKey: localKey.toString('hex'), owner: {
      publicKey: Buffer.from(signingKey.publicKey).toString('hex'), secretKey: Buffer.from(signingKey.secretKey).toString('hex') }, delta, boundary });
    await exited; expect(messages).toEqual(['ready']); expect(child.signalCode).toBe('SIGKILL');
    const before = n.calls(), writer = n.writer(); expect(n.calls()).toBe(before);
    const committed = ['after-certificate', 'durable'].includes(boundary);
    expect(writer.read().committed?.envelope).toEqual(committed ? delta : n.root);
    expect(writer.read().pending).toEqual(boundary === 'before-pending' || committed ? null : delta);
    const cert = await writer.replicate(writer.read().pending ?? delta);
    expect(cert.receipts.every(r => r.request.envelopeId === historyCheckpointEnvelopeId(delta))).toBe(true);
    expect([...writer.history()]).toEqual([n.root, delta]);
    for (const receipt of cert.receipts) expect(n.stores[n.context.members.indexOf(receipt.request.replica)].read().envelopes).toEqual([n.root, delta]);
  }, 30000,
);
