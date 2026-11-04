import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { createHistoryExchangeRequest, parseHistoryWriteCertificate } from '@resonance/core/history-exchange';
import { historyCheckpointEnvelopeId, openHistoryCheckpoint, sealHistoryCheckpoint, HISTORY_CHECKPOINT_MAX_PAYLOAD } from '@resonance/core/history-checkpoint';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { createHistoryCheckpointReplica, listenHistoryCheckpointReplica, readHistoryCheckpoint, exchangeHistoryCheckpoint,
  HISTORY_EXCHANGE_MAX_BYTES } from '../history-checkpoint-exchange.js';
import { createHistoryCheckpointWriter } from '../history-checkpoint-quorum.js';
import { createHistoryCheckpointRecovery } from '../history-checkpoint-recovery.js';
import { createHistoryCheckpointSuccessor } from '../history-checkpoint-successor.js';
import { historySuccessorProposalId, parseHistorySuccessorCertificate } from '@resonance/core/history-successor';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

const clean: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
async function network(f = historyCheckpointFixture()) {
  const directory = mkdtempSync(join(tmpdir(), 'history-exchange-'));
  clean.push(() => rmSync(directory, { force: true, recursive: true }));
  const stores: ReturnType<typeof openHistoryCheckpointStore>[] = [];
  const roles: ReturnType<typeof createHistoryCheckpointReplica>[] = [];
  const listeners: Awaited<ReturnType<typeof listenHistoryCheckpointReplica>>[] = [];
  const members = f.context.members.map(publicKey => ({ publicKey, endpoint: '' }));
  let exchanges = 0;
  async function start(i: number, initialize: boolean) {
    const store = openHistoryCheckpointStore({ ...f.options, directory: join(directory, `r${i}`), replica: members[i].publicKey,
      ...(initialize ? { initialize: f.root } : {}) }); stores[i] = store;
    const role = createHistoryCheckpointReplica({ context: f.context, store, signingKey: f.memberKeys[i] }); roles[i] = role;
    const listener = await listenHistoryCheckpointReplica({ ...role, exchange(value) { exchanges++; return role.exchange(value); } },
      { port: members[i].endpoint ? Number(new URL(members[i].endpoint).port) : 0, connectionTimeoutMs: 30000 });
    listeners[i] = listener; members[i].endpoint = listener.endpoint;
    clean.push(async () => { await listener.close(); role.close(); store.close(); });
  }
  for (let i = 0; i < 5; i++) await start(i, true);
  const options = { directory: join(directory, 'writer'), context: f.context, localKey: f.localKey, signingKey: f.owner,
    rootId: f.options.rootId, generation: 0, members, timeoutMs: 30000 };
  const writer = () => { const w = createHistoryCheckpointWriter({ ...options, initialize: true }); clean.push(() => w.close()); return w; };
  const request = (i: number, action: 'head' | 'read', sequence = 0) => {
    const issuedAt = Date.now(); // One sample keeps the maximum lifetime exactly 30 seconds.
    return createHistoryExchangeRequest({ action,
      replica: members[i].publicKey, rootId: f.options.rootId, generation: 0, sequence, envelopeId: null,
      issuedAt, expiresAt: issuedAt + 30000, challenge: randomBytes(32).toString('base64url') }, f.context, f.owner);
  };
  return { ...f, directory, stores, roles, listeners, members, options, writer, request, exchanges: () => exchanges,
    stop: async (i: number) => { await listeners[i].close(); roles[i].close(); stores[i].close(); },
    restart: (i: number) => start(i, false) };
}

it('replicates over five real sockets, refuses three online replicas, and recovers exact writes after two volunteer restarts', async () => {
  const n = await network(), writer = n.writer();
  await writer.replicate(n.root); const delta = n.next(n.root);
  const cert = await writer.replicate(delta);
  expect(parseHistoryWriteCertificate(cert, delta, n.options.rootId, n.context).receipts).toHaveLength(4);
  await n.stop(3); await n.stop(4);
  const second = n.next(delta, 'next binding');
  await expect(writer.replicate(second)).rejects.toThrow('Four');
  expect(writer.read().pending).toEqual(second);
  await n.restart(3); await n.restart(4); const confirmed = await writer.replicate(second);
  const responder = n.context.members.indexOf(confirmed.receipts[0].request.replica);
  const head = await readHistoryCheckpoint(n.members[responder], n.request(responder, 'head'), n.context, AbortSignal.timeout(10000));
  expect(head.head.envelopeId).toBe(historyCheckpointEnvelopeId(second));
  const data = await readHistoryCheckpoint(n.members[responder], n.request(responder, 'read', 2), n.context, AbortSignal.timeout(10000));
  expect(openHistoryCheckpoint(data.envelope, n.context, n.key).toString()).toBe('next binding');
  const missing = await readHistoryCheckpoint(n.members[responder], n.request(responder, 'read', 3), n.context, AbortSignal.timeout(10000));
  expect(missing.status).toBe('missing');
}, 30000);

