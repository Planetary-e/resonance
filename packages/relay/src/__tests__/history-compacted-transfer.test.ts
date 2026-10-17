import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { rmSync, readFileSync } from 'node:fs';
import { historyCheckpointEnvelopeId, historyDigest } from '@resonance/core/history-checkpoint';
import { createHistoryCompactionProposal, createHistoryCompactionVote } from '@resonance/core/history-compaction';
import { createHistoryAgreementDataFrame, parseHistoryAgreementDataFrame } from '@resonance/core/history-agreement-data';
import { exchangeHistoryAgreementData } from '../history-agreement-exchange.js';
import { historyAgreementFixture, AGREEMENT_TEST_TIME as NOW } from './fixtures/history-agreement-fixture.js';
import { historyAgreementNetworkFixture } from './fixtures/history-agreement-owner-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function proof(n: Pick<ReturnType<typeof historyAgreementFixture>, 'root' | 'blocks' | 'context' | 'owner' | 'memberKeys'>) {
  const genesisId = historyCheckpointEnvelopeId(n.root), checkpoint = n.blocks[3];
  const proposal = createHistoryCompactionProposal({ genesisId, rootId: genesisId, checkpoint, issuedAt: NOW,
    expiresAt: NOW + 30000 }, n.context, n.owner);
  const certificate = { version: 1 as const, kind: 'history-compaction-certificate' as const, proposal,
    votes: n.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, n.context, genesisId, key, NOW)) };
  return { genesisId, certificate };
}
function local() {
  const n = historyAgreementFixture('missing', 4, { checkpointSequence: 3, laggingSequence: 1 }); cleanup.push(n.close);
  const compaction = proof(n), view = n.promise(1, [0, 1, 2, 4]), auth = n.frames('prepare', 1, n.a, view)[4];
  function frame(sequence: number) {
    return createHistoryAgreementDataFrame({ action: 'stage', authorization: auth, sequence,
      envelopeId: historyCheckpointEnvelopeId(n.blocks[sequence]), envelope: n.blocks[sequence],
      ...(sequence === 3 ? { compaction: compaction.certificate } : {}) }, n.context, n.owner, compaction.genesisId);
  }
  return { ...n, compaction, auth, frame };
}

