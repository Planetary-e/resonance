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
  const request = (i: number, action: 'head' | 'read', sequence = 0) => createHistoryExchangeRequest({ action,
    replica: members[i].publicKey, rootId: f.options.rootId, generation: 0, sequence, envelopeId: null,
    issuedAt: Date.now(), expiresAt: Date.now() + 30000, challenge: randomBytes(32).toString('base64url') }, f.context, f.owner);
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
  expect(openHistoryCheckpoint(data.envelope, n.context, n.key)).toEqual(plaintext);
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
