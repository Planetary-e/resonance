import { afterEach, describe, expect, it, vi } from 'vitest';
import { fsyncSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createHistoryFreeze, historyCheckpointEnvelopeId, historyDigest, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, createHistoryExchangeResponse, parseHistoryRecoveryPreparation } from '@resonance/core/history-exchange';
import { createHistoryCheckpointRecovery, HISTORY_RECOVERY_FILENAME } from '../history-checkpoint-recovery.js';
import { createHistoryCheckpointReplica, type HistoryCheckpointTransport } from '../history-checkpoint-exchange.js';
import { createHistoryCheckpointWriter } from '../history-checkpoint-quorum.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
const clean: Array<() => void> = [];
afterEach(() => { vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); for (const close of clean.splice(0).reverse()) close(); });
function network() {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'history-recovery-'));
  clean.push(() => rmSync(directory, { recursive: true, force: true }));
  const stores = f.context.members.map((replica, i) => openHistoryCheckpointStore({ ...f.options, replica,
    directory: join(directory, `r${i}`), initialize: f.root }));
  stores.forEach(s => clean.push(() => s.close()));
  const roles = stores.map((store, i) => createHistoryCheckpointReplica({ context: f.context, store, signingKey: f.memberKeys[i] }));
  roles.forEach(r => clean.push(() => r.close()));
  const members = f.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${21000 + i}/history-checkpoint` }));
  const transport: HistoryCheckpointTransport = async (m, frame) => roles[f.context.members.indexOf(m.publicKey)].exchange(frame);
  const options = { directory: join(directory, 'recovery'), localKey: f.localKey, context: f.context, signingKey: f.owner,
    rootId: f.options.rootId, generation: 0, nextGeneration: 1, members, transport };
  const recovery = (initialize = true, changes: Partial<Parameters<typeof createHistoryCheckpointRecovery>[0]> = {}) => {
    const result = createHistoryCheckpointRecovery({ ...options, ...changes, initialize }); clean.push(() => result.close()); return result;
  };
  return { ...f, directory, stores, roles, members, options, transport, recovery };
}

// Real signature verification and fsync on five stores need room on shared CI CPUs.
describe('history recovery preparation', { timeout: 30_000 }, () => {
it('freezes four complete histories, preserves the newest partial tail and persists evidence before returning', async () => {
  const n = network(), a = n.next(n.root), b = n.next(a);
  n.stores[0].append(a); n.stores[0].append(b); n.stores[1].append(a);
  let cancelled = false;
  const transport: HistoryCheckpointTransport = (m, f, s) => m.publicKey === n.members[4].publicKey
    ? new Promise((_, reject) => s.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true }))
    : n.transport(m, f, s);
  let recovery = n.recovery(true, { transport });
  const prepared = await recovery.prepare();
  expect(parseHistoryRecoveryPreparation(prepared, n.context)).toEqual(prepared);
  expect(prepared.envelopes).toEqual([n.root, a, b]); expect(cancelled).toBe(true);
  expect(prepared.receipts).toHaveLength(4); expect(recovery.read().attempt).toBeNull();
  expect(recovery.read().prepared).toEqual(prepared);
  expect(readFileSync(join(n.options.directory, HISTORY_RECOVERY_FILENAME), 'utf8')).not.toContain(n.options.rootId);
  n.stores.slice(0, 4).forEach(store => expect(() => store.append(n.root)).toThrow('frozen'));
  recovery.close(); const spy = vi.fn(transport); recovery = n.recovery(false, { transport: spy });
  expect(spy).not.toHaveBeenCalled(); expect(recovery.read().prepared).toEqual(prepared);
  const repeated = await recovery.prepare();
  expect(repeated.receipts[0].request.challenge).not.toBe(prepared.receipts[0].request.challenge);
  expect(repeated.envelopes).toEqual(prepared.envelopes);
});

it('requires four complete payloads, not four freeze receipts and only three readable copies', async () => {
  const n = network(); let repaired = false;
  const transport: HistoryCheckpointTransport = (m, f, s) => !repaired && f.request.action === 'read'
    && n.context.members.indexOf(m.publicKey) >= 3 ? Promise.reject(new Error('unavailable payload')) : n.transport(m, f, s);
  const recovery = n.recovery(true, { transport });
  await expect(recovery.prepare()).rejects.toThrow('Four');
  expect(n.stores.every(s => s.describe().freeze !== null)).toBe(true);
  expect(recovery.read().prepared).toBeNull(); expect(recovery.read().attempt).not.toBeNull();
  repaired = true; expect((await recovery.prepare()).envelopes).toEqual([n.root]);
});

it.each(['deadline', 'malformed', 'transport'] as const)('reports bounded redacted member diagnostics for %s refusal', async fault => {
  const n = network(), sensitive = `private-payload ${n.members[0].publicKey} ${n.members[0].endpoint}`;
  let clock = performance.now();
  const clockSpy = fault === 'deadline' ? vi.spyOn(performance, 'now').mockImplementation(() => clock) : undefined;
  const transport: HistoryCheckpointTransport = async (member, frame, signal) => {
    if (fault === 'deadline') clock += 1001;
    if (fault === 'transport') throw new Error(sensitive);
    if (fault === 'malformed') return { secret: sensitive };
    return n.transport(member, frame, signal);
  };
  const recovery = n.recovery(true, { transport, timeoutMs: 1000 });
  let error: Error;
  try { error = await recovery.prepare().then(() => { throw new Error('Unexpected recovery success'); }, error => error); }
  finally { clockSpy?.mockRestore(); }
  const prefix = 'Four complete frozen histories unavailable: ';
  expect(error.message.startsWith(prefix)).toBe(true);
  const diagnostic = JSON.parse(error.message.slice(prefix.length));
  expect(diagnostic.completed).toBe(0);
  expect(diagnostic.failed + diagnostic.pending).toBe(5);
  expect(diagnostic.members).toHaveLength(5);
  expect(error.message.length).toBeLessThan(1200);
  expect(error.message).not.toContain(sensitive);
  expect(error.message).not.toContain(n.options.rootId);
  const reason = fault === 'malformed' ? 'invalid-response' : fault;
  for (const [index, member] of diagnostic.members.entries()) {
    expect(Object.keys(member).sort()).toEqual(['deadline', 'elapsedMs', 'index', 'phase', 'reads', 'reason']);
    expect(member.index).toBe(index); expect(member.reads).toBe(0);
    expect(member.reason).toBe(reason); expect(member.deadline).toBe(fault === 'deadline');
    expect(member.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(error.message).not.toContain(n.members[index].publicKey);
    expect(error.message).not.toContain(n.members[index].endpoint);
  }
  expect(recovery.read().prepared).toBeNull(); expect(recovery.read().attempt).not.toBeNull();
});

it('retains bounded diagnostics on external close cancellation without accepting a preparation', async () => {
  const n = network(), transport = vi.fn<HistoryCheckpointTransport>(() => new Promise(() => {}));
  const recovery = n.recovery(true, { transport });
  const pending = recovery.prepare(); await Promise.resolve(); recovery.close();
  const error = await pending.then(() => { throw new Error('Unexpected recovery success'); }, error => error);
  const prefix = 'History recovery cancelled: ';
  expect(error.message.startsWith(prefix)).toBe(true);
  const diagnostic = JSON.parse(error.message.slice(prefix.length));
  expect(diagnostic).toMatchObject({ completed: 0, failed: 0, pending: 5 });
  expect(diagnostic.members).toHaveLength(5);
  expect(diagnostic.members.every((member: { reason: string }) => member.reason === 'cancelled')).toBe(true);
  expect(error.message.length).toBeLessThan(1200);
  const reopened = n.recovery(false); expect(reopened.read().prepared).toBeNull();
});

it('survives lost freeze replies and restart but never accepts replies from an earlier attempt', async () => {
  const n = network(), old = new Map<string, unknown>();
  let recovery = n.recovery(true, { transport: async (m, f, s) => { old.set(m.publicKey, await n.transport(m, f, s)); throw new Error('lost'); } });
  await expect(recovery.prepare()).rejects.toThrow('Four'); const first = recovery.read().attempt;
  recovery.close(); recovery = n.recovery(false, { transport: async m => old.get(m.publicKey) });
  await expect(recovery.prepare()).rejects.toThrow('Four'); expect(recovery.read().attempt?.freeze.challenge).not.toBe(first?.freeze.challenge);
  recovery.close(); recovery = n.recovery(false); expect((await recovery.prepare()).receipts).toHaveLength(4);
});

it.each(['signature', 'missing', 'ancestry', 'head', 'capacity', 'barrier'])('excludes an invalid %s response and cannot count two bad replicas', async fault => {
  const n = network(), a = n.next(n.root), b = n.next(a);
  n.stores.forEach(s => { s.append(a); s.append(b); }); let badCount = 1;
  const transport: HistoryCheckpointTransport = async (m, f, s) => {
    const i = n.context.members.indexOf(m.publicKey), response = await n.transport(m, f, s) as ReturnType<typeof createHistoryExchangeResponse>;
    if (i >= badCount) return response;
    if (fault === 'signature') return { ...response, signature: randomBytes(64).toString('base64url') };
    if (fault === 'capacity' && f.request.action === 'freeze') return createHistoryExchangeResponse(f.request, 'frozen',
      { ...response.head, sequence: 10001 }, null, n.context, n.memberKeys[i]);
    if (f.request.action !== 'read') return response;
    if (fault === 'missing') throw new Error('missing payload');
    if (fault === 'ancestry' && f.request.sequence === 1) return createHistoryExchangeResponse(f.request, 'block', response.head,
      sealHistoryCheckpoint({ context: n.context, signingKey: n.owner, encryptionKey: n.key, plaintext: Buffer.from('bad chain'),
        header: { kind: 'delta', generation: 0, sequence: 1, previous: historyDigest('not root') } }), n.context, n.memberKeys[i]);
    if (fault === 'head') return createHistoryExchangeResponse(f.request, 'block',
      { ...response.head, sequence: 3, envelopeId: historyDigest('changed') }, response.envelope, n.context, n.memberKeys[i]);
    if (fault === 'barrier') return createHistoryExchangeResponse(f.request, 'block', { ...response.head,
      freeze: createHistoryFreeze(n.context, 0, 2, f.request.challenge, n.owner) }, response.envelope, n.context, n.memberKeys[i]);
    return response;
  };
  const recovery = n.recovery(true, { transport }); expect((await recovery.prepare()).envelopes).toEqual([n.root, a, b]);
  badCount = 2; await expect(recovery.prepare()).rejects.toThrow('Four');
});

it('refuses collected owner-authenticated forks and regression behind locally retained preparation evidence', async () => {
  const n = network(), a = n.next(n.root, 'A'), b = n.next(n.root, 'B');
  n.stores[0].append(a); n.stores[1].append(b);
  const recovery = n.recovery(true, { transport: (m, f, s) => m.publicKey === n.members[4].publicKey
    ? Promise.reject(new Error('offline')) : n.transport(m, f, s) });
  await expect(recovery.prepare()).rejects.toThrow('conflict');
  expect(recovery.read().prepared).toBeNull();
  const p = network(), tail = p.next(p.root); p.stores[0].append(tail);
  let omit = 4;
  const r = p.recovery(true, { transport: (m, f, s) => m.publicKey === p.members[omit].publicKey
    ? Promise.reject(new Error('offline')) : p.transport(m, f, s) });
  expect((await r.prepare()).envelopes).toHaveLength(2);
  omit = 0; await expect(r.prepare()).rejects.toThrow('regress');
  expect(r.read().prepared?.envelopes).toEqual([p.root, tail]);
});

it('persists intent before network activity and refuses success after an uncertain preparation flush', async () => {
  const n = network(), spy = vi.fn(n.transport); let recovery = n.recovery(true, { transport: spy });
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('intent flush'); });
  await expect(recovery.prepare()).rejects.toThrow('intent flush'); expect(spy).not.toHaveBeenCalled(); recovery.close();
  let reads = 0;
  recovery = n.recovery(false, { transport: async (m, f, s) => {
    const response = await n.transport(m, f, s);
    if (f.request.action === 'read' && ++reads === 4) vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('preparation flush'); });
    return response;
  } });
  await expect(recovery.prepare()).rejects.toThrow('preparation flush');
  expect(() => recovery.read()).toThrow('write failed'); recovery.close();
  recovery = n.recovery(false); expect(recovery.read().prepared).toBeNull(); expect(recovery.read().attempt).not.toBeNull();
  expect((await recovery.prepare()).receipts).toHaveLength(4);
});

it('returns no freeze receipt before a durable barrier and rejects substituted freeze commands', () => {
  const n = network(), challenge = randomBytes(32).toString('base64url');
  const request = createHistoryExchangeRequest({ action: 'freeze', generation: 0, rootId: n.options.rootId, replica: n.context.members[0],
    sequence: 1, envelopeId: null, challenge, issuedAt: Date.now(), expiresAt: Date.now() + 10000 }, n.context, n.owner);
  const freeze = createHistoryFreeze(n.context, 0, 1, challenge, n.owner);
  expect(() => n.roles[0].exchange({ request, envelope: null })).toThrow();
  expect(() => n.roles[0].exchange({ request, envelope: null,
    freeze: createHistoryFreeze(n.context, 0, 1, randomBytes(32).toString('base64url'), n.owner) })).toThrow('mismatch');
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('barrier flush'); });
  expect(() => n.roles[0].exchange({ request, envelope: null, freeze })).toThrow('barrier flush');
  expect(() => n.roles[0].exchange({ request, envelope: null, freeze })).toThrow('write failed');
});

it('preserves a completed old write racing the freeze and then refuses further old-generation acknowledgements', async () => {
  const n = network(), writer = createHistoryCheckpointWriter({ ...n.options, directory: join(n.directory, 'writer'), initialize: true });
  clean.push(() => writer.close()); await writer.replicate(n.root);
  const tail = n.next(n.root), recovery = n.recovery();
  const [written, prepared] = await Promise.allSettled([writer.replicate(tail), recovery.prepare()]);
  expect(written.status).toBe('fulfilled');
  expect(prepared.status).toBe('fulfilled');
  if (written.status === 'fulfilled' && prepared.status === 'fulfilled') expect(prepared.value.envelopes).toContainEqual(tail);
  await expect(writer.replicate(tail)).rejects.toThrow('Four');
});

it('bounds attempts, rejects late replies after cancellation, and lets a higher concurrent barrier supersede collection', async () => {
  const n = network(), deliveries: Array<() => void> = [];
  let recovery = n.recovery(true, { transport: (m, f) => new Promise(resolve => {
    deliveries.push(() => resolve(n.roles[n.context.members.indexOf(m.publicKey)].exchange(f)));
  }), timeoutMs: 1000 });
  let timerDiagnostic: { pending: number; members: Array<{ phase: string }> } | undefined;
  const attempt = recovery.prepare().catch(error => {
    timerDiagnostic = JSON.parse(error.message.slice('Four complete frozen histories unavailable: '.length));
    throw error;
  }), failed = expect(attempt).rejects.toThrow('Four');
  await expect(recovery.prepare()).rejects.toThrow('active'); await failed; expect(deliveries).toHaveLength(5);
  expect(timerDiagnostic?.pending).toBe(5); expect(timerDiagnostic?.members).toHaveLength(5);
  expect(timerDiagnostic?.members.every(member => member.phase === 'transport')).toBe(true);
  deliveries.splice(0).forEach(deliver => expect(deliver).toThrow('expired')); recovery.close();
  recovery = n.recovery(false, { transport: () => new Promise(() => {}) });
  const cancelled = expect(recovery.prepare()).rejects.toThrow('cancelled'); recovery.close(); await cancelled;
  const p = network(); let raised = false;
  const lower = p.recovery(true, { transport: (m, f, s) => {
    if (f.request.action === 'read' && !raised) { raised = true;
      p.stores.forEach(store => store.freeze(createHistoryFreeze(p.context, 0, 2, randomBytes(32).toString('base64url'), p.owner))); }
    return p.transport(m, f, s);
  } });
  await expect(lower.prepare()).rejects.toThrow('Four');
  const higher = p.recovery(true, { directory: join(p.directory, 'higher'), nextGeneration: 2 });
  expect((await higher.prepare()).nextGeneration).toBe(2);
}, 15000);

it('refuses missing state, invalid pins and attempts to reinterpret a preparation with another barrier', async () => {
  const n = network(); expect(() => n.recovery(false)).toThrow('missing');
  expect(() => n.recovery(true, { nextGeneration: 0 })).toThrow('configuration');
  expect(() => n.recovery(true, { members: [n.members[0], ...n.members.slice(0, 4)] })).toThrow('distinct');
  expect(() => n.recovery(true, { members: n.members.map(m => ({ ...m, endpoint: 'ws://public.example/' })) })).toThrow('wss');
  const recovery = n.recovery(); await recovery.prepare(); recovery.close();
  expect(() => n.recovery(false, { nextGeneration: 2 })).toThrow('state is invalid');
});
});
