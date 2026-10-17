import { afterEach, expect, it, vi } from 'vitest';
import { historyCheckpointEnvelopeId, historyDigest } from '@resonance/core/history-checkpoint';
import { createHistoryCompactionProposal, createHistoryCompactionVote } from '@resonance/core/history-compaction';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
import { collectHistoryCompactionCertificate } from '../history-compaction-coordinator.js';
import type { HistoryCompactionTransport } from '../history-agreement-exchange.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const f = historyCheckpointFixture(), genesisId = historyCheckpointEnvelopeId(f.root), checkpoint = f.next(f.root, 'image', 'checkpoint');
  const issuedAt = Date.now(), proposal = createHistoryCompactionProposal({ genesisId, rootId: genesisId, checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, f.context, f.owner);
  const members = f.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${19000 + i}/history-checkpoint` }));
  const votes = f.memberKeys.map(key => createHistoryCompactionVote(proposal, f.context, genesisId, key, issuedAt));
  const options = { context: f.context, genesisId, checkpoint, proposal, members, timeoutMs: 500 };
  const vote: HistoryCompactionTransport = async member => votes[f.context.members.indexOf(member.publicKey)];
  return { ...f, ...options, votes, options, vote };
}
it('collects four votes without waiting for a silent fifth and cancels every remaining request', async () => {
  const f = fixture(), signals: AbortSignal[] = [];
  const certificate = await collectHistoryCompactionCertificate({ ...f.options, transport: async (member, proposal, signal) => {
    signals.push(signal);
    expect(proposal).toEqual(f.proposal);
    if (member.publicKey === f.members[0].publicKey) return new Promise(() => {});
    return f.vote(member, proposal, signal);
  } });
  expect(certificate.votes.map(v => v.replica)).toEqual(f.context.members.slice(1));
  expect(signals).toHaveLength(5); expect(signals.every(s => s.aborted)).toBe(true);
});
it.each(['cross-member', 'forged', 'cross-proposal', 'duplicate'] as const)('rejects %s replies when only three authentic targets remain', async attack => {
  const f = fixture(), other = createHistoryCompactionProposal({ genesisId: f.genesisId, rootId: f.genesisId, checkpoint: f.checkpoint,
    issuedAt: Date.now(), expiresAt: Date.now() + 10000 }, f.context, f.owner);
  await expect(collectHistoryCompactionCertificate({ ...f.options, transport: async member => {
    const i = f.context.members.indexOf(member.publicKey);
    if (i < 3) return f.votes[i];
    if (attack === 'cross-member') return f.votes[i === 3 ? 4 : 3];
    if (attack === 'forged') return { ...f.votes[i], signature: f.votes[0].signature };
    if (attack === 'cross-proposal') return createHistoryCompactionVote(other, f.context, f.genesisId, f.memberKeys[i], Date.now());
    return f.votes[0];
  } })).rejects.toThrow('Four authenticated');
});
it('tolerates one invalid response but retains only four authenticated distinct members', async () => {
  const f = fixture();
  const result = await collectHistoryCompactionCertificate({ ...f.options, transport: async member => {
    const i = f.context.members.indexOf(member.publicKey); return i === 0 ? { ...f.votes[0], extra: true } : f.votes[i];
  } });
  expect(result.votes.map(v => v.replica)).toEqual(f.context.members.slice(1));
});
it('fails before dialing for bad pins, checkpoint, genesis, stale request or cancelled operation', async () => {
  const f = fixture(), transport = vi.fn(f.vote), controller = new AbortController(); controller.abort();
  for (const change of [
    { genesisId: historyDigest('wrong') }, { checkpoint: f.next(f.root, 'different', 'checkpoint') },
    { proposal: { ...f.proposal, signature: 'bad' } }, { members: f.members.slice(0, 4) },
    { members: [f.members[0], ...f.members.slice(0, 4)] },
    { members: f.members.map((m, i) => i ? m : { ...m, endpoint: 'ws://example.com/history-checkpoint' }) },
    { members: f.members.map((m, i) => i ? m : { ...m, endpoint: 'ws://127.0.0.1:19000/unknown' }) },
    { signal: controller.signal }, { timeoutMs: 30001 },
  ]) await expect(collectHistoryCompactionCertificate({ ...f.options, ...change, transport })).rejects.toThrow();
  vi.spyOn(Date, 'now').mockReturnValue(f.proposal.expiresAt);
  await expect(collectHistoryCompactionCertificate({ ...f.options, transport })).rejects.toThrow('expired');
  expect(transport).not.toHaveBeenCalled();
});
it('cancels all silent transports when the collection deadline expires', async () => {
  const f = fixture(), signals: AbortSignal[] = [];
  await expect(collectHistoryCompactionCertificate({ ...f.options, timeoutMs: 50, transport: async (_m, _p, signal) => {
    signals.push(signal); return new Promise(() => {});
  } })).rejects.toThrow('timed out');
  expect(signals).toHaveLength(5); expect(signals.every(s => s.aborted)).toBe(true);
});
it('propagates caller cancellation and never returns a certificate from late replies', async () => {
  const f = fixture(), controller = new AbortController(), signals: AbortSignal[] = [];
  await expect(collectHistoryCompactionCertificate({ ...f.options, signal: controller.signal, transport: async (m, p, signal) => {
    signals.push(signal); controller.abort(); return f.vote(m, p, signal);
  } })).rejects.toThrow('cancelled');
  expect(signals.every(s => s.aborted)).toBe(true);
});
it('rechecks signed request expiration after receiving otherwise valid votes', async () => {
  const f = fixture();
  await expect(collectHistoryCompactionCertificate({ ...f.options, transport: async member => {
    vi.spyOn(Date, 'now').mockReturnValue(f.proposal.expiresAt);
    return f.votes[f.context.members.indexOf(member.publicKey)];
  } })).rejects.toThrow('Four authenticated');
});
