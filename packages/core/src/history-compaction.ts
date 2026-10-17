/** Historical proof of a complete encrypted checkpoint at a pinned genesis.
 * This certificate is neither fresh writer authority nor permission to delete a suffix/barrier. */
import { randomBytes } from 'node:crypto';
import { sign, type SigningKeyPair } from './crypto.js';
import { copyAdmissionSigningKey, exactWitnessFields, witnessBytes } from './admission-witness.js';
import { verifyHistorySignature } from './history-signature.js';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest,
  parseHistoryCheckpointEnvelope, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from './history-checkpoint.js';
import { HISTORY_REQUEST_MAX_LIFETIME_MS } from './history-exchange.js';

export interface HistoryCompactionProposal {
  version: 1; kind: 'history-compaction-proposal'; contextId: string; genesisId: string; rootId: string;
  generation: number; sequence: number; envelopeId: string;
  challenge: string; issuedAt: number; expiresAt: number; signature: string;
}
export interface HistoryCompactionVote {
  version: 1; kind: 'history-compaction-vote'; proposalId: string; replica: string; signature: string;
}
export interface HistoryCompactionCertificate {
  version: 1; kind: 'history-compaction-certificate'; proposal: HistoryCompactionProposal; votes: HistoryCompactionVote[];
}
export const HISTORY_COMPACTION_MAX_BYTES = 8192;
const DOMAIN = 'resonance:history-compaction:v1';
const proposalFields = ['version', 'kind', 'contextId', 'genesisId', 'rootId', 'generation', 'sequence', 'envelopeId',
  'challenge', 'issuedAt', 'expiresAt', 'signature'];
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const proposalBytes = (p: HistoryCompactionProposal) => Buffer.from(`${DOMAIN}:proposal\n${JSON.stringify([
  p.version, p.kind, p.contextId, p.genesisId, p.rootId, p.generation, p.sequence, p.envelopeId, p.challenge, p.issuedAt, p.expiresAt,
])}`);
const voteBytes = (v: HistoryCompactionVote) => Buffer.from(`${DOMAIN}:vote\n${JSON.stringify([v.version, v.kind, v.proposalId, v.replica])}`);

/** Genesis comes from independent enrollment, never from the proposal itself.
 * Supply now when processing a request; omit it only for historical evidence. */
export function parseHistoryCompactionProposal(value: unknown, context: HistoryCheckpointContext, genesisId: string,
  now?: number): HistoryCompactionProposal {
  if (!isHistoryDigest(genesisId) || !exactWitnessFields(value, proposalFields) || value.version !== 1
    || value.kind !== 'history-compaction-proposal' || value.contextId !== historyCheckpointContextId(context)
    || value.genesisId !== genesisId || !isHistoryDigest(value.rootId) || !integer(value.generation)
    || (value.generation === 0) !== (value.rootId === genesisId) || !integer(value.sequence) || value.sequence < 1
    || !isHistoryDigest(value.envelopeId) || value.envelopeId === value.rootId || !witnessBytes(value.challenge, 32)
    || !integer(value.issuedAt) || !integer(value.expiresAt) || value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > HISTORY_REQUEST_MAX_LIFETIME_MS || !witnessBytes(value.signature, 64)
    || (now !== undefined && (!integer(now) || now < value.issuedAt || now >= value.expiresAt))
    || Buffer.byteLength(JSON.stringify(value)) > HISTORY_COMPACTION_MAX_BYTES) throw new Error('Invalid or expired history compaction proposal');
  const p: HistoryCompactionProposal = { version: 1, kind: value.kind, contextId: value.contextId as string, genesisId,
    rootId: value.rootId, generation: value.generation, sequence: value.sequence, envelopeId: value.envelopeId,
    challenge: value.challenge, issuedAt: value.issuedAt, expiresAt: value.expiresAt, signature: value.signature };
  if (!verifyHistorySignature(proposalBytes(p), Buffer.from(p.signature, 'base64url'), Buffer.from(context.owner, 'base64url'))) {
    throw new Error('Invalid compaction owner signature');
  }
  return p;
}
export function createHistoryCompactionProposal(input: { genesisId: string; rootId: string; checkpoint: HistoryCheckpointEnvelope;
  issuedAt: number; expiresAt: number }, context: HistoryCheckpointContext, signer: SigningKeyPair): HistoryCompactionProposal {
  const checkpoint = parseHistoryCheckpointEnvelope(input.checkpoint, context);
  if (checkpoint.kind !== 'checkpoint' || checkpoint.sequence === 0) throw new Error('Compaction needs a complete non-genesis checkpoint');
  const key = copyAdmissionSigningKey(signer);
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong compaction owner');
    const p: HistoryCompactionProposal = { version: 1, kind: 'history-compaction-proposal', contextId: historyCheckpointContextId(context),
      genesisId: input.genesisId, rootId: input.rootId, generation: checkpoint.generation, sequence: checkpoint.sequence,
      envelopeId: historyCheckpointEnvelopeId(checkpoint), challenge: randomBytes(32).toString('base64url'),
      issuedAt: input.issuedAt, expiresAt: input.expiresAt, signature: '' };
    return parseHistoryCompactionProposal({ ...p, signature: Buffer.from(sign(proposalBytes(p), key.secretKey)).toString('base64url') }, context, input.genesisId);
  } finally { key.secretKey.fill(0); }
}
/** Parse before hashing. */
export const historyCompactionProposalId = (proposal: HistoryCompactionProposal): string =>
  historyDigest(Buffer.concat([proposalBytes(proposal), Buffer.from(`\n${proposal.signature}`)]));