describe('certified compacted agreement transfer', { timeout: 60000 }, () => {
  it.each([false, true])('repairs a lagging fourth socket replica using retained cache=%s and keeps its earlier accepted blocks', async retained => {
    const n = await historyAgreementNetworkFixture('missing', 4, { checkpointSequence: 3, laggingSequence: 1 }); cleanup.push(n.close);
    const compaction = proof({ ...n, owner: n.options.signingKey }), actions: Array<[string, number]> = [];
    await n.stop(3);
    const owner = n.owner(true, { historyTransfer: { compaction, ...(retained ? { retained: () => [n.root, ...n.blocks.slice(3)] } : {}),
      transport: async (member, frame, signal) => {
        actions.push([frame.action, frame.sequence]);
        if (frame.action === 'read' && (retained || frame.sequence < 3)) throw new Error('Omitted prefix unavailable');
        return exchangeHistoryAgreementData(member, frame, signal);
      } } });
    expect((await owner.run()).phase).toBe('confirmed');
    expect(n.stores[4].read().envelopes).toEqual([n.root, n.blocks[1], ...n.blocks.slice(3)]);
    expect(n.stores[4].compactionAnchor()).toEqual(compaction.certificate);
    expect(n.stores[4].envelopeIdAt(2)).toBeNull(); expect(n.stores[4].envelopeAt(2)).toBeNull();
    expect(actions.filter(([action]) => action === 'stage').map(([, sequence]) => sequence)).toEqual([4, 3]);
    expect(actions.every(([action, sequence]) => action !== 'read' || sequence >= 3)).toBe(true);
    const before = n.stores[4].reviewDigest(); await n.stop(4); await n.restart(4);
    expect(n.stores[4].reviewDigest()).toBe(before); expect(n.stores[4].describe().sequence).toBe(4);
    expect(n.stores[4].agreementState()?.confirmed).not.toBeNull();
    expect(() => n.stores[4].append(n.next(n.blocks[4]))).toThrow('frozen');
  });

  it.each([4, 3])('resumes a lost reply at sequence %s across owner and replica reopen', async lostSequence => {
    const n = await historyAgreementNetworkFixture('missing', 4, { checkpointSequence: 3, laggingSequence: 1 }); cleanup.push(n.close);
    const compaction = proof({ ...n, owner: n.options.signingKey }); await n.stop(3);
    let lost = false; const uploaded: number[] = [];
    const transfer = { compaction, retained: () => [n.root, ...n.blocks.slice(3)], transport: async (...args: Parameters<typeof exchangeHistoryAgreementData>) => {
      const response = await exchangeHistoryAgreementData(...args), [member, frame] = args;
      if (member.publicKey === n.context.members[4] && frame.action === 'stage') {
        uploaded.push(frame.sequence);
        if (!lost && frame.sequence === lostSequence) { lost = true; throw new Error('Lost installation reply'); }
      }
      return response;
    } };
    let owner = n.owner(true, { historyTransfer: transfer });
    await expect(owner.run()).rejects.toThrow('Four'); owner.close();
    expect(n.stores[4].describe().sequence).toBe(lostSequence === 4 ? 1 : 4);
    await n.stop(4); await n.restart(4);
    owner = n.owner(false, { historyTransfer: transfer }); expect((await owner.run()).phase).toBe('confirmed');
    expect(uploaded).toEqual([4, 3]); expect(n.stores[4].read().compaction).toEqual(compaction.certificate);
  });

  it('binds the certificate to the exact fresh authorization, staged ciphertext and independently pinned genesis', () => {
    const n = local(), frame = n.frame(3);
    expect(parseHistoryAgreementDataFrame(frame, n.context, NOW, n.compaction.genesisId)).toEqual(frame);
    expect(() => parseHistoryAgreementDataFrame(frame, n.context, NOW)).toThrow();
    expect(() => parseHistoryAgreementDataFrame(frame, n.context, NOW, historyDigest('foreign'))).toThrow();
    const { compaction: _, ...removed } = frame;
    expect(() => parseHistoryAgreementDataFrame(removed, n.context, NOW, n.compaction.genesisId)).toThrow('signature');
    const alternate = { ...n.compaction.certificate, votes: n.memberKeys.slice(1).map(key =>
      createHistoryCompactionVote(n.compaction.certificate.proposal, n.context, n.compaction.genesisId, key, NOW)) };
    expect(() => parseHistoryAgreementDataFrame({ ...frame, compaction: alternate }, n.context, NOW, n.compaction.genesisId)).toThrow('signature');
    expect(() => createHistoryAgreementDataFrame({ ...frame, action: 'head', envelope: null }, n.context, n.owner, n.compaction.genesisId)).toThrow();
    n.roles[4].transfer(n.frame(4)); const before = n.stores[4].reviewDigest();
    expect(() => n.roles[4].transfer({ ...frame, compaction: { ...n.compaction.certificate, votes: n.compaction.certificate.votes.slice(0, 3) } })).toThrow();
    expect(n.stores[4].reviewDigest()).toBe(before);
    expect(() => n.roles[4].transfer(n.frame(3))).not.toThrow();
    const installed = n.stores[4].reviewDigest(); expect(() => n.roles[4].transfer(n.frame(3))).not.toThrow();
    expect(n.stores[4].reviewDigest()).toBe(installed);
  });

  it('cannot turn a checkpoint into a vote after a later view supersedes its authorization', () => {
    const n = local(); n.roles[4].transfer(n.frame(4)); n.promise(2, [0, 1, 2, 4]);
    const before = n.stores[4].reviewDigest(); expect(() => n.roles[4].transfer(n.frame(3))).toThrow('current provisional');
    expect(n.stores[4].reviewDigest()).toBe(before); expect(n.stores[4].describe().sequence).toBe(1);
    expect(n.stores[4].compactionAnchor()).toBeNull();
  });

  it('fails reopening if the named checkpoint is missing and preserves the earlier accepted prefix bytes', () => {
    const n = local(), oldPath = join(n.directory, 'r4', `${historyCheckpointEnvelopeId(n.blocks[1]).slice(7)}.block`);
    const before = readFileSync(oldPath); n.roles[4].transfer(n.frame(4)); n.roles[4].transfer(n.frame(3));
    n.reopen(4); expect(readFileSync(oldPath)).toEqual(before);
    n.roles[4].close(); n.stores[4].close();
    rmSync(join(n.directory, 'r4', `${historyCheckpointEnvelopeId(n.blocks[3]).slice(7)}.block`));
    expect(() => n.reopen(4)).toThrow(); expect(readFileSync(oldPath)).toEqual(before);
  });

  it('pins the exact agreement proof on reopen and never contacts a replica from read-only construction', async () => {
    const n = await historyAgreementNetworkFixture('missing', 4, { checkpointSequence: 3, laggingSequence: 1 }); cleanup.push(n.close);
    const compaction = proof({ ...n, owner: n.options.signingKey });
    const owner = n.owner(true, { historyTransfer: { compaction } }); await owner.select(); owner.close();
    expect(() => n.owner(false, { historyTransfer: {} })).toThrow('state is invalid');
    const alternate = structuredClone(compaction); alternate.certificate.votes = n.memberKeys.slice(1).map(key =>
      createHistoryCompactionVote(compaction.certificate.proposal, n.context, compaction.genesisId, key, NOW));
    expect(() => n.owner(false, { historyTransfer: { compaction: alternate } })).toThrow('state is invalid');
    const spy = vi.fn(exchangeHistoryAgreementData), reopened = n.owner(false, { historyTransfer: { compaction, transport: spy } });
    expect(reopened.read().compaction).toEqual(compaction); expect(spy).not.toHaveBeenCalled();
  });

  it.each(['before-block-rename', 'after-block-rename', 'before-rename', 'after-rename', 'durable'] as const)(
    'recovers compacted installation after SIGKILL at %s without exposing a partial suffix', async boundary => {
      const n = local(); n.roles[4].transfer(n.frame(4)); n.roles[4].close(); n.stores[4].close();
      const child = fork(new URL('./fixtures/history-agreement-crash.ts', import.meta.url), [],
        { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      const exited = once(child, 'exit');
      try {
        expect((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Child exited before ready'); })]))[0]).toBe('ready');
        child.send({ options: { ...n.options, replica: n.context.members[4], directory: join(n.directory, 'r4') },
          localKey: n.localKey.toString('hex'), member: { publicKey: Buffer.from(n.memberKeys[4].publicKey).toString('hex'),
            secretKey: Buffer.from(n.memberKeys[4].secretKey).toString('hex') }, transfer: true, frame: n.frame(3),
          boundary, checkpointId: historyCheckpointEnvelopeId(n.blocks[3]), now: NOW });
        await exited; expect(child.signalCode).toBe('SIGKILL'); n.reopen(4);
        const installed = boundary === 'after-rename' || boundary === 'durable';
        expect(n.stores[4].describe().sequence).toBe(installed ? 4 : 1);
        expect(n.stores[4].agreementState()?.prepared).toBeNull();
        n.roles[4].transfer(n.frame(3));
        expect(n.stores[4].read().envelopes).toEqual([n.root, n.blocks[1], ...n.blocks.slice(3)]);
        expect(n.roles[4].exchange(n.auth).request.action).toBe('prepare');
      } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
    });
});
