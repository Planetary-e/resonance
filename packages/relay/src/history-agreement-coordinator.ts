/** Explicit, resumable owner agreement. A decided certificate does not activate a writer. */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { assertSecureRelayTransportEndpoint, type SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields, witnessBytes } from '@resonance/core/admission-witness';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { historyCheckpointContextId, isHistoryDigest, parseHistoryCheckpointContext, type HistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { historySuccessorProposalId, parseHistorySuccessorProposal, type HistorySuccessorProposal } from '@resonance/core/history-successor';
import {
  HISTORY_AGREEMENT_MAX_VIEW, assertHistoryAgreementSelection, createHistoryAgreementRequest,
  historyAgreementEvidenceId, historyAgreementSlot, parseHistoryAgreementCertificate, parseHistoryAgreementRequest,
  parseHistoryAgreementResponse, parseHistoryPreparedEvidence, parseHistoryViewCertificate,
  type HistoryAgreementCertificate, type HistoryAgreementFrame, type HistoryAgreementRequest, type HistoryAgreementVote,
  type HistoryPreparedEvidence, type HistoryViewCertificate, type HistoryViewReport,
} from '@resonance/core/history-agreement';
import type { HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';
import { createHistoryAgreementHistory } from './history-agreement-history.js';
import { exchangeHistoryAgreement, exchangeHistoryAgreementData, type HistoryAgreementDataTransport, type HistoryAgreementTransport } from './history-agreement-exchange.js';

export const HISTORY_AGREEMENT_COORDINATOR_FILENAME = 'history-agreement-owner.json';
interface AgreementAttempt { challenge: string; issuedAt: number; expiresAt: number }
export interface AgreementOwnerState {
  version: 2; contextId: string; rootId: string; generation: number; nextGeneration: number;
  preferred: HistorySuccessorProposal; view: number; phase: 'promise' | 'prepare' | 'confirm' | 'decided';
  selected: HistorySuccessorProposal | null; viewCertificate: HistoryViewCertificate | null;
  preparedCertificate: HistoryAgreementCertificate | null; certificate: HistoryAgreementCertificate | null;
  /** Keep the last locally known prepared proof when explicitly moving to a later view. */
  previous: HistoryPreparedEvidence | null; attempt: AgreementAttempt | null;
}
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const validView = (n: unknown): n is number => integer(n) && n >= 1 && n <= HISTORY_AGREEMENT_MAX_VIEW;

export function createHistoryAgreementCoordinator(options: {
  directory: string; localKey: Uint8Array; context: HistoryCheckpointContext; signingKey: SigningKeyPair;
  rootId: string; generation: number; nextGeneration: number; members: HistoryReplicaEndpoint[];
  initialize?: { proposal: HistorySuccessorProposal; view?: number };
  timeoutMs?: number; transport?: HistoryAgreementTransport;
  /** Explicit composition with ciphertext recovery/write-back; never activates a writer. */
  historyTransfer?: { transport?: HistoryAgreementDataTransport };
  /** Independent anchor, not a value recovered from the same owner file. */
  minimumView?: number;
}) {
  const context = parseHistoryCheckpointContext(options.context), contextId = historyCheckpointContextId(context);
  const { rootId, generation, nextGeneration } = options, slot = { contextId, rootId, generation, nextGeneration };
  const timeoutMs = options.timeoutMs ?? 30_000, transport = options.transport ?? exchangeHistoryAgreement;
  if (!isHistoryDigest(rootId) || !integer(generation) || !integer(nextGeneration) || nextGeneration <= generation
    || !integer(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000 || options.members.length !== 5
    || (options.minimumView !== undefined && !validView(options.minimumView))) throw new Error('Invalid agreement coordinator configuration');
  const members = options.members.map(member => {
    if (!context.members.includes(member.publicKey)) throw new Error('Unknown agreement member');
    assertSecureRelayTransportEndpoint(member.endpoint);
    return { publicKey: member.publicKey, endpoint: new URL(member.endpoint).href };
  });
  if (new Set(members.map(m => m.publicKey)).size !== 5 || new Set(members.map(m => m.endpoint)).size !== 5) {
    throw new Error('Agreement needs five distinct pinned members and endpoints');
  }
  const matchesSlot = (r: typeof slot) => historyAgreementSlot(r) === historyAgreementSlot(slot);
  function valid(raw: unknown): raw is AgreementOwnerState {
    if (!exactWitnessFields(raw, ['version', 'contextId', 'rootId', 'generation', 'nextGeneration', 'preferred', 'view', 'phase',
      'selected', 'viewCertificate', 'preparedCertificate', 'certificate', 'previous', 'attempt']) || raw.version !== 2
      || raw.contextId !== contextId || raw.rootId !== rootId || raw.generation !== generation || raw.nextGeneration !== nextGeneration
      || !validView(raw.view) || !['promise', 'prepare', 'confirm', 'decided'].includes(raw.phase as string)) return false;
    try {
      if (!matchesSlot(parseHistorySuccessorProposal(raw.preferred, context))) return false;
      if (raw.attempt !== null && (!exactWitnessFields(raw.attempt, ['challenge', 'issuedAt', 'expiresAt'])
        || !witnessBytes(raw.attempt.challenge, 32) || !integer(raw.attempt.issuedAt) || !integer(raw.attempt.expiresAt)
        || raw.attempt.expiresAt <= raw.attempt.issuedAt || raw.attempt.expiresAt - raw.attempt.issuedAt > 30_000)) return false;
      if (raw.previous !== null) {
        const previous = parseHistoryPreparedEvidence(raw.previous, context);
        if (!matchesSlot(previous.proposal) || previous.certificate.votes[0].request.view >= raw.view) return false;
      }
      if (raw.phase === 'promise') return raw.selected === null && raw.viewCertificate === null && raw.preparedCertificate === null && raw.certificate === null;
      const selected = parseHistorySuccessorProposal(raw.selected, context), viewCertificate = parseHistoryViewCertificate(raw.viewCertificate, context);
      if (!matchesSlot(selected) || viewCertificate.reports[0].request.view !== raw.view) return false;
      assertHistoryAgreementSelection(selected, viewCertificate);
      if (raw.phase === 'prepare') return raw.preparedCertificate === null && raw.certificate === null;
      const prepared = parseHistoryPreparedEvidence({ proposal: selected, certificate: raw.preparedCertificate }, context).certificate;
      if (prepared.votes[0].request.view !== raw.view || prepared.votes[0].request.evidenceId !== historyAgreementEvidenceId(viewCertificate)) return false;
      if (raw.phase === 'confirm') return raw.certificate === null;
      const certificate = parseHistoryAgreementCertificate(raw.certificate, context, 'confirmed'), request = certificate.votes[0].request;
      return raw.attempt === null && matchesSlot(request) && request.view === raw.view
        && request.proposalId === historySuccessorProposalId(selected) && request.evidenceId === historyAgreementEvidenceId(prepared);
    } catch { return false; }
  }
  const key = copyAdmissionSigningKey(options.signingKey);
  let storage: ReturnType<typeof openEncryptedLocalState<AgreementOwnerState>>;
  try {
    if (Buffer.from(key.publicKey).toString('base64url') !== context.owner) throw new Error('Wrong agreement owner');
    let initial: AgreementOwnerState | undefined;
    if (options.initialize) {
      initial = { version: 2, ...slot, preferred: parseHistorySuccessorProposal(options.initialize.proposal, context),
        view: options.initialize.view ?? 1, phase: 'promise', selected: null, viewCertificate: null,
        preparedCertificate: null, certificate: null, previous: null, attempt: null };
      if (!valid(initial) || initial.view < (options.minimumView ?? 1)) throw new Error('Invalid agreement initialization or anchor');
    }
    storage = openEncryptedLocalState<AgreementOwnerState>({ path: join(options.directory, HISTORY_AGREEMENT_COORDINATOR_FILENAME),
      key: options.localKey, domain: 'resonance:history-agreement-owner:v2', maxBytes: 2 * 1024 * 1024,
      mode: initial ? 'create-new' : 'open-existing', initial: initial!, validate: valid });
    if (storage.read().view < (options.minimumView ?? 1)) { storage.close(); throw new Error('Agreement is behind the external view anchor'); }
  } catch (error) { key.secretKey.fill(0); throw error; }
  let closed = false, active: AbortController | undefined;
  return {
    read(): AgreementOwnerState { return structuredClone(storage.read()); },
    /** No automatic view change after timeout. Persist the explicit higher round without sending. */
    beginView(view: number): void {
      const state = storage.read();
      if (active) throw new Error('Agreement already has an active attempt');
      if (!validView(view) || view <= state.view || state.phase === 'decided') throw new Error('Cannot replace a decided agreement or regress its view');
      storage.write({ ...state, view, phase: 'promise', selected: null, viewCertificate: null, preparedCertificate: null,
        certificate: null, attempt: null, previous: state.preparedCertificate
          ? { proposal: state.selected!, certificate: state.preparedCertificate } : state.previous });
    },
    /** Explicit continuation only; reopen, read and beginView never transmit. */
    async run(signal?: AbortSignal): Promise<HistoryAgreementCertificate> {
      storage.read();
      if (active) throw new Error('Agreement already has an active attempt');
      if (signal?.aborted) throw new Error('Agreement cancelled');
      if (storage.read().certificate) return structuredClone(storage.read().certificate!); // Historical decision, not readiness.
      const started = performance.now(), issuedAt = Date.now(), expiresAt = issuedAt + timeoutMs;
      const controller = new AbortController(); active = controller;
      const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
      const deadlineError = new Error('Agreement deadline expired');
      const deadlineTimer = setTimeout(() => controller.abort(deadlineError), timeoutMs);
      const live = () => {
        if (closed || controller.signal.aborted || performance.now() - started >= timeoutMs || Date.now() >= expiresAt) {
          throw new Error('Agreement cancelled or timed out');
        }
      };
      function frameFor(state: AgreementOwnerState, attempt: AgreementAttempt, member: HistoryReplicaEndpoint, action: HistoryAgreementRequest['action']): HistoryAgreementFrame {
        const proof = action === 'prepare' ? state.viewCertificate : action === 'confirm' ? state.preparedCertificate : null;
        const request = createHistoryAgreementRequest({ action, rootId, generation, nextGeneration, view: state.view,
          replica: member.publicKey, ...attempt, proposalId: action === 'promise' ? null : historySuccessorProposalId(state.selected!),
          evidenceId: proof && historyAgreementEvidenceId(proof) }, context, key);
        return { request, proposal: action === 'promise' ? null : state.selected,
          viewCertificate: action === 'prepare' ? state.viewCertificate : null, preparedCertificate: action === 'confirm' ? state.preparedCertificate : null };
      }
      async function collect(state: AgreementOwnerState, attempt: AgreementAttempt,
        history?: ReturnType<typeof createHistoryAgreementHistory>): Promise<Array<HistoryViewReport | HistoryAgreementVote>> {
        return new Promise((resolve, reject) => {
          const group = new AbortController(), replies: Array<HistoryViewReport | HistoryAgreementVote> = [];
          let settled = false, remaining = 5;
          const finish = (error?: Error) => {
            if (settled) return; settled = true;
            clearTimeout(timer); controller.signal.removeEventListener('abort', abort); group.abort();
            if (error) reject(error); else resolve(replies);
          };
          const abort = () => finish(controller.signal.reason === deadlineError ? deadlineError : new Error('Agreement cancelled'));
          const timer = setTimeout(() => finish(new Error('Four agreement replies unavailable before deadline')),
            Math.max(1, timeoutMs - (performance.now() - started)));
          controller.signal.addEventListener('abort', abort, { once: true });
          async function send(member: HistoryReplicaEndpoint, action: HistoryAgreementRequest['action']) {
            live(); if (group.signal.aborted) throw new Error('Agreement phase completed');
            const frame = frameFor(state, attempt, member, action), request = frame.request;
            if (action === 'prepare') await history?.synchronize(member, group.signal);
            live();
            const raw = await transport(member, structuredClone(frame), group.signal);
            live(); if (group.signal.aborted) throw new Error('Agreement phase completed');
            const response = parseHistoryAgreementResponse(raw, request, context);
            parseHistoryAgreementRequest(request, context, Date.now()); live(); return response;
          }
          async function memberPhase(member: HistoryReplicaEndpoint) {
            // A different fourth volunteer may answer this phase. Supply its missing prerequisites.
            if (state.phase !== 'promise' && !state.preparedCertificate?.votes.some(v => v.request.replica === member.publicKey)) {
              if (!state.viewCertificate!.reports.some(r => r.request.replica === member.publicKey)) await send(member, 'promise');
              if (state.phase === 'confirm') await send(member, 'prepare');
            }
            return send(member, state.phase as HistoryAgreementRequest['action']);
          }
          members.forEach(member => {
            void Promise.resolve().then(() => memberPhase(member)).then(response => {
              if (settled) return; live(); replies.push(response);
              if (replies.length === 4) finish();
            }).catch(() => {}).finally(() => {
              if (!settled && replies.length + --remaining < 4) finish(new Error('Four authenticated agreement replies unavailable'));
            });
          });
        });
      }
      let history: ReturnType<typeof createHistoryAgreementHistory> | undefined;
      let transferState: AgreementOwnerState, transferAttempt: AgreementAttempt;
      try {
        while (storage.read().phase !== 'decided') {
          live();
          const state = storage.read(), attempt = { challenge: randomBytes(32).toString('base64url'), issuedAt, expiresAt };
          storage.write({ ...state, attempt }); live(); // Intent precedes every phase and prerequisite request.
          transferState = state; transferAttempt = attempt;
          if (options.historyTransfer && state.phase !== 'promise' && !history) {
            history = createHistoryAgreementHistory({ context, key, members, proposal: state.selected!,
              authorization: member => frameFor(transferState, transferAttempt, member, 'prepare'),
              transport: options.historyTransfer.transport ?? exchangeHistoryAgreementData, signal: controller.signal, live });
            await history.download(); live();
          }
          const replies = await collect(state, attempt, history); live();
          let next: AgreementOwnerState;
          if (state.phase === 'promise') {
            const viewCertificate = parseHistoryViewCertificate({ version: 2, kind: 'history-view-certificate', reports: replies }, context);
            const highest = viewCertificate.reports.flatMap(r => r.prepared ? [r.prepared] : [])
              .sort((a, b) => b.certificate.votes[0].request.view - a.certificate.votes[0].request.view)[0];
            const selected = highest?.proposal ?? state.previous?.proposal ?? state.preferred;
            assertHistoryAgreementSelection(selected, viewCertificate);
            next = { ...state, phase: 'prepare', selected, viewCertificate, attempt: null };
          } else {
            const certificate = parseHistoryAgreementCertificate({ version: 2, kind: 'history-agreement-certificate',
              phase: state.phase === 'prepare' ? 'prepared' : 'confirmed', votes: replies }, context);
            next = state.phase === 'prepare' ? { ...state, phase: 'confirm', preparedCertificate: certificate, attempt: null }
              : { ...state, phase: 'decided', certificate, attempt: null };
          }
          live(); storage.write(next); live(); // Complete proof precedes any subsequent phase or successful return.
        }
        return structuredClone(storage.read().certificate!);
      } finally { clearTimeout(deadlineTimer); signal?.removeEventListener('abort', cancel); controller.abort(); if (active === controller) active = undefined; }
    },
    close() { if (!closed) { closed = true; active?.abort(); storage.close(); key.secretKey.fill(0); } },
  };
}