it('transfers and reads the maximum full encrypted checkpoint without relaxing the ordinary relay frame limit', async () => {
  const f = historyCheckpointFixture(), plaintext = Buffer.alloc(HISTORY_CHECKPOINT_MAX_PAYLOAD, 0x5a);
  const n = await network(f), writer = n.writer();
  await writer.replicate(n.root);
  const checkpoint = sealHistoryCheckpoint({ context: f.context, encryptionKey: f.key, signingKey: f.owner, plaintext,
    header: { kind: 'checkpoint', generation: 0, sequence: 1, previous: f.options.rootId } });
  const certificate = await writer.replicate(checkpoint);
  expect(certificate.receipts).toHaveLength(4);
  const responder = n.context.members.indexOf(certificate.receipts[0].request.replica);
  const data = await readHistoryCheckpoint(n.members[responder], n.request(responder, 'read', 1), n.context, AbortSignal.timeout(30000));
  expect(openHistoryCheckpoint(data.envelope, n.context, n.key).equals(plaintext)).toBe(true);
}, 90000);

it('rejects unauthenticated, binary and oversized frames without changing the enrolled head', async () => {
  const n = await network();
  async function rejected(data: string | Buffer, binary: boolean) {
    const ws = new WebSocket(n.members[0].endpoint);
    ws.on('error', () => {});
    await once(ws, 'open');
    const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)));
    ws.send(data, { binary }); return closed;
  }
  const request = { ...n.request(0, 'head'), signature: randomBytes(64).toString('base64url') };
  expect(await rejected(JSON.stringify({ request, envelope: null }), false)).toBe(4003);
  expect(await rejected(Buffer.from('{}'), true)).toBe(1006);
  expect(await rejected(Buffer.alloc(HISTORY_EXCHANGE_MAX_BYTES + 1, 0x20), false)).toBe(1009);
  expect(n.stores[0].describe().sequence).toBe(0);
}, 15000);

