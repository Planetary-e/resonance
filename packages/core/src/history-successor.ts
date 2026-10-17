/** Immutable successor reservation. A certificate does not itself activate a new writer. */
import { randomBytes } from 'node:crypto';
import { sign, type SigningKeyPair } from './crypto.js';
import { verifyHistorySignature } from './history-signature.js';
import { copyAdmissionSigningKey, exactWitnessFields, witnessBytes } from './admission-witness.js';
import { historyCheckpointContextId, historyCheckpointEnvelopeId, historyDigest, isHistoryDigest,
  type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from './history-checkpoint.js';
import { parseHistoryExchangeRequest, parseHistoryExchangeResponse, parseHistoryRecoveryPreparation,
  HISTORY_RECOVERY_MAX_BLOCKS, type HistoryExchangeResponse, type HistoryRecoveryPreparation } from './history-exchange.js';

export interface HistorySuccessorProposal {
  version: 1; kind: 'history-successor'; contextId: string; rootId: string;
  generation: number; nextGeneration: number; sequence: number; envelopeId: string;
  nonce: string; freezes: HistoryExchangeResponse[]; signature: string;
}
export interface HistorySuccessorCertificate { version: 1; proposalId: string; receipts: HistoryExchangeResponse[] }
export const HISTORY_SUCCESSOR_MAX_BYTES = 16 * 1024;
const DOMAIN = 'resonance:history-successor:v1';
const fields = ['version', 'kind', 'contextId', 'rootId', 'generation', 'nextGeneration', 'sequence', 'envelopeId', 'nonce', 'freezes', 'signature'];
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const bytes = (p: HistorySuccessorProposal) => Buffer.from(`${DOMAIN}:proposal\n${JSON.stringify([
  p.version, p.kind, p.contextId, p.rootId, p.generation, p.nextGeneration, p.sequence, p.envelopeId, p.nonce, p.freezes,
])}`);

export function parseHistorySuccessorProposal(value: unknown, context: HistoryCheckpointContext): HistorySuccessorProposal {
  if (!exactWitnessFields(value, fields) || value.version !== 1 || value.kind !== 'history-successor'
    || value.contextId !== historyCheckpointContextId(context) || !isHistoryDigest(value.rootId)
    || !integer(value.generation) || !integer(value.nextGeneration) || value.nextGeneration <= value.generation
    || !integer(value.sequence) || value.sequence >= HISTORY_RECOVERY_MAX_BLOCKS || !isHistoryDigest(value.envelopeId)
    || (value.sequence === 0 && value.envelopeId !== value.rootId) || !witnessBytes(value.nonce, 32)
    || !witnessBytes(value.signature, 64) || !Array.isArray(value.freezes) || value.freezes.length !== 4
    || Buffer.byteLength(JSON.stringify(value)) > HISTORY_SUCCESSOR_MAX_BYTES) throw new Error('Invalid successor proposal');
  const sequence = value.sequence;
  const freezes = value.freezes.map(raw => {
    const request = parseHistoryExchangeRequest(raw?.request, context);
    if (request.action !== 'freeze' || request.generation !== value.generation || request.rootId !== value.rootId
      || request.sequence !== value.nextGeneration) throw new Error('Wrong successor freeze evidence');
    const receipt = parseHistoryExchangeResponse(raw, request, context);
    if (receipt.head.sequence > sequence || (receipt.head.sequence === sequence && receipt.head.envelopeId !== value.envelopeId)) {
      throw new Error('Successor selection omits frozen evidence');
    }
    return receipt;
  });
  if (new Set(freezes.map(r => r.request.replica)).size !== 4
    || new Set(freezes.map(r => JSON.stringify([r.request.challenge, r.request.issuedAt, r.request.expiresAt]))).size !== 1
    || !freezes.some(r => r.head.sequence === value.sequence)) throw new Error('Successor requires four matching freeze receipts');
  const proposal: HistorySuccessorProposal = { version: 1, kind: value.kind, contextId: value.contextId as string,
    rootId: value.rootId, generation: value.generation, nextGeneration: value.nextGeneration, sequence: value.sequence,
    envelopeId: value.envelopeId, nonce: value.nonce, freezes, signature: value.signature };
  if (!verifyHistorySignature(bytes(proposal), Buffer.from(proposal.signature, 'base64url'), Buffer.from(context.owner, 'base64url'))) {
    throw new Error('Invalid successor owner signature');
  }
  return proposal;
}
export function createHistorySuccessorProposal(preparation: HistoryRecoveryPreparation, context: HistoryCheckpointContext,
  signingKey: SigningKeyPair, genesisId?: string): HistorySuccessorProposal {
  const prepared = parseHistoryRecoveryPreparation(preparation, context, genesisId);
  if (prepared.receipts.length !== 4) throw new Error('Successor requires exactly four selected freeze receipts');
  const key = copyAdmissionSigningKey(signingKey);
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong successor owner');
    const proposal: HistorySuccessorProposal = { version: 1, kind: 'history-successor', contextId: historyCheckpointContextId(context),
      rootId: prepared.rootId, generation: prepared.generation, nextGeneration: prepared.nextGeneration,
      sequence: prepared.envelopes.at(-1)!.sequence, envelopeId: historyCheckpointEnvelopeId(prepared.envelopes.at(-1)!),
      nonce: randomBytes(32).toString('base64url'), freezes: prepared.receipts, signature: '' };
    return parseHistorySuccessorProposal({ ...proposal, signature: Buffer.from(sign(bytes(proposal), key.secretKey)).toString('base64url') }, context);
  } finally { key.secretKey.fill(0); }
}
/** The caller validates the proposal before hashing it. */
export const historySuccessorProposalId = (p: HistorySuccessorProposal): string => historyDigest(Buffer.concat([bytes(p), Buffer.from(`\n${p.signature}`)]));
export const historySuccessorRepairId = (p: HistorySuccessorProposal, block: HistoryCheckpointEnvelope): string =>
  historyDigest(`${DOMAIN}:repair\n${historySuccessorProposalId(p)}\n${historyCheckpointEnvelopeId(block)}`);

