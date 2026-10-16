import { afterEach, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createRetainedHistoryCheckpointWriter } from '../history-retained-writer.js';
import { createHistoryCheckpointReplica, listenHistoryCheckpointReplica } from '../history-checkpoint-exchange.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function network() {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'retained-writer-network-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const stores = f.context.members.map((replica, i) => openHistoryCheckpointStore({ ...f.options, replica, directory: join(directory, `r${i}`), initialize: f.root }));
  stores.forEach(s => cleanup.push(() => s.close()));
  const roles = stores.map((store, i) => createHistoryCheckpointReplica({ context: f.context, store, signingKey: f.memberKeys[i] }));
  roles.forEach(r => cleanup.push(() => r.close()));
  const listeners: Awaited<ReturnType<typeof listenHistoryCheckpointReplica>>[] = [], members = f.context.members.map(publicKey => ({ publicKey, endpoint: '' }));
  let calls = 0;
  async function start(i: number) {
    const listener = await listenHistoryCheckpointReplica({ ...roles[i], exchange(value) { calls++; return roles[i].exchange(value); } },
      { port: listeners[i] ? Number(new URL(listeners[i].endpoint).port) : 0 });
    listeners[i] = listener; members[i].endpoint = listener.endpoint; cleanup.push(() => listener.close());
  }
  for (let i = 0; i < 5; i++) await start(i);
  const options = { directory: join(directory, 'writer'), context: f.context, localKey: f.localKey, signingKey: f.owner,
    rootId: f.options.rootId, generation: 0, members, timeoutMs: 30000 };
  function writer(initialize = false) {
    const w = createRetainedHistoryCheckpointWriter({ ...options, initialize }); cleanup.push(() => w.close()); return w;
  }
  return { ...f, directory, stores, listeners, options, writer, start, calls: () => calls };
}

it('reopens the complete owner ciphertext and repairs a different fourth volunteer over real sockets', async () => {
  const n = await network(); await n.listeners[4].close(); let writer = n.writer(true);
  const a = n.next(n.root), b = n.next(a); for (const block of [n.root, a, b]) await writer.replicate(block);
  writer.close(); await n.listeners[3].close(); await n.start(4);
  const before = n.calls(); writer = n.writer(); expect(n.calls()).toBe(before);
  const c = n.next(b), certificate = await writer.replicate(c);
  expect(certificate.receipts.some(r => r.request.replica === n.context.members[4])).toBe(true);
  expect(n.stores[4].read().envelopes).toEqual([n.root, a, b, c]); expect([...writer.history()]).toEqual([n.root, a, b, c]);
}, 30000);

it.each(['before-pending', 'after-pending', 'before-payload', 'after-payload', 'before-index', 'after-index',
  'before-certificate', 'after-certificate', 'durable'] as const)(
  'preserves accepted history and the exact retry across SIGKILL at %s', async boundary => {
    const n = await network(), initial = n.writer(true); await initial.replicate(n.root); initial.close();
    const delta = n.next(n.root), child = fork(new URL('./fixtures/history-retained-writer-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit'), messages: unknown[] = [];
    child.on('message', value => messages.push(value));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Writer process exited before ready'); })]))[0]).toBe('ready');
    const { localKey, signingKey, ...publicOptions } = n.options;
    child.send({ options: publicOptions, localKey: localKey.toString('hex'), owner: {
      publicKey: Buffer.from(signingKey.publicKey).toString('hex'), secretKey: Buffer.from(signingKey.secretKey).toString('hex') }, delta, boundary });
    await exited; expect(messages).toEqual(['ready']); expect(child.signalCode).toBe('SIGKILL');
    const before = n.calls(), writer = n.writer(); expect(n.calls()).toBe(before);
    const committed = ['after-certificate', 'durable'].includes(boundary);
    expect(writer.read().committed?.envelope).toEqual(committed ? delta : n.root);
    expect(writer.read().pending).toEqual(boundary === 'before-pending' || committed ? null : delta);
    const cert = await writer.replicate(writer.read().pending ?? delta);
    expect(cert.receipts.every(r => r.request.envelopeId === historyCheckpointEnvelopeId(delta))).toBe(true);
    expect([...writer.history()]).toEqual([n.root, delta]);
    for (const receipt of cert.receipts) expect(n.stores[n.context.members.indexOf(receipt.request.replica)].read().envelopes).toEqual([n.root, delta]);
  }, 30000,
);
