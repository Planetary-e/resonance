import { afterEach, describe, expect, it, vi } from 'vitest';
import { fsyncSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHistoryAgreementDataFrame, parseHistoryAgreementDataResponse } from '@resonance/core/history-agreement-data';
import { historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { createHistoryAgreementReplica } from '../history-checkpoint-agreement.js';
import { historyAgreementFixture, AGREEMENT_TEST_TIME as NOW } from './fixtures/history-agreement-fixture.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
const clean: Array<() => void> = [];
function fixture(tail: Parameters<typeof historyAgreementFixture>[0] = 'sparse', length = 3) {
  const n = historyAgreementFixture(tail, length); clean.push(() => n.close());
  const reports = n.promise(1, [0, 1, 2, 4]), frames = n.frames('prepare', 1, n.a, reports);
  const frame = (i: number, action: 'head' | 'read' | 'stage', sequence = n.a.sequence) => createHistoryAgreementDataFrame({ action,
    authorization: frames[i], sequence, envelopeId: historyCheckpointEnvelopeId(n.blocks[sequence]),
    envelope: action === 'stage' ? n.blocks[sequence] : null }, n.context, n.owner);
  return { ...n, frames, frame };
}
afterEach(() => { vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); clean.splice(0).reverse().forEach(f => f()); });

