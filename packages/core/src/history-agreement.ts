/** Signed view-change evidence for one successor slot. No activation authority. */
import { sign, verify, type SigningKeyPair } from './crypto.js';
import { copyAdmissionSigningKey, exactWitnessFields, witnessBytes } from './admission-witness.js';
import { historyCheckpointContextId, historyDigest, isHistoryDigest, type HistoryCheckpointContext } from './history-checkpoint.js';
import { historySuccessorProposalId, parseHistorySuccessorProposal, type HistorySuccessorProposal } from './history-successor.js';

export interface HistoryAgreementRequest {
  version: 2; kind: 'history-agreement-request'; action: 'promise' | 'prepare' | 'confirm';
  contextId: string; rootId: string; generation: number; nextGeneration: number;
  replica: string; view: number; challenge: string; issuedAt: number; expiresAt: number;
  proposalId: string | null; evidenceId: string | null; signature: string;
}
export interface HistoryAgreementVote {
  version: 2; kind: 'history-agreement-vote'; phase: 'prepared' | 'confirmed';
  request: HistoryAgreementRequest; signature: string;
}
export interface HistoryAgreementCertificate {
  version: 2; kind: 'history-agreement-certificate'; phase: 'prepared' | 'confirmed'; votes: HistoryAgreementVote[];
}
export interface HistoryPreparedEvidence { proposal: HistorySuccessorProposal; certificate: HistoryAgreementCertificate }
export interface HistoryViewReport {
  version: 2; kind: 'history-view-report'; request: HistoryAgreementRequest;
  prepared: HistoryPreparedEvidence | null; signature: string;
}
export interface HistoryViewCertificate { version: 2; kind: 'history-view-certificate'; reports: HistoryViewReport[] }
export interface HistoryAgreementFrame {
  request: HistoryAgreementRequest; proposal: HistorySuccessorProposal | null;
  viewCertificate: HistoryViewCertificate | null; preparedCertificate: HistoryAgreementCertificate | null;
}
export const HISTORY_AGREEMENT_MAX_VIEW = 1_000_000;
export const HISTORY_AGREEMENT_MAX_FRAME_BYTES = 256 * 1024;
const DOMAIN = 'resonance:history-agreement:v2';
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const reqFields = ['version', 'kind', 'action', 'contextId', 'rootId', 'generation', 'nextGeneration', 'replica',
  'view', 'challenge', 'issuedAt', 'expiresAt', 'proposalId', 'evidenceId', 'signature'];
const bounded = (value: unknown, max: number) => {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > max) throw new Error('History agreement evidence exceeds capacity');
};
const reqBody = (r: HistoryAgreementRequest) => [r.version, r.kind, r.action, r.contextId, r.rootId, r.generation,
  r.nextGeneration, r.replica, r.view, r.challenge, r.issuedAt, r.expiresAt, r.proposalId, r.evidenceId];
const bytes = (purpose: string, body: unknown) => Buffer.from(`${DOMAIN}:${purpose}\n${JSON.stringify(body)}`);
function signature(purpose: string, body: unknown, key: SigningKeyPair, expected: string): string {
  const copy = copyAdmissionSigningKey(key);
  try {
    if (Buffer.from(copy.publicKey).toString('base64url') !== expected) throw new Error('Wrong agreement signing key');
    return Buffer.from(sign(bytes(purpose, body), copy.secretKey)).toString('base64url');
  } finally { copy.secretKey.fill(0); }
}
function checkSignature(purpose: string, body: unknown, encoded: unknown, key: string) {
  if (!witnessBytes(encoded, 64) || !verify(bytes(purpose, body), Buffer.from(encoded, 'base64url'), Buffer.from(key, 'base64url'))) {
    throw new Error('Invalid history agreement signature');
  }
}
/** Hash canonical parsed evidence. Callers must parse untrusted values first. */
export const historyAgreementEvidenceId = (value: HistoryAgreementCertificate | HistoryViewCertificate): string =>
  historyDigest(bytes('evidence', value));
export const historyAgreementSlot = (r: Pick<HistoryAgreementRequest, 'contextId' | 'rootId' | 'generation' | 'nextGeneration'>): string =>
  JSON.stringify([r.contextId, r.rootId, r.generation, r.nextGeneration]);
