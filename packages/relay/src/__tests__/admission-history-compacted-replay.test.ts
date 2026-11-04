import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { historyCheckpointEnvelopeId, historyDigest, sealHistoryCheckpoint, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryCompactionProposal, createHistoryCompactionVote } from '@resonance/core/history-compaction';
import { admissionRestoreFixture } from './fixtures/admission-restore-fixture.js';
import { replayAdmissionHistory } from '../admission-history-replay.js';
import { encodeAdmissionHistoryRecord, type AdmissionHistoryImage } from '../admission-history-records.js';
import { prepareAdmissionHistoryRestore } from '../admission-history-restore.js';
import { openProtectedAdmissionSpendHistory } from '../protected-admission-history.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(generation: 0 | 1 = 0, record?: (image: AdmissionHistoryImage, at: number) => unknown) {
  const state = (image: AdmissionHistoryImage, at: number) => record?.(image, at) ?? { version: 1, kind: 'admission-state-checkpoint', image, at };
  const n = await admissionRestoreFixture(false, generation === 0 ? state : undefined); cleanup.push(n.close);
  let checkpoint: HistoryCheckpointEnvelope, full: HistoryCheckpointEnvelope[];
  let tailRow = n.currentRow;
  if (generation === 0) {
    full = n.generations[0][0].read().envelopes; checkpoint = full.at(-1)!;
  } else {
    const root = n.generations[1][0].read().envelopes[0];
    checkpoint = sealHistoryCheckpoint({ context: n.context, signingKey: n.owner, encryptionKey: n.key,
      header: { kind: 'checkpoint', generation: 1, sequence: 1, previous: historyCheckpointEnvelopeId(root) },
      plaintext: Buffer.from(JSON.stringify(state(n.image, n.time + 10000))) });
    tailRow = { ...n.currentRow, spend: randomBytes(32).toString('base64url') };
    const tail = sealHistoryCheckpoint({ context: n.context, signingKey: n.owner, encryptionKey: n.key,
      header: { kind: 'delta', generation: 1, sequence: 2, previous: historyCheckpointEnvelopeId(checkpoint) },
      plaintext: encodeAdmissionHistoryRecord({ version: 1, kind: 'spend', at: n.time + 10000, row: tailRow }) });
    n.generations[1].forEach(store => { store.append(checkpoint); store.append(tail); });
    full = [root, checkpoint, tail]; await n.certify();
  }
  const genesisId = historyCheckpointEnvelopeId(n.root), issuedAt = Date.now();
  // Pure historical-proof fixture: service issuance/current-generation gating is
  // tested separately with five live volunteers and actual transports.
  const proposal = createHistoryCompactionProposal({ genesisId, rootId: historyCheckpointEnvelopeId(full[0]), checkpoint,
    issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
  const compaction = { version: 1, kind: 'history-compaction-certificate', proposal,
    votes: n.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, n.context, genesisId, key, issuedAt)) };
  const blocks = [n.root, ...full.slice(checkpoint.sequence)];
  return { ...n, checkpoint, compaction, blocks, tailRow,
    input: () => ({ ...n.replayOptions(), blocks, compaction }) };
}

