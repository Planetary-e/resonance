import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { historyCheckpointEnvelopeId, historyDigest, sealHistoryCheckpoint } from '@resonance/core/history-checkpoint';
import { createHistoryCompactionProposal, createHistoryCompactionVote } from '@resonance/core/history-compaction';
import { createHistoryFrontierRequest, createHistoryFrontierResponse, parseHistoryFrontierRequest, parseHistoryFrontierResponse } from '@resonance/core/history-frontier';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';
import { discoverHistoryCompactionFrontier } from '../history-frontier-discovery.js';
import type { HistoryFrontierTransport } from '../history-agreement-exchange.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const f = historyCheckpointFixture(), genesisId = historyCheckpointEnvelopeId(f.root), time = Date.now();
  const members = f.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${19000 + i}/history-checkpoint` }));
  function certificate(generation = 0, sequence = 1, salt = '') {
    const rootId = generation ? historyDigest(`root-${generation}${salt}`) : genesisId;
    const checkpoint = sealHistoryCheckpoint({ context: f.context, signingKey: f.owner, encryptionKey: f.key,
      header: { kind: 'checkpoint', generation, sequence, previous: historyDigest('preceding') }, plaintext: Buffer.from(`state${salt}`) });
    const proposal = createHistoryCompactionProposal({ genesisId, rootId, checkpoint, issuedAt: time, expiresAt: time + 30000 }, f.context, f.owner);
    return { version: 1 as const, kind: 'history-compaction-certificate' as const, proposal,
      votes: f.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, f.context, genesisId, key, time)) };
  }
  const proof = certificate(), options = { context: f.context, genesisId, signingKey: f.owner, members, timeoutMs: 10000 };
  const request = createHistoryFrontierRequest({ genesisId, replica: members[0].publicKey,
    challenge: randomBytes(32).toString('base64url'), issuedAt: time, expiresAt: time + 30000 }, f.context, f.owner);
  const reply = (member: typeof members[number], r: typeof request, value: ReturnType<typeof certificate> | null = proof) =>
    createHistoryFrontierResponse(r, value, f.context, f.memberKeys[f.context.members.indexOf(member.publicKey)]);
  return { ...f, genesisId, time, members, certificate, proof, options, request, reply };
}
it('authenticates absence and historical certificates against exact fresh request and independent genesis', () => {
  const f = fixture();
  for (const certificate of [null, f.proof]) {
    const response = f.reply(f.members[0], f.request, certificate);
    expect(parseHistoryFrontierResponse(response, f.request, f.context, f.genesisId)).toEqual(response);
    expect(() => parseHistoryFrontierResponse(response, f.request, f.context, historyDigest('other'))).toThrow();
    expect(() => parseHistoryFrontierResponse({ ...response, certificate: certificate ? null : f.proof }, f.request, f.context, f.genesisId)).toThrow('signature');
    expect(() => parseHistoryFrontierResponse({ ...response, extra: true }, f.request, f.context, f.genesisId)).toThrow();
  }
  for (const now of [f.time - 1, f.request.expiresAt, NaN, Infinity]) {
    expect(() => parseHistoryFrontierRequest(f.request, f.context, f.genesisId, now)).toThrow();
  }
  expect(parseHistoryFrontierRequest(f.request, f.context, f.genesisId, f.time)).toEqual(f.request);
  expect(() => createHistoryFrontierResponse(f.request, f.proof, f.context, f.memberKeys[1])).toThrow('member');
});
it.each(['version', 'kind', 'contextId', 'genesisId', 'replica', 'challenge', 'issuedAt', 'expiresAt', 'signature', 'extra'])(
  'rejects request tampering in %s', field => {
    const f = fixture(), changes: Record<string, unknown> = { version: 2, kind: 'history-compaction-control',
      contextId: historyDigest('other'), genesisId: historyDigest('other'), replica: f.members[1].publicKey,
      challenge: randomBytes(32).toString('base64url'), issuedAt: f.time - 1, expiresAt: f.request.expiresAt - 1,
      signature: randomBytes(64).toString('base64url'), extra: true };
    expect(() => parseHistoryFrontierRequest({ ...f.request, [field]: changes[field] }, f.context, f.genesisId, f.time)).toThrow();
  });
it('chooses the latest certified generation then checkpoint from four fresh members and cancels the silent fifth', async () => {
  const f = fixture(), later = f.certificate(1_000_000_000, 1_000_000_000), earlier = f.certificate(1_000_000_000, 2);
  const signals: AbortSignal[] = [];
  const result = await discoverHistoryCompactionFrontier({ ...f.options, transport: async (m, request, signal) => {
    signals.push(signal); const i = f.context.members.indexOf(m.publicKey);
    if (i === 4) return new Promise(() => {});
    return f.reply(m, request, [f.proof, later, earlier, null][i]);
  } });
  expect(result.certificate).toEqual(later); expect(result.receipts).toHaveLength(4);
  expect(new Set(result.receipts.map(r => r.request.challenge)).size).toBe(1);
  expect(signals).toHaveLength(5); expect(signals.every(s => s.aborted)).toBe(true);
});
it('does not substitute historical endorsements or duplicated responses for four fresh distinct observations', async () => {
  const f = fixture(); let saved: unknown, mode = 'save';
  const transport: HistoryFrontierTransport = async (m, request) => {
    const i = f.context.members.indexOf(m.publicKey), response = f.reply(m, request);
    if (i < 3) return response;
    if (mode === 'save') { saved = response; return response; }
    if (mode === 'replay') return saved;
    if (mode === 'duplicate') return f.reply(f.members[0], { ...request, replica: f.members[0].publicKey });
    return { ...response, signature: 'forged' };
  };
  await discoverHistoryCompactionFrontier({ ...f.options, transport });
  for (mode of ['replay', 'duplicate', 'forged']) await expect(discoverHistoryCompactionFrontier({ ...f.options, transport })).rejects.toThrow('Four');
});
it('ignores one faulty reply, including unauthenticated or incomplete certificates', async () => {
  const f = fixture();
  for (const bad of ['member', 'certificate', 'size']) {
    const result = await discoverHistoryCompactionFrontier({ ...f.options, transport: async (m, request) => {
      const response = f.reply(m, request); if (m.publicKey !== f.members[0].publicKey) return response;
      if (bad === 'member') return { ...response, signature: randomBytes(64).toString('base64url') };
      if (bad === 'size') return { ...response, signature: 'x'.repeat(17000) };
      return { ...response, certificate: { ...f.proof, votes: f.proof.votes.slice(0, 3) } };
    } });
    expect(result.receipts.map(r => r.request.replica)).toEqual(f.context.members.slice(1));
  }
});
it.each(['root', 'checkpoint'] as const)('refuses observed conflicting certified %s evidence', async attack => {
  const f = fixture(), proofs = attack === 'root' ? [f.certificate(1, 1), f.certificate(1, 2, 'fork')]
    : [f.proof, f.certificate(0, 1, 'fork')];
  await expect(discoverHistoryCompactionFrontier({ ...f.options, transport: async (m, r) =>
    f.reply(m, r, proofs[f.context.members.indexOf(m.publicKey) % 2]) })).rejects.toThrow('Conflicting');
});
it('accepts different endorsement subsets for one checkpoint and reports absence without inventing a checkpoint', async () => {
  const f = fixture(), alternate = { ...f.proof, votes: f.memberKeys.slice(1).map(key => createHistoryCompactionVote(f.proof.proposal, f.context, f.genesisId, key, f.time)) };
  expect((await discoverHistoryCompactionFrontier({ ...f.options, transport: async (m, r) =>
    f.reply(m, r, m.publicKey === f.members[0].publicKey ? alternate : f.proof) })).certificate?.proposal).toEqual(f.proof.proposal);
  expect((await discoverHistoryCompactionFrontier({ ...f.options, transport: async (m, r) => f.reply(m, r, null) })).certificate).toBeNull();
});
it('refuses invalid pins, owner keys, bounds and pre-cancelled calls before dialing', async () => {
  const f = fixture(), transport = vi.fn(async (m, r) => f.reply(m, r)), controller = new AbortController(); controller.abort();
  for (const change of [{ genesisId: 'bad' }, { signingKey: f.memberKeys[0] }, { members: f.members.slice(0, 4) },
    { members: [f.members[0], ...f.members.slice(0, 4)] }, { timeoutMs: 30001 }, { signal: controller.signal },
    { members: f.members.map(m => ({ ...m, endpoint: 'ws://remote.example/history-checkpoint' })) },
    { members: f.members.map(m => ({ ...m, endpoint: `${m.endpoint}/unknown` })) }]) {
    await expect(discoverHistoryCompactionFrontier({ ...f.options, ...change, transport })).rejects.toThrow();
  }
  expect(transport).not.toHaveBeenCalled();
});
it.each(['silent', 'cancel', 'signed-expiry', 'clock-reversal', 'timer-delayed'] as const)('bounds %s transports and ignores late otherwise valid evidence', async mode => {
  const f = fixture(), controller = new AbortController(), signals: AbortSignal[] = [];
  const transport: HistoryFrontierTransport = async (m, r, signal) => {
    signals.push(signal);
    if (mode === 'cancel') controller.abort();
    if (mode === 'signed-expiry') vi.spyOn(Date, 'now').mockReturnValue(r.expiresAt);
    if (mode === 'clock-reversal') vi.spyOn(Date, 'now').mockReturnValue(r.issuedAt - 1);
    if (mode === 'timer-delayed') vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 10001);
    return mode === 'silent' || mode === 'timer-delayed' ? new Promise(() => {}) : f.reply(m, r);
  };
  await expect(discoverHistoryCompactionFrontier({ ...f.options, signal: controller.signal,
    timeoutMs: mode === 'silent' ? 100 : 10000, transport })).rejects.toThrow('timed out');
  expect(signals.length).toBeGreaterThan(0); expect(signals.every(s => s.aborted)).toBe(true);
});
