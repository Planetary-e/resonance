import { afterEach, expect, it } from 'vitest';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createAdmissionPolicyHeadRequest, parseAdmissionPolicyHeadVote } from '@resonance/core/admission-policy-freshness';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, openHistoryCheckpoint, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { createHistoryFreeze } from '@resonance/core/history-checkpoint';
import { createPolicyObserverHistoryRoot, openProtectedPolicyObserver, policyObserverHistoryContext } from '../protected-policy-observer.js';
import { createHistoryCheckpointReplica, exchangeHistoryCheckpoint, listenHistoryCheckpointReplica, type HistoryCheckpointTransport } from '../history-checkpoint-exchange.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { createRetainedHistoryCheckpointWriter } from '../history-retained-writer.js';
import { parseAdmissionHistoryConfiguration } from '../admission-history-config.js';
import { policyObserverFixture } from './fixtures/policy-observer-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }));
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(limits: { maxArchiveBlocks?: number; maxArchiveBytes?: number } = {}) {
  const f = await policyObserverFixture(); cleanup.push(f.close);
  const enrolled = await createPolicyObserverHistoryRoot({ context: f.context, signingKey: f.keys[0], encryptionKey: f.options.encryptionKey, policy: f.first, now: () => f.now });
  const stores = enrolled.context.members.map((replica, i) => openHistoryCheckpointStore({ directory: join(f.directory, `r${i}`), context: enrolled.context,
    replica, localKey: randomBytes(32), rootId: historyCheckpointEnvelopeId(enrolled.root), generation: 0, initialize: enrolled.root }));
  stores.forEach(store => cleanup.push(store.close));
  const roles = stores.map((store, i) => createHistoryCheckpointReplica({ context: enrolled.context, store,
    signingKey: f.keys.find(key => Buffer.from(key.publicKey).toString('base64url') === enrolled.context.members[i])! }));
  roles.forEach(role => cleanup.push(role.close));
  const listeners: Awaited<ReturnType<typeof listenHistoryCheckpointReplica>>[] = [];
  for (const role of roles) { const listener = await listenHistoryCheckpointReplica(role, { port: 0 }); listeners.push(listener); cleanup.push(listener.close); }
  const members = enrolled.context.members.map((publicKey, i) => ({ publicKey, endpoint: listeners[i].endpoint }));
  let online = new Set([0, 1, 2, 3, 4]), lost = false, gate: Promise<void> | undefined, calls = 0, time = f.now;
  const transport: HistoryCheckpointTransport = async (member, frame, signal) => {
    calls++; if (!online.has(enrolled.context.members.indexOf(member.publicKey))) throw new Error('volunteer offline');
    if (gate) await gate;
    const response = await exchangeHistoryCheckpoint(member, frame, signal);
    if (lost && frame.request.action === 'append') throw new Error('durable reply lost');
    return response;
  };
  const options = { directory: join(f.directory, 'owner'), encryptionKey: f.options.encryptionKey, context: f.context, signingKey: f.keys[0],
    historyContext: enrolled.context, root: enrolled.root, members, transport, timeoutMs: 2500, now: () => time, ...limits };
  async function open(mode: 'create-new' | 'open-existing' = 'open-existing', overrides: Partial<typeof options> = {}) {
    const observer = await openProtectedPolicyObserver({ ...options, ...overrides, mode }); cleanup.push(observer.close); return observer;
  }
  const observer = await open('create-new'); expect(calls).toBe(0);
  return { ...f, enrolled, stores, roles, members, listeners, options, observer, open,
    calls: () => calls, online: (...indices: number[]) => { online = new Set(indices); }, lost: (value: boolean) => { lost = value; },
    gate: (value?: Promise<void>) => { gate = value; }, time: (value: number) => { time = value; } };
}

