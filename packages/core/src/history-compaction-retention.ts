/** Evidence that four distinct volunteers durably retained a checkpoint proof.
 * Historical storage evidence only; not fresh writer authority or readiness. */
import { exactWitnessFields } from './admission-witness.js';
import type { HistoryCheckpointContext } from './history-checkpoint.js';
import { parseHistoryCompactionAttestation, type HistoryCompactionCertificate } from './history-compaction.js';
import { parseHistoryCompactionControlRequest, parseHistoryCompactionControlResponse,
  type HistoryCompactionControlResponse } from './history-compaction-control.js';

export const HISTORY_COMPACTION_RETENTION_MAX_BYTES = 64 * 1024;
export interface HistoryCompactionRetention {
  version: 1; kind: 'history-compaction-retention'; certificate: HistoryCompactionCertificate;
  receipts: HistoryCompactionControlResponse[];
}
export function parseHistoryCompactionRetention(value: unknown, context: HistoryCheckpointContext, genesisId: string): HistoryCompactionRetention {
  if (!exactWitnessFields(value, ['version', 'kind', 'certificate', 'receipts']) || value.version !== 1
    || value.kind !== 'history-compaction-retention' || !Array.isArray(value.receipts) || value.receipts.length !== 4
    || Buffer.byteLength(JSON.stringify(value)) > HISTORY_COMPACTION_RETENTION_MAX_BYTES) throw new Error('Invalid checkpoint proof retention evidence');
  const certificate = parseHistoryCompactionAttestation(value.certificate, context, genesisId);
  const receipts = value.receipts.map(raw => {
    if (!raw || typeof raw !== 'object' || !('request' in raw)) throw new Error('Missing checkpoint retention request');
    const request = parseHistoryCompactionControlRequest(raw.request, context, genesisId);
    if (request.action !== 'retain') throw new Error('Checkpoint retention requires durable retention acknowledgements');
    return parseHistoryCompactionControlResponse(raw, { request, certificate }, context, genesisId);
  }).sort((a, b) => a.request.replica < b.request.replica ? -1 : a.request.replica > b.request.replica ? 1 : 0);
  if (new Set(receipts.map(r => r.request.replica)).size !== 4
    || new Set(receipts.map(r => JSON.stringify([r.request.challenge, r.request.issuedAt, r.request.expiresAt]))).size !== 1) {
    throw new Error('Checkpoint retention needs four distinct members from the same owner request');
  }
  return { version: 1, kind: 'history-compaction-retention', certificate, receipts };
}