/** Check complete local ancestry, not just signed head numbers. */
export function assertHistorySuccessorChain(p: HistorySuccessorProposal, ids: readonly string[]): void {
  if (ids.length !== p.sequence + 1 || ids[0] !== p.rootId || ids.at(-1) !== p.envelopeId
    || p.freezes.some(r => ids[r.head.sequence] !== r.head.envelopeId)) throw new Error('Successor requires the exact complete selected chain');
}
export function parseHistorySuccessorCertificate(value: unknown, proposal: HistorySuccessorProposal,
  context: HistoryCheckpointContext): HistorySuccessorCertificate {
  const p = parseHistorySuccessorProposal(proposal, context), id = historySuccessorProposalId(p);
  if (!exactWitnessFields(value, ['version', 'proposalId', 'receipts']) || value.version !== 1 || value.proposalId !== id
    || !Array.isArray(value.receipts) || value.receipts.length !== 4) throw new Error('Four successor reservations required');
  const receipts = value.receipts.map(raw => {
    const request = parseHistoryExchangeRequest(raw?.request, context);
    if (request.action !== 'seal' || request.rootId !== p.rootId || request.generation !== p.generation
      || request.sequence !== p.sequence || request.envelopeId !== id) throw new Error('Reservation binds another successor');
    const receipt = parseHistoryExchangeResponse(raw, request, context);
    if (receipt.head.sequence !== p.sequence || receipt.head.envelopeId !== p.envelopeId
      || receipt.head.freeze?.nextGeneration !== p.nextGeneration) throw new Error('Reservation does not retain the selected history');
    return receipt;
  });
  if (new Set(receipts.map(r => r.request.replica)).size !== 4
    || new Set(receipts.map(r => JSON.stringify([r.request.challenge, r.request.issuedAt, r.request.expiresAt]))).size !== 1) {
    throw new Error('Successor reservations must be distinct and from the same attempt');
  }
  return { version: 1, proposalId: id, receipts };
}