describe('selected-history data transfer', { timeout: 30_000 }, () => {
  it('stages backwards durably, hides incomplete suffixes, then installs atomically before voting', () => {
    const n = fixture(), stage = n.frame(4, 'stage');
    const first = n.roles[4].transfer(stage);
    expect(parseHistoryAgreementDataResponse(first, stage, n.context).pending?.sequence).toBe(2);
    expect(n.stores[4].read().envelopes).toEqual([n.root]);
    expect(() => n.roles[4].exchange(n.frames[4])).toThrow();
    expect(() => n.roles[4].transfer(n.frame(4, 'read'))).toThrow('unavailable');
    n.reopen(4);
    expect(n.roles[4].transfer(stage).pending?.sequence).toBe(2); // Duplicate after lost reply/restart.
    n.roles[4].transfer(n.frame(4, 'stage', 2));
    expect(n.stores[4].envelopeAt(1)).toBeNull();
    expect(n.roles[4].transfer(n.frame(4, 'stage', 1)).pending).toBeNull();
    expect(n.stores[4].read().envelopes).toEqual(n.blocks);
    expect(n.roles[4].exchange(n.frames[4]).request.action).toBe('prepare');
    n.reopen(4); expect(n.stores[4].read().envelopes).toEqual(n.blocks);
  });

  it('isolates returned blocks and authenticated positions from caller mutation', () => {
    const n = fixture(), read = n.frame(0, 'read'), original = n.stores[0].read();
    const raw = n.roles[0].transfer(read), parsed = parseHistoryAgreementDataResponse(raw, read, n.context);
    raw.head.sequence = 0;
    if (raw.envelope!.kind === 'continuation') throw new Error('Expected encrypted fixture block');
    raw.envelope!.ciphertext = 'changed';
    expect(parsed.head.sequence).toBe(3); expect(parsed.envelope).toEqual(n.blocks[3]);
    parsed.envelope!.previous = null;
    expect(n.stores[0].read()).toEqual(original);
    expect(n.roles[0].exchange(n.frames[0]).request.action).toBe('prepare');
  });

  it('binds data, target, current view, proof, action, fresh challenge and replies without counting data acknowledgements as votes', () => {
    const n = fixture(), f = n.frame(4, 'stage');
    expect(() => n.roles[3].transfer(n.frame(3, 'stage'))).toThrow('current provisional');
    for (const bad of [{ ...f, action: 'read', envelope: null }, { ...f, envelope: n.delta },
      { ...f, signature: 'x'.repeat(86) }, { ...f, extra: true }, { ...f, authorization: n.frames[2] }]) {
      expect(() => n.roles[4].transfer(bad)).toThrow();
    }
    expect(() => n.roles[4].transfer(n.frame(4, 'stage', 1))).toThrow('selected head');
    const reply = n.roles[4].transfer(f);
    expect(() => parseHistoryAgreementDataResponse(reply, n.frame(2, 'stage'), n.context)).toThrow();
    const expired = createHistoryAgreementReplica({ context: n.context, store: n.stores[4], signingKey: n.memberKeys[4], now: () => NOW + 30_000 });
    try { expect(() => expired.transfer(f)).toThrow('expired'); } finally { expired.close(); }
    n.promise(2, [0, 1, 2, 4]);
    expect(n.stores[4].read().envelopes).toEqual([n.root]);
    expect(() => n.roles[4].transfer(f)).toThrow('current provisional');
    n.reopen(4); expect(n.stores[4].agreementState()!.report.request.view).toBe(2);
  });

  it('keeps an accepted fork intact when backwards staging cannot join its predecessor', () => {
    const n = fixture('forked'), before = n.stores[4].read();
    n.roles[4].transfer(n.frame(4, 'stage', 3));
    expect(() => n.roles[4].transfer(n.frame(4, 'stage', 2))).toThrow('forks');
    expect(n.stores[4].read()).toEqual(before); n.reopen(4);
    expect(n.stores[4].read()).toEqual(before); expect(n.stores[4].agreementState()!.prepared).toBeNull();
  });

  it('rejects truncation and preserves longer accepted tails', () => {
    const n = fixture('newer', 1), frame = createHistoryAgreementDataFrame({ action: 'stage', authorization: n.frames[4],
      sequence: 0, envelopeId: n.options.rootId, envelope: n.root }, n.context, n.owner);
    expect(() => n.roles[4].transfer(frame)).toThrow('newer');
    expect(n.stores[4].read().envelopes).toEqual([n.root, n.delta]);
  });

  it('enforces capacity including staged blocks before any accepted index changes', () => {
    const n = fixture(); n.roles[4].close(); n.stores[4].close();
    n.stores[4] = openHistoryCheckpointStore({ ...n.options, replica: n.context.members[4], directory: join(n.directory, 'r4'), maxBlocks: 2 });
    n.roles[4] = createHistoryAgreementReplica({ context: n.context, store: n.stores[4], signingKey: n.memberKeys[4], now: () => NOW });
    n.roles[4].transfer(n.frame(4, 'stage'));
    expect(() => n.roles[4].transfer(n.frame(4, 'stage', 2))).toThrow();
    expect(n.stores[4].read().envelopes).toEqual([n.root]);
  });

  it('fails closed if a retained staged block is missing or corrupted', () => {
    const n = fixture(); n.roles[4].transfer(n.frame(4, 'stage')); n.roles[4].close(); n.stores[4].close();
    const path = join(n.directory, 'r4', `${n.a.envelopeId.slice(7)}.block`), original = readFileSync(path);
    writeFileSync(path, '{}'); expect(() => n.reopen(4)).toThrow();
    writeFileSync(path, original); n.reopen(4); expect(n.roles[4].transfer(n.frame(4, 'head')).pending?.sequence).toBe(2);
  });

  it.each([1, 3, 4])('recovers after fsync failure %i, with either durable staging or complete history and no premature vote', (failure) => {
    const n = fixture('sparse', 2); n.roles[4].transfer(n.frame(4, 'stage'));
    let calls = 0; vi.mocked(fsyncSync).mockImplementation(fd => { if (++calls === failure) throw new Error('disk failure'); actualFsync(fd); });
    expect(() => n.roles[4].transfer(n.frame(4, 'stage', 1))).toThrow('disk failure');
    expect(() => n.stores[4].read()).toThrow();
    vi.mocked(fsyncSync).mockImplementation(actualFsync); n.reopen(4);
    expect(n.stores[4].agreementState()!.prepared).toBeNull();
    expect([0, 2]).toContain(n.stores[4].describe().sequence);
    n.roles[4].transfer(n.frame(4, 'stage', 1)); expect(n.stores[4].read().envelopes).toEqual(n.blocks);
  });
});
