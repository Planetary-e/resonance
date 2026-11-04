import { afterEach, describe, expect, it, vi } from 'vitest';
import { fsyncSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHistoryFreeze, historyCheckpointEnvelopeId, historyDigest } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, createHistoryExchangeResponse, parseHistoryWriteCertificate } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal, historySuccessorProposalId, historySuccessorRepairId,
  parseHistorySuccessorCertificate, parseHistorySuccessorProposal } from '@resonance/core/history-successor';
import { HISTORY_MANIFEST_FILENAME, openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { createHistoryCheckpointReplica, type HistoryCheckpointTransport } from '../history-checkpoint-exchange.js';
import { createHistoryCheckpointRecovery } from '../history-checkpoint-recovery.js';
import { createHistoryCheckpointSuccessor, HISTORY_SUCCESSOR_FILENAME } from '../history-checkpoint-successor.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
const clean: Array<() => void> = [];
afterEach(() => { vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); for (const close of clean.splice(0).reverse()) close(); });
async function network(tail = true) {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'history-successor-'));
  clean.push(() => rmSync(directory, { recursive: true, force: true }));
  const stores = f.context.members.map((replica, i) => openHistoryCheckpointStore({ ...f.options, replica,
    directory: join(directory, `r${i}`), initialize: f.root }));
  stores.forEach(s => clean.push(() => s.close()));
  const delta = f.next(f.root);
  if (tail) { stores[0].append(delta); stores[1].append(delta); }
  const roles = stores.map((store, i) => createHistoryCheckpointReplica({ context: f.context, store, signingKey: f.memberKeys[i] }));
  roles.forEach(r => clean.push(() => r.close()));
  const members = f.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${22000 + i}/history-checkpoint` }));
  const transport: HistoryCheckpointTransport = async (m, frame) => roles[f.context.members.indexOf(m.publicKey)].exchange(frame);
  const options = { directory: join(directory, 'successor'), localKey: f.localKey, context: f.context, signingKey: f.owner,
    rootId: f.options.rootId, generation: 0, nextGeneration: 1, members, transport };
  const recovery = createHistoryCheckpointRecovery({ ...options, directory: join(directory, 'recovery'), initialize: true });
  clean.push(() => recovery.close()); const preparation = await recovery.prepare();
  const successor = (initialize = true, changes: Partial<Parameters<typeof createHistoryCheckpointSuccessor>[0]> = {}) => {
    const result = createHistoryCheckpointSuccessor({ ...options, ...(initialize ? { initialize: preparation } : {}), ...changes });
    clean.push(() => result.close()); return result;
  };
  return { ...f, directory, delta, stores, roles, members, options, transport, preparation, successor };
}

describe('durable successor reservation', { timeout: 30_000 }, () => {
it('copies the missing suffix to four members, reserves one exact successor and retries after restart with fresh receipts', async () => {
  const n = await network(), repairs: number[] = []; let aborted = false;
  const transport: HistoryCheckpointTransport = (m, f, s) => {
    if (m.publicKey === n.members[4].publicKey) return new Promise((_, reject) => s.addEventListener('abort', () => {
      aborted = true; reject(new Error('cancelled')); }, { once: true }));
    if (f.request.action === 'repair') repairs.push(f.request.sequence);
    return n.transport(m, f, s);
  };
  let successor = n.successor(true, { transport }); const original = successor.read().proposal;
  const certificate = await successor.reserve();
  expect(parseHistorySuccessorCertificate(certificate, original, n.context)).toEqual(certificate);
  expect(aborted).toBe(true); expect(repairs).toEqual([1, 1]);
  for (let i = 0; i < 4; i++) {
    expect(n.stores[i].read().envelopes).toEqual([n.root, n.delta]);
    expect(n.stores[i].reservedSuccessor()).toEqual(original);
    expect(() => n.stores[i].append(n.delta)).toThrow('frozen');
  }
  expect(successor.read().certificate).toEqual(certificate);
  expect(readFileSync(join(n.options.directory, HISTORY_SUCCESSOR_FILENAME), 'utf8')).not.toContain(n.options.rootId);
  n.roles[0].close(); n.stores[0].close();
  n.stores[0] = openHistoryCheckpointStore({ ...n.options, replica: n.members[0].publicKey, directory: join(n.directory, 'r0') });
  clean.push(() => n.stores[0].close());
  n.roles[0] = createHistoryCheckpointReplica({ context: n.context, store: n.stores[0], signingKey: n.memberKeys[0] });
  clean.push(() => n.roles[0].close()); expect(n.stores[0].reservedSuccessor()).toEqual(original);
  expect(() => n.stores[0].seal(createHistorySuccessorProposal(n.preparation, n.context, n.owner))).toThrow('already reserved');
  expect(() => n.stores[0].freeze(createHistoryFreeze(n.context, 0, 2, randomBytes(32).toString('base64url'), n.owner))).toThrow('cannot be replaced');
  successor.close(); const spy = vi.fn(transport); successor = n.successor(false, { transport: spy });
  expect(spy).not.toHaveBeenCalled(); repairs.length = 0;
  const retry = await successor.reserve(); expect(repairs).toEqual([]);
  expect(successor.read().proposal).toEqual(original);
  expect(retry.receipts[0].request.challenge).not.toBe(certificate.receipts[0].request.challenge);
  expect(() => parseHistoryWriteCertificate({ version: 1, receipts: retry.receipts }, n.delta, n.options.rootId, n.context)).toThrow();
});

it('retains exact intent through a partition and lost replies, then repairs only blocks still missing', async () => {
  const n = await network(); let online = new Set(n.context.members.slice(0, 3)), lose = true;
  const captured = new Map<string, unknown>();
  const transport: HistoryCheckpointTransport = async (m, f, s) => {
    if (!online.has(m.publicKey)) throw new Error('offline');
    const response = await n.transport(m, f, s);
    if (f.request.action === 'seal' && lose) { captured.set(m.publicKey, response); throw new Error('lost reply'); }
    return response;
  };
  let successor = n.successor(true, { transport }); const proposal = successor.read().proposal;
  await expect(successor.reserve()).rejects.toThrow('Four'); expect(successor.read().certificate).toBeNull(); successor.close();
  successor = n.successor(false, { transport: async m => captured.get(m.publicKey) });
  await expect(successor.reserve()).rejects.toThrow('Four'); expect(successor.read().proposal).toEqual(proposal); successor.close();
  lose = false; online = new Set(n.context.members);
  successor = n.successor(false, { transport }); expect((await successor.reserve()).receipts).toHaveLength(4);
});

it.each(['winner', 'split'])('cannot certify conflicting successors with one equivocating member: %s schedule', async schedule => {
  const n = await network(false);
  const a = createHistorySuccessorProposal(n.preparation, n.context, n.owner), b = createHistorySuccessorProposal(n.preparation, n.context, n.owner);
  // Reserve durable honest choices before either coordinator collects replies.
  const aCount = schedule === 'winner' ? 3 : 2;
  n.stores.slice(0, 4).forEach((s, i) => s.seal(i < aCount ? a : b));
  const transport: HistoryCheckpointTransport = async (m, f, s) => {
    const i = n.context.members.indexOf(m.publicKey);
    if (i === 4 && f.request.action === 'seal') return createHistoryExchangeResponse(f.request, 'sealed',
      n.stores[4].describe(), null, n.context, n.memberKeys[4]);
    return n.transport(m, f, s);
  };
  async function attempt(p: typeof a) {
    const challenge = randomBytes(32).toString('base64url'), issuedAt = Date.now();
    const replies = await Promise.allSettled(n.members.map(async member => {
      const request = createHistoryExchangeRequest({ action: 'seal', rootId: p.rootId, generation: p.generation,
        sequence: p.sequence, envelopeId: historySuccessorProposalId(p), replica: member.publicKey,
        challenge, issuedAt, expiresAt: issuedAt + 10000 }, n.context, n.owner);
      return transport(member, { request, envelope: null, successor: p }, new AbortController().signal);
    }));
    const receipts = replies.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
    return () => parseHistorySuccessorCertificate({ version: 1, proposalId: historySuccessorProposalId(p), receipts }, p, n.context);
  }
  const [first, second] = await Promise.all([attempt(a), attempt(b)]);
  if (schedule === 'winner') expect(first().receipts).toHaveLength(4); else expect(first).toThrow('Four');
  expect(second).toThrow('Four');
  // Neither timeout nor a higher freeze erases the competing durable choices.
  n.stores.slice(0, 4).forEach(s => expect(() => s.freeze(createHistoryFreeze(n.context, 0, 2,
    randomBytes(32).toString('base64url'), n.owner))).toThrow('cannot be replaced'));
});

it('will not seal incomplete or newer histories, accept another repair payload, or use a changed proposal', async () => {
  const n = await network(), coordinator = n.successor(), p = coordinator.read().proposal;
  expect(() => n.stores[2].seal(p)).toThrow('complete');
  expect(() => n.stores[2].repair(n.next(n.delta), p)).toThrow('Wrong');
  const request = createHistoryExchangeRequest({ action: 'repair', rootId: p.rootId, generation: 0, sequence: 1,
    envelopeId: historySuccessorRepairId(p, n.delta), replica: n.members[2].publicKey,
    challenge: randomBytes(32).toString('base64url'), issuedAt: Date.now(), expiresAt: Date.now() + 10000 }, n.context, n.owner);
  expect(() => n.roles[2].exchange({ request, envelope: n.next(n.root, 'other'), successor: p })).toThrow('mismatch');
  expect(() => n.roles[2].exchange({ request, envelope: n.delta,
    successor: createHistorySuccessorProposal(n.preparation, n.context, n.owner) })).toThrow('mismatch');
  expect(n.roles[2].exchange({ request, envelope: n.delta, successor: p }).status).toBe('repaired');
  expect(n.stores[2].seal(p)).toBe(historySuccessorProposalId(p));
  expect(() => parseHistorySuccessorProposal({ ...p, nextGeneration: 2 }, n.context)).toThrow();
  expect(() => parseHistorySuccessorProposal({ ...p, nonce: randomBytes(32).toString('base64url') }, n.context)).toThrow('signature');
  // A later retained tail cannot be discarded to reserve an earlier selection.
  const next = n.next(n.delta), larger = { ...n.preparation, envelopes: [...n.preparation.envelopes, next] };
  expect(() => createHistorySuccessorProposal(larger, n.context, n.owner)).toThrow();
});

it('rejects duplicate, forged, substituted and cross-attempt reservation certificates', async () => {
  const n = await network(false), successor = n.successor(), first = await successor.reserve(), second = await successor.reserve();
  const p = successor.read().proposal;
  for (const bad of [
    { ...first, proposalId: historyDigest('other') }, { ...first, receipts: first.receipts.slice(0, 3) },
    { ...first, receipts: [first.receipts[0], first.receipts[0], ...first.receipts.slice(1, 3)] },
    { ...first, receipts: first.receipts.map((r, i) => i ? r : { ...r, signature: randomBytes(64).toString('base64url') }) },
    { ...first, receipts: first.receipts.map((r, i) => i ? r : second.receipts.find(s => s.request.replica === r.request.replica)!) },
  ]) expect(() => parseHistorySuccessorCertificate(bad, p, n.context)).toThrow();
  expect(() => parseHistorySuccessorCertificate(first, createHistorySuccessorProposal(n.preparation, n.context, n.owner), n.context)).toThrow();
});

it('refuses a receipt after an uncertain reservation flush and recovers without losing repaired payloads', async () => {
  const n = await network(), successor = n.successor(), p = successor.read().proposal;
  n.stores[2].repair(n.delta, p);
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('reservation flush'); });
  expect(() => n.stores[2].seal(p)).toThrow('reservation flush'); expect(() => n.stores[2].read()).toThrow('write failed');
  n.stores[2].close(); n.roles[2].close();
  const reopened = openHistoryCheckpointStore({ ...n.options, replica: n.members[2].publicKey, directory: join(n.directory, 'r2') });
  clean.push(() => reopened.close()); expect(reopened.read().envelopes).toEqual([n.root, n.delta]);
  expect(reopened.reservedSuccessor()).toBeNull(); expect(reopened.seal(p)).toBe(historySuccessorProposalId(p));
});

it('does not return a certificate after its local flush fails and preserves the same proposal for retry', async () => {
  const n = await network(false); let sealed = 0;
  const transport: HistoryCheckpointTransport = async (m, f, s) => {
    if (m.publicKey === n.members[4].publicKey) throw new Error('offline');
    const response = await n.transport(m, f, s);
    if (f.request.action === 'seal' && ++sealed === 4) vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('certificate flush'); });
    return response;
  };
  let successor = n.successor(true, { transport }); const p = successor.read().proposal;
  await expect(successor.reserve()).rejects.toThrow('certificate flush'); expect(() => successor.read()).toThrow('write failed');
  successor.close(); successor = n.successor(false); expect(successor.read().proposal).toEqual(p); expect(successor.read().certificate).toBeNull();
  expect((await successor.reserve()).receipts).toHaveLength(4);
});

it('respects paused new storage and capacity without clearing accepted data or reserving incomplete histories', async () => {
  const n = await network(), p = n.successor().read().proposal;
  const paused = createHistoryCheckpointReplica({ context: n.context, store: n.stores[2], signingKey: n.memberKeys[2], acceptNew: () => false });
  clean.push(() => paused.close());
  const request = createHistoryExchangeRequest({ action: 'repair', rootId: p.rootId, generation: 0, sequence: 1,
    envelopeId: historySuccessorRepairId(p, n.delta), replica: n.members[2].publicKey, challenge: randomBytes(32).toString('base64url'),
    issuedAt: Date.now(), expiresAt: Date.now() + 10000 }, n.context, n.owner);
  expect(() => paused.exchange({ request, envelope: n.delta, successor: p })).toThrow('paused');
  const capped = openHistoryCheckpointStore({ ...n.options, replica: n.members[2].publicKey,
    directory: join(n.directory, 'capped'), initialize: n.root, maxBlocks: 1 }); clean.push(() => capped.close());
  capped.freeze(createHistoryFreeze(n.context, 0, 1, randomBytes(32).toString('base64url'), n.owner));
  expect(() => capped.repair(n.delta, p)).toThrow('capacity'); expect(() => capped.seal(p)).toThrow('complete');
  expect(capped.read().envelopes).toEqual([n.root]);
});

it('persists selection before network, refuses replacement on reopen, and rejects missing or mismatched state', async () => {
  const n = await network(false), spy = vi.fn(n.transport);
  expect(() => n.successor(false)).toThrow('missing');
  let successor = n.successor(true, { transport: spy }); expect(spy).not.toHaveBeenCalled();
  const p = successor.read().proposal; successor.close();
  expect(() => n.successor(true)).toThrow('already exists');
  expect(() => n.successor(false, { nextGeneration: 2 })).toThrow('state is invalid');
  successor = n.successor(false); expect(successor.read().proposal).toEqual(p);
  expect(() => n.successor(true, { directory: join(n.directory, 'bad'), rootId: historyDigest('wrong') })).toThrow('pins');
});

it('detects rollback of a reservation when an independent successor anchor survives', async () => {
  const n = await network(false), p = n.successor().read().proposal;
  const path = join(n.directory, 'r0', HISTORY_MANIFEST_FILENAME), prior = readFileSync(path);
  n.stores[0].seal(p); n.stores[0].close(); n.roles[0].close(); writeFileSync(path, prior);
  expect(() => openHistoryCheckpointStore({ ...n.options, replica: n.members[0].publicKey, directory: join(n.directory, 'r0'),
    minimum: { sequence: 0, id: n.options.rootId, generationBarrier: 1, successorId: historySuccessorProposalId(p) } })).toThrow('anchor');
});

it('bounds attempts, closes pending connections, and cannot accept late replies after cancellation', async () => {
  const n = await network(false), deliveries: Array<() => void> = [];
  const transport: HistoryCheckpointTransport = (m, f) => new Promise(resolve => {
    deliveries.push(() => resolve(n.roles[n.context.members.indexOf(m.publicKey)].exchange(f)));
  });
  let successor = n.successor(true, { transport, timeoutMs: 1000 });
  const expired = expect(successor.reserve()).rejects.toThrow('Four'); await expect(successor.reserve()).rejects.toThrow('active');
  await expired; expect(deliveries).toHaveLength(5); deliveries.splice(0).forEach(deliver => expect(deliver).toThrow('expired'));
  const saved = readFileSync(join(n.options.directory, HISTORY_SUCCESSOR_FILENAME)); successor.close();
  successor = n.successor(false, { transport }); const cancelled = expect(successor.reserve()).rejects.toThrow('cancelled');
  await Promise.resolve(); successor.close(); await cancelled;
  deliveries.splice(0).forEach(deliver => deliver()); await Promise.resolve();
  expect(readFileSync(join(n.options.directory, HISTORY_SUCCESSOR_FILENAME))).toEqual(saved);
});
});