it.each([0, 1] as const)('reconstructs the same complete state from a certified generation %s checkpoint and every later record', async generation => {
  const n = await fixture(generation), calls = n.calls();
  const original = await replayAdmissionHistory(n.replayOptions()), compacted = await replayAdmissionHistory(n.input());
  expect(compacted.image).toEqual(original.image); expect(compacted.head).toEqual(original.head);
  expect(compacted.replayDigest).toBe(original.replayDigest); expect(compacted.blocks).toBeLessThan(original.blocks);
  expect(compacted.image.state.spends).toContainEqual(n.legacy); expect(compacted.image.state.spends).toContainEqual(n.tailRow);
  expect(compacted.image.state.retiredIssuerKeys).toContain(n.oldKey); expect(n.calls()).toBe(calls);
});
it('keeps the certified prefix across a subsequent continuation, suffix and frozen generation', async () => {
  const n = await fixture(0), child = n.continuation(), row = { ...n.currentRow, spend: randomBytes(32).toString('base64url') };
  const tail = sealHistoryCheckpoint({ context: n.context, signingKey: n.owner, encryptionKey: n.key,
    header: { kind: 'delta', generation: 1, sequence: 1, previous: historyCheckpointEnvelopeId(child) },
    plaintext: encodeAdmissionHistoryRecord({ version: 1, kind: 'spend', at: n.time + 10000, row }) });
  n.generations[1].forEach(store => store.append(tail)); await n.certify();
  const expected = await replayAdmissionHistory(n.replayOptions());
  const result = await replayAdmissionHistory({ ...n.input(), blocks: [...n.blocks, child, tail] });
  expect(result.image).toEqual(expected.image); expect(result.replayDigest).toBe(expected.replayDigest);
  expect(result.image.state.spends).toContainEqual(row); expect(result.generations).toBe(2);
});
it.each(['missing-proof', 'wrong-genesis', 'three-votes', 'duplicate-vote', 'wrong-checkpoint', 'missing-tail', 'extra-tail', 'missing-anchor', 'oversized-proof', 'cancelled'] as const)(
  'refuses %s without returning a partial reconstruction', async damage => {
    const n = await fixture(1), input: Parameters<typeof replayAdmissionHistory>[0] = n.input();
    if (damage === 'missing-proof') delete input.compaction;
    if (damage === 'wrong-genesis') input.genesisId = historyDigest('unrelated');
    if (damage === 'three-votes') input.compaction = { ...n.compaction, votes: n.compaction.votes.slice(0, 3) };
    if (damage === 'duplicate-vote') input.compaction = { ...n.compaction, votes: Array(4).fill(n.compaction.votes[0]) };
    if (damage === 'wrong-checkpoint') input.blocks = [n.root, n.root, ...n.blocks.slice(2)];
    if (damage === 'missing-tail') input.blocks = n.blocks.slice(0, -1);
    if (damage === 'extra-tail') input.blocks = [...n.blocks, n.blocks.at(-1)];
    if (damage === 'missing-anchor') input.blocks = [n.root];
    if (damage === 'oversized-proof') input.compaction = { ...n.compaction, extra: 'x'.repeat(8192) };
    if (damage === 'cancelled') { const controller = new AbortController(); controller.abort(); input.signal = controller.signal; }
    await expect(replayAdmissionHistory(input)).rejects.toThrow();
  },
);
it.each(['policy-record', 'bad-time', 'unknown-field', 'foreign-authority'] as const)('rejects a signed and certified %s payload as a compacted baseline', async damage => {
  const n = await fixture(1, (image, at) => {
    if (damage === 'foreign-authority') image.state.authority = randomBytes(32).toString('base64url');
    return { version: 1, kind: damage === 'policy-record' ? 'admission-policy-checkpoint' : 'admission-state-checkpoint',
      at: damage === 'bad-time' ? image.policy.expiresAt : at, image, ...(damage === 'unknown-field' ? { extra: true } : {}) };
  });
  await expect(replayAdmissionHistory(n.input())).rejects.toThrow();
});
it('restores a protected owner from a reviewed compacted source and still requires four fresh copies before serving', async () => {
  const n = await fixture(1), destination = join(n.directory, 'compacted-restore');
  const preparation = await prepareAdmissionHistoryRestore({ ...n.restoreOptions(destination), blocks: n.blocks, compaction: n.compaction });
  expect(preparation.review.blocks).toBe(3);
  const history = await openProtectedAdmissionSpendHistory({ directory: destination, authority: n.context.authority,
    policy: n.policy, encryptionKey: n.key, now: () => n.time + 10000, initialize: true,
    protection: { context: n.context, signingKey: n.owner, members: n.members, transport: n.transport, timeoutMs: 1000,
      initializeWriter: true, restore: { preparation, approvedDigest: preparation.review.approvalDigest } } });
  cleanup.push(history.close);
  expect(() => history.get(n.tailRow.spend)).toThrow('readiness');
  n.online(3); await expect(history.ready()).rejects.toThrow('Four');
  n.online(4); await history.ready(); expect(history.get(n.tailRow.spend)).toEqual(n.tailRow);
  expect(history.get(n.legacy.spend)).toEqual(n.legacy); expect(history.isRetired(n.oldKey)).toBe(true);
  await expect(history.write({ ...n.tailRow, binding: 'changed-binding' })).rejects.toThrow();
  await history.write({ ...n.currentRow, spend: randomBytes(32).toString('base64url') });
}, 30000);
