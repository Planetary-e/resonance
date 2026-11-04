import { afterEach, describe, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import {
  createHistoryAgreementRequest, HISTORY_AGREEMENT_MAX_FRAME_BYTES, parseHistoryAgreementResponse,
  type HistoryAgreementFrame,
} from '@resonance/core/history-agreement';
import { historySuccessorProposalId } from '@resonance/core/history-successor';
import { exchangeHistoryAgreement, listenHistoryAgreementReplica } from '../history-agreement-exchange.js';
import { historyAgreementNetworkFixture } from './fixtures/history-agreement-owner-fixture.js';

const clean: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
async function network() { const n = await historyAgreementNetworkFixture(); clean.push(() => n.close()); return n; }
function promise(n: Awaited<ReturnType<typeof network>>, i = 0): HistoryAgreementFrame {
  const issuedAt = Date.now();
  return { request: createHistoryAgreementRequest({ action: 'promise', rootId: n.options.rootId, generation: 0, nextGeneration: 1,
    replica: n.context.members[i], view: 1, challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 30_000,
    proposalId: null, evidenceId: null }, n.context, n.options.signingKey), proposal: null, viewCertificate: null, preparedCertificate: null };
}

describe('agreement network exchange', { timeout: 60_000 }, () => {
it('uses real volunteer sockets, refuses a three-member partition, and resumes after a fourth volunteer returns', async () => {
  const n = await network(), owner = n.owner(); await n.stop(3); await n.stop(4);
  await expect(owner.run()).rejects.toThrow('Four'); expect(owner.read().phase).toBe('promise'); expect(owner.read().certificate).toBeNull();
  await n.restart(3); const certificate = await owner.run(); expect(certificate.votes).toHaveLength(4);
  expect(certificate.votes.every(v => v.request.replica !== n.context.members[4])).toBe(true);
  await n.stop(0); await n.restart(0);
  expect(n.stores[0].agreementState()!.confirmed!.frame.proposal).toEqual(n.a);
});

it('preserves a hidden decision over real sockets and transfers prepared proofs in later view reports', async () => {
  const n = await network(), first = n.owner(true, { transport: async (m, f, s) => {
    const result = await exchangeHistoryAgreement(m, f, s);
    if (f.request.action === 'confirm') throw new Error('lost final response'); return result;
  } });
  await expect(first.run()).rejects.toThrow('Four'); expect(first.read().phase).toBe('confirm'); first.close();
  let largestReport = 0;
  const second = n.owner(true, { directory: join(n.directory, 'next-owner'), initialize: { proposal: n.b, view: 2 },
    transport: async (m, f, s) => { const result = await exchangeHistoryAgreement(m, f, s);
      if (f.request.action === 'promise') largestReport = Math.max(largestReport, Buffer.byteLength(JSON.stringify(result))); return result; } });
  const final = await second.run(); expect(second.read().selected).toEqual(n.a); expect(largestReport).toBeGreaterThan(4096);
  expect(final.votes.every(v => v.request.proposalId === historySuccessorProposalId(n.a))).toBe(true);
});

it('rejects malformed, unauthenticated, binary, oversized and repeated request frames', async () => {
  const n = await network(), frame = promise(n);
  async function refused(data: string | Buffer, binary = false) {
    const ws = new WebSocket(n.options.members[0].endpoint); ws.on('error', () => {});
    await once(ws, 'open'); const closed = new Promise<number>(resolve => ws.once('close', resolve)); ws.send(data, { binary }); return closed;
  }
  expect(await refused('{bad')).toBe(4003);
  expect(await refused(JSON.stringify({ ...frame, request: { ...frame.request, signature: randomBytes(64).toString('base64url') } }))).toBe(4003);
  expect(await refused(Buffer.from('{}'), true)).toBe(1006);
  expect(await refused(Buffer.alloc(HISTORY_AGREEMENT_MAX_FRAME_BYTES + 1, 0x20))).toBe(1009);
  expect(n.stores[0].agreementState()).toBeNull();
  const ws = new WebSocket(n.options.members[0].endpoint); ws.on('error', () => {}); await once(ws, 'open');
  let replies = 0; ws.on('message', () => replies++); const closed = once(ws, 'close');
  ws.send(JSON.stringify(frame)); ws.send(JSON.stringify(frame)); await closed;
  expect(replies).toBeLessThanOrEqual(1); expect(n.stores[0].agreementState()!.report.request.view).toBe(1);
});

it('bounds silent connections and response bytes, rejects redirects/insecure endpoints and meters only live sockets', async () => {
  const n = await network(), frame = promise(n);
  expect(() => exchangeHistoryAgreement({ ...n.options.members[0], endpoint: 'ws://example.com/history-agreement' }, frame, AbortSignal.timeout(1000))).toThrow();
  await expect(exchangeHistoryAgreement(n.options.members[1], frame, AbortSignal.timeout(1000))).rejects.toThrow('target');
  const redirect = createServer();
  redirect.on('upgrade', (_request, socket) => socket.end(`HTTP/1.1 302 Found\r\nLocation: ${n.options.members[0].endpoint}\r\nConnection: close\r\n\r\n`));
  await new Promise<void>(resolve => redirect.listen(0, '127.0.0.1', resolve));
  clean.push(() => new Promise<void>(resolve => redirect.close(() => resolve())));
  const redirectAddress = redirect.address(); if (!redirectAddress || typeof redirectAddress === 'string') throw new Error('missing redirect');
  const beforeRedirect = n.exchanges();
  await expect(exchangeHistoryAgreement({ ...n.options.members[0], endpoint: `ws://127.0.0.1:${redirectAddress.port}` }, frame, AbortSignal.timeout(1000))).rejects.toThrow('connection');
  expect(n.exchanges()).toBe(beforeRedirect);
  for (const mode of ['silent', 'oversized', 'binary'] as const) {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
    clean.push(async () => { for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
    let disconnected!: () => void; const closed = new Promise<void>(resolve => { disconnected = resolve; });
    server.on('connection', ws => { ws.on('error', () => {}); ws.once('close', disconnected);
      ws.on('message', () => { if (mode === 'oversized') ws.send('x'.repeat(64 * 1024 + 1)); if (mode === 'binary') ws.send(Buffer.from('{}')); }); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
    const member = { ...n.options.members[0], endpoint: `ws://127.0.0.1:${address.port}/history-agreement` };
    await expect(exchangeHistoryAgreement(member, frame, AbortSignal.timeout(500))).rejects.toThrow(/cancelled|connection|response/); await closed;
  }
  let metered = false;
  const response = await exchangeHistoryAgreement(n.options.members[0], frame, AbortSignal.timeout(5000), () => { metered = true; });
  expect(metered).toBe(true); expect(parseHistoryAgreementResponse(response, frame.request, n.context).request).toEqual(frame.request);
  await expect(exchangeHistoryAgreement(n.options.members[0], frame, AbortSignal.timeout(5000), () => { throw new Error('meter unavailable'); })).rejects.toThrow('accounting');
});

it('expires idle pre-handshake sockets and rejects excess connections', async () => {
  const n = await network(), listener = await listenHistoryAgreementReplica(n.roles[0], { maxConnections: 1, connectionTimeoutMs: 300 });
  clean.push(() => listener.close());
  const idle = connect(Number(new URL(listener.endpoint).port), '127.0.0.1'); idle.on('error', () => {});
  const idleClosed = once(idle, 'close'); await once(idle, 'connect');
  const extra = new WebSocket(listener.endpoint); extra.on('error', () => {});
  expect((await new Promise<number>(resolve => extra.once('close', resolve)))).toBe(1006);
  await idleClosed; expect(n.stores[0].agreementState()).toBeNull();
});

it.each(['promise', 'prepare', 'confirm', 'decided'])('recovers the exact owner %s phase after SIGKILL without transmitting on reopen', async phase => {
  const n = await network();
  const child = fork(new URL('./fixtures/history-agreement-owner-crash.ts', import.meta.url), [],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    const ready = once(child, 'message');
    expect((await Promise.race([ready, exited.then(() => { throw new Error('Owner exited before ready'); })]))[0]).toBe('ready');
    const reached = once(child, 'message');
    child.send({ options: n.options, localKey: n.localKey.toString('hex'), owner: {
      publicKey: Buffer.from(n.options.signingKey.publicKey).toString('hex'), secretKey: Buffer.from(n.options.signingKey.secretKey).toString('hex') }, proposal: n.a, phase });
    expect((await reached)[0]).toBe(phase); child.kill('SIGKILL'); await exited;
    const before = n.exchanges(), owner = n.owner(false); expect(n.exchanges()).toBe(before);
    expect(owner.read().phase).toBe(phase); expect(owner.read().preferred).toEqual(n.a);
    if (phase !== 'promise') expect(owner.read().selected).toEqual(n.a);
    const final = await owner.run(); expect(final.votes).toHaveLength(4);
    if (phase === 'decided') expect(n.exchanges()).toBe(before);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
});
});
