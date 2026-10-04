import { describe, expect, it } from 'vitest';
import {
  freshnessIntersections, generationFreezeReport, memberSets, readRepairReport,
  recoveryCounterexamples, selectModelCheckpoint, snapshotPayloadBudget, type ModelReply,
} from '../history-checkpoint-model.js';

const response = (member: number, revision = 1): ModelReply => ({
  member, revision, challenge: 'fresh', history: 'pinned-history', authenticated: true,
  ownerAuthenticated: true, completePayload: true,
});

describe('finite checkpoint recovery model', () => {
  it('enumerates all quorums and exposes why three writes plus three reads can lose an accepted spend', () => {
    expect(memberSets(4)).toHaveLength(5);
    expect(memberSets(3)).toHaveLength(10);
    const weak = freshnessIntersections(3, 3);
    expect(weak.cases).toBe(600);
    expect(weak.minimumHonestIntersection).toBe(0);
    expect(weak.lostCompletedWrites).toBeGreaterThan(0);
    const example = weak.counterexample!;
    expect(example.stored.filter(member => example.readers.includes(member))).toEqual([example.byzantine]);
    // Four/four is the conservative uniform candidate, not a mathematical minimum for signed values.
    expect(freshnessIntersections(4, 3)).toMatchObject({ minimumHonestIntersection: 1, lostCompletedWrites: 0 });
    expect(freshnessIntersections(4, 4)).toMatchObject({ cases: 150, minimumHonestIntersection: 2, lostCompletedWrites: 0 });
  });

  it('preserves all completed writes and every returned recovery value after four-member write-back', () => {
    const report = readRepairReport();
    expect(report.selections).toBe(14400);
    expect(report.comparisons).toBe(1080000);
    expect(report.lostCompletedWrites).toBe(0);
    expect(report.regressionsWithRepair).toBe(0);
    expect(report.regressionsWithoutRepair).toBeGreaterThan(0);
    expect(report.counterexample!.first).toBeGreaterThan(report.counterexample!.second);
  });

  it('preserves every certified old write across all modeled write/freeze orderings', () => {
    const report = generationFreezeReport();
    expect(report.cases).toBe(1440);
    expect(report.completedOldWrites).toBeGreaterThan(0);
    expect(report.preservedCompletedWrites).toBe(report.completedOldWrites);
    expect(report.blockedOldWrites).toBeGreaterThan(0);
    expect(report.completedOldWrites + report.blockedOldWrites).toBe(report.cases);
    expect(report.maximumLateOldAcknowledgements).toBe(2);
  });

  it('does not count replayed, unauthenticated, foreign, missing-payload or invented-version evidence', () => {
    const replies = [0, 1, 2, 3].map(member => response(member));
    expect(selectModelCheckpoint(replies, 'fresh')).toBe(1);
    const invalid: Partial<ModelReply>[] = [
      { challenge: 'old' }, { history: 'other-history' }, { member: 5 }, { member: -1 },
      { authenticated: false }, { ownerAuthenticated: false }, { completePayload: false },
      { revision: 99 }, { revision: -1 }, { revision: 1.5 },
    ];
    for (const change of invalid) {
      expect(selectModelCheckpoint([{ ...replies[0], ...change }, ...replies.slice(1)], 'fresh')).toBeNull();
      expect(selectModelCheckpoint([{ ...replies[0], ...change }, ...replies.slice(1), response(4)], 'fresh')).toBe(1);
    }
    expect(selectModelCheckpoint(replies, '')).toBeNull();
    expect(recoveryCounterexamples().replayedResponses).toEqual({ withoutNonceCheck: 0, withNonceCheck: null, latestRevision: 1 });
  });

  it('counts a replica once and excludes contradictory replies without giving one replica a veto', () => {
    expect(selectModelCheckpoint([response(0), response(0), response(1), response(2)], 'fresh')).toBeNull();
    const conflicting = [response(0, 2), response(0, 0), response(0, 2)];
    expect(selectModelCheckpoint([...conflicting, response(1), response(2), response(3)], 'fresh')).toBeNull();
    expect(selectModelCheckpoint([...conflicting, response(1), response(2), response(3), response(4)], 'fresh')).toBe(1);
  });

  it('retains observed authentic partial tails instead of trusting only a local completion certificate', () => {
    // The original owner's reply/certificate may have been lost, while a full
    // signed later snapshot survives. Returning it is conservative in this model.
    expect(selectModelCheckpoint([response(0, 2), response(1), response(2), response(3)], 'fresh')).toBe(2);
    expect(selectModelCheckpoint([response(0, 2), response(1), response(2)], 'fresh')).toBeNull();
  });

  it('reports payload-only costs without confusing replication with free capacity', () => {
    expect(snapshotPayloadBudget(8 * 1024 * 1024)).toMatchObject({
      minimumWriteUpload: 32 * 1024 * 1024, fiveReplicaWriteUpload: 40 * 1024 * 1024,
      minimumRecoveryTransfer: 64 * 1024 * 1024, fiveReplicaStoredPayload: 40 * 1024 * 1024,
    });
    for (const bytes of [0, -1, 1.5, 8 * 1024 * 1024 + 1]) expect(() => snapshotPayloadBudget(bytes)).toThrow();
    for (const size of [0, 6, 1.5]) expect(() => memberSets(size)).toThrow();
  });
});
