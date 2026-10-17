import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistoryFreeze } from '@resonance/core/history-checkpoint';
import { createHistoryExchangeRequest, type HistoryRecoveryPreparation } from '@resonance/core/history-exchange';
import { createHistorySuccessorProposal, historySuccessorProposalId, type HistorySuccessorProposal } from '@resonance/core/history-successor';
import {
  createHistoryAgreementRequest, historyAgreementEvidenceId, parseHistoryAgreementCertificate, parseHistoryViewCertificate,
  type HistoryAgreementCertificate, type HistoryAgreementFrame, type HistoryAgreementRequest, type HistoryViewCertificate,
} from '@resonance/core/history-agreement';
import { openHistoryCheckpointStore } from '../../history-checkpoint-store.js';
import { createHistoryCheckpointReplica } from '../../history-checkpoint-exchange.js';
import { createHistoryAgreementReplica } from '../../history-checkpoint-agreement.js';
import { historyCheckpointFixture } from './history-checkpoint-fixture.js';

export const AGREEMENT_TEST_TIME = 10_000;
export function historyAgreementFixture(tail: 'none' | 'missing' | 'newer' | 'sparse' | 'forked' = 'none', length = 1,
  shape: { checkpointSequence?: number; laggingSequence?: number } = {}) {
  const f = historyCheckpointFixture(), directory = mkdtempSync(join(tmpdir(), 'history-agreement-'));
  const stores = f.context.members.map((replica, i) => openHistoryCheckpointStore({ ...f.options, replica,
    directory: join(directory, `r${i}`), initialize: f.root }));
  const blocks = [f.root];
  for (let i = 0; i < length; i++) blocks.push(f.next(blocks.at(-1)!, undefined, i + 1 === shape.checkpointSequence ? 'checkpoint' : 'delta'));
  const delta = blocks[1];
  if (tail === 'missing') stores.slice(0, 4).forEach(s => blocks.slice(1).forEach(b => s.append(b)));
  if (tail === 'missing' && shape.laggingSequence) blocks.slice(1, shape.laggingSequence + 1).forEach(b => stores[4].append(b));
  if (tail === 'sparse' || tail === 'forked') blocks.slice(1).forEach(b => stores[0].append(b));
  if (tail === 'forked') stores[4].append(f.next(f.root));
  if (tail === 'newer') stores[4].append(delta);
  const challenge = randomBytes(32).toString('base64url');
  const receipts = stores.map((store, i) => {
    const role = createHistoryCheckpointReplica({ context: f.context, store, signingKey: f.memberKeys[i], now: () => AGREEMENT_TEST_TIME });
    try {
      return role.exchange({ request: createHistoryExchangeRequest({ action: 'freeze', rootId: f.options.rootId, generation: 0,
        replica: f.context.members[i], challenge, issuedAt: AGREEMENT_TEST_TIME, expiresAt: AGREEMENT_TEST_TIME + 30_000,
        sequence: 1, envelopeId: null }, f.context, f.owner), envelope: null,
      freeze: createHistoryFreeze(f.context, 0, 1, challenge, f.owner) });
    } finally { role.close(); }
  });
  const preparation: HistoryRecoveryPreparation = { version: 1, kind: 'frozen-history', rootId: f.options.rootId,
    generation: 0, nextGeneration: 1, receipts: receipts.slice(0, 4), envelopes: tail === 'missing' || tail === 'sparse' || tail === 'forked' ? blocks : [f.root] };
  const a = createHistorySuccessorProposal(preparation, f.context, f.owner), b = createHistorySuccessorProposal(preparation, f.context, f.owner);
  const roles = stores.map((store, i) => createHistoryAgreementReplica({ context: f.context, store, signingKey: f.memberKeys[i], now: () => AGREEMENT_TEST_TIME }));
  function frames(action: HistoryAgreementRequest['action'], view: number, proposal: HistorySuccessorProposal | null = null,
    proof: HistoryViewCertificate | HistoryAgreementCertificate | null = null): HistoryAgreementFrame[] {
    const challenge = randomBytes(32).toString('base64url');
    return f.context.members.map(replica => ({ request: createHistoryAgreementRequest({ action, rootId: f.options.rootId,
      generation: 0, nextGeneration: 1, replica, view, challenge, issuedAt: AGREEMENT_TEST_TIME, expiresAt: AGREEMENT_TEST_TIME + 30_000,
      proposalId: proposal && historySuccessorProposalId(proposal), evidenceId: proof && historyAgreementEvidenceId(proof) }, f.context, f.owner),
    proposal, viewCertificate: proof?.kind === 'history-view-certificate' ? proof : null,
    preparedCertificate: proof?.kind === 'history-agreement-certificate' ? proof : null }));
  }
  const viewCertificate = (reports: unknown[]) => parseHistoryViewCertificate({ version: 2, kind: 'history-view-certificate', reports }, f.context);
  const certificate = (votes: unknown[], phase: 'prepared' | 'confirmed' = 'prepared') =>
    parseHistoryAgreementCertificate({ version: 2, kind: 'history-agreement-certificate', phase, votes }, f.context, phase);
  function promise(view: number, members = [0, 1, 2, 3]) {
    const requests = frames('promise', view);
    return viewCertificate(members.map(i => roles[i].exchange(requests[i])));
  }
  function reopen(i: number) {
    roles[i].close(); stores[i].close();
    stores[i] = openHistoryCheckpointStore({ ...f.options, replica: f.context.members[i], directory: join(directory, `r${i}`) });
    roles[i] = createHistoryAgreementReplica({ context: f.context, store: stores[i], signingKey: f.memberKeys[i], now: () => AGREEMENT_TEST_TIME });
  }
  return { ...f, directory, stores, roles, preparation, delta, blocks, a, b, frames, viewCertificate, certificate, promise, reopen,
    close() { roles.forEach(r => r.close()); stores.forEach(s => s.close()); rmSync(directory, { recursive: true, force: true }); } };
}