it('cancels an established silent peer and rejects an oversized acknowledgement response', async () => {
  const n = await network();
  for (const oversized of [false, true]) {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
    clean.push(async () => { for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
    let closed!: () => void; const disconnected = new Promise<void>(resolve => { closed = resolve; });
    server.on('connection', ws => { ws.on('error', () => {}); ws.once('close', closed);
      ws.on('message', () => { if (oversized) ws.send('x'.repeat(4097)); }); });
    const address = server.address(); if (typeof address === 'string' || !address) throw new Error('missing listener');
    const member = { ...n.members[0], endpoint: `ws://127.0.0.1:${address.port}` };
    await expect(exchangeHistoryCheckpoint(member, { request: n.request(0, 'head'), envelope: null }, AbortSignal.timeout(500)))
      .rejects.toThrow(/cancelled|connection/);
    await disconnected;
  }
});

it.each(['pending', 'committed'])('preserves %s writer evidence through SIGKILL, without sending on reopen', async mode => {
  const n = await network();
  const raw = JSON.stringify({ options: n.options, root: n.root, localKey: n.localKey.toString('hex'),
    owner: { publicKey: Buffer.from(n.owner.publicKey).toString('hex'), secretKey: Buffer.from(n.owner.secretKey).toString('hex') } });
  const child = fork(new URL('./fixtures/history-checkpoint-writer-crash.ts', import.meta.url), [raw, mode],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    expect((await once(child, 'message'))[0]).toBe(mode);
    child.kill('SIGKILL'); await exited;
    const before = n.exchanges(), writer = createHistoryCheckpointWriter(n.options); clean.push(() => writer.close());
    expect(n.exchanges()).toBe(before);
    expect(mode === 'pending' ? writer.read().pending : writer.read().committed?.envelope).toEqual(n.root);
    expect((await writer.replicate(n.root)).receipts).toHaveLength(4);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
}, 20000);

it('collects complete frozen histories over real sockets and keeps the barrier after volunteer restart', async () => {
  const n = await network(), writer = n.writer(); await writer.replicate(n.root);
  const delta = n.next(n.root); await writer.replicate(delta);
  const partial = n.next(delta); const latest = n.stores.findIndex(s => s.envelopeIdAt(1) === historyCheckpointEnvelopeId(delta));
  n.stores[latest].append(partial);
  // Require this partial holder in the four responding members; partial updates are retained conservatively.
  const offline = latest === 4 ? 3 : 4; await n.stop(offline);
  const options = { ...n.options, directory: join(n.directory, 'recovery'), nextGeneration: 1 };
  let recovery = createHistoryCheckpointRecovery({ ...options, initialize: true }); clean.push(() => recovery.close());
  const prepared = await recovery.prepare(); expect(prepared.envelopes).toEqual([n.root, delta, partial]);
  await expect(writer.replicate(n.next(delta, 'competing old write'))).rejects.toThrow('Four');
  await n.stop(latest); await n.restart(latest);
  expect(n.stores[latest].describe().freeze?.nextGeneration).toBe(1);
  recovery.close(); const before = n.exchanges(); recovery = createHistoryCheckpointRecovery(options);
  expect(n.exchanges()).toBe(before); expect(recovery.read().prepared).toEqual(prepared);
  expect((await recovery.prepare()).envelopes).toEqual(prepared.envelopes);
}, 30000);

it.each(['pending', 'prepared'])('retains %s recovery evidence across SIGKILL and explicitly retries with a new challenge', async mode => {
  const n = await network(), options = { ...n.options, directory: join(n.directory, 'recovery'), nextGeneration: 1 };
  const raw = JSON.stringify({ options, localKey: n.localKey.toString('hex'),
    owner: { publicKey: Buffer.from(n.owner.publicKey).toString('hex'), secretKey: Buffer.from(n.owner.secretKey).toString('hex') } });
  const child = fork(new URL('./fixtures/history-checkpoint-recovery-crash.ts', import.meta.url), [raw, mode],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    expect((await once(child, 'message'))[0]).toBe(mode);
    child.kill('SIGKILL'); await exited;
    const before = n.exchanges(), recovery = createHistoryCheckpointRecovery(options); clean.push(() => recovery.close());
    expect(n.exchanges()).toBe(before);
    const saved = recovery.read();
    expect(mode === 'pending' ? saved.attempt : saved.prepared).not.toBeNull();
    const challenge = saved.attempt?.freeze.challenge ?? saved.prepared!.receipts[0].request.challenge;
    const fresh = await recovery.prepare(); expect(fresh.receipts[0].request.challenge).not.toBe(challenge);
    expect(fresh.envelopes).toEqual([n.root]);
    expect(n.stores.every(s => s.describe().freeze?.nextGeneration === 1)).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
}, 20000);

it('writes back a partial tail to four real volunteers before reserving a successor and retains it after restart', async () => {
  const n = await network(), delta = n.next(n.root); n.stores[0].append(delta); n.stores[1].append(delta);
  const recovery = createHistoryCheckpointRecovery({ ...n.options, directory: join(n.directory, 'recovery'), nextGeneration: 1, initialize: true });
  clean.push(() => recovery.close()); const prepared = await recovery.prepare(); expect(prepared.envelopes).toEqual([n.root, delta]);
  await n.stop(4);
  const options = { ...n.options, directory: join(n.directory, 'successor'), nextGeneration: 1 };
  let successor = createHistoryCheckpointSuccessor({ ...options, initialize: prepared }); clean.push(() => successor.close());
  const certificate = await successor.reserve(), proposal = successor.read().proposal;
  expect(parseHistorySuccessorCertificate(certificate, proposal, n.context)).toEqual(certificate);
  for (const receipt of certificate.receipts) {
    const index = n.context.members.indexOf(receipt.request.replica);
    expect(n.stores[index].read().envelopes).toEqual([n.root, delta]);
    expect(n.stores[index].reservedSuccessor()).toEqual(proposal);
  }
  await n.stop(2); await n.restart(2); expect(n.stores[2].reservedSuccessor()).toEqual(proposal);
  successor.close(); const before = n.exchanges(); successor = createHistoryCheckpointSuccessor(options);
  expect(n.exchanges()).toBe(before); const repeated = await successor.reserve();
  expect(repeated.proposalId).toBe(certificate.proposalId);
  expect(repeated.receipts[0].request.challenge).not.toBe(certificate.receipts[0].request.challenge);
  const writer = n.writer(); await expect(writer.replicate(n.root)).rejects.toThrow('Four');
}, 30000);

it.each(['pending', 'certified'])('preserves the exact %s successor across SIGKILL and retry', async mode => {
  const n = await network(), delta = n.next(n.root); n.stores[0].append(delta); n.stores[1].append(delta);
  const recovery = createHistoryCheckpointRecovery({ ...n.options, directory: join(n.directory, 'recovery'), nextGeneration: 1, initialize: true });
  clean.push(() => recovery.close()); const preparation = await recovery.prepare();
  const options = { ...n.options, directory: join(n.directory, 'successor'), nextGeneration: 1 };
  const raw = JSON.stringify({ options, preparation, localKey: n.localKey.toString('hex'),
    owner: { publicKey: Buffer.from(n.owner.publicKey).toString('hex'), secretKey: Buffer.from(n.owner.secretKey).toString('hex') } });
  const child = fork(new URL('./fixtures/history-checkpoint-successor-crash.ts', import.meta.url), [raw, mode],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    expect((await once(child, 'message'))[0]).toBe(mode); child.kill('SIGKILL'); await exited;
    const before = n.exchanges(), successor = createHistoryCheckpointSuccessor(options); clean.push(() => successor.close());
    expect(n.exchanges()).toBe(before); const saved = successor.read();
    expect(saved.certificate === null).toBe(mode === 'pending');
    const result = await successor.reserve(); expect(result.proposalId).toBe(historySuccessorProposalId(saved.proposal));
    for (const receipt of result.receipts) expect(n.stores[n.context.members.indexOf(receipt.request.replica)].read().envelopes).toEqual([n.root, delta]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
}, 30000);
