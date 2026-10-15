import { afterEach, expect, it, vi } from 'vitest';
import { fsyncSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHistoryFreeze, historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, createHistoryExchangeResponse, parseHistoryWriteCertificate } from '@resonance/core/history-exchange';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { createHistoryCheckpointReplica, type HistoryCheckpointTransport, type HistoryExchangeFrame } from '../history-checkpoint-exchange.js';
import { createHistoryCheckpointWriter, HISTORY_WRITER_FILENAME } from '../history-checkpoint-quorum.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
const clean: Array<() => void> = [];
afterEach(() => { vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); for (const close of clean.splice(0).reverse()) close(); });
function network() {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'history-quorum-'));
  clean.push(() => rmSync(directory, { force: true, recursive: true }));
  const stores = f.context.members.map((replica, i) => openHistoryCheckpointStore({ ...f.options, replica, directory: join(directory, `r${i}`), initialize: f.root }));
  stores.forEach(s => clean.push(() => s.close()));
  const roles = stores.map((store, i) => createHistoryCheckpointReplica({ context: f.context, store, signingKey: f.memberKeys[i] }));
  roles.forEach(r => clean.push(() => r.close()));
  const members = f.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${20000 + i}/history-checkpoint` }));
  const transport: HistoryCheckpointTransport = async (member, frame) => roles[f.context.members.indexOf(member.publicKey)].exchange(frame);
  const options = { directory: join(directory, 'writer'), localKey: f.localKey, context: f.context, rootId: f.options.rootId,
    generation: 0, signingKey: f.owner, members, transport };
  const writer = (initialize = true, changes: Partial<typeof options> & { timeoutMs?: number } = {}) => {
    const result = createHistoryCheckpointWriter({ ...options, ...changes, initialize }); clean.push(() => result.close()); return result;
  };
  const frame = (i = 0, block = f.root): HistoryExchangeFrame => ({ envelope: block,
    request: createHistoryExchangeRequest({ action: 'append', rootId: f.options.rootId, generation: 0, replica: f.context.members[i],
      challenge: randomBytes(32).toString('base64url'), issuedAt: Date.now(), expiresAt: Date.now() + 10000,
      sequence: block.sequence, envelopeId: historyCheckpointEnvelopeId(block) }, f.context, f.owner) });
  return { ...f, directory, stores, roles, members, transport, writer, options, frame };
}

it('returns four durable distinct receipts, cancels a silent fifth and persists the certificate before success', async () => {
  const n = network(); let cancelled = false;
  const transport: HistoryCheckpointTransport = (m, f, signal) => m.publicKey === n.members[4].publicKey
    ? new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true }))
    : n.transport(m, f, signal);
  let writer = n.writer(true, { transport });
  const certificate = await writer.replicate(n.root);
  expect(parseHistoryWriteCertificate(certificate, n.root, n.options.rootId, n.context)).toEqual(certificate);
  expect(cancelled).toBe(true); expect(writer.read().pending).toBeNull();
  const saved = writer.read().committed; expect(saved?.certificate).toEqual(certificate);
  expect(readFileSync(join(n.options.directory, HISTORY_WRITER_FILENAME), 'utf8')).not.toContain(n.options.rootId);
  writer.close(); writer = n.writer(false, { transport }); expect(writer.read().committed).toEqual(saved);
  const repeated = await writer.replicate(n.root);
  expect(repeated.receipts[0].request.challenge).not.toBe(certificate.receipts[0].request.challenge);
  const delta = n.next(n.root); await writer.replicate(delta);
  expect(n.stores.slice(0, 4).every(s => s.envelopeIdAt(1) === historyCheckpointEnvelopeId(delta))).toBe(true);
  expect(n.stores[4].envelopeIdAt(1)).toBeNull();
});

it('refuses both sides of a 3/2 partition and preserves the pending exact block for restart/rejoin', async () => {
  const n = network(); let connected = new Set(n.context.members.slice(0, 3));
  const transport: HistoryCheckpointTransport = (m, f, s) => connected.has(m.publicKey) ? n.transport(m, f, s) : Promise.reject(new Error('offline'));
  let writer = n.writer(true, { transport });
  await expect(writer.replicate(n.root)).rejects.toThrow('Four');
  connected = new Set(n.context.members.slice(3)); await expect(writer.replicate(n.root)).rejects.toThrow('Four');
  expect(writer.read().pending).toEqual(n.root); expect(writer.read().committed).toBeNull();
  await expect(writer.replicate(n.next(n.root))).rejects.toThrow('pending');
  writer.close(); connected = new Set(n.context.members.slice(0, 4)); writer = n.writer(false, { transport });
  await writer.replicate(writer.read().pending); expect(writer.read().pending).toBeNull();
});

it('retains accepted data when every reply is lost and rejects replaying those replies during a new attempt', async () => {
  const n = network(), old = new Map<string, unknown>();
  const losing: HistoryCheckpointTransport = async (m, f, s) => { old.set(m.publicKey, await n.transport(m, f, s)); throw new Error('lost response'); };
  let writer = n.writer(true, { transport: losing });
  await expect(writer.replicate(n.root)).rejects.toThrow('Four'); writer.close();
  writer = n.writer(false, { transport: async m => old.get(m.publicKey) });
  await expect(writer.replicate(n.root)).rejects.toThrow('Four'); expect(writer.read().pending).toEqual(n.root); writer.close();
  writer = n.writer(false); await writer.replicate(n.root);
});

it('does not count another member twice and still succeeds with four honest responding members', async () => {
  const n = network(); let poisoned = 1;
  const transport: HistoryCheckpointTransport = (m, f, s) => n.context.members.indexOf(m.publicKey) < poisoned
    ? n.transport(n.members[4], { ...f, request: { ...f.request, replica: n.members[4].publicKey } }, s) : n.transport(m, f, s);
  const writer = n.writer(true, { transport }); await writer.replicate(n.root);
  poisoned = 2; await expect(writer.replicate(n.next(n.root))).rejects.toThrow('Four');
});

it('a frozen quorum refuses a new write and fresh re-acknowledgement of a previously committed write', async () => {
  const n = network(), writer = n.writer(); await writer.replicate(n.root);
  const freeze = createHistoryFreeze(n.context, 0, 1, randomBytes(32).toString('base64url'), n.owner);
  n.stores.slice(0, 4).forEach(s => s.freeze(freeze));
  await expect(writer.replicate(n.root)).rejects.toThrow('Four');
  await expect(writer.replicate(n.next(n.root))).rejects.toThrow('Four');
  expect(writer.read().committed?.envelope).toEqual(n.root);
});

it('cannot certify two competing next blocks even when one replica signs both', async () => {
  const n = network();
  const transport: HistoryCheckpointTransport = async (m, f, s) => m.publicKey !== n.members[4].publicKey ? n.transport(m, f, s)
    : createHistoryExchangeResponse(f.request, 'stored', { generation: 0, rootId: n.options.rootId,
      sequence: f.request.sequence, envelopeId: f.request.envelopeId!, freeze: null }, null, n.context, n.memberKeys[4]);
  const first = n.writer(true, { transport }), second = n.writer(true, { directory: join(n.directory, 'competing-writer'), transport });
  await first.replicate(n.root); await second.replicate(n.root);
  const a = n.next(n.root, 'binding A'), b = n.next(n.root, 'binding B');
  const results = await Promise.allSettled([first.replicate(a), second.replicate(b)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(n.stores.slice(0, 4).every(store => store.envelopeIdAt(1) === historyCheckpointEnvelopeId(a))).toBe(true);
});

it('will not transmit before persisting its pending block or report success after an uncertain certificate flush', async () => {
  const n = network(), transport = vi.fn(n.transport);
  let writer = n.writer(true, { transport });
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('pending flush'); });
  await expect(writer.replicate(n.root)).rejects.toThrow('pending flush'); expect(transport).not.toHaveBeenCalled(); writer.close();
  let calls = 0;
  writer = n.writer(false, { transport: async (m, f, s) => {
    const response = await n.transport(m, f, s);
    if (++calls === 4) vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('certificate flush'); });
    return response;
  } });
  await expect(writer.replicate(n.root)).rejects.toThrow('certificate flush');
  expect(() => writer.read()).toThrow('write failed'); writer.close();
  writer = n.writer(false); expect(writer.read().pending).toEqual(n.root); await writer.replicate(n.root);
});

it('returns no replica receipt after an uncertain payload flush and keeps reads available when owner pauses new storage', () => {
  const n = network(), delta = n.next(n.root);
  const role = createHistoryCheckpointReplica({ context: n.context, store: n.stores[0], signingKey: n.memberKeys[0], acceptNew: () => false });
  clean.push(() => role.close());
  expect(role.exchange(n.frame()).status).toBe('stored');
  expect(() => role.exchange(n.frame(0, delta))).toThrow('paused');
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('payload flush'); });
  expect(() => n.roles[0].exchange(n.frame(0, delta))).toThrow('payload flush');
  expect(() => n.roles[0].exchange(n.frame())).toThrow('write failed');
});

it('rejects role/store pin mismatches and callback close or freeze before returning any new receipt', () => {
  const n = network();
  expect(() => createHistoryCheckpointReplica({ context: n.context, store: n.stores[0], signingKey: n.memberKeys[1] })).toThrow('another replica');
  const frozen = createHistoryCheckpointReplica({ context: n.context, store: n.stores[0], signingKey: n.memberKeys[0], acceptNew: () => {
    n.stores[0].freeze(createHistoryFreeze(n.context, 0, 1, randomBytes(32).toString('base64url'), n.owner)); return true;
  } }); clean.push(() => frozen.close());
  expect(() => frozen.exchange(n.frame(0, n.next(n.root)))).toThrow('frozen');
  const closed = createHistoryCheckpointReplica({ context: n.context, store: n.stores[1], signingKey: n.memberKeys[1], acceptNew: () => { closed.close(); return true; } });
  expect(() => closed.exchange(n.frame(1, n.next(n.root)))).toThrow('closed');
});

it('bounds concurrent attempts, rejects deadlines and ignores late signed replies after timeout or close', async () => {
  const n = network(), deliveries: Array<() => void> = [];
  const transport: HistoryCheckpointTransport = (m, f) => new Promise(resolve => {
    deliveries.push(() => resolve(n.roles[n.context.members.indexOf(m.publicKey)].exchange(f)));
  });
  // Leave time for five real owner signatures on slower CI CPUs before the
  // deliberately silent transports exhaust the deadline.
  let writer = n.writer(true, { transport, timeoutMs: 1000 });
  const attempt = writer.replicate(n.root); const failed = expect(attempt).rejects.toThrow('Four');
  await expect(writer.replicate(n.root)).rejects.toThrow('active');
  await failed;
  expect(deliveries).toHaveLength(5);
  const before = readFileSync(join(n.options.directory, HISTORY_WRITER_FILENAME));
  // Expired requests cannot be executed to fabricate late acknowledgements.
  deliveries.splice(0).forEach(deliver => expect(deliver).toThrow('expired'));
  expect(readFileSync(join(n.options.directory, HISTORY_WRITER_FILENAME))).toEqual(before);
  writer.close(); writer = n.writer(false, { transport, timeoutMs: 10000 });
  const pending = writer.replicate(n.root); const cancelled = expect(pending).rejects.toThrow('cancelled');
  await Promise.resolve(); writer.close(); await cancelled;
  deliveries.splice(0).forEach(deliver => deliver()); await Promise.resolve();
  expect(readFileSync(join(n.options.directory, HISTORY_WRITER_FILENAME))).toEqual(before);
}, 15000);

it('refuses missing writer state and incompatible pinned endpoint lists', () => {
  const n = network(); expect(() => n.writer(false)).toThrow('missing');
  expect(() => n.writer(true, { members: [n.members[0], ...n.members.slice(0, 4)] })).toThrow('distinct');
  expect(() => n.writer(true, { members: n.members.map((m, i) => i ? m : { ...m, endpoint: 'ws://public.example.org/' }) })).toThrow('wss');
});
