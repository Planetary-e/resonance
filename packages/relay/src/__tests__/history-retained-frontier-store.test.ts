import { afterEach, expect, it } from 'vitest';
import { join } from 'node:path';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { historyCheckpointEnvelopeId, historyDigest, sealHistoryCheckpoint, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { createHistoryCompactionProposal, createHistoryCompactionVote } from '@resonance/core/history-compaction';
import { HISTORY_MANIFEST_FILENAME, openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { admissionRestoreFixture } from './fixtures/admission-restore-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const n = await admissionRestoreFixture(); cleanup.push(n.close);
  const root = n.continuation(), rootId = historyCheckpointEnvelopeId(root), genesisId = historyCheckpointEnvelopeId(n.root);
  const directory = join(n.directory, 'g1-r0'), path = join(directory, HISTORY_MANIFEST_FILENAME);
  function next(previous: HistoryCheckpointEnvelope, kind: 'checkpoint' | 'delta' = 'delta') {
    return sealHistoryCheckpoint({ context: n.context, signingKey: n.owner, encryptionKey: n.key,
      header: { generation: 1, sequence: previous.sequence + 1, previous: historyCheckpointEnvelopeId(previous), kind },
      plaintext: Buffer.from('opaque complete owner state or delta') });
  }
  const first = next(root), checkpoint = next(first, 'checkpoint'), tail = next(checkpoint);
  const certificate = (block: HistoryCheckpointEnvelope, selectedGenesis = genesisId, selectedRoot = rootId) => {
    const issuedAt = Date.now(), proposal = createHistoryCompactionProposal({ genesisId: selectedGenesis, rootId: selectedRoot,
      checkpoint: block, issuedAt, expiresAt: issuedAt + 30000 }, n.context, n.owner);
    return { version: 1 as const, kind: 'history-compaction-certificate' as const, proposal,
      votes: n.memberKeys.slice(0, 4).map(key => createHistoryCompactionVote(proposal, n.context, selectedGenesis, key, issuedAt)) };
  };
  const proof = certificate(checkpoint), store = n.generations[1][0];
  [first, checkpoint, tail].forEach(block => store.append(block)); store.retainCompactionAnchor(proof, store.reviewDigest());
  const options = { directory, localKey: n.localKey, context: n.context, replica: n.context.members[0], generation: 1,
    rootId, retainedFrontier: { genesisId, certificate: proof } };
  const files = () => Object.fromEntries(readdirSync(directory).filter(name => name.endsWith('.block') || name === HISTORY_MANIFEST_FILENAME)
    .map(name => [name, readFileSync(join(directory, name))]));
  const open = (changes: Partial<typeof options> = {}) => { const s = openHistoryCheckpointStore({ ...options, ...changes }); cleanup.push(s.close); return s; };
  return { ...n, root, rootId, genesisId, directory, path, store, first, checkpoint, tail, proof, certificate, options, open, files, next };
}
it('reopens an explicitly selected certified frontier after its ancestors are unavailable and continues from the accepted tail', async () => {
  const n = await fixture(), expected = n.store.read(), head = n.store.describe();
  n.store.retirePrefix(n.store.planPrefixRetirement().approvalDigest); const usage = n.store.storageUsage(); n.store.close();
  n.generations[0].forEach(s => s.close());
  for (let i = 0; i < 5; i++) rmSync(join(n.directory, '..', `g0-r${i}`), { recursive: true });
  const before = n.files();
  expect(() => openHistoryCheckpointStore({ ...n.options, retainedFrontier: undefined })).toThrow('state is invalid');
  expect(n.files()).toEqual(before);
  const store = n.open();
  expect(store.genesisId).toBe(n.genesisId); expect(store.describe()).toEqual(head);
  expect(store.read().envelopes).toEqual([n.root, ...expected.envelopes.slice(2)]);
  expect(store.compactionAnchor()).toEqual(n.proof); expect(n.files()).toEqual(before);
  expect(store.storageUsage().reservedBytes).toBe(usage.reservedBytes);
  const next = n.next(n.tail); store.append(next); expect(store.describe().sequence).toBe(next.sequence); store.close();
  expect(n.open().envelopeAt(next.sequence)).toEqual(next);
}, 30000);
it('preserves durable freeze, agreement and child activation across anchored reopen', async () => {
  const n = await fixture(), child = await n.certify(), head = n.store.describe();
  const activation = n.store.activatedContinuation(), before = n.files();
  n.store.close(); n.generations[0][0].close(); n.generations[2][0].close();
  rmSync(join(n.directory, '..', 'g0-r0'), { recursive: true });
  const anchored = n.open();
  expect(anchored.describe()).toEqual(head); expect(anchored.activatedContinuation()).toEqual(activation);
  expect(n.files()).toEqual(before); expect(() => anchored.append(n.next(n.tail))).toThrow();
  expect(anchored.requireContinuation(child, n.context.members[0]).depth).toBe(1);
  const successor = openHistoryCheckpointStore({ directory: join(n.directory, '..', 'g2-r0'), localKey: n.localKey,
    context: n.context, replica: n.context.members[0], generation: 2, rootId: historyCheckpointEnvelopeId(child), parent: anchored });
  cleanup.push(successor.close); expect(successor.envelopeAt(0)).toEqual(child); expect(successor.genesisId).toBe(n.genesisId);
}, 30000);
it('refuses wrong enrollment, incomplete proof, stale retained state and implicit initialization before cleaning any files', async () => {
  const n = await fixture(); n.store.close();
  const orphan = join(n.directory, `${historyDigest('unreferenced').slice(7)}.block`); writeFileSync(orphan, 'retain this until validation succeeds');
  const later = n.next(n.tail, 'checkpoint'), before = n.files();
  const failures = [
    { retainedFrontier: { genesisId: historyDigest('wrong'), certificate: n.proof } },
    { retainedFrontier: { genesisId: n.genesisId, certificate: { ...n.proof, votes: n.proof.votes.slice(0, 3) } } },
    { retainedFrontier: { genesisId: n.genesisId, certificate: n.certificate(later) } },
    { retainedFrontier: { genesisId: n.genesisId, certificate: n.certificate(n.checkpoint, n.genesisId, historyDigest('foreign root')) } },
    { initialize: n.root }, { parent: n.generations[0][0] },
  ];
  for (const change of failures) {
    expect(() => openHistoryCheckpointStore({ ...n.options, ...change })).toThrow(); expect(n.files()).toEqual(before);
  }
  const checkpointPath = join(n.directory, `${n.proof.proposal.envelopeId.slice(7)}.block`), saved = readFileSync(checkpointPath);
  writeFileSync(checkpointPath, '{}'); const corrupt = n.files();
  expect(() => n.open()).toThrow(); expect(n.files()).toEqual(corrupt); writeFileSync(checkpointPath, saved);
  n.open(); expect(readdirSync(n.directory)).not.toContain(orphan.split('/').at(-1));
}, 30000);
it('advances the local checkpoint without losing the older selected frontier floor', async () => {
  const n = await fixture(); n.store.close(); let store = n.open();
  const later = n.next(n.tail, 'checkpoint'), proof = n.certificate(later);
  store.append(later); store.retainCompactionAnchor(proof, store.reviewDigest()); store.retirePrefix(store.planPrefixRetirement().approvalDigest);
  expect(store.envelopeAt(n.checkpoint.sequence)).toBeNull(); store.close();
  const before = n.files(); store = n.open(); expect(n.files()).toEqual(before);
  expect(store.compactionAnchor()).toEqual(proof); expect(store.read().envelopes).toEqual([n.root, later]);
  store.append(n.next(later));
}, 30000);
