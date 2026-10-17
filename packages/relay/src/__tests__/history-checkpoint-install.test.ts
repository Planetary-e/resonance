import { afterEach, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistoryFreeze, historyCheckpointEnvelopeId, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryCompactionProposal, createHistoryCompactionVote, type HistoryCompactionCertificate } from '@resonance/core/history-compaction';
import { historyCompactionCertificateId } from '@resonance/core/history-compaction-control';
import { createHistoryExchangeRequest, createHistoryExchangeResponse, parseHistoryExchangeRequest,
  parseHistoryExchangeResponse, parseHistoryWriteCertificate } from '@resonance/core/history-exchange';
import { HISTORY_MANIFEST_FILENAME, openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { createHistoryCheckpointReplica, exchangeHistoryCheckpoint, listenHistoryCheckpointReplica } from '../history-checkpoint-exchange.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(maxBlocks?: number) {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'checkpoint-install-'));
  cleanup.push(() => rmSync(directory, { force: true, recursive: true }));
  const options = { ...f.options, directory, maxBlocks };
  const open = (initialize = false) => {
    const store = openHistoryCheckpointStore({ ...options, ...(initialize ? { initialize: f.root } : {}) });
    cleanup.push(store.close); return store;
  };
  const blocks = [f.root];
  for (let i = 1; i <= 9; i++) blocks.push(f.next(blocks.at(-1)!, `state ${i}`, i === 4 || i === 8 ? 'checkpoint' : 'delta'));
  const certificate = (checkpoint: HistoryCheckpointEnvelope): HistoryCompactionCertificate => {
    const issuedAt = Date.now(), proposal = createHistoryCompactionProposal({ genesisId: options.rootId, rootId: options.rootId,
      checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, f.context, f.owner);
    return { version: 1, kind: 'history-compaction-certificate', proposal,
      votes: f.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, f.context, options.rootId, key, issuedAt)) };
  };
  const first = certificate(blocks[4]), later = certificate(blocks[8]), store = open(true);
  store.append(blocks[1]);
  const frame = (proof = first, issuedAt = Date.now()) => ({
    request: createHistoryExchangeRequest({ action: 'install', rootId: options.rootId, generation: 0,
      replica: options.replica, sequence: proof.proposal.sequence, envelopeId: proof.proposal.envelopeId,
      certificateId: historyCompactionCertificateId(proof, f.context, options.rootId),
      challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt: issuedAt + 30000 }, f.context, f.owner),
    envelope: blocks[proof.proposal.sequence], compaction: proof,
  });
  const files = () => Object.fromEntries(readdirSync(directory).filter(n => n.endsWith('.block')).map(n => [n, readFileSync(join(directory, n))]));
  const role = (extra: Partial<Parameters<typeof createHistoryCheckpointReplica>[0]> = {}) => {
    const r = createHistoryCheckpointReplica({ context: f.context, signingKey: f.memberKeys[0], store, ...extra });
    cleanup.push(r.close); return r;
  };
  return { ...f, directory, options, blocks, first, later, store, open, frame, files, role, certificate };
}

it('installs successive live checkpoints without losing accepted segments and resumes ordinary writes after reopening', () => {
  const f = fixture(), before = f.files();
  f.store.installCheckpoint(f.blocks[4], f.first, f.store.reviewDigest());
  expect(f.store.read().envelopes).toEqual([f.root, f.blocks[1], f.blocks[4]]);
  expect(f.store.envelopeAt(2)).toBeNull(); expect(f.store.describe().freeze).toBeNull();
  expect(f.files()).toMatchObject(before);
  f.store.append(f.blocks[5]);
  const accepted = f.files(); f.store.installCheckpoint(f.blocks[8], f.later, f.store.reviewDigest());
  expect(f.files()).toMatchObject(accepted);
  expect(f.store.read().envelopes).toEqual([f.root, f.blocks[1], f.blocks[4], f.blocks[5], f.blocks[8]]);
  const manifest = readFileSync(join(f.directory, HISTORY_MANIFEST_FILENAME));
  expect(f.store.installCheckpoint(f.blocks[8], f.later, 'old exact retry')).toBe(historyCheckpointEnvelopeId(f.blocks[8]));
  expect(readFileSync(join(f.directory, HISTORY_MANIFEST_FILENAME))).toEqual(manifest);
  f.store.close(); const reopened = f.open();
  expect(reopened.compactionAnchor()).toEqual(f.later); expect(reopened.storageUsage().retainedBlocks).toBe(5);
  reopened.append(f.blocks[9]); expect(reopened.describe().sequence).toBe(9); expect(f.files()).toMatchObject(accepted);
  expect(() => reopened.installCheckpoint(f.blocks[8], f.later, reopened.reviewDigest())).toThrow('accepted history');
});

it('refuses stale review, insufficient proofs and conflicting adjacent blocks', () => {
  const f = fixture(), before = f.files(), review = f.store.reviewDigest();
  expect(() => f.store.installCheckpoint(f.blocks[4], f.first, 'stale')).toThrow('review');
  expect(() => f.store.installCheckpoint(f.blocks[4], { ...f.first, votes: f.first.votes.slice(0, 3) }, review)).toThrow();
  expect(() => f.store.installCheckpoint(f.blocks[8], f.first, review)).toThrow();
  expect(f.files()).toEqual(before); expect(f.store.reviewDigest()).toBe(review);
  f.store.append(f.blocks[2]);
  f.store.append(f.next(f.blocks[2], 'accepted conflicting branch'));
  expect(() => f.store.installCheckpoint(f.blocks[4], f.first, f.store.reviewDigest())).toThrow('predecessor');
});

