import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { createHistoryFreeze, historyCheckpointContextId, historyCheckpointEnvelopeId, openHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, parseHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal, historySuccessorProposalId } from '@resonance/core/history-successor';
import { createHistoryContinuationRoot } from '@resonance/core/history-continuation';
import { createHistoryAgreementReplica } from '../history-checkpoint-agreement.js';
import { createHistoryAgreementCoordinator } from '../history-agreement-coordinator.js';
import { createHistoryCheckpointReplica, type HistoryCheckpointTransport } from '../history-checkpoint-exchange.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { HISTORY_WRITER_FILENAME } from '../history-checkpoint-quorum.js';
import { HISTORY_WRITER_ARCHIVE_FILENAME } from '../history-writer-archive.js';
import { openProtectedIssuerHistory, protectedIssuerReplayDigest, type ProtectedIssuerHistoryOptions, type ProtectedIssuerHistoryState } from '../protected-issuer-history.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, renameSync: vi.fn(fs.renameSync) }; });
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => void> = [];
afterEach(() => { vi.mocked(renameSync).mockReset().mockImplementation(actual.renameSync); for (const close of cleanup.splice(0).reverse()) close(); });
interface Image { version: 9; grants: string[]; padding: string }
const initial: Image = { version: 9, grants: [], padding: '' };
function validate(value: unknown): Image {
  const image = value as Image;
  if (!image || image.version !== 9 || !Array.isArray(image.grants) || !image.grants.every(v => typeof v === 'string') || typeof image.padding !== 'string'
    || Object.keys(image).sort().join(',') !== 'grants,padding,version') throw new Error('Invalid test issuer image');
  return structuredClone(image);
}
async function fixture(limits: { maxArchiveBlocks?: number; maxArchiveBytes?: number } = {}) {
  const h = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'protected-issuer-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const context = { ...h.context, role: 'admission-issuer' as const }, path = join(directory, 'issuer.json'), writerDirectory = join(directory, 'writer');
  const members = context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${29000 + i}/history-checkpoint` }));
  let calls = 0, online = 5, gate: Promise<void> | undefined;
  const stores: ReturnType<typeof openHistoryCheckpointStore>[] = [], roles: ReturnType<typeof createHistoryCheckpointReplica>[] = [];
  const transport: HistoryCheckpointTransport = async (member, frame) => {
    calls++; const index = context.members.indexOf(member.publicKey); if (index >= online) throw new Error('offline');
    if (gate) await gate; return roles[index].exchange(frame);
  };
  const options: ProtectedIssuerHistoryOptions<Image> = { path, writerDirectory, domain: 'test:issuer-local-state:v1', encryptionKey: h.key,
    context, signingKey: h.owner, members, initial, validate, timeoutMs: 1000, transport, ...limits };
  let history = await openProtectedIssuerHistory({ ...options, initialize: true, initializeWriter: true });
  cleanup.push(() => history.close()); expect(calls).toBe(0);
  const { root } = history.enrollment();
  for (let i = 0; i < 5; i++) {
    const store = openHistoryCheckpointStore({ directory: join(directory, `replica-${i}`), context, replica: context.members[i], localKey: h.localKey,
      rootId: historyCheckpointEnvelopeId(root), generation: 0, initialize: root });
    stores.push(store); cleanup.push(() => store.close()); const role = createHistoryCheckpointReplica({ context, store, signingKey: h.memberKeys[i] }); roles.push(role); cleanup.push(() => role.close());
  }
  return { ...h, context, directory, path, writerDirectory, stores, options, get history() { return history; }, calls: () => calls,
    online: (value: number) => { online = value; }, gate: (value?: Promise<void>) => { gate = value; },
    async reopen() { history.close(); history = await openProtectedIssuerHistory(options); return history; } };
}
it('opens offline under a distinct signed role and requires four fresh exact-head copies before serving on every restart', async () => {
  const n = await fixture(); expect(n.history.read()).toEqual(initial); expect(() => n.history.assertServing()).toThrow('readiness');
  expect(historyCheckpointContextId(n.context)).not.toBe(historyCheckpointContextId({ ...n.context, role: 'relay-admission-spends' }));
  n.online(3); await expect(n.history.ready()).rejects.toThrow('Four'); expect(n.history.status()).toMatchObject({ ready: false, pending: true, applied: null });
  n.online(4); await n.history.ready(); n.history.assertServing(); expect(n.history.status()).toMatchObject({ ready: true, pending: false, applied: { sequence: 0 } });
  const read = n.history.read(); read.grants.push('caller-mutation'); expect(n.history.read()).toEqual(initial);
  const before = n.calls(), reopened = await n.reopen(); expect(n.calls()).toBe(before); expect(reopened.status().ready).toBe(false);
  n.online(3); await expect(reopened.ready()).rejects.toThrow('Four'); expect(() => reopened.assertServing()).toThrow('readiness');
  n.online(4); await reopened.ready(); reopened.assertServing(); expect(n.calls()).toBeGreaterThan(before);
});
it('retains the exact pending full image with three copies and applies it once after restart with four', async () => {
  const n = await fixture(); await n.history.ready(); n.online(3); const next: Image = { ...initial, grants: ['assignment-one'] };
  const input = structuredClone(next), pending = n.history.commit(input); input.grants[0] = 'caller-mutated';
  await expect(pending).rejects.toThrow('Four'); expect(n.history.read()).toEqual(initial); expect(n.history.status()).toMatchObject({ pending: true, ready: false });
  expect(() => n.history.assertServing()).toThrow('readiness');
  const envelope = n.stores[0].read().envelopes[1]; expect(JSON.parse(openHistoryCheckpoint(envelope, n.context, n.key).toString())).toEqual(next);
  await expect(n.history.commit({ ...initial, grants: ['unrelated'] })).rejects.toThrow('readiness');
  const reopened = await n.reopen(); expect(reopened.read()).toEqual(initial); n.online(4); await reopened.ready();
  expect(reopened.read()).toEqual(next); expect(reopened.status().applied?.id).toBe(historyCheckpointEnvelopeId(envelope));
  expect(n.stores.filter(s => s.describe().envelopeId === historyCheckpointEnvelopeId(envelope)).length).toBeGreaterThanOrEqual(4);
  const calls = n.calls(); await reopened.commit(next); expect(n.calls()).toBe(calls); expect(reopened.status().applied?.sequence).toBe(1);
});
it('persists the quorum certificate before owner apply and requires fresh readiness after a certificate-before-apply restart', async () => {
  const n = await fixture(); await n.history.ready(); let writes = 0;
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === n.path && ++writes === 2) throw new Error('owner apply failed'); actual.renameSync(from, to); });
  const next: Image = { ...initial, grants: ['signed-response'] };
  await expect(n.history.commit(next)).rejects.toThrow('owner apply failed'); expect(() => n.history.read()).toThrow('write failed'); n.history.close();
  vi.mocked(renameSync).mockImplementation(actual.renameSync);
  const raw = openEncryptedLocalState<any>({ path: join(n.writerDirectory, HISTORY_WRITER_FILENAME), key: n.key, domain: 'resonance:history-checkpoint-writer:v1',
    maxBytes: 40 * 1024 * 1024, initial: {}, mode: 'open-existing', validate: (value): value is any => !!value });
  expect(raw.read().committed.certificate.receipts).toHaveLength(4); expect(raw.read().committed.envelope.sequence).toBe(1); expect(raw.read().pending).toBeNull(); raw.close();
  const reopened = await n.reopen(); expect(reopened.read()).toEqual(initial); n.online(0);
  await expect(reopened.ready()).rejects.toThrow('Four'); expect(reopened.read()).toEqual(next); expect(() => reopened.assertServing()).toThrow('readiness');
  n.online(4); await reopened.ready(); reopened.assertServing(); expect(reopened.status().applied?.sequence).toBe(1);
});
it('fences same-file local reopening, missing owner/writer/archive files and initialization-based reset', async () => {
  const n = await fixture(); await n.history.ready(); n.history.close();
  expect(() => openEncryptedLocalState<Image>({ path: n.path, key: n.key, domain: n.options.domain, maxBytes: 32 * 1024 * 1024, initial,
    mode: 'open-existing', validate: (value): value is Image => { try { validate(value); return true; } catch { return false; } } })).toThrow('invalid');
  await expect(openProtectedIssuerHistory({ ...n.options, initializeWriter: true })).rejects.toThrow('fresh owner');
  const owner = readFileSync(n.path), writerPath = join(n.writerDirectory, HISTORY_WRITER_FILENAME), writer = readFileSync(writerPath);
  rmSync(n.path); await expect(openProtectedIssuerHistory(n.options)).rejects.toThrow('missing'); expect(existsSync(n.path)).toBe(false); writeFileSync(n.path, owner);
  rmSync(writerPath); await expect(openProtectedIssuerHistory(n.options)).rejects.toThrow('missing'); expect(existsSync(writerPath)).toBe(false); writeFileSync(writerPath, writer);
  rmSync(join(n.writerDirectory, 'payloads'), { recursive: true }); await expect(openProtectedIssuerHistory(n.options)).rejects.toThrow();
  expect(existsSync(join(n.writerDirectory, 'payloads'))).toBe(false);
});
it('checks two-checkpoint headroom, logical and outer bounds before any intent or replication', async () => {
  const n = await fixture({ maxArchiveBlocks: 2 }); await n.history.ready(); const before = readFileSync(n.path), calls = n.calls();
  await expect(n.history.assertCapacity([{ ...initial, grants: ['prepared'] }, { ...initial, grants: ['completed'] }])).rejects.toThrow('capacity');
  expect(readFileSync(n.path)).toEqual(before); expect(n.calls()).toBe(calls); expect(n.history.status().pending).toBe(false);
  await n.history.ready(); await n.history.assertCapacity([{ ...initial, grants: ['prepared'] }]);
  expect(n.history.status().applied?.sequence).toBe(0); await n.history.commit({ ...initial, grants: ['prepared'] });
  const applied = readFileSync(n.path), position = n.calls(); await expect(n.history.commit({ ...initial, grants: ['completed'] })).rejects.toThrow('capacity');
  expect(readFileSync(n.path)).toEqual(applied); expect(n.calls()).toBe(position); expect(n.history.status().pending).toBe(false);
  const h = historyCheckpointFixture(), directory = join(n.directory, 'bounds');
  const options = { ...n.options, path: join(directory, 'issuer.json'), writerDirectory: join(directory, 'writer'), encryptionKey: h.key };
  await expect(openProtectedIssuerHistory({ ...options, initialize: true, initializeWriter: true, maxArchiveBytes: 1 })).rejects.toThrow('before intent'); expect(existsSync(options.path)).toBe(false);
  await expect(openProtectedIssuerHistory({ ...options, initialize: true, initial: { ...initial, padding: 'p'.repeat(8 * 1024 * 1024) } })).rejects.toThrow('payload capacity'); expect(existsSync(options.path)).toBe(false);
  await expect(openProtectedIssuerHistory({ ...options, initialize: true, initial: { ...initial, padding: 'p'.repeat(7 * 1024 * 1024) } })).rejects.toThrow('outer state capacity'); expect(existsSync(options.path)).toBe(false);
});
it('bounds concurrent operations and aborts close before releasing an unfinished image', async () => {
  const n = await fixture(); await n.history.ready(); let release!: () => void; n.gate(new Promise<void>(resolve => { release = resolve; }));
  const next: Image = { ...initial, grants: ['pending-response'] }, pending = n.history.commit(next), refusal = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(n.history.status().pending).toBe(true));
  await expect(n.history.ready()).rejects.toThrow('in progress'); n.history.close(); release(); await refusal;
  expect(() => n.history.assertServing()).toThrow('closed'); n.gate(); const reopened = await n.reopen(); await reopened.ready(); expect(reopened.read()).toEqual(next);
});
it('detects owner-image tampering and owner-only rollback against retained signed checkpoints', async () => {
  const n = await fixture(); await n.history.ready(); const old = readFileSync(n.path); await n.history.commit({ ...initial, grants: ['durable-decision'] }); n.history.close();
  const raw = openEncryptedLocalState<any>({ path: n.path, key: n.key, domain: n.options.domain, maxBytes: 32 * 1024 * 1024, initial: {}, mode: 'open-existing', validate: (value): value is any => !!value });
  const state = raw.read(); raw.write({ ...state, image: initial }); raw.close();
  await expect(openProtectedIssuerHistory(n.options)).rejects.toThrow('signed checkpoint');
  writeFileSync(n.path, old); await expect(openProtectedIssuerHistory(n.options)).rejects.toThrow('histories disagree');
});

it('sends no volunteer replication when the first owner intent rename fails and reopens the previous exact applied image', async () => {
  const n = await fixture(); await n.history.ready();
  const before = n.history.status(), previous = n.history.read(), calls = n.calls(), ownerBytes = readFileSync(n.path);
  vi.mocked(renameSync).mockImplementationOnce((from, to) => {
    expect(String(to)).toBe(n.path); throw new Error('owner intent rename failed');
  });
  await expect(n.history.commit({ ...initial, grants: ['uncommitted-response'] })).rejects.toThrow('owner intent rename failed');
  expect(n.calls()).toBe(calls); expect(readFileSync(n.path)).toEqual(ownerBytes);
  expect(n.stores.every(store => store.describe().sequence === 0)).toBe(true);
  expect(() => n.history.assertServing()).toThrow('write failed'); n.history.close();
  vi.mocked(renameSync).mockImplementation(actual.renameSync);
  const reopened = await n.reopen(); expect(reopened.read()).toEqual(previous);
  expect(reopened.status()).toMatchObject({ pending: false, ready: false, applied: before.applied });
  await reopened.ready(); reopened.assertServing(); expect(reopened.read()).toEqual(previous);
  expect(reopened.status().applied).toEqual(before.applied);
});
it('refuses a coherent owner, writer and archive backup after a current owner advances the volunteer head', async () => {
  const n = await fixture(); await n.history.ready();
  const backupDirectory = join(n.directory, 'stale-owner'), backupWriter = join(backupDirectory, 'writer'), backupArchive = join(backupWriter, 'payloads');
  mkdirSync(backupArchive, { recursive: true });
  const backupPath = join(backupDirectory, 'issuer.json'); writeFileSync(backupPath, readFileSync(n.path));
  writeFileSync(join(backupWriter, HISTORY_WRITER_FILENAME), readFileSync(join(n.writerDirectory, HISTORY_WRITER_FILENAME)));
  for (const name of readdirSync(join(n.writerDirectory, 'payloads'))) {
    if (name === HISTORY_WRITER_ARCHIVE_FILENAME || /^[a-f0-9]{64}\.block$/.test(name)) {
      writeFileSync(join(backupArchive, name), readFileSync(join(n.writerDirectory, 'payloads', name)));
    }
  }
  const options = { ...n.options, path: backupPath, writerDirectory: backupWriter };
  let backup = await openProtectedIssuerHistory(options); cleanup.push(() => backup.close());
  await backup.ready(); backup.assertServing(); expect(backup.read()).toEqual(initial); backup.close();
  const accepted: Image = { ...initial, grants: ['accepted-current-owner-response'] };
  await n.history.commit(accepted); const acceptedHead = n.history.status().applied!;
  expect(n.stores.filter(store => store.describe().envelopeId === acceptedHead.id).length).toBeGreaterThanOrEqual(4);
  backup = await openProtectedIssuerHistory(options); expect(backup.status()).toMatchObject({ ready: false, pending: false, applied: { sequence: 0 } });
  await expect(backup.ready()).rejects.toThrow('Four'); expect(() => backup.assertServing()).toThrow('readiness');
  await expect(backup.commit({ ...initial, grants: ['stale-owner-conflicting-response'] })).rejects.toThrow('readiness');
  expect(backup.read()).toEqual(initial); expect(backup.status()).toMatchObject({ ready: false, pending: false, applied: { sequence: 0 } });
  expect(n.history.read()).toEqual(accepted); expect(n.history.status().applied).toEqual(acceptedHead);
  expect(n.stores.filter(store => store.describe().envelopeId === acceptedHead.id).length).toBeGreaterThanOrEqual(4);
  expect(n.stores.every(store => store.describe().sequence <= 1)).toBe(true);
});

async function restoredFixture() {
  const n = await fixture(); await n.history.ready();
  const baseline: Image = { ...initial, grants: ['retained-assignment'] }; await n.history.commit(baseline); n.history.close();
  const blocks = n.stores[0].read().envelopes, genesis = blocks[0], rootId = historyCheckpointEnvelopeId(genesis), issuedAt = Date.now(), challenge = randomBytes(32).toString('base64url');
  const freeze = createHistoryFreeze(n.context, 0, 1, challenge, n.owner);
  const receipts = await Promise.all(n.options.members.map(async member => {
    const request = createHistoryExchangeRequest({ action: 'freeze', rootId, generation: 0, replica: member.publicKey,
      challenge, issuedAt, expiresAt: issuedAt + 30000, sequence: 1, envelopeId: null }, n.context, n.owner);
    return parseHistoryExchangeResponse(await n.options.transport!(member, { request, envelope: null, freeze }, new AbortController().signal), request, n.context);
  }));
  const proposal = createHistorySuccessorProposal({ version: 1, kind: 'frozen-history', rootId, generation: 0, nextGeneration: 1,
    receipts: receipts.slice(0, 4), envelopes: blocks }, n.context, n.owner);
  const voters = n.stores.map((store, index) => createHistoryAgreementReplica({ context: n.context, store, signingKey: n.memberKeys[index] }));
  cleanup.push(() => voters.forEach(voter => voter.close()));
  const coordinator = createHistoryAgreementCoordinator({ directory: join(n.directory, 'agreement'), localKey: n.localKey, context: n.context,
    signingKey: n.owner, rootId, generation: 0, nextGeneration: 1, members: n.options.members, initialize: { proposal },
    transport: async (member, frame) => voters[n.context.members.indexOf(member.publicKey)].exchange(frame) }); cleanup.push(coordinator.close);
  const root = createHistoryContinuationRoot(proposal, await coordinator.run(), n.context);
  const roles = n.stores.map((parent, index) => {
    parent.activateContinuation(root);
    const store = openHistoryCheckpointStore({ directory: join(n.directory, `g1-replica-${index}`), context: n.context, replica: n.context.members[index], localKey: n.localKey,
      rootId: historyCheckpointEnvelopeId(root), generation: 1, initialize: root, parent }); cleanup.push(store.close);
    const role = createHistoryCheckpointReplica({ context: n.context, store, signingKey: n.memberKeys[index] }); cleanup.push(role.close); return role;
  });
  let online = 5;
  const options = { ...n.options, path: join(n.directory, 'restored.json'), writerDirectory: join(n.directory, 'restored-writer'),
    transport: async (member: { publicKey: string }, frame: Parameters<HistoryCheckpointTransport>[1]) => {
      const index = n.context.members.indexOf(member.publicKey); if (index >= online) throw new Error('offline'); return roles[index].exchange(frame);
    } };
  const restore = { genesis, root, baseline, replayDigest: protectedIssuerReplayDigest(historyCheckpointContextId(n.context), rootId, historySuccessorProposalId(root.proposal), baseline) };
  const open = () => openProtectedIssuerHistory({ ...options, initialize: true, initializeWriter: true, restore });
  return { ...n, baseline, options, restore, open, online(value: number) { online = value; } };
}

it('restores a certified continuation baseline, then authenticates new generation checkpoints and fresh readiness on reopen', async () => {
  const n = await restoredFixture(), history = await n.open(); cleanup.push(history.close);
  expect(history.read()).toEqual(n.baseline); expect(history.enrollment().root.kind).toBe('continuation');
  expect(history.status()).toMatchObject({ ready: false, pending: true, applied: null });
  n.online(3); await expect(history.ready()).rejects.toThrow('Four'); expect(history.read()).toEqual(n.baseline);
  n.online(4); await history.ready();
  await history.commit({ ...n.baseline, grants: [...n.baseline.grants, 'next-generation-assignment'] });
  history.close();
  const reopened = await openProtectedIssuerHistory(n.options); cleanup.push(reopened.close);
  expect(reopened.read().grants).toHaveLength(2); expect(reopened.status()).toMatchObject({ ready: false, applied: { sequence: 1 } });
  n.online(3); await expect(reopened.ready()).rejects.toThrow('Four'); n.online(4); await reopened.ready(); reopened.assertServing();
  reopened.close();
  const raw = openEncryptedLocalState<ProtectedIssuerHistoryState<Image>>({ path: n.options.path, key: n.key, domain: n.options.domain, maxBytes: 32 * 1024 * 1024,
    mode: 'open-existing', initial: {} as ProtectedIssuerHistoryState<Image>, validate: (value): value is ProtectedIssuerHistoryState<Image> => !!value });
  const state = raw.read(); expect(state.version).toBe(2);
  if (state.version !== 2) throw new Error('Expected restored state'); expect(state.restoration.baseline).toEqual(n.baseline); raw.close();
});

it('refuses altered restoration baselines, existing destinations and missing restored writer evidence', async () => {
  const n = await restoredFixture();
  await expect(openProtectedIssuerHistory({ ...n.options, initialize: true, initializeWriter: true,
    restore: { ...n.restore, baseline: { ...n.baseline, grants: [] } } })).rejects.toThrow('reviewed selected history');
  expect(existsSync(n.options.path)).toBe(false);
  mkdirSync(n.options.writerDirectory); writeFileSync(join(n.options.writerDirectory, 'existing'), 'retained');
  await expect(n.open()).rejects.toThrow('empty new writer'); rmSync(n.options.writerDirectory, { recursive: true });
  const history = await n.open(); cleanup.push(history.close); await history.ready(); history.close();
  await expect(n.open()).rejects.toThrow('new owner');
  const writerPath = join(n.options.writerDirectory, HISTORY_WRITER_FILENAME); rmSync(writerPath);
  await expect(openProtectedIssuerHistory(n.options)).rejects.toThrow('missing'); expect(existsSync(writerPath)).toBe(false);
});

it('applies a restored baseline after certificate-before-owner-apply crash while still requiring fresh current copies', async () => {
  const n = await restoredFixture(), history = await n.open(); cleanup.push(history.close);
  vi.mocked(renameSync).mockImplementation((from, to) => { if (String(to) === n.options.path) throw new Error('restore apply failed'); actual.renameSync(from, to); });
  await expect(history.ready()).rejects.toThrow('restore apply failed'); history.close(); vi.mocked(renameSync).mockImplementation(actual.renameSync);
  const reopened = await openProtectedIssuerHistory(n.options); cleanup.push(reopened.close); n.online(0);
  await expect(reopened.ready()).rejects.toThrow('Four'); expect(reopened.read()).toEqual(n.baseline); expect(reopened.status()).toMatchObject({ ready: false, pending: false, applied: { sequence: 0 } });
  n.online(4); await reopened.ready(); reopened.assertServing();
});

it.each(['baseline', 'image', 'genesis', 'version'])('rejects tampered persisted restored %s without substituting its baseline for the current signed head', async damage => {
  const n = await restoredFixture(), history = await n.open(); cleanup.push(history.close); await history.ready();
  await history.commit({ ...n.baseline, grants: [...n.baseline.grants, 'signed-new-generation'] }); history.close();
  const raw = openEncryptedLocalState<Record<string, any>>({ path: n.options.path, key: n.key, domain: n.options.domain, maxBytes: 32 * 1024 * 1024,
    mode: 'open-existing', initial: {}, validate: (value): value is Record<string, any> => !!value });
  const state = raw.read();
  if (damage === 'baseline') state.restoration.baseline.grants = [];
  if (damage === 'image') state.image = structuredClone(state.restoration.baseline);
  if (damage === 'genesis') state.restoration.genesis = state.root;
  if (damage === 'version') { state.version = 1; delete state.restoration; }
  raw.write(state); raw.close();
  await expect(openProtectedIssuerHistory(n.options)).rejects.toThrow();
});
