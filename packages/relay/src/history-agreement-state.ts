/** Durable agreement transitions. The checkpoint store owns persistence and payload checks. */
import type { SigningKeyPair } from '@resonance/core';
import { exactWitnessFields } from '@resonance/core/admission-witness';
import type { HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { historySuccessorProposalId } from '@resonance/core/history-successor';
import {
  createHistoryAgreementVote, createHistoryViewReport, historyAgreementSlot,
  parseHistoryAgreementFrame, parseHistoryAgreementVote, parseHistoryViewReport,
  type HistoryAgreementFrame, type HistoryAgreementVote, type HistoryViewReport,
} from '@resonance/core/history-agreement';

interface RetainedVote { frame: HistoryAgreementFrame; vote: HistoryAgreementVote }
export interface HistoryAgreementState {
  version: 2;
  /** Snapshot at entry to this view; retries must not replace it with a current-view proof. */
  report: HistoryViewReport;
  prepared: RetainedVote | null;
  /** Highest proof saved before issuing a confirmation, including across view changes. */
  confirmed: RetainedVote | null;
}
const evidence = (record: RetainedVote | null) => record && ({
  proposal: record.frame.proposal!, certificate: record.frame.preparedCertificate!,
});
const proposalId = (record: RetainedVote) => historySuccessorProposalId(record.frame.proposal!);

/** Historical validation: receipt expiry does not erase a persisted vote or barrier. */
export function parseHistoryAgreementState(value: unknown, context: HistoryCheckpointContext, replica: string): HistoryAgreementState {
  if (!exactWitnessFields(value, ['version', 'report', 'prepared', 'confirmed']) || value.version !== 2) {
    throw new Error('Invalid persisted history agreement');
  }
  const report = parseHistoryViewReport(value.report, context), current = report.request;
  if (current.replica !== replica) throw new Error('Agreement report belongs to another replica');
  function retained(raw: unknown, phase: HistoryAgreementVote['phase']): RetainedVote | null {
    if (raw === null) return null;
    if (!exactWitnessFields(raw, ['frame', 'vote'])) throw new Error('Invalid retained agreement vote');
    const frame = parseHistoryAgreementFrame(raw.frame, context), vote = parseHistoryAgreementVote(raw.vote, context);
    if (vote.phase !== phase || JSON.stringify(frame.request) !== JSON.stringify(vote.request)
      || frame.request.replica !== replica || historyAgreementSlot(frame.request) !== historyAgreementSlot(current)
      || frame.request.view > current.view) throw new Error('Retained agreement vote mismatch');
    return { frame, vote };
  }
  const prepared = retained(value.prepared, 'prepared'), confirmed = retained(value.confirmed, 'confirmed');
  if (prepared && prepared.frame.request.view !== current.view) throw new Error('Stale tentative agreement vote');
  if (confirmed?.frame.request.view === current.view) {
    if (!prepared || proposalId(prepared) !== proposalId(confirmed)) throw new Error('Confirmation lacks its local preparation');
  } else if (JSON.stringify(report.prepared) !== JSON.stringify(evidence(confirmed))) {
    throw new Error('View entry lost the highest confirmed prepared proof');
  }
  return { version: 2, report, prepared, confirmed };
}

/** Inputs have been authenticated and checked against local pins and retained payloads. */
export function advanceHistoryAgreement(state: HistoryAgreementState | null, frame: HistoryAgreementFrame,
  context: HistoryCheckpointContext, key: SigningKeyPair): { state: HistoryAgreementState; response: HistoryViewReport | HistoryAgreementVote } {
  const request = frame.request;
  if (request.action === 'promise') {
    if (state && request.view < state.report.request.view) throw new Error('Stale agreement view');
    const sameView = state?.report.request.view === request.view;
    const report = createHistoryViewReport(request, sameView ? state!.report.prepared : evidence(state?.confirmed ?? null), context, key);
    return { state: { version: 2, report, prepared: sameView ? state!.prepared : null, confirmed: state?.confirmed ?? null }, response: report };
  }
  if (!state || request.view !== state.report.request.view) throw new Error('Agreement requires a promise in the current view');
  if (request.action === 'prepare') {
    if (state.prepared && proposalId(state.prepared) !== request.proposalId) throw new Error('Another proposal was prepared in this view');
    const vote = createHistoryAgreementVote(request, context, key);
    return { state: { ...state, prepared: { frame, vote } }, response: vote };
  }
  if (!state.prepared || proposalId(state.prepared) !== request.proposalId) throw new Error('Confirmation requires the local prepared proposal');
  const vote = createHistoryAgreementVote(request, context, key);
  return { state: { ...state, confirmed: { frame, vote } }, response: vote };
}
