import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { historyCheckpointEnvelopeId, historyDigest } from '@resonance/core/history-checkpoint';
import { createHistoryCompactionProposal, createHistoryCompactionVote } from '@resonance/core/history-compaction';
import { parseHistoryRecoveryPreparation } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal } from '@resonance/core/history-successor';
import { assertHistoryCompactedSuccessorChain } from '@resonance/core/history-compacted-chain';
import { createHistoryCheckpointRecovery, HISTORY_RECOVERY_FILENAME } from '../history-checkpoint-recovery.js';
import { createHistoryCheckpointReplica, type HistoryCheckpointTransport } from '../history-checkpoint-exchange.js';
import { openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { historyCheckpointFixture } from './fixtures/history-checkpoint-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function network() {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'history-compacted-freeze-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const delta = f.next(f.root), checkpoint = f.next(delta, 'complete state', 'checkpoint'), tail = f.next(checkpoint);
  const stores = f.context.members.map((replica, i) => openHistoryCheckpointStore({ ...f.options, replica,
    directory: join(directory, `r${i}`), initialize: f.root }));
  stores.forEach((s, i) => { cleanup.push(s.close); if (i < 4) { s.append(delta); s.append(checkpoint); } });
  // A single unacknowledged tail still belongs to the selected frozen history.
  stores[0].append(tail);
  const roles = stores.map((store, i) => createHistoryCheckpointReplica({ context: f.context, store, signingKey: f.memberKeys[i] }));
  roles.forEach(r => cleanup.push(r.close));
  const genesisId = f.options.rootId, issuedAt = Date.now();
  const proposal = createHistoryCompactionProposal({ genesisId, rootId: genesisId, checkpoint, issuedAt, expiresAt: issuedAt + 30000 }, f.context, f.owner);
  const certificate = { version: 1 as const, kind: 'history-compaction-certificate' as const, proposal,
    votes: f.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, f.context, genesisId, key, issuedAt)) };
  const members = f.context.members.map((publicKey, i) => ({ publicKey, endpoint: `ws://127.0.0.1:${21000 + i}/history-checkpoint` }));
  const reads: number[] = [];
  const transport: HistoryCheckpointTransport = async (member, frame) => {
    const i = f.context.members.indexOf(member.publicKey);
    if (i === 3) throw new Error('Offline fourth checkpoint endorser');
    if (frame.request.action === 'read') {
      reads.push(frame.request.sequence);
      if (frame.request.sequence < checkpoint.sequence) throw new Error('Omitted prefix unavailable');
    }
    return roles[i].exchange(frame);
  };
  const options = { directory: join(directory, 'recovery'), localKey: f.localKey, context: f.context, signingKey: f.owner,
    rootId: genesisId, generation: 0, nextGeneration: 1, members, transport, compaction: { genesisId, certificate } };
  function open(initialize = false, changes: Partial<Parameters<typeof createHistoryCheckpointRecovery>[0]> = {}) {
    const recovery = createHistoryCheckpointRecovery({ ...options, ...changes, initialize }); cleanup.push(recovery.close); return recovery;
  }
  return { ...f, directory, delta, checkpoint, tail, stores, roles, certificate, options, open, reads, transport, genesisId };
}

