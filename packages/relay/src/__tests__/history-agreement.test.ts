import { afterEach, describe, expect, it, vi } from 'vitest';
import { fsyncSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createHistoryFreeze, historyDigest } from '@resonance/core/history-checkpoint';
import { historySuccessorProposalId } from '@resonance/core/history-successor';
import {
  createHistoryAgreementRequest, createHistoryAgreementVote, createHistoryViewReport, historyAgreementEvidenceId,
  parseHistoryAgreementCertificate, parseHistoryAgreementFrame, parseHistoryAgreementRequest,
} from '@resonance/core/history-agreement';
import { openHistoryCheckpointStore, HISTORY_MANIFEST_FILENAME } from '../history-checkpoint-store.js';
import { parseHistoryAgreementState } from '../history-agreement-state.js';
import { historyAgreementFixture, AGREEMENT_TEST_TIME as NOW } from './fixtures/history-agreement-fixture.js';

vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) }; });
const actualFsync = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
const fixtures: ReturnType<typeof historyAgreementFixture>[] = [];
function fixture(tail?: Parameters<typeof historyAgreementFixture>[0]) { const n = historyAgreementFixture(tail); fixtures.push(n); return n; }
afterEach(() => { vi.mocked(fsyncSync).mockReset().mockImplementation(actualFsync); fixtures.splice(0).forEach(n => n.close()); });