it('requires four current durable heads per observation and repairs a different returning fourth volunteer', async () => {
  const n = await fixture(), observer = n.observer; n.online(0, 1, 2, 3); await observer.ready();
  await observer.advance(n.advance); expect(n.stores.slice(0, 4).map(store => store.describe().sequence)).toEqual([1, 1, 1, 1]);
  expect(n.stores[4].describe().sequence).toBe(0);
  const request = createAdmissionPolicyHeadRequest(n.context, n.now);
  n.online(0, 1, 2); await expect(observer.observe(request)).rejects.toThrow('Four');
  n.online(0, 1, 2, 4);
  expect(parseAdmissionPolicyHeadVote(await observer.observe(request), request, n.context, n.now).head).toEqual(n.advance.commitment.next);
  expect(n.stores[4].describe().sequence).toBe(1);
  const bytes = readFileSync(join(n.options.directory, 'history-writer.json'));
  expect(bytes.toString()).not.toContain(n.authority); observer.close();
  const reopened = await n.open(); expect(reopened.policy()).toEqual(n.second);
  expect((await reopened.observe(request)).head).toEqual(n.advance.commitment.next);
});

it('fences a coherent stale backup even if it was already open and previously passed readiness', async () => {
  const n = await fixture(); await n.observer.ready(); n.observer.close();
  const backup = join(n.directory, 'backup'); cpSync(n.options.directory, backup, { recursive: true });
  const current = await n.open(), stale = await n.open('open-existing', { directory: backup }); await stale.ready();
  expect((await stale.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).head).toEqual(n.context.genesis);
  await current.advance(n.advance);
  await expect(stale.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).rejects.toThrow('Four');
  await expect(stale.ready()).rejects.toThrow('Four');
  await expect(stale.advance(n.conflict)).rejects.toThrow('Four');
  expect(stale.status().pending).toBe(true);
  expect((await current.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).head).toEqual(n.advance.commitment.next);
  stale.close(); const restored = await n.open('open-existing', { directory: backup });
  await expect(restored.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).rejects.toThrow('pending');
  await expect(restored.ready()).rejects.toThrow('Four');
});

it('serves exact signed retained successors after restart without a network quorum or reconstructed history', async () => {
  const n = await fixture(); await n.observer.ready(); await n.observer.advance(n.advance); await n.observer.advance(n.later);
  n.observer.close(); const observer = await n.open(), calls = n.calls(); n.online();
  expect(await observer.successor(n.context.genesis)).toEqual(n.advance);
  expect(await observer.successor(n.advance.commitment.next)).toEqual(n.later);
  expect(n.calls()).toBe(calls);
  await expect(observer.successor({ ...n.context.genesis, transition: 'a'.repeat(64) })).rejects.toThrow('differs');
  await expect(observer.successor(n.later.commitment.next)).rejects.toThrow('outside');
  await expect(observer.successor(n.context.genesis, AbortSignal.abort())).rejects.toThrow();
  observer.close(); await expect(observer.successor(n.context.genesis)).rejects.toThrow('closed');
});

it('retains exact accepted ciphertext through lost replies and restart without rolling back to the last local certificate', async () => {
  const n = await fixture(); await n.observer.ready(); n.online(0, 1, 2, 3); n.lost(true);
  await expect(n.observer.advance(n.advance)).rejects.toThrow('Four');
  const id = n.stores[0].describe().envelopeId;
  expect(n.observer.status()).toMatchObject({ pending: true, head: n.advance.commitment.next }); n.observer.close();
  const observer = await n.open(); expect(observer.policy()).toEqual(n.second);
  await expect(observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).rejects.toThrow('pending');
  await expect(observer.advance(n.later)).rejects.toThrow('pending');
  n.lost(false); await observer.advance(n.advance);
  expect(observer.status()).toMatchObject({ pending: false, retainedBlocks: 2 });
  expect(n.stores.slice(0, 4).map(store => store.describe().envelopeId)).toEqual([id, id, id, id]);
});