const attempt = (r: HistoryAgreementRequest) => JSON.stringify([historyAgreementSlot(r), r.action, r.view,
  r.challenge, r.issuedAt, r.expiresAt, r.proposalId, r.evidenceId]);

/** Omit now only for historical certificates, never for an incoming operation. */
export function parseHistoryAgreementRequest(value: unknown, context: HistoryCheckpointContext, now?: number): HistoryAgreementRequest {
  if (!exactWitnessFields(value, reqFields) || value.version !== 2 || value.kind !== 'history-agreement-request'
    || !['promise', 'prepare', 'confirm'].includes(value.action as string) || value.contextId !== historyCheckpointContextId(context)
    || !isHistoryDigest(value.rootId) || !integer(value.generation) || !integer(value.nextGeneration) || value.nextGeneration <= value.generation
    || !context.members.includes(value.replica as string) || !integer(value.view) || value.view < 1 || value.view > HISTORY_AGREEMENT_MAX_VIEW
    || !witnessBytes(value.challenge, 32) || !integer(value.issuedAt) || !integer(value.expiresAt)
    || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > 30_000
    || (value.action === 'promise' ? value.proposalId !== null || value.evidenceId !== null
      : !isHistoryDigest(value.proposalId) || !isHistoryDigest(value.evidenceId))
    || (now !== undefined && (!integer(now) || now < value.issuedAt || now >= value.expiresAt))) throw new Error('Invalid or expired agreement request');
  const r: HistoryAgreementRequest = { version: 2, kind: 'history-agreement-request', action: value.action as HistoryAgreementRequest['action'],
    contextId: value.contextId as string, rootId: value.rootId, generation: value.generation, nextGeneration: value.nextGeneration,
    replica: value.replica as string, view: value.view, challenge: value.challenge, issuedAt: value.issuedAt, expiresAt: value.expiresAt,
    proposalId: value.proposalId as string | null, evidenceId: value.evidenceId as string | null, signature: value.signature as string };
  checkSignature('request', reqBody(r), r.signature, context.owner); return r;
}
export function createHistoryAgreementRequest(body: Omit<HistoryAgreementRequest, 'version' | 'kind' | 'contextId' | 'signature'>,
  context: HistoryCheckpointContext, key: SigningKeyPair): HistoryAgreementRequest {
  const r: HistoryAgreementRequest = { ...body, version: 2, kind: 'history-agreement-request', contextId: historyCheckpointContextId(context), signature: '' };
  return parseHistoryAgreementRequest({ ...r, signature: signature('request', reqBody(r), key, context.owner) }, context);
}
const voteBody = (v: HistoryAgreementVote) => [v.version, v.kind, v.phase, reqBody(v.request), v.request.signature];
export function parseHistoryAgreementVote(value: unknown, context: HistoryCheckpointContext): HistoryAgreementVote {
  if (!exactWitnessFields(value, ['version', 'kind', 'phase', 'request', 'signature']) || value.version !== 2
    || value.kind !== 'history-agreement-vote' || !['prepared', 'confirmed'].includes(value.phase as string)) throw new Error('Invalid agreement vote');
  const request = parseHistoryAgreementRequest(value.request, context);
  if (request.action !== (value.phase === 'prepared' ? 'prepare' : 'confirm')) throw new Error('Wrong agreement vote phase');
  const v: HistoryAgreementVote = { version: 2, kind: 'history-agreement-vote', phase: value.phase as HistoryAgreementVote['phase'],
    request, signature: value.signature as string };
  checkSignature('vote', voteBody(v), v.signature, request.replica); return v;
}
export function createHistoryAgreementVote(request: HistoryAgreementRequest, context: HistoryCheckpointContext, key: SigningKeyPair): HistoryAgreementVote {
  const r = parseHistoryAgreementRequest(request, context);
  if (r.action === 'promise') throw new Error('A promise is not a vote');
  const v: HistoryAgreementVote = { version: 2, kind: 'history-agreement-vote', phase: r.action === 'prepare' ? 'prepared' : 'confirmed', request: r, signature: '' };
  return { ...v, signature: signature('vote', voteBody(v), key, r.replica) };
}
export function parseHistoryAgreementCertificate(value: unknown, context: HistoryCheckpointContext,
  phase?: HistoryAgreementCertificate['phase']): HistoryAgreementCertificate {
  bounded(value, 16 * 1024);
  if (!exactWitnessFields(value, ['version', 'kind', 'phase', 'votes']) || value.version !== 2 || value.kind !== 'history-agreement-certificate'
    || !['prepared', 'confirmed'].includes(value.phase as string) || (phase && value.phase !== phase)
    || !Array.isArray(value.votes) || value.votes.length !== 4) throw new Error('Four matching agreement votes required');
  const votes = value.votes.map(raw => parseHistoryAgreementVote(raw, context)).sort((a, b) => a.request.replica < b.request.replica ? -1 : 1);
  if (new Set(votes.map(v => v.request.replica)).size !== 4 || new Set(votes.map(v => attempt(v.request))).size !== 1
    || votes.some(v => v.phase !== value.phase)) throw new Error('Agreement votes must be distinct and from the same phase and attempt');
  return { version: 2, kind: 'history-agreement-certificate', phase: value.phase as HistoryAgreementCertificate['phase'], votes };
}
export function parseHistoryPreparedEvidence(value: unknown, context: HistoryCheckpointContext): HistoryPreparedEvidence {
  if (!exactWitnessFields(value, ['proposal', 'certificate'])) throw new Error('Invalid prepared evidence');
  const proposal = parseHistorySuccessorProposal(value.proposal, context), certificate = parseHistoryAgreementCertificate(value.certificate, context, 'prepared');
  const r = certificate.votes[0].request;
  if (r.proposalId !== historySuccessorProposalId(proposal) || historyAgreementSlot(r) !== historyAgreementSlot(proposal)) {
    throw new Error('Prepared proof binds another proposal or slot');
  }
  return { proposal, certificate };
}
const reportBody = (r: HistoryViewReport) => [r.version, r.kind, reqBody(r.request), r.request.signature,
  r.prepared && [historySuccessorProposalId(r.prepared.proposal), historyAgreementEvidenceId(r.prepared.certificate)]];
