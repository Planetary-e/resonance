import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createHistoryFreeze, historyCheckpointEnvelopeId, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryCheckpointWriter } from '../history-checkpoint-quorum.js';
import { createHistoryCheckpointReplica, exchangeHistoryCheckpoint, listenHistoryCheckpointReplica,
  type HistoryCheckpointTransport } from '../history-checkpoint-exchange.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'history-live-repair-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const stores = f.context.members.map((replica, i) => openHistoryCheckpointStore({ ...f.options, replica,
    directory: join(directory, `r${i}`), initialize: f.root }));
  const roles = stores.map((store, i) => createHistoryCheckpointReplica({ context: f.context, store, signingKey: f.memberKeys[i] }));
  stores.forEach(s => cleanup.push(() => s.close())); roles.forEach(r => cleanup.push(() => r.close()));
  const members = f.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${26000 + i}/history-checkpoint` }));
  const retained: HistoryCheckpointEnvelope[] = [f.root];
  const transport: HistoryCheckpointTransport = async (member, frame) => roles[f.context.members.indexOf(member.publicKey)].exchange(frame);
  const options = { directory: join(directory, 'writer'), localKey: f.localKey, context: f.context, signingKey: f.owner,
    rootId: f.options.rootId, generation: 0, members, transport, retained: () => retained, timeoutMs: 30000 };
  function writer(initialize = true, changes: Partial<Parameters<typeof createHistoryCheckpointWriter>[0]> = {}) {
    const w = createHistoryCheckpointWriter({ ...options, initialize, ...changes }); cleanup.push(() => w.close()); return w;
  }
  return { ...f, directory, stores, roles, members, retained, transport, options, writer };
}

it('repairs a returning fourth volunteer over real sockets and resumes after a lost repair reply and owner reopen', async () => {
  const n = fixture(), listeners: Awaited<ReturnType<typeof listenHistoryCheckpointReplica>>[] = [];
  async function start(i: number) {
    const listener = await listenHistoryCheckpointReplica(n.roles[i], { port: listeners[i] ? Number(new URL(listeners[i].endpoint).port) : 0 });
    listeners[i] = listener; n.members[i].endpoint = listener.endpoint; cleanup.push(() => listener.close());
  }
  for (let i = 0; i < 5; i++) await start(i);
  await listeners[4].close();
  const attempts: number[] = []; let lose = true;
  const transport: HistoryCheckpointTransport = async (member, frame, signal) => {
    const response = await exchangeHistoryCheckpoint(member, frame, signal);
    if (member.publicKey === n.members[4].publicKey && frame.request.action === 'append') {
      attempts.push(frame.request.sequence);
      if (lose && frame.request.sequence === 1) throw new Error('Lost prefix acknowledgement');
    }
    return response;
  };
  let writer = n.writer(true, { transport }); await writer.replicate(n.root);
  for (let i = 0; i < 2; i++) { const block = n.next(n.retained.at(-1)!); await writer.replicate(block); n.retained.push(block); }
  expect(n.stores[4].describe().sequence).toBe(0);
  await listeners[3].close(); await start(4);
  const next = n.next(n.retained.at(-1)!);
  await expect(writer.replicate(next)).rejects.toThrow('Four');
  expect(writer.read().pending).toEqual(next); expect(n.stores[4].describe().sequence).toBe(1); expect(attempts).toEqual([1]);
  writer.close(); lose = false; writer = n.writer(false, { transport });
  const cert = await writer.replicate(writer.read().pending); n.retained.push(next);
  expect(cert.receipts).toHaveLength(4); expect(cert.receipts.some(r => r.request.replica === n.members[4].publicKey)).toBe(true);
  expect(attempts).toEqual([1, 2, 3]); expect(n.stores[4].read().envelopes).toEqual(n.retained);
  expect(cert.receipts.every(r => r.request.sequence === 3 && r.request.envelopeId === historyCheckpointEnvelopeId(next))).toBe(true);
  const retry = await writer.replicate(next);
  expect(retry.receipts[0].request.challenge).not.toBe(cert.receipts[0].request.challenge);
  expect(attempts).toEqual([1, 2, 3, 3]); // Fresh target receipt, no duplicate prefix transfer.
}, 60000);

it.each(['gap', 'fork', 'longer', 'corrupt'] as const)('rejects a %s retained prefix before sending and preserves the exact pending write', async kind => {
  const n = fixture(); let source = n.retained, calls = 0;
  const writer = n.writer(true, { retained: () => source, transport: async (...args) => { calls++; return n.transport(...args); } });
  await writer.replicate(n.root); const a = n.next(n.root); await writer.replicate(a); n.retained.push(a);
  const b = n.next(a); calls = 0;
  source = kind === 'gap' ? [a] : kind === 'fork' ? [n.root, n.next(n.root, 'other')]
    : kind === 'longer' ? [n.root, a, b, n.next(b)] : [n.root, { ...a, signature: 'invalid' }];
  await expect(writer.replicate(b)).rejects.toThrow();
  expect(calls).toBe(0); expect(writer.read().pending).toEqual(b); expect(writer.read().committed?.envelope).toEqual(a);
  source = n.retained; await writer.replicate(b); expect(writer.read().pending).toBeNull();
});

it.each(['fork', 'newer', 'frozen'] as const)('never changes a %s replica or counts its head as a durable write receipt', async kind => {
  const n = fixture(); let offline = 4; const actions: string[] = [];
  const writer = n.writer(true, { transport: async (member, frame, signal) => {
    const i = n.context.members.indexOf(member.publicKey); if (i === offline) throw new Error('offline');
    if (i === 4) actions.push(frame.request.action); return n.transport(member, frame, signal);
  } });
  await writer.replicate(n.root); const a = n.next(n.root); await writer.replicate(a); n.retained.push(a);
  const b = n.next(a);
  if (kind === 'fork') n.stores[4].append(n.next(n.root, 'conflicting history'));
  if (kind === 'newer') { n.stores[4].append(a); n.stores[4].append(b); n.stores[4].append(n.next(b)); }
  if (kind === 'frozen') n.stores[4].freeze(createHistoryFreeze(n.context, 0, 1, randomBytes(32).toString('base64url'), n.owner));
  const before = n.stores[4].read(); offline = 3;
  await expect(writer.replicate(b)).rejects.toThrow('Four');
  expect(actions).toEqual(['head']); expect(n.stores[4].read()).toEqual(before); expect(writer.read().pending).toEqual(b);
});

it('cannot turn a repaired prefix into a fourth acknowledgement when recovery freezes the member before the pending append', async () => {
  const n = fixture(); let offline = 4, freeze = false;
  const writer = n.writer(true, { transport: async (member, frame, signal) => {
    const i = n.context.members.indexOf(member.publicKey); if (i === offline) throw new Error('offline');
    const result = await n.transport(member, frame, signal);
    if (freeze && i === 4 && frame.request.action === 'append' && frame.request.sequence === 1) {
      n.stores[4].freeze(createHistoryFreeze(n.context, 0, 1, randomBytes(32).toString('base64url'), n.owner));
    }
    return result;
  } });
  await writer.replicate(n.root); const a = n.next(n.root); await writer.replicate(a); n.retained.push(a);
  offline = 3; freeze = true; const b = n.next(a);
  await expect(writer.replicate(b)).rejects.toThrow('Four');
  expect(n.stores[4].describe().sequence).toBe(1); expect(n.stores[4].describe().freeze).not.toBeNull();
  expect(writer.read().committed?.envelope).toEqual(a); expect(writer.read().pending).toEqual(b);
});

it('stops after close during retained traversal before any socket or signature request can escape', async () => {
  const n = fixture(); let calls = 0;
  const writer = n.writer(true, { retained: function* () { writer.close(); yield n.root; },
    transport: async (...args) => { calls++; return n.transport(...args); } });
  await expect(writer.replicate(n.root)).rejects.toThrow('cancelled'); expect(calls).toBe(0);
});

it('bounds a silent head transport with the same whole-write deadline and keeps the exact pending payload', async () => {
  const n = fixture(); let calls = 0;
  const writer = n.writer(true, { timeoutMs: 1000, transport: async () => { calls++; return new Promise(() => {}); } });
  await expect(writer.replicate(n.root)).rejects.toThrow('Four'); expect(calls).toBe(5);
  expect(writer.read().pending).toEqual(n.root); expect(writer.read().committed).toBeNull();
});
