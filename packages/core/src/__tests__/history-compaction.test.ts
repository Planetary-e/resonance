import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generateSigningKeyPair } from '../crypto.js';
import { historyDigest, historyCheckpointEnvelopeId, sealHistoryCheckpoint, type HistoryCheckpointContext } from '../history-checkpoint.js';
import { createHistoryCompactionProposal, createHistoryCompactionVote, parseHistoryCompactionProposal,
  parseHistoryCompactionCertificate } from '../history-compaction.js';

function fixture() {
  const owner = generateSigningKeyPair(), members = Array.from({ length: 5 }, () => generateSigningKeyPair());
  const context: HistoryCheckpointContext = { version: 1, role: 'relay-admission-spends', historyId: randomBytes(32).toString('base64url'),
    owner: Buffer.from(owner.publicKey).toString('base64url'), authority: Buffer.from(generateSigningKeyPair().publicKey).toString('base64url'),
    policyDigest: historyDigest('policy'), members: members.map(key => Buffer.from(key.publicKey).toString('base64url')).sort(), quorum: 4 };
  const genesisId = historyDigest('independently retained genesis'), time = Date.now();
  const seal = (kind: 'checkpoint' | 'delta' = 'checkpoint') => sealHistoryCheckpoint({ context, signingKey: owner, encryptionKey: randomBytes(32),
    header: { kind, generation: 0, sequence: 1, previous: genesisId }, plaintext: Buffer.from('opaque state') });
  const checkpoint = seal(), input = { genesisId, rootId: genesisId, checkpoint, issuedAt: time, expiresAt: time + 10000 };
  const proposal = createHistoryCompactionProposal(input, context, owner);
  const votes = members.map(key => createHistoryCompactionVote(proposal, context, genesisId, key, time));
  const certificate = { version: 1, kind: 'history-compaction-certificate', proposal, votes: votes.slice(0, 4) };
  return { owner, members, context, genesisId, time, seal, checkpoint, input, proposal, votes, certificate };
}

it('verifies four distinct pinned endorsements bound to one checkpoint and independently retained genesis', () => {
  const f = fixture();
  const accepted = parseHistoryCompactionCertificate(f.certificate, f.context, f.genesisId, f.checkpoint);
  expect(accepted.proposal).toEqual(f.proposal); expect(accepted.votes.map(v => v.replica)).toEqual(f.votes.slice(0, 4).map(v => v.replica).sort());
  expect(parseHistoryCompactionCertificate({ ...f.certificate, votes: f.votes }, f.context, f.genesisId, f.checkpoint).votes).toHaveLength(5);
  expect(() => parseHistoryCompactionCertificate(f.certificate, f.context, historyDigest('foreign genesis'), f.checkpoint)).toThrow();
  expect(() => parseHistoryCompactionCertificate(f.certificate, { ...f.context, historyId: randomBytes(32).toString('base64url') }, f.genesisId, f.checkpoint)).toThrow();
  expect(() => parseHistoryCompactionCertificate(f.certificate, f.context, f.genesisId, f.seal())).toThrow('different checkpoint');
});

it('keeps expired certificates historical and refuses new endorsements outside their request window', () => {
  const f = fixture();
  for (const time of [f.time - 1, f.time + 10000, NaN, Infinity]) {
    expect(() => parseHistoryCompactionProposal(f.proposal, f.context, f.genesisId, time)).toThrow();
    expect(() => createHistoryCompactionVote(f.proposal, f.context, f.genesisId, f.members[0], time)).toThrow();
  }
  expect(parseHistoryCompactionCertificate(f.certificate, f.context, f.genesisId, f.checkpoint).proposal.expiresAt).toBe(f.time + 10000);
  expect(() => createHistoryCompactionProposal({ ...f.input, expiresAt: f.time + 30001 }, f.context, f.owner)).toThrow();
  expect(() => createHistoryCompactionProposal({ ...f.input, expiresAt: f.time }, f.context, f.owner)).toThrow();
});