export function parseHistoryViewReport(value: unknown, context: HistoryCheckpointContext): HistoryViewReport {
  bounded(value, 64 * 1024);
  if (!exactWitnessFields(value, ['version', 'kind', 'request', 'prepared', 'signature']) || value.version !== 2 || value.kind !== 'history-view-report') {
    throw new Error('Invalid history view report');
  }
  const request = parseHistoryAgreementRequest(value.request, context);
  const prepared = value.prepared === null ? null : parseHistoryPreparedEvidence(value.prepared, context);
  if (request.action !== 'promise' || (prepared && (historyAgreementSlot(prepared.proposal) !== historyAgreementSlot(request)
    || prepared.certificate.votes[0].request.view >= request.view))) throw new Error('View report does not carry an earlier proof for this slot');
  const r: HistoryViewReport = { version: 2, kind: 'history-view-report', request, prepared, signature: value.signature as string };
  checkSignature('report', reportBody(r), r.signature, request.replica); return r;
}
export function createHistoryViewReport(request: HistoryAgreementRequest, prepared: HistoryPreparedEvidence | null,
  context: HistoryCheckpointContext, key: SigningKeyPair): HistoryViewReport {
  const r: HistoryViewReport = { version: 2, kind: 'history-view-report', request: parseHistoryAgreementRequest(request, context),
    prepared: prepared && parseHistoryPreparedEvidence(prepared, context), signature: '' };
  if (r.request.action !== 'promise' || (r.prepared && (historyAgreementSlot(r.prepared.proposal) !== historyAgreementSlot(r.request)
    || r.prepared.certificate.votes[0].request.view >= r.request.view))) throw new Error('Invalid earlier prepared proof');
  return { ...r, signature: signature('report', reportBody(r), key, r.request.replica) };
}
export function parseHistoryViewCertificate(value: unknown, context: HistoryCheckpointContext): HistoryViewCertificate {
  bounded(value, 192 * 1024);
  if (!exactWitnessFields(value, ['version', 'kind', 'reports']) || value.version !== 2 || value.kind !== 'history-view-certificate'
    || !Array.isArray(value.reports) || value.reports.length !== 4) throw new Error('Four view reports required');
  const reports = value.reports.map(raw => parseHistoryViewReport(raw, context)).sort((a, b) => a.request.replica < b.request.replica ? -1 : 1);
  if (new Set(reports.map(r => r.request.replica)).size !== 4 || new Set(reports.map(r => attempt(r.request))).size !== 1) {
    throw new Error('View reports must be distinct and from the same attempt');
  }
  return { version: 2, kind: 'history-view-certificate', reports };
}
/** Verify a reply against the exact outstanding request, including its target and challenge. */
export function parseHistoryAgreementResponse(value: unknown, request: HistoryAgreementRequest,
  context: HistoryCheckpointContext): HistoryViewReport | HistoryAgreementVote {
  const original = parseHistoryAgreementRequest(request, context);
  bounded(value, original.action === 'promise' ? 64 * 1024 : 4096);
  const response = original.action === 'promise' ? parseHistoryViewReport(value, context) : parseHistoryAgreementVote(value, context);
  if (JSON.stringify(response.request) !== JSON.stringify(original)) throw new Error('Agreement reply belongs to another request');
  return response;
}
export function assertHistoryAgreementSelection(proposal: HistorySuccessorProposal, certificate: HistoryViewCertificate): void {
  if (historyAgreementSlot(proposal) !== historyAgreementSlot(certificate.reports[0].request)) throw new Error('Selection belongs to another slot');
  const proofs = certificate.reports.flatMap(r => r.prepared ? [r.prepared] : []);
  const highestView = Math.max(0, ...proofs.map(p => p.certificate.votes[0].request.view));
  const required = new Set(proofs.filter(p => p.certificate.votes[0].request.view === highestView).map(p => historySuccessorProposalId(p.proposal)));
  if (required.size > 1 || (required.size && !required.has(historySuccessorProposalId(proposal)))) throw new Error('Selection must preserve the highest prepared proposal');
}
export function parseHistoryAgreementFrame(value: unknown, context: HistoryCheckpointContext, now?: number): HistoryAgreementFrame {
  bounded(value, HISTORY_AGREEMENT_MAX_FRAME_BYTES);
  if (!exactWitnessFields(value, ['request', 'proposal', 'viewCertificate', 'preparedCertificate'])) throw new Error('Invalid agreement frame');
  const request = parseHistoryAgreementRequest(value.request, context, now);
  const proposal = value.proposal === null ? null : parseHistorySuccessorProposal(value.proposal, context);
  const viewCertificate = value.viewCertificate === null ? null : parseHistoryViewCertificate(value.viewCertificate, context);
  const preparedCertificate = value.preparedCertificate === null ? null : parseHistoryAgreementCertificate(value.preparedCertificate, context, 'prepared');
  if (request.action === 'promise') {
    if (proposal || viewCertificate || preparedCertificate) throw new Error('Unexpected promise payload');
  } else {
    if (!proposal || historyAgreementSlot(proposal) !== historyAgreementSlot(request) || historySuccessorProposalId(proposal) !== request.proposalId) {
      throw new Error('Agreement request proposal mismatch');
    }
    if (request.action === 'prepare') {
      if (!viewCertificate || preparedCertificate || request.evidenceId !== historyAgreementEvidenceId(viewCertificate)
        || viewCertificate.reports[0].request.view !== request.view) throw new Error('Prepare request proof mismatch');
      assertHistoryAgreementSelection(proposal, viewCertificate);
    } else {
      if (!preparedCertificate || viewCertificate || request.evidenceId !== historyAgreementEvidenceId(preparedCertificate)
        || preparedCertificate.votes[0].request.view !== request.view) throw new Error('Confirm request proof mismatch');
      parseHistoryPreparedEvidence({ proposal, certificate: preparedCertificate }, context);
    }
  }
  return { request, proposal, viewCertificate, preparedCertificate };
}