it('checks absolute slot capacity before writing checkpoint bytes', () => {
  const f = fixture(4), before = f.files();
  expect(() => f.store.installCheckpoint(f.blocks[4], f.first, f.store.reviewDigest())).toThrow('capacity');
  expect(f.files()).toEqual(before); expect(f.store.describe().sequence).toBe(1);
});

it('retains a durable freeze across restart and refuses even an exact installation retry after freeze', () => {
  const f = fixture(); f.store.installCheckpoint(f.blocks[4], f.first, f.store.reviewDigest());
  const freeze = createHistoryFreeze(f.context, 0, 1, randomBytes(32).toString('base64url'), f.owner); f.store.freeze(freeze);
  expect(() => f.store.installCheckpoint(f.blocks[4], f.first, 'retry')).toThrow('Frozen');
  f.store.close(); const reopened = f.open(); expect(reopened.describe().freeze).toEqual(freeze);
  expect(() => reopened.installCheckpoint(f.blocks[8], f.later, reopened.reviewDigest())).toThrow('Frozen');
  expect(() => reopened.append(f.blocks[5])).toThrow('frozen');
});

it('binds the exact proof and action in owner and replica signatures and never counts install as a writer receipt', () => {
  const f = fixture(), frame = f.frame(), role = f.role();
  expect(() => parseHistoryExchangeRequest({ ...frame.request, certificateId: f.options.rootId }, f.context)).toThrow('signature');
  expect(() => parseHistoryExchangeRequest({ ...frame.request, certificateId: undefined }, f.context)).toThrow();
  expect(() => role.exchange({ ...frame, compaction: f.later })).toThrow();
  expect(() => role.exchange({ ...frame, compaction: f.certificate(f.blocks[4]) })).toThrow('authorization');
  expect(() => role.exchange({ request: frame.request, envelope: frame.envelope })).toThrow();
  expect(() => role.exchange({ ...frame, extra: true })).toThrow();
  const response = role.exchange(frame);
  expect(parseHistoryExchangeResponse(response, frame.request, f.context).status).toBe('installed');
  expect(() => parseHistoryWriteCertificate({ version: 1, receipts: Array(4).fill(response) }, f.blocks[4], f.options.rootId, f.context)).toThrow('different data');
  expect(() => createHistoryExchangeResponse(frame.request, 'stored', response.head, null, f.context, f.memberKeys[0])).toThrow();
  expect(() => createHistoryExchangeResponse(frame.request, 'installed', { ...response.head, sequence: 5 }, null, f.context, f.memberKeys[0])).toThrow();
  expect(() => parseHistoryExchangeResponse({ ...response, status: 'stored' }, frame.request, f.context)).toThrow();
});

it('honors owner pause and close callbacks and checks expiry after a durable installation', () => {
  const f = fixture(), frame = f.frame(), paused = f.role({ acceptNew: () => false });
  expect(() => paused.exchange(frame)).toThrow('paused'); expect(f.store.describe().sequence).toBe(1);
  let closing: ReturnType<typeof createHistoryCheckpointReplica>;
  closing = f.role({ acceptNew: () => { closing.close(); return true; } });
  expect(() => closing.exchange(frame)).toThrow('closed'); expect(f.store.describe().sequence).toBe(1);
  let reads = 0;
  const expiring = f.role({ now: () => ++reads <= 2 ? frame.request.issuedAt : frame.request.expiresAt });
  expect(() => expiring.exchange(frame)).toThrow('expired');
  expect(f.store.describe().sequence).toBe(4); expect(f.store.compactionAnchor()).toEqual(f.first);
  // A fresh retry can acknowledge the durable result; the expired reply never escaped.
  expect(f.role().exchange(f.frame()).status).toBe('installed');
});

it('installs through a real bounded socket and separately obtains a fresh append receipt', async () => {
  const f = fixture(), role = f.role(), listener = await listenHistoryCheckpointReplica(role); cleanup.push(listener.close);
  const frame = f.frame(), member = { publicKey: f.options.replica, endpoint: listener.endpoint };
  const result = await exchangeHistoryCheckpoint(member, frame, AbortSignal.timeout(10000));
  expect(parseHistoryExchangeResponse(result, frame.request, f.context).status).toBe('installed');
  const { certificateId: _proof, signature: _signature, ...body } = frame.request;
  const request = createHistoryExchangeRequest({ ...body, action: 'append', challenge: randomBytes(32).toString('base64url') }, f.context, f.owner);
  const receipt = await exchangeHistoryCheckpoint(member, { request, envelope: f.blocks[4] }, AbortSignal.timeout(10000));
  expect(parseHistoryExchangeResponse(receipt, request, f.context).status).toBe('stored');
}, 15000);

it.each(['before-write', 'after-file-flush', 'block-renamed', 'before-rename', 'after-rename', 'durable'] as const)(
  'preserves accepted history and installs atomically through SIGKILL at %s', async boundary => {
    const f = fixture(), before = f.files(); f.store.close();
    const child = fork(new URL('./fixtures/history-compaction-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'), messages: unknown[] = []; child.on('message', message => messages.push(message));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    child.send({ options: { ...f.options, localKey: f.localKey.toString('hex') }, certificate: f.first, checkpoint: f.blocks[4], boundary });
    await exited; expect(messages).toEqual(['ready']); expect(child.signalCode).toBe('SIGKILL');
    const reopened = f.open(), installed = boundary === 'after-rename' || boundary === 'durable';
    expect(f.files()).toMatchObject(before); expect(reopened.describe().sequence).toBe(installed ? 4 : 1);
    expect(reopened.compactionAnchor()).toEqual(installed ? f.first : null);
    reopened.installCheckpoint(f.blocks[4], f.first, reopened.reviewDigest());
    reopened.append(f.blocks[5]); expect(reopened.describe().sequence).toBe(5);
  }, 15000);