it('keeps terminal equivocation evidence across partition, pending replay and restart', async () => {
  const n = await fixture(); await n.observer.ready(); await n.observer.advance(n.advance); n.online(0, 1, 2);
  await expect(n.observer.advance(n.conflict)).rejects.toThrow('Four');
  expect(n.observer.status()).toMatchObject({ blocked: true, pending: true }); n.observer.close();
  const observer = await n.open(); expect(observer.status().evidence).toHaveLength(2);
  await expect(observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).rejects.toThrow('equivocated');
  n.online(0, 1, 2, 3); await expect(observer.ready()).rejects.toThrow('equivocated');
  expect(observer.status().pending).toBe(false); expect(n.stores.slice(0, 4).map(store => store.describe().sequence)).toEqual([2, 2, 2, 2]);
  observer.close(); const reopened = await n.open(); expect(reopened.status().evidence).toHaveLength(2);
  await expect(reopened.advance(n.later)).rejects.toThrow('equivocated');
});

it('reserves a terminal conflict checkpoint before normal updates consume the bounded archive', async () => {
  const n = await fixture({ maxArchiveBlocks: 3 }); await n.observer.ready(); await n.observer.advance(n.advance);
  const calls = n.calls(); await expect(n.observer.advance(n.later)).rejects.toThrow('conflict headroom');
  expect(n.calls()).toBe(calls); expect(n.observer.status().pending).toBe(false);
  await expect(n.observer.advance(n.conflict)).rejects.toThrow('equivocated');
  expect(n.observer.status()).toMatchObject({ pending: false, blocked: true, retainedBlocks: 3 });
});

it('retains a conflict intent even when an operator reduces the archive below its previous reservation', async () => {
  const n = await fixture({ maxArchiveBlocks: 3 }); await n.observer.ready(); await n.observer.advance(n.advance); n.observer.close();
  const smaller = await n.open('open-existing', { maxArchiveBlocks: 2 });
  await expect(smaller.advance(n.conflict)).rejects.toThrow('capacity exceeded');
  expect(smaller.status()).toMatchObject({ blocked: true, pending: true }); smaller.close();
  const restored = await n.open(); expect(restored.status().blocked).toBe(true);
  await expect(restored.ready()).rejects.toThrow('equivocated'); expect(restored.status().pending).toBe(false);
});

it('does not turn a new directory, different role or different history identifier into a replacement observer', async () => {
  const n = await fixture(), calls = n.calls(), directory = join(n.directory, 'missing');
  await expect(n.open('open-existing', { directory })).rejects.toThrow('missing');
  for (const historyContext of [{ ...n.enrolled.context, historyId: randomBytes(32).toString('base64url') },
    { ...n.enrolled.context, role: 'relay-admission-spends' as const }]) {
    await expect(n.open('create-new', { directory, historyContext })).rejects.toThrow();
  }
  expect(existsSync(join(directory, 'history-writer.json'))).toBe(false); expect(n.calls()).toBe(calls);
  expect(() => parseAdmissionHistoryConfiguration({ version: 1, context: n.enrolled.context, members: n.members, ownerKeyFile: 'owner.key' })).toThrow('history role');
  expect(policyObserverHistoryContext(n.context, n.enrolled.context.owner)).toEqual(n.enrolled.context);
  expect(historyCheckpointContextId({ ...n.enrolled.context, role: 'relay-admission-spends' })).not.toBe(historyCheckpointContextId(n.enrolled.context));
});

it('serializes in-flight operations, captures the request and fences signatures after close', async () => {
  const n = await fixture(); await n.observer.ready();
  let release!: () => void; n.gate(new Promise<void>(resolve => { release = resolve; }));
  const request = createAdmissionPolicyHeadRequest(n.context, n.now), original = structuredClone(request), observed = n.observer.observe(request);
  request.challenge = randomBytes(32).toString('base64url');
  await expect(n.observer.advance(n.advance)).rejects.toThrow('already in progress'); release();
  expect((await observed).request).toEqual(original);
  n.gate(new Promise<void>(resolve => { release = resolve; }));
  const late = n.observer.observe(original); n.observer.close(); release(); await expect(late).rejects.toThrow();
});