/** Signing primitive only: the service must first verify possession of the complete
 * durable checkpoint and its enrolled ancestry, and retain all suffix/barrier evidence. */
export function createHistoryCompactionVote(proposal: HistoryCompactionProposal, context: HistoryCheckpointContext,
  genesisId: string, signer: SigningKeyPair, now: number): HistoryCompactionVote {
  const p = parseHistoryCompactionProposal(proposal, context, genesisId, now), key = copyAdmissionSigningKey(signer);
  try {
    const replica = Buffer.from(key.publicKey).toString('base64url');
    if (!context.members.includes(replica)) throw new Error('Compaction member is not pinned');
    const vote: HistoryCompactionVote = { version: 1, kind: 'history-compaction-vote', proposalId: historyCompactionProposalId(p), replica, signature: '' };
    return { ...vote, signature: Buffer.from(sign(voteBytes(vote), key.secretKey)).toString('base64url') };
  } finally { key.secretKey.fill(0); }
}
export function parseHistoryCompactionCertificate(value: unknown, context: HistoryCheckpointContext, genesisId: string,
  checkpointValue: unknown): HistoryCompactionCertificate {
  const certificate = parseHistoryCompactionAttestation(value, context, genesisId), proposal = certificate.proposal;
  const checkpoint = parseHistoryCheckpointEnvelope(checkpointValue, context);
  if (checkpoint.kind !== 'checkpoint' || checkpoint.sequence !== proposal.sequence || checkpoint.generation !== proposal.generation
    || historyCheckpointEnvelopeId(checkpoint) !== proposal.envelopeId) throw new Error('Compaction certificate binds a different checkpoint');
  return certificate;
}

/** Bounded signature/metadata check only. Durable stores must separately validate
 * the named ciphertext with parseHistoryCompactionCertificate before exposing it. */
export function parseHistoryCompactionAttestation(value: unknown, context: HistoryCheckpointContext, genesisId: string): HistoryCompactionCertificate {
  if (!exactWitnessFields(value, ['version', 'kind', 'proposal', 'votes']) || value.version !== 1
    || value.kind !== 'history-compaction-certificate' || !Array.isArray(value.votes) || value.votes.length < 4
    || value.votes.length > 5 || Buffer.byteLength(JSON.stringify(value)) > HISTORY_COMPACTION_MAX_BYTES) {
    throw new Error('Four bounded compaction votes required');
  }
  const proposal = parseHistoryCompactionProposal(value.proposal, context, genesisId);
  const votes = value.votes.map(raw => parseHistoryCompactionVote(raw, proposal, context, genesisId));
  if (new Set(votes.map(v => v.replica)).size !== votes.length) throw new Error('Compaction requires distinct pinned members');
  return { version: 1, kind: 'history-compaction-certificate', proposal, votes: votes.sort((a, b) => a.replica < b.replica ? -1 : 1) };
}

/** Historical signature validation; callers accepting a network reply must also
 * check the original proposal's deadline and the expected transport member. */
export function parseHistoryCompactionVote(raw: unknown, proposalValue: unknown, context: HistoryCheckpointContext,
  genesisId: string): HistoryCompactionVote {
  const proposalId = historyCompactionProposalId(parseHistoryCompactionProposal(proposalValue, context, genesisId));
  if (!exactWitnessFields(raw, ['version', 'kind', 'proposalId', 'replica', 'signature']) || raw.version !== 1
    || raw.kind !== 'history-compaction-vote' || raw.proposalId !== proposalId || !context.members.includes(raw.replica as string)
    || !witnessBytes(raw.signature, 64)) throw new Error('Invalid compaction vote');
  const vote: HistoryCompactionVote = { version: 1, kind: raw.kind, proposalId, replica: raw.replica as string, signature: raw.signature };
  if (!verifyHistorySignature(voteBytes(vote), Buffer.from(vote.signature, 'base64url'), Buffer.from(vote.replica, 'base64url'))) {
    throw new Error('Invalid compaction member signature');
  }
  return vote;
}
