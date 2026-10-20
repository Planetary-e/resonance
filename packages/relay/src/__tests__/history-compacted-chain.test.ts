import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createHistoryFreeze, historyCheckpointEnvelopeId, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, createHistoryExchangeResponse } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { createHistoryCompactionProposal, createHistoryCompactionVote } from '@resonance/core/history-compaction';
import { assertHistoryCompactedSuccessorChain } from '@resonance/core/history-compacted-chain';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

function fixture() {
  const f = historyCheckpointFixture(), delta = f.next(f.root), checkpoint = f.next(delta, 'full state', 'checkpoint'), tail = f.next(checkpoint);
  const blocks = [f.root, delta, checkpoint, tail], genesisId = historyCheckpointEnvelopeId(f.root);
  function selected(chain: HistoryCheckpointEnvelope[], positions = [0, 2, 3, 3]) {
    const issuedAt = Date.now(), challenge = randomBytes(32).toString('base64url'), freeze = createHistoryFreeze(f.context, 0, 1, challenge, f.owner);
    const receipts = positions.map((sequence, i) => {
      const request = createHistoryExchangeRequest({ action: 'freeze', rootId: genesisId, generation: 0, replica: f.context.members[i],
        challenge, issuedAt, expiresAt: issuedAt + 30000, sequence: 1, envelopeId: null }, f.context, f.owner);
      return createHistoryExchangeResponse(request, 'frozen', { rootId: genesisId, generation: 0, sequence,
        envelopeId: historyCheckpointEnvelopeId(chain[sequence]), freeze }, null, f.context, f.memberKeys[i]);
    });
    return createHistorySuccessorProposal({ version: 1, kind: 'frozen-history', rootId: genesisId, generation: 0, nextGeneration: 1,
      receipts, envelopes: chain }, f.context, f.owner);
  }
  const issuedAt = Date.now(), proposal = createHistoryCompactionProposal({ genesisId, rootId: genesisId, checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, f.context, f.owner);
  const certificate = { version: 1, kind: 'history-compaction-certificate', proposal,
    votes: f.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, f.context, genesisId, key, issuedAt)) };
  const options = { context: f.context, genesisId, checkpoint, certificate, proposal: selected(blocks), ids: [checkpoint, tail].map(historyCheckpointEnvelopeId) };
  return { ...f, delta, checkpoint, tail, selected, options };
}
it('allows a lagging frozen head below the certified checkpoint and binds every retained suffix head', () => {
  const f = fixture(); expect(() => assertHistoryCompactedSuccessorChain(f.options)).not.toThrow();
  expect(() => assertHistoryCompactedSuccessorChain({ ...f.options, ids: [f.options.ids[0]] })).toThrow();
  expect(() => assertHistoryCompactedSuccessorChain({ ...f.options, ids: [f.options.ids[1], f.options.ids[0]] })).toThrow();
});
it('rejects a frozen selection behind the certified checkpoint', () => {
  const f = fixture(), proposal = f.selected([f.root, f.delta], [0, 1, 1, 1]);
  expect(() => assertHistoryCompactedSuccessorChain({ ...f.options, proposal, ids: [historyCheckpointEnvelopeId(f.delta)] })).toThrow('exact certified');
});
it('does not ignore a conflicting frozen head at the checkpoint boundary', () => {
  const f = fixture(), other = f.next(f.delta, 'different image', 'checkpoint'), tail = f.next(other);
  const proposal = f.selected([f.root, f.delta, other, tail]);
  expect(() => assertHistoryCompactedSuccessorChain({ ...f.options, proposal,
    ids: [historyCheckpointEnvelopeId(f.checkpoint), historyCheckpointEnvelopeId(tail)] })).toThrow('exact certified');
});
it('rejects a matching suffix when its prefix certificate is short of quorum', () => {
  const f = fixture();
  expect(() => assertHistoryCompactedSuccessorChain({ ...f.options, certificate: {
    ...f.options.certificate, votes: f.options.certificate.votes.slice(0, 3),
  } })).toThrow('Four');
});