describe('signed durable successor agreement', { timeout: 30_000 }, () => {
it('decides with four volunteers, preserves evidence across restart and separates tentative from final votes', () => {
  const n = fixture(), view = n.promise(1), prepare = n.frames('prepare', 1, n.a, view);
  const prepared = n.certificate(prepare.slice(0, 4).map((f, i) => n.roles[i].exchange(f)));
  expect(() => parseHistoryAgreementCertificate(prepared, n.context, 'confirmed')).toThrow();
  const confirm = n.frames('confirm', 1, n.a, prepared);
  const final = n.certificate(confirm.slice(0, 4).map((f, i) => n.roles[i].exchange(f)), 'confirmed');
  expect(final.votes.map(v => v.request.proposalId)).toEqual(Array(4).fill(historySuccessorProposalId(n.a)));
  const saved = n.stores[0].agreementState(); n.reopen(0);
  expect(n.stores[0].agreementState()).toEqual(saved);
  expect(parseHistoryAgreementState(saved, n.context, n.context.members[0])).toEqual(saved);
  expect(n.stores[4].agreementState()).toBeNull(); // no fifth participant needed
  expect(readFileSync(join(n.directory, 'r0', HISTORY_MANIFEST_FILENAME), 'utf8')).not.toContain(n.a.rootId);
  expect(() => n.roles[0].exchange(n.frames('prepare', 1, n.b, view)[0])).toThrow('Another proposal');
  expect(() => n.stores[0].seal(n.a)).toThrow('disabled');
  expect(() => n.stores[0].repair(n.root, n.a)).toThrow('disabled');
  expect(() => n.stores[0].freeze(createHistoryFreeze(n.context, 0, 2, randomBytes(32).toString('base64url'), n.owner))).toThrow('cannot be replaced');
  expect(() => n.stores[0].append(n.delta)).toThrow('frozen');
});

it('resolves a split tentative round in a later view with four honest volunteers and a silent equivocator', () => {
  const n = fixture(), view = n.promise(1), pa = n.frames('prepare', 1, n.a, view), pb = n.frames('prepare', 1, n.b, view);
  const aVotes = [n.roles[0].exchange(pa[0]), n.roles[1].exchange(pa[1]), createHistoryAgreementVote(pa[4].request, n.context, n.memberKeys[4])];
  const bVotes = [n.roles[2].exchange(pb[2]), n.roles[3].exchange(pb[3]), createHistoryAgreementVote(pb[4].request, n.context, n.memberKeys[4])];
  expect(() => n.certificate(aVotes)).toThrow('Four'); expect(() => n.certificate(bVotes)).toThrow('Four');
  n.reopen(0); expect(() => n.roles[0].exchange(pb[0])).toThrow('Another proposal');
  const v2 = n.promise(2); expect(v2.reports.every(r => r.prepared === null)).toBe(true);
  expect(() => n.roles[0].exchange(pa[0])).toThrow('current view');
  const p2 = n.frames('prepare', 2, n.b, v2), qc = n.certificate(p2.slice(0, 4).map((f, i) => n.roles[i].exchange(f)));
  const c2 = n.frames('confirm', 2, n.b, qc);
  expect(n.certificate(c2.slice(0, 4).map((f, i) => n.roles[i].exchange(f)), 'confirmed').votes).toHaveLength(4);
});

it('carries a hidden decision through view changes even when the deciding replies were lost', () => {
  const n = fixture(), view = n.promise(1), pa = n.frames('prepare', 1, n.a, view);
  const prepared = n.certificate([0, 1, 2].map(i => n.roles[i].exchange(pa[i])).concat(createHistoryAgreementVote(pa[4].request, n.context, n.memberKeys[4])));
  const ca = n.frames('confirm', 1, n.a, prepared);
  const hidden = n.certificate([0, 1, 2].map(i => n.roles[i].exchange(ca[i])).concat(createHistoryAgreementVote(ca[4].request, n.context, n.memberKeys[4])), 'confirmed');
  n.reopen(0);
  const v2 = n.promise(2);
  expect(v2.reports.filter(r => r.prepared !== null)).toHaveLength(3);
  expect(() => n.roles[0].exchange(n.frames('prepare', 2, n.b, v2)[0])).toThrow('highest prepared');
  expect(() => n.roles[0].exchange(ca[0])).toThrow('current view');
  const p2 = n.frames('prepare', 2, n.a, v2), qc2 = n.certificate(p2.slice(0, 4).map((f, i) => n.roles[i].exchange(f)));
  const c2 = n.frames('confirm', 2, n.a, qc2); c2.slice(0, 4).forEach((f, i) => n.roles[i].exchange(f));
  // Same-view retries keep the entry snapshot (view 1), even after confirming in view 2.
  const retry = n.promise(2); expect(retry.reports[0].prepared!.certificate.votes[0].request.view).toBe(1);
  const v3 = n.promise(3); expect(v3.reports.every(r => r.prepared?.certificate.votes[0].request.view === 2)).toBe(true);
  expect(parseHistoryAgreementCertificate(hidden, n.context, 'confirmed')).toEqual(hidden);
  n.reopen(0); expect(n.stores[0].agreementState()!.report.request.view).toBe(3);
}, 60_000); // Multiple real-crypto views; the protocol clock remains independently controlled.

it('refuses legacy reservations and requires complete selected payloads without truncating a newer tail', () => {
  const legacy = fixture(); legacy.stores[0].seal(legacy.a);
  expect(() => legacy.roles[0].exchange(legacy.frames('promise', 1)[0])).toThrow('Legacy successor');
  expect(legacy.stores[0].reservedSuccessor()).toEqual(legacy.a); expect(legacy.stores[0].agreementState()).toBeNull();
  for (const tail of ['missing', 'newer'] as const) {
    const n = fixture(tail), view = n.promise(1), promise = n.frames('promise', 1); n.roles[4].exchange(promise[4]);
    const before = n.stores[4].read();
    expect(() => n.roles[4].exchange(n.frames('prepare', 1, n.a, view)[4])).toThrow('complete');
    expect(n.stores[4].read()).toEqual(before); expect(n.stores[4].agreementState()!.prepared).toBeNull();
  }
});

it('rejects forged, duplicate, mixed-attempt and wrong-phase evidence before changing state', () => {
  const n = fixture(), view = n.promise(1), p = n.frames('prepare', 1, n.a, view);
  const votes = p.slice(0, 4).map((f, i) => n.roles[i].exchange(f));
  const qc = n.certificate(votes), retry = n.frames('prepare', 1, n.a, view);
  for (const bad of [
    [votes[0], votes[0], votes[2], votes[3]],
    votes.map((v, i) => i ? v : { ...v, signature: randomBytes(64).toString('base64url') }),
    [n.roles[0].exchange(retry[0]), ...votes.slice(1)],
  ]) expect(() => n.certificate(bad)).toThrow();
  expect(() => n.viewCertificate([view.reports[0], view.reports[0], ...view.reports.slice(2)])).toThrow();
  const confirm = n.frames('confirm', 1, n.a, qc)[0], before = n.stores[0].agreementState();
  for (const bad of [
    { ...confirm, request: { ...confirm.request, view: 2 } },
    { ...confirm, proposal: n.b },
    { ...confirm, preparedCertificate: { ...qc, phase: 'confirmed' } },
    { ...confirm, request: { ...confirm.request, evidenceId: historyDigest('wrong') } },
    { ...confirm, excess: 'x'.repeat(256 * 1024) },
    { ...confirm, preparedCertificate: { version: 1, proposalId: historySuccessorProposalId(n.a), receipts: n.a.freezes } },
  ]) expect(() => n.roles[0].exchange(bad)).toThrow();
  expect(n.stores[0].agreementState()).toEqual(before);
  expect(() => n.roles[4].exchange(n.frames('confirm', 1, n.a, qc)[4])).toThrow('promise');
  n.roles[4].exchange(n.frames('promise', 1)[4]);
  expect(() => n.roles[4].exchange(n.frames('confirm', 1, n.a, qc)[4])).toThrow('local prepared');
  expect(() => parseHistoryAgreementRequest(confirm.request, n.context, confirm.request.expiresAt)).toThrow('expired');
  // Sorting evidence is part of parsing; equivalent wire orders bind the same proof.
  expect(historyAgreementEvidenceId(n.certificate([...votes].reverse()))).toBe(historyAgreementEvidenceId(qc));
});

it('validates slot, bounded views and highest-proof selection even with correctly signed hostile requests', () => {
  const n = fixture(), base = n.frames('promise', 1)[0].request;
  for (const view of [0, -1, 1.5, 1_000_001]) expect(() => createHistoryAgreementRequest({ ...base, view }, n.context, n.owner)).toThrow();
  for (const changes of [{ rootId: historyDigest('other') }, { nextGeneration: 2 }, { generation: 1, nextGeneration: 2 }]) {
    const request = createHistoryAgreementRequest({ ...base, ...changes }, n.context, n.owner);
    expect(() => n.roles[0].exchange({ request, proposal: null, viewCertificate: null, preparedCertificate: null })).toThrow('pins');
  }
  const v1 = n.promise(1), p1 = n.frames('prepare', 1, n.a, v1), qc1 = n.certificate(p1.slice(0, 4).map((f, i) => n.roles[i].exchange(f)));
  const c1 = n.frames('confirm', 1, n.a, qc1); c1.slice(0, 4).forEach((f, i) => n.roles[i].exchange(f));
  const v2 = n.promise(2), p2 = n.frames('prepare', 2, n.a, v2), qc2 = n.certificate(p2.slice(0, 4).map((f, i) => n.roles[i].exchange(f)));
  // A higher report must carry an older proof, never one from its own view.
  expect(() => createHistoryViewReport(n.frames('promise', 2)[0].request, { proposal: n.a, certificate: qc2 }, n.context, n.memberKeys[0])).toThrow('earlier');
  const c2 = n.frames('confirm', 2, n.a, qc2); n.roles[0].exchange(c2[0]);
  const v3 = n.promise(3); expect(v3.reports[0].prepared!.certificate.votes[0].request.view).toBe(2);
  expect(() => parseHistoryAgreementFrame(n.frames('prepare', 3, n.b, v3)[1], n.context, NOW)).toThrow('highest prepared');
  const state = n.stores[0].agreementState()!;
  expect(() => parseHistoryAgreementState({ ...state, confirmed: null }, n.context, n.context.members[0])).toThrow('lost');
}, 60_000); // Multiple real-crypto views; the protocol clock remains independently controlled.

it.each(['promise', 'prepare', 'confirm'] as const)('does not return %s after an uncertain fsync, and restores only durable state', action => {
  const n = fixture();
  let frame = n.frames('promise', 1)[0];
  if (action !== 'promise') {
    const view = n.promise(1), p = n.frames('prepare', 1, n.a, view); frame = p[0];
    if (action === 'confirm') { const qc = n.certificate(p.slice(0, 4).map((f, i) => n.roles[i].exchange(f))); frame = n.frames('confirm', 1, n.a, qc)[0]; }
  }
  const before = n.stores[0].agreementState();
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('agreement flush failure'); });
  expect(() => n.roles[0].exchange(frame)).toThrow('agreement flush failure');
  expect(() => n.stores[0].agreementState()).toThrow('write failed');
  n.reopen(0); expect(n.stores[0].agreementState()).toEqual(before);
  expect(n.roles[0].exchange(frame).request.action).toBe(action);
});

it('suppresses an expired response after persistence and detects view rollback with an independent anchor', () => {
  const n = fixture(), frame = n.frames('promise', 2)[0], before = readFileSync(join(n.directory, 'r0', HISTORY_MANIFEST_FILENAME));
  const clock = vi.fn().mockReturnValueOnce(NOW).mockReturnValue(frame.request.expiresAt);
  expect(() => n.stores[0].exchangeAgreement(frame, n.memberKeys[0], clock)).toThrow('expired');
  n.reopen(0); expect(n.stores[0].agreementState()!.report.request.view).toBe(2);
  expect(() => n.roles[0].exchange(n.frames('promise', 1)[0])).toThrow('Stale');
  n.roles[0].close(); n.stores[0].close(); writeFileSync(join(n.directory, 'r0', HISTORY_MANIFEST_FILENAME), before);
  expect(() => openHistoryCheckpointStore({ ...n.options, directory: join(n.directory, 'r0'),
    minimum: { sequence: 0, id: n.options.rootId, generationBarrier: 1, agreementView: 2 } })).toThrow('anchor');
});
});
