import { expect, it } from 'vitest';
import { historyCheckpointEnvelopeId, historyDigest, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { createHistoryCompactionProposal, createHistoryCompactionVote } from '@resonance/core/history-compaction';
import { createHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
import { discoverHistoryContinuations } from '../history-continuation-discovery.js';
import type { HistoryCheckpointTransport } from '../history-checkpoint-exchange.js';

function fixture(generation = 1_000_000_000) {
  const n = historyCheckpointFixture(), genesisId = historyCheckpointEnvelopeId(n.root);
  const rootId = generation === 0 ? genesisId : historyDigest('independently endorsed generation root');
  const checkpoint = sealHistoryCheckpoint({ context: n.context, encryptionKey: n.key, signingKey: n.owner,
    header: { kind: 'checkpoint', generation, sequence: 1, previous: rootId }, plaintext: Buffer.from('complete test image') });
  const issuedAt = Date.now(), proposal = createHistoryCompactionProposal({ genesisId, rootId, checkpoint,
    issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
  const certificate = { version: 1, kind: 'history-compaction-certificate', proposal,
    votes: n.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, n.context, genesisId, key, issuedAt)) };
  const members = n.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${24000 + i}/history-checkpoint` }));
  let online = 5; const requests: number[] = [], signals: AbortSignal[] = [], saved = new Map<string, unknown>();
  const transport: HistoryCheckpointTransport = async (member, frame, signal) => {
    requests.push(frame.request.generation); signals.push(signal);
    const i = n.context.members.indexOf(member.publicKey);
    if (frame.request.rootId !== rootId || frame.request.generation !== generation || i >= online) throw new Error('Unretained generation');
    const response = createHistoryExchangeResponse(frame.request, 'no-continuation', { rootId, generation,
      sequence: 1, envelopeId: historyCheckpointEnvelopeId(checkpoint), freeze: null }, null, n.context, n.memberKeys[i]);
    saved.set(member.publicKey, response); return response;
  };
  const options = { context: n.context, genesisId, signingKey: n.owner, members, compaction: certificate, transport, timeoutMs: 1000 };
  return { ...n, rootId, generation, certificate, options, requests, signals, saved, online: (count: number) => { online = count; } };
}

it.each([0, 1_000_000_000])('bounds explicit checkpoint discovery at generation %i and still requires four fresh observations', async generation => {
  const n = fixture(generation), result = await discoverHistoryContinuations(n.options);
  expect(result.observedLeaf).toMatchObject({ rootId: n.rootId, generation });
  expect(result.observedLeaf.receipts).toHaveLength(4); expect(result.continuations).toEqual([]);
  expect(result.anchor).toEqual(generation ? { rootId: n.rootId, generation } : undefined);
  expect(n.requests).toEqual(Array(5).fill(generation)); expect(n.signals.every(signal => signal.aborted)).toBe(true);
  // A checkpoint's historical endorsements cannot replace fresh leaf replies.
  n.online(3); await expect(discoverHistoryContinuations(n.options)).rejects.toThrow('Four');
  const saved = new Map(n.saved);
  await expect(discoverHistoryContinuations({ ...n.options, transport: async member => saved.get(member.publicKey) })).rejects.toThrow('Four');
});

it('never infers a checkpoint start from missing ancestors and rejects mismatched proof pins before dispatch', async () => {
  const n = fixture();
  for (const change of [{ genesisId: historyDigest('other genesis') },
    { compaction: { ...n.certificate, votes: n.certificate.votes.slice(0, 3) } },
    { compaction: { ...n.certificate, proposal: { ...n.certificate.proposal, rootId: historyDigest('other root') } } }]) {
    await expect(discoverHistoryContinuations({ ...n.options, ...change })).rejects.toThrow();
  }
  expect(n.requests).toEqual([]);
  await expect(discoverHistoryContinuations({ ...n.options, compaction: undefined })).rejects.toThrow('Four');
  expect(n.requests).toEqual(Array(5).fill(0));
});
