import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHistoryAgreementDataFrame } from '@resonance/core/history-agreement-data';
import { createHistoryAgreementRequest } from '@resonance/core/history-agreement';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { exchangeHistoryAgreement, exchangeHistoryAgreementData } from '../history-agreement-exchange.js';
import { historyAgreementNetworkFixture } from './fixtures/history-agreement-owner-fixture.js';

const clean: Array<() => Promise<void>> = [];
async function fixture(tail: Parameters<typeof historyAgreementNetworkFixture>[0] = 'sparse', length = 2) {
  const n = await historyAgreementNetworkFixture(tail, length); clean.push(() => n.close()); return n;
}
afterEach(async () => { for (const f of clean.splice(0).reverse()) await f(); });

describe('network agreement with complete history', { timeout: 60_000 }, () => {
  it('recovers the only complete source and copies missing history to a four-member quorum with the fifth offline', async () => {
    const n = await fixture(); await n.stop(3);
    const staged = new Set<string>();
    const owner = n.owner(true, { historyTransfer: { transport: async (m, f, s) => {
      if (f.action === 'stage') staged.add(m.publicKey);
      const response = await exchangeHistoryAgreementData(m, f, s);
      f.authorization.request.signature = 'transport mutated its copy';
      return response;
    } } });
    const result = await owner.run(); expect(result.phase).toBe('confirmed'); expect(result.votes).toHaveLength(4);
    expect(staged).toEqual(new Set([1, 2, 4].map(i => n.context.members[i])));
    for (const i of [0, 1, 2, 4]) expect(n.stores[i].read().envelopes).toEqual(n.blocks);
  });

  it('preserves staging when replies are lost, resumes from the missing predecessor, and ignores forged read responses', async () => {
    const n = await fixture(); await n.stop(3);
    let lose = true; const uploads: number[] = [];
    const data = async (m: Parameters<typeof exchangeHistoryAgreementData>[0], f: Parameters<typeof exchangeHistoryAgreementData>[1], s: AbortSignal) => {
      if (f.action === 'read' && m.publicKey === n.context.members[2]) return { forged: true };
      const response = await exchangeHistoryAgreementData(m, f, s);
      if (f.action === 'stage' && m.publicKey === n.context.members[4]) {
        uploads.push(f.sequence); if (lose) throw new Error('lost durable staging reply');
      }
      return response;
    };
    let owner = n.owner(true, { historyTransfer: { transport: data } });
    await expect(owner.run()).rejects.toThrow('Four'); expect(owner.read().phase).toBe('prepare');
    expect(n.stores[4].read().envelopes).toEqual([n.root]); owner.close();
    await n.stop(4); await n.restart(4); lose = false;
    owner = n.owner(false, { historyTransfer: { transport: data } });
    expect((await owner.run()).phase).toBe('confirmed'); expect(uploads).toEqual([2, 1]);
    expect(n.stores[4].read().envelopes).toEqual(n.blocks);
  });

  it('fails without votes if the selected source disappears, and bounds a transport that ignores cancellation', async () => {
    const n = await fixture(); await n.stop(0);
    const owner = n.owner(true, { historyTransfer: {} });
    await expect(owner.run()).rejects.toThrow('unavailable'); expect(owner.read().phase).toBe('prepare');
    for (const i of [1, 2, 3, 4]) expect(n.stores[i].agreementState()!.prepared).toBeNull();
    owner.close();
    const stalled = n.owner(false, { timeoutMs: 300, historyTransfer: { transport: async () => new Promise(() => {}) } });
    const before = performance.now(); await expect(stalled.run()).rejects.toThrow(/cancelled|timed out/);
    expect(performance.now() - before).toBeLessThan(3000);
  });

  it('uses a carried proposal instead of the owner preference, repairs a new fourth member and preserves the hidden decision', async () => {
    const n = await fixture('missing', 1);
    const first = n.owner(true, { transport: async (m, f, s) => {
      if (m.publicKey === n.context.members[4]) throw new Error('offline');
      const response = await exchangeHistoryAgreement(m, f, s); if (f.request.action === 'confirm') throw new Error('lost decision'); return response;
    } });
    await expect(first.run()).rejects.toThrow('Four'); first.close(); await n.stop(3);
    const second = n.owner(true, { directory: join(n.directory, 'later-owner'), initialize: { proposal: n.b, view: 2 }, historyTransfer: {} });
    expect((await second.run()).phase).toBe('confirmed'); expect(second.read().selected).toEqual(n.a);
    expect(n.stores[4].read().envelopes).toEqual(n.blocks);
  });

  it('keeps newer local history even when the other four can decide a shorter selected chain', async () => {
    const n = await fixture('newer', 1), owner = n.owner(true, { historyTransfer: {} });
    expect((await owner.run()).phase).toBe('confirmed');
    expect(n.stores[4].read().envelopes).toEqual([n.root, n.delta]);
    expect(n.stores[4].agreementState()?.prepared ?? null).toBeNull();
  });

  it('resumes an owner killed after remote staging but before accepting its acknowledgement', async () => {
    const n = await fixture(); await n.stop(3);
    const child = fork(new URL('./fixtures/history-agreement-data-owner-crash.ts', import.meta.url), [],
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit');
    try {
      expect((await once(child, 'message'))[0]).toBe('ready');
      const staged = once(child, 'message');
      child.send({ options: n.options, proposal: n.a, target: n.context.members[4], localKey: n.localKey.toString('hex'),
        owner: { publicKey: Buffer.from(n.options.signingKey.publicKey).toString('hex'), secretKey: Buffer.from(n.options.signingKey.secretKey).toString('hex') } });
      expect((await Promise.race([staged, exited.then(() => { throw new Error('Owner exited before staging'); })]))[0]).toBe('staged');
      child.kill('SIGKILL'); await exited;
      const owner = n.owner(false, { historyTransfer: {} }); expect(owner.read().phase).toBe('prepare');
      expect(n.stores[4].read().envelopes).toEqual([n.root]);
      expect((await owner.run()).phase).toBe('confirmed'); expect(n.stores[4].read().envelopes).toEqual(n.blocks);
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
  });

  it('rejects a correctly signed block on the wrong target or a stale view over the data endpoint', async () => {
    const n = await fixture();
    const fresh = (frames: ReturnType<typeof n.frames>) => frames.map(f => ({ ...f,
      request: createHistoryAgreementRequest({ ...f.request, issuedAt: Date.now(), expiresAt: Date.now() + 20_000 }, n.context, n.options.signingKey) }));
    const promises = fresh(n.frames('promise', 1));
    // Keep a single attempt timestamp across members.
    const issuedAt = Date.now();
    for (const f of promises) f.request = createHistoryAgreementRequest({ ...f.request, issuedAt, expiresAt: issuedAt + 20_000 }, n.context, n.options.signingKey);
    const reports = n.viewCertificate(promises.slice(0, 4).map((f, i) => n.roles[i].exchange(f)));
    const auth = fresh(n.frames('prepare', 1, n.a, reports))[2];
    const frame = createHistoryAgreementDataFrame({ action: 'stage', authorization: auth, sequence: n.a.sequence,
      envelopeId: historyCheckpointEnvelopeId(n.blocks.at(-1)!), envelope: n.blocks.at(-1)! }, n.context, n.options.signingKey);
    await expect(exchangeHistoryAgreementData(n.options.members[1], frame, new AbortController().signal)).rejects.toThrow('target');
    n.roles[2].exchange(fresh(n.frames('promise', 2))[2]);
    await expect(exchangeHistoryAgreementData(n.options.members[2], frame, new AbortController().signal)).rejects.toThrow();
    expect(n.stores[2].describe().sequence).toBe(0);
  });
});
