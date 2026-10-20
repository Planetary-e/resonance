import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sign } from '@resonance/core';
import { historyCheckpointContextId, historyCheckpointEnvelopeId } from '@resonance/core/history-checkpoint';
import { createHistoryCompactionProposal, createHistoryCompactionVote, historyCompactionProposalId,
  parseHistoryCompactionProposal, type HistoryCompactionCertificate, type HistoryCompactionProposal } from '@resonance/core/history-compaction';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { HISTORY_MANIFEST_FILENAME, openHistoryCheckpointStore } from '../history-checkpoint-store.js';
import { policyObserverRestoreFixture } from './fixtures/policy-observer-restore-fixture.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const f = await policyObserverRestoreFixture(close => cleanup.push(close));
  await f.observer.advance(f.advance); await f.observer.advance(f.later);
  const checkpoint = f.stores[0].read().envelopes.at(-1)!, context = f.enrolled.context;
  const genesisId = historyCheckpointEnvelopeId(f.enrolled.root), now = Date.now();
  // An old/malicious client can still produce mathematically valid v1 opaque
  // certificates. Do not use the guarded production constructors for this input.
  const proposal: HistoryCompactionProposal = { version: 1, kind: 'history-compaction-proposal',
    contextId: historyCheckpointContextId(context), genesisId, rootId: genesisId, generation: 0,
    sequence: checkpoint.sequence, envelopeId: historyCheckpointEnvelopeId(checkpoint),
    challenge: randomBytes(32).toString('base64url'), issuedAt: now, expiresAt: now + 30000, signature: '' };
  proposal.signature = Buffer.from(sign(Buffer.from(`resonance:history-compaction:v1:proposal\n${JSON.stringify([
    proposal.version, proposal.kind, proposal.contextId, proposal.genesisId, proposal.rootId, proposal.generation,
    proposal.sequence, proposal.envelopeId, proposal.challenge, proposal.issuedAt, proposal.expiresAt,
  ])}`), f.owner.secretKey)).toString('base64url');
  const proposalId = historyCompactionProposalId(proposal);
  const certificate: HistoryCompactionCertificate = { version: 1, kind: 'history-compaction-certificate', proposal,
    votes: f.signingKeys.slice(0, 4).map(key => {
      const replica = Buffer.from(key.publicKey).toString('base64url');
      return { version: 1, kind: 'history-compaction-vote', proposalId, replica,
        signature: Buffer.from(sign(Buffer.from(`resonance:history-compaction:v1:vote\n${JSON.stringify([
          1, 'history-compaction-vote', proposalId, replica,
        ])}`), key.secretKey)).toString('base64url') };
    }) };
  const directory = join(f.directory, 'g0-r0');
  const files = () => Object.fromEntries(readdirSync(directory).sort()
    .filter(name => name.endsWith('.block') || name === HISTORY_MANIFEST_FILENAME)
    .map(name => [name, readFileSync(join(directory, name))]));
  return { ...f, context, genesisId, checkpoint, proposal, certificate, now, directory, files };
}

it('refuses opaque policy compaction even with four valid signatures, preserving all accepted snapshots', async () => {
  const f = await fixture(), before = f.files(), head = f.stores[0].describe();
  expect(() => f.stores[0].retainCompactionAnchor(f.certificate, f.stores[0].reviewDigest())).toThrow('semantic');
  expect(() => parseHistoryCompactionProposal(f.proposal, f.context, f.genesisId, f.now)).toThrow('semantic');
  expect(() => createHistoryCompactionProposal({ genesisId: f.genesisId, rootId: f.genesisId,
    checkpoint: f.checkpoint, issuedAt: f.now, expiresAt: f.now + 30000 }, f.context, f.owner)).toThrow('semantic');
  expect(() => createHistoryCompactionVote(f.proposal, f.context, f.genesisId, f.signingKeys[0], f.now)).toThrow('semantic');
  const lagging = openHistoryCheckpointStore({ directory: join(f.directory, 'lagging'), localKey: f.localKeys[0],
    context: f.context, replica: f.context.members[0], rootId: f.genesisId, generation: 0, initialize: f.enrolled.root });
  cleanup.push(lagging.close);
  expect(() => lagging.installCheckpoint(f.checkpoint, f.certificate, lagging.reviewDigest())).toThrow('semantic');
  expect(lagging.read().envelopes).toEqual([f.enrolled.root]);
  expect(f.stores[0].compactionAnchor()).toBeNull(); expect(f.stores[0].describe()).toEqual(head);
  expect(f.files()).toEqual(before);
}, 20000);

it('refuses an old opaque policy anchor on reopen without cleaning or rewriting its evidence', async () => {
  const f = await fixture(); f.stores[0].close();
  const path = join(f.directory, HISTORY_MANIFEST_FILENAME);
  const storage = openEncryptedLocalState<any>({ path, key: f.localKeys[0], domain: 'resonance:history-replica-manifest:v1',
    maxBytes: 2 * 1024 * 1024, mode: 'open-existing', initial: null, validate: (_v): _v is any => true });
  storage.write({ ...storage.read(), compaction: f.certificate }); storage.close();
  const before = f.files();
  expect(() => openHistoryCheckpointStore({ directory: f.directory, localKey: f.localKeys[0], context: f.context,
    replica: f.context.members[0], rootId: f.genesisId, generation: 0 })).toThrow();
  expect(f.files()).toEqual(before);
}, 20000);
