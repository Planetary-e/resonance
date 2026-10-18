import { describe, expect, it } from 'vitest';
import { evaluatePrivateSchedule, type PrivateScheduleInput } from '../private-schedule-feasibility.js';
function fixture(submissions: PrivateScheduleInput['submissions'] = []): PrivateScheduleInput {
  return { durationMs: 10000, clients: [{ id: 'a', enrollment: [{ startMs: 0, endMs: 10000 }] }], submissions };
}
const small = { id: 'x', clientId: 'a', atMs: 0, requestBytes: 1, replyBytes: 1, processingMs: 0 };
describe('offline fixed-cell capacity model', () => {
  it('bills identical whole enrollment for idle and real traffic, including all other-edge reserves', () => {
    const empty = evaluatePrivateSchedule(fixture()), active = evaluatePrivateSchedule(fixture([small]));
    expect(active.totals).toEqual(empty.totals);
    expect(active.totals).toEqual({ accessBytes: 163840, transportBytes: 327680, reservedBytes: 327680, allBytes: 655360 });
    expect(empty.bytesPerCompletion).toEqual({ value: null, reason: 'infinite-zero-completions' });
    expect(JSON.parse(JSON.stringify(empty))).toEqual(empty);
  });
  it('requires two edges in both directions and never advances a cell twice in a tick', () => {
    const result = evaluatePrivateSchedule(fixture([small]));
    expect(result.operations[0]).toMatchObject({ status: 'completed', completedAtMs: 2000 });
    expect(result.costs[0]).toMatchObject({ fixedWireCells: 80, realCells: 4, dummyCells: 76, deliveredPayloadBytes: 4 });
    const fragmented = evaluatePrivateSchedule(fixture([{ ...small, requestBytes: 3073, replyBytes: 3073 }]));
    expect(fragmented.operations[0].completedAtMs).toBe(3000);
    expect(fragmented.costs[0].realCells).toBe(8);
    const processing = evaluatePrivateSchedule(fixture([{ ...small, processingMs: 501 }]));
    expect(processing.operations[0].completedAtMs).toBe(3000);
  });
  it('keeps overflow, original deadlines, sleeping clients and unfinished operations in denominator', () => {
    const overflow = evaluatePrivateSchedule({ ...fixture([small, { ...small, id: 'y' }]), maxPendingPerClient: 1 });
    expect(overflow).toMatchObject({ submitted: 2, completed: 1, rejected: 1 });
    expect(overflow.latencyMs.p95).toEqual({ value: null, reason: 'infinite-failed-or-rejected' });
    expect(evaluatePrivateSchedule({ ...fixture([small]), deadlineMs: 1999 }).operations[0]).toMatchObject({ status: 'failed', reason: 'deadline' });
    const sleeping = fixture([small, { ...small, id: 'y', atMs: 1500 }]);
    sleeping.clients[0].enrollment = [{ startMs: 0, endMs: 1000 }, { startMs: 3000, endMs: 10000 }];
    expect(evaluatePrivateSchedule(sleeping)).toMatchObject({ submitted: 2, completed: 0, rejected: 1, failed: 1 });
    const betweenSlots = fixture([{ ...small, atMs: 750 }]);
    betweenSlots.clients[0].enrollment = [{ startMs: 0, endMs: 1000 }, { startMs: 1500, endMs: 10000 }];
    expect(evaluatePrivateSchedule(betweenSlots).operations[0]).toMatchObject({ status: 'failed', reason: 'enrollment-ended', completedAtMs: null });
    const expired = evaluatePrivateSchedule({ ...fixture([{ ...small, atMs: 1 }]), deadlineMs: 1 });
    expect(expired.operations[0]).toMatchObject({ status: 'failed', reason: 'deadline' });
    const end = evaluatePrivateSchedule(fixture([{ ...small, atMs: 9501 }, { ...small, id: 'y', atMs: 10000 }]));
    expect(end).toMatchObject({ submitted: 2, completed: 0, failed: 2 });
    expect(end.operations.every(op => op.infiniteLatency)).toBe(true);
  });
  it('retries synthetic loss only in later fixed slots with unchanged charged bytes', () => {
    const input = { ...fixture([small]), droppedCells: [{ clientId: 'a', tick: 0, lane: 0 as const }] };
    const result = evaluatePrivateSchedule(input);
    expect(result.operations[0].completedAtMs).toBe(2500);
    expect(result.costs[0]).toMatchObject({ lostRealCells: 1, realCells: 5 });
    expect(result.totals).toEqual(evaluatePrivateSchedule(fixture([small])).totals);
    expect(result).toEqual(evaluatePrivateSchedule(input));
    const loss = evaluatePrivateSchedule({ ...fixture([small]), droppedCells: Array.from({ length: 20 }, (_, tick) => ({ clientId: 'a', tick, lane: 0 as const })) });
    expect(loss).toMatchObject({ completed: 0, failed: 1 });
  });
  it('supports only fixed-rate predeclared geometry sensitivities and charges startup', () => {
    const base = evaluatePrivateSchedule(fixture([small]));
    const fine = evaluatePrivateSchedule({ ...fixture([small]), profile: { slotMs: 125, wireBytes: 1024, usefulBytes: 768 } });
    expect(fine.totals).toEqual(base.totals); expect(fine.operations[0].completedAtMs).toBe(500);
    const startup = fixture(); startup.clients[0].startupAccessBytes = 64 * 1024 ** 2; startup.clients[0].startupAllBytes = 256 * 1024 ** 2;
    expect(evaluatePrivateSchedule(startup).horizonCaps).toMatchObject({ withinAccess: false, withinAll: false });
  });
  it('rejects malformed and unbounded simulations', () => {
    for (const bad of [{ ...fixture(), durationMs: 3600500 }, { ...fixture(), maxPendingPerClient: 129 },
      { ...fixture(), deadlineMs: 10001 }, fixture([{ ...small, requestBytes: -1 }]), fixture([{ ...small, clientId: 'missing' }]),
      fixture([small, small]), { ...fixture(), profile: { slotMs: 1, wireBytes: 1, usefulBytes: 1 } }]) expect(() => evaluatePrivateSchedule(bad)).toThrow();
    const invalid = fixture(); invalid.clients[0].enrollment = [{ startMs: 1, endMs: 500 }]; expect(() => evaluatePrivateSchedule(invalid)).toThrow();
  });
});
