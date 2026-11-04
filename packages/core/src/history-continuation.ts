/** A deterministic generation boundary, not a replacement snapshot or a readiness receipt. */
import { exactWitnessFields } from './admission-witness.js';
import { historyCheckpointContextId, historyDigest, type HistoryCheckpointContext } from './history-checkpoint.js';
import { historySuccessorProposalId, parseHistorySuccessorProposal, type HistorySuccessorProposal } from './history-successor.js';
import { historyAgreementSlot, parseHistoryAgreementCertificate, type HistoryAgreementCertificate } from './history-agreement.js';

export interface HistoryContinuationRoot {
  version: 2; kind: 'continuation'; contextId: string; generation: number; sequence: 0; previous: null;
  proposal: HistorySuccessorProposal; certificate: HistoryAgreementCertificate;
}
const MAX_BYTES = 36 * 1024;

export function parseHistoryContinuationRoot(value: unknown, context: HistoryCheckpointContext): HistoryContinuationRoot {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > MAX_BYTES
    || !exactWitnessFields(value, ['version', 'kind', 'contextId', 'generation', 'sequence', 'previous', 'proposal', 'certificate'])
    || value.version !== 2 || value.kind !== 'continuation' || value.contextId !== historyCheckpointContextId(context)
    || value.sequence !== 0 || value.previous !== null) throw new Error('Invalid history continuation root');
  const proposal = parseHistorySuccessorProposal(value.proposal, context);
  const certificate = parseHistoryAgreementCertificate(value.certificate, context, 'confirmed'), request = certificate.votes[0].request;
  if (value.generation !== proposal.nextGeneration || historyAgreementSlot(request) !== historyAgreementSlot(proposal)
    || request.proposalId !== historySuccessorProposalId(proposal)) throw new Error('Continuation requires the decided predecessor');
  return { version: 2, kind: 'continuation', contextId: value.contextId as string, generation: proposal.nextGeneration,
    sequence: 0, previous: null, proposal, certificate };
}

export function createHistoryContinuationRoot(proposal: HistorySuccessorProposal, certificate: HistoryAgreementCertificate,
  context: HistoryCheckpointContext): HistoryContinuationRoot {
  return parseHistoryContinuationRoot({ version: 2, kind: 'continuation', contextId: historyCheckpointContextId(context),
    generation: proposal.nextGeneration, sequence: 0, previous: null, proposal, certificate }, context);
}

/**
 * Hash parsed roots only. Different genuine confirmation proofs for the SAME
 * decided proposal authorize the same boundary, regardless of view or signers.
 * There is no nonce, new ciphertext or owner-selected replacement root here.
 */
export function historyContinuationRootId(root: HistoryContinuationRoot): string {
  return historyDigest(`resonance:history-continuation:v2\n${historySuccessorProposalId(root.proposal)}`);
}