it.each(['contextId', 'genesisId', 'rootId', 'generation', 'sequence', 'envelopeId', 'challenge', 'issuedAt', 'expiresAt', 'signature', 'extra'])(
  'rejects owner proposal tampering in %s', field => {
    const f = fixture(), changes: Record<string, unknown> = { contextId: historyDigest('other'), genesisId: historyDigest('other'), rootId: historyDigest('other'),
      generation: 2, sequence: 2, envelopeId: historyDigest('other'), challenge: randomBytes(32).toString('base64url'), issuedAt: f.time - 1,
      expiresAt: f.time + 9999, signature: randomBytes(64).toString('base64url'), extra: true };
    expect(() => parseHistoryCompactionProposal({ ...f.proposal, [field]: changes[field] }, f.context, f.genesisId)).toThrow();
  },
);

it('rejects missing, duplicate, unpinned, forged and cross-proposal votes', () => {
  const f = fixture(), other = createHistoryCompactionProposal(f.input, f.context, f.owner);
  const vote = createHistoryCompactionVote(other, f.context, f.genesisId, f.members[3], f.time);
  const damaged = [f.votes.slice(0, 3), Array(6).fill(f.votes[0]), [f.votes[0], f.votes[0], f.votes[1], f.votes[2]],
    [...f.votes.slice(0, 3), { ...f.votes[3], replica: randomBytes(32).toString('base64url') }],
    [...f.votes.slice(0, 3), { ...f.votes[3], signature: f.votes[4].signature }],
    [...f.votes.slice(0, 3), { ...f.votes[3], extra: true }], [...f.votes.slice(0, 3), vote]];
  for (const votes of damaged) expect(() => parseHistoryCompactionCertificate({ ...f.certificate, votes }, f.context, f.genesisId, f.checkpoint)).toThrow();
  expect(() => createHistoryCompactionVote(f.proposal, f.context, f.genesisId, generateSigningKeyPair(), f.time)).toThrow('not pinned');
});

it('refuses delta/genesis checkpoints, wrong owners and inconsistent generation roots', () => {
  const f = fixture();
  expect(() => createHistoryCompactionProposal({ ...f.input, checkpoint: f.seal('delta') }, f.context, f.owner)).toThrow('complete');
  const genesis = sealHistoryCheckpoint({ context: f.context, signingKey: f.owner, encryptionKey: randomBytes(32), plaintext: Buffer.from('state'),
    header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null } });
  expect(() => createHistoryCompactionProposal({ ...f.input, genesisId: historyCheckpointEnvelopeId(genesis), checkpoint: genesis }, f.context, f.owner)).toThrow('non-genesis');
  expect(() => createHistoryCompactionProposal(f.input, f.context, generateSigningKeyPair())).toThrow('owner');
  expect(() => createHistoryCompactionProposal({ ...f.input, rootId: historyDigest('different') }, f.context, f.owner)).toThrow();
});

it.each(['admission-issuer', 'admission-allocation-authority'] as const)('refuses ciphertext-only compaction for %s histories at the shared parsing boundary', role => {
  const f = fixture(), context: HistoryCheckpointContext = { ...f.context, role };
  const checkpoint = sealHistoryCheckpoint({ context, signingKey: f.owner, encryptionKey: randomBytes(32), plaintext: Buffer.from('issuer state'),
    header: { kind: 'checkpoint', generation: 0, sequence: 1, previous: f.genesisId } });
  expect(() => createHistoryCompactionProposal({ ...f.input, checkpoint }, context, f.owner)).toThrow('semantic ancestry');
  expect(() => parseHistoryCompactionProposal(f.proposal, context, f.genesisId)).toThrow('semantic ancestry');
  expect(() => createHistoryCompactionVote(f.proposal, context, f.genesisId, f.members[0], f.time)).toThrow('semantic ancestry');
  expect(() => parseHistoryCompactionCertificate(f.certificate, context, f.genesisId, f.checkpoint)).toThrow('semantic ancestry');
});