describe('compacted history freeze preparation', { timeout: 30000 }, () => {
  it('preserves a later partial tail and a lagging frozen head without requesting the omitted prefix', async () => {
    const n = network(), recovery = n.open(true), prepared = await recovery.prepare();
    expect(prepared.envelopes).toEqual([n.checkpoint, n.tail]);
    expect(prepared.receipts.map(r => r.head.sequence).sort()).toEqual([0, 2, 2, 3]);
    expect(n.reads.length).toBeGreaterThan(0); expect(n.reads.every(s => s >= 2)).toBe(true);
    expect(prepared.compaction).toEqual(n.certificate);
    expect(parseHistoryRecoveryPreparation(prepared, n.context, n.genesisId)).toEqual(prepared);
    const proposal = createHistorySuccessorProposal(prepared, n.context, n.owner, n.genesisId);
    expect(proposal.sequence).toBe(3); expect(proposal.envelopeId).toBe(historyCheckpointEnvelopeId(n.tail));
    expect(() => assertHistoryCompactedSuccessorChain({ proposal, context: n.context, genesisId: n.genesisId,
      certificate: n.certificate, checkpoint: n.checkpoint, ids: prepared.envelopes.map(historyCheckpointEnvelopeId) })).not.toThrow();
    expect(readFileSync(join(n.options.directory, HISTORY_RECOVERY_FILENAME), 'utf8')).not.toContain(n.genesisId);
    recovery.close(); const spy = vi.fn(n.transport), reopened = n.open(false, { transport: spy });
    expect(spy).not.toHaveBeenCalled(); expect(reopened.read().prepared).toEqual(prepared);
    expect((await reopened.prepare()).envelopes).toEqual(prepared.envelopes);
  });

  it('requires the independently pinned genesis for parsing and selecting compacted evidence', async () => {
    const n = network(), prepared = await n.open(true).prepare();
    expect(() => parseHistoryRecoveryPreparation(prepared, n.context)).toThrow();
    expect(() => createHistorySuccessorProposal(prepared, n.context, n.owner)).toThrow();
    expect(() => parseHistoryRecoveryPreparation(prepared, n.context, historyDigest('foreign genesis'))).toThrow();
    const { compaction: _, ...unproved } = prepared;
    expect(() => parseHistoryRecoveryPreparation(unproved, n.context, n.genesisId)).toThrow('chain');
    expect(() => parseHistoryRecoveryPreparation({ ...prepared, compaction: null }, n.context, n.genesisId)).toThrow();
    expect(() => parseHistoryRecoveryPreparation({ ...prepared, envelopes: [n.checkpoint] }, n.context, n.genesisId)).toThrow();
    expect(() => parseHistoryRecoveryPreparation({ ...prepared, envelopes: [n.checkpoint, n.next(n.checkpoint)] }, n.context, n.genesisId)).toThrow();
    expect(() => parseHistoryRecoveryPreparation({ ...prepared, envelopes: [n.tail] }, n.context, n.genesisId)).toThrow();
  });

  it('pins the exact retained certificate on reopening and copies mutable configuration', async () => {
    const n = network(), pins = structuredClone(n.options.compaction), recovery = n.open(true, { compaction: pins });
    pins.certificate.votes.length = 0; pins.genesisId = historyDigest('changed');
    expect((await recovery.prepare()).compaction).toEqual(n.certificate); recovery.close();
    expect(() => n.open(false, { compaction: undefined })).toThrow('state is invalid');
    const alternate = { ...n.certificate, votes: n.memberKeys.slice(1).map(key =>
      createHistoryCompactionVote(n.certificate.proposal, n.context, n.genesisId, key, n.certificate.proposal.issuedAt)) };
    expect(() => n.open(false, { compaction: { genesisId: n.genesisId, certificate: alternate } })).toThrow('state is invalid');
    expect(n.open().read().prepared?.compaction).toEqual(n.certificate);
  });

  it('cannot replace a fourth current freeze with an old certificate or three readable histories', async () => {
    const n = network(); let repaired = false;
    const recovery = n.open(true, { transport: (m, frame, signal) => !repaired && m.publicKey === n.context.members[2]
      && frame.request.action === 'read' ? Promise.reject(new Error('Lost suffix')) : n.transport(m, frame, signal) });
    await expect(recovery.prepare()).rejects.toThrow('Four');
    expect(recovery.read().attempt).not.toBeNull(); expect(recovery.read().prepared).toBeNull();
    repaired = true; expect((await recovery.prepare()).envelopes).toEqual([n.checkpoint, n.tail]);
  });

  it('retains the freshest local selection when a later round cannot find its tail', async () => {
    const n = network(); let omit = 3;
    const recovery = n.open(true, { transport: async (m, frame) => {
      const i = n.context.members.indexOf(m.publicKey); if (i === omit) throw new Error('offline');
      if (frame.request.action === 'read' && frame.request.sequence < 2) throw new Error('prefix gone');
      return n.roles[i].exchange(frame);
    } });
    const prepared = await recovery.prepare(); expect(prepared.envelopes.at(-1)).toEqual(n.tail);
    omit = 0; await expect(recovery.prepare()).rejects.toThrow('regress');
    expect(recovery.read().prepared).toEqual(prepared);
  });

  it('rejects invalid pins before creating state or sending requests', () => {
    const n = network(), spy = vi.fn(n.transport);
    expect(() => n.open(true, { transport: spy, compaction: { genesisId: n.genesisId,
      certificate: { ...n.certificate, votes: n.certificate.votes.slice(0, 3) } } })).toThrow('Four');
    expect(() => n.open(true, { transport: spy, compaction: null as never })).toThrow('pins');
    expect(() => n.open(true, { transport: spy, generation: 1, nextGeneration: 2 })).toThrow('another generation');
    expect(spy).not.toHaveBeenCalled();
  });
});
