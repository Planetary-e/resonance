/** Checks a selected frozen chain whose omitted prefix is independently certified.
 * This authenticates historical evidence; it grants no fresh writer authority. */
import { isHistoryDigest, type HistoryCheckpointContext } from './history-checkpoint.js';
import { parseHistoryCompactionAttestation, parseHistoryCompactionCertificate } from './history-compaction.js';
import { parseHistorySuccessorProposal } from './history-successor.js';
import { HISTORY_RECOVERY_MAX_BLOCKS } from './history-exchange.js';

export function assertHistoryCompactedSuccessorChain(options: {
  proposal: unknown; ids: readonly string[]; certificate: unknown; checkpoint: unknown;
  context: HistoryCheckpointContext; genesisId: string;
}): void {
  parseHistoryCompactionCertificate(options.certificate, options.context, options.genesisId, options.checkpoint);
  assertHistoryCompactedSuccessorIds(options);
}

/** Manifest-level proof only. Before exposing history, callers must also authenticate
 * the named checkpoint ciphertext and every retained suffix link. */
export function assertHistoryCompactedSuccessorIds(options: {
  proposal: unknown; ids: readonly string[]; certificate: unknown;
  context: HistoryCheckpointContext; genesisId: string;
}): void {
  const p = parseHistorySuccessorProposal(options.proposal, options.context);
  const certificate = parseHistoryCompactionAttestation(options.certificate, options.context, options.genesisId);
  const anchor = certificate.proposal, ids = options.ids;
  if (ids.length > HISTORY_RECOVERY_MAX_BLOCKS || p.rootId !== anchor.rootId || p.generation !== anchor.generation || p.sequence < anchor.sequence
    || ids.length !== p.sequence - anchor.sequence + 1 || ids[0] !== anchor.envelopeId || ids.at(-1) !== p.envelopeId
    || !ids.every(isHistoryDigest) || new Set(ids).size !== ids.length
    || p.freezes.some(r => r.head.sequence >= anchor.sequence && ids[r.head.sequence - anchor.sequence] !== r.head.envelopeId)) {
    throw new Error('Compacted successor requires the exact certified checkpoint and complete selected suffix');
  }
  // A freeze below the anchor contributes no suffix evidence. Its older opaque
  // ID cannot be compared after pruning. Four retained-ancestry endorsements and
  // four frozen heads intersect in at least two honest members (one fault/5),
  // and the existing correct-owner assumption supplies a single signed chain.
  // Every head at/above the anchor, including the highest, must match exactly.
  // Callers must also authenticate each ciphertext link within ids.
}