it('rechecks expiry and the monotonic request budget even with a frozen wall clock', async () => {
  const n = await fixture(); await n.observer.ready();
  const calls = n.calls(); await expect(n.observer.observe({ ...createAdmissionPolicyHeadRequest(n.context, n.now), extra: true })).rejects.toThrow(); expect(n.calls()).toBe(calls);
  n.gate(delay(160)); await expect(n.observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now, 100))).rejects.toThrow('too late');
  let release!: () => void; n.gate(new Promise<void>(resolve => { release = resolve; }));
  const observed = n.observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now, 30000));
  n.time(n.first.expiresAt); release(); await expect(observed).rejects.toThrow('not current');
});

it('rejects a frozen generation even while its original policy and old receipt remain valid', async () => {
  const n = await fixture(); await n.observer.ready();
  const freeze = createHistoryFreeze(n.enrolled.context, 0, 1, randomBytes(32).toString('base64url'), n.keys[0]);
  n.stores.slice(0, 4).forEach(store => store.freeze(freeze));
  await expect(n.observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).rejects.toThrow('Four');
});

it('rejects an owner-signed complete snapshot that discards durable conflict evidence during replay', async () => {
  const n = await fixture(); await n.observer.ready(); await n.observer.advance(n.advance);
  await expect(n.observer.advance(n.conflict)).rejects.toThrow('equivocated'); n.observer.close();
  const writer = createRetainedHistoryCheckpointWriter({ directory: n.options.directory, localKey: n.options.encryptionKey,
    context: n.enrolled.context, rootId: historyCheckpointEnvelopeId(n.enrolled.root), generation: 0, signingKey: n.keys[0], members: n.members });
  cleanup.push(writer.close);
  const committed = writer.read().committed!.envelope, bytes = openHistoryCheckpoint(committed, n.enrolled.context, n.options.encryptionKey);
  const snapshot = JSON.parse(bytes.toString()); bytes.fill(0); snapshot.conflict = null;
  const illegal = sealHistoryCheckpoint({ context: n.enrolled.context, signingKey: n.keys[0], encryptionKey: n.options.encryptionKey,
    header: { kind: 'checkpoint', generation: 0, sequence: committed.sequence + 1, previous: historyCheckpointEnvelopeId(committed) }, plaintext: Buffer.from(JSON.stringify(snapshot)) });
  await writer.replicate(illegal); writer.close();
  await expect(n.open()).rejects.toThrow('continued after equivocation');
});

for (const conflict of [false, true]) it.each(['pending-published', 'ciphertext-published', 'archive-index-published', 'certificate-published',
  ...(process.platform === 'win32' ? [] : ['pending-flushed', 'certificate-flushed'])])(`retains ${conflict ? 'conflict evidence' : 'the exact update'} across process death at %s`, async boundary => {
  const n = await fixture(); await n.observer.ready(); if (conflict) await n.observer.advance(n.advance); n.observer.close();
  const child = fork(new URL('./fixtures/protected-policy-observer-crash.ts', import.meta.url), [], { serialization: 'advanced',
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.push(child); expect((await once(child, 'message'))[0]).toBe('ready');
  const errors: unknown[] = []; child.on('message', value => errors.push(value));
  const marker = join(n.directory, 'crash-marker'), exited = once(child, 'exit'), { now: _, transport: _t, ...options } = n.options;
  child.send({ options, now: n.now, advance: conflict ? n.conflict : n.advance, marker, boundary }); await exited; expect(errors).toEqual([]);
  expect(readFileSync(marker, 'utf8')).toBe(boundary);
  const observer = await n.open(); expect(observer.policy()).toEqual(n.second);
  expect(observer.status().pending).toBe(!boundary.startsWith('certificate-'));
  if (conflict) {
    expect(observer.status().evidence).toHaveLength(2);
    await expect(observer.ready()).rejects.toThrow('equivocated');
    await expect(observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).rejects.toThrow('equivocated');
  } else {
    await observer.advance(n.advance);
    expect((await observer.observe(createAdmissionPolicyHeadRequest(n.context, n.now))).head).toEqual(n.advance.commitment.next);
  }
  expect(observer.status().pending).toBe(false);
}, 15000);
