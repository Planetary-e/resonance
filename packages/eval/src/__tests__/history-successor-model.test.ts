import { describe, expect, it } from 'vitest';
import { exploreSuccessorAgreement, finishWithHonestQuorum, initialSuccessorModel,
  oneShotSuccessorCounterexamples, permittedSuccessorValues, possibleSuccessorProofs, stepSuccessorModel,
  type SuccessorModelState, type SuccessorValue } from '../history-successor-model.js';

function promiseAll(input: SuccessorModelState, view: number) {
  let state = input;
  for (let n = 0; n < 4; n++) state = stepSuccessorModel(state, {
    kind: 'promise', member: state.findIndex(r => r.view < view), view,
  })!;
  return state;
}
function vote(input: SuccessorModelState, kind: 'prepare' | 'confirm', view: number, value: SuccessorValue, count: number) {
  let state = input;
  for (let n = 0; n < count; n++) {
    const member = state.findIndex(r => !r[kind][view - 1] && (kind === 'prepare' || r.prepare[view - 1] === value));
    const next = stepSuccessorModel(state, { kind, view, member, value });
    if (!next) throw new Error('Invalid test schedule');
    state = next;
  }
  return state;
}

describe('bounded successor view-change evaluation', () => {
  it('exhausts two views without conflicting certificates, and completes an honest continuation from every reachable state', () => {
    const r = exploreSuccessorAgreement({ checkStableContinuation: true });
    expect(r).toMatchObject({ views: 2, exhaustive: true, limitReached: false, conflictingDecisions: 0, counterexample: null });
    expect(r.exploredStates).toBeGreaterThan(7000);
    expect(r.discoveredStates).toBe(r.exploredStates);
    expect(r.decidedStates).toBeGreaterThan(1000);
    expect(r.carriedProofStates).toBeGreaterThan(2000);
    expect(r.stableContinuation).toEqual({ cases: 2 * r.exploredStates, completed: 2 * r.exploredStates, blocked: 0, conflicting: 0 });
  }, 15000);

  it.each([{ retainPreparedProof: false }, { fenceLateConfirmations: false }])('finds and replays a safety violation when a required rule is removed: %j', rules => {
    const r = exploreSuccessorAgreement(rules);
    expect(r.conflictingDecisions).toBe(1); expect(r.limitReached).toBe(false);
    let state = initialSuccessorModel();
    for (const step of r.counterexample!) {
      const next = stepSuccessorModel(state, step.action, rules);
      expect(next).toEqual(step.state); state = next!;
    }
    const values = new Set(possibleSuccessorProofs(state, 'confirm').map(id => id % 2 ? 1 : 2));
    expect(values.size).toBe(2);
  });

  it('unblocks a split of tentative votes with four honest volunteers and a silent fifth', () => {
    let state = promiseAll(initialSuccessorModel(), 1);
    state = vote(state, 'prepare', 1, 1, 2); state = vote(state, 'prepare', 1, 2, 2);
    expect(possibleSuccessorProofs(state, 'prepare')).toEqual([]);
    expect(possibleSuccessorProofs(state, 'confirm')).toEqual([]);
    const resumed = finishWithHonestQuorum(state);
    expect(resumed).toMatchObject({ view: 2, value: 2, honestConfirmations: 4 });
    // Old tentative votes are retained, not erased or mistaken for a decision.
    expect(resumed.state.map(r => r.prepare[0]).sort()).toEqual([1, 1, 2, 2]);
  });

  it('carries an unobserved confirmation certificate through two further views', () => {
    let state = promiseAll(initialSuccessorModel(3), 1);
    state = vote(state, 'prepare', 1, 1, 3); state = vote(state, 'confirm', 1, 1, 3);
    // No coordinator-observation flag exists: the delayed signatures suffice.
    expect(possibleSuccessorProofs(state, 'confirm')).toEqual([1]);
    const second = finishWithHonestQuorum(state, 2), third = finishWithHonestQuorum(second.state, 2);
    expect(second).toMatchObject({ view: 2, value: 1, honestConfirmations: 4 });
    expect(third).toMatchObject({ view: 3, value: 1, honestConfirmations: 4 });
  });

  it('requires a genuine preparation certificate, fences late confirmations and preserves state through restart', () => {
    let state = promiseAll(initialSuccessorModel(), 1);
    state = vote(state, 'prepare', 1, 1, 2);
    let member = state.findIndex(r => r.prepare[0] === 1);
    expect(stepSuccessorModel(state, { kind: 'confirm', member, view: 1, value: 1 })).toBeNull();
    state = vote(state, 'prepare', 1, 1, 1);
    member = state.findIndex(r => r.prepare[0] === 1);
    state = stepSuccessorModel(state, { kind: 'promise', member, view: 2 })!;
    member = state.findIndex(r => r.view === 2);
    const restart = JSON.parse(JSON.stringify(state));
    expect(stepSuccessorModel(restart, { kind: 'confirm', member, view: 1, value: 1 })).toBeNull();
    expect(restart).toEqual(state);
  });

  it('requires four distinct current-view reports and disallows an invented high prepared proof', () => {
    let state = initialSuccessorModel();
    for (let n = 0; n < 2; n++) state = stepSuccessorModel(state, {
      kind: 'promise', member: state.findIndex(r => r.view === 0), view: 1,
    })!;
    expect(permittedSuccessorValues(state, 1)).toEqual([]); // two honest + the Byzantine is insufficient
    state = promiseAll(state, 2);
    state.forEach(r => { r.reports[1] = 2; }); // a claimed view-1 B QC without any real votes
    expect(permittedSuccessorValues(state, 2)).toEqual([]);
    expect(() => permittedSuccessorValues(state, 0)).toThrow('view');
  });

  it('retains indistinguishable legacy worlds and never treats a timeout as proof that a certificate does not exist', () => {
    const { split, reset, indistinguishableReports: worlds } = oneShotSuccessorCounterexamples();
    expect(split.receiptsA).toBeLessThan(4); expect(split.receiptsB).toBeLessThan(4);
    expect(reset.conflictingCertificates).toEqual(['A', 'B']);
    for (const [world, value] of [[worlds.worldA, 'A'], [worlds.worldB, 'B']] as const) {
      expect(new Set(world.possibleCertificate).size).toBe(4);
      for (const member of world.possibleCertificate) if (member !== world.byzantine) {
        expect((world.honestVotes as Record<number, string>)[member]).toBe(value);
      }
      for (const observed of worlds.observed) {
        const [label, vote] = observed.split(':'), member = Number(label.slice(7));
        if (member !== world.byzantine) expect((world.honestVotes as Record<number, string>)[member]).toBe(vote);
      }
    }
  });

  it('reports truncated searches explicitly instead of claiming exhaustive safety', () => {
    const r = exploreSuccessorAgreement({ maxStates: 10 });
    expect(r).toMatchObject({ exhaustive: false, limitReached: true, discoveredStates: 10, conflictingDecisions: 0 });
    for (const views of [0, 4, 1.5]) expect(() => initialSuccessorModel(views)).toThrow();
    expect(() => exploreSuccessorAgreement({ maxStates: 0 })).toThrow();
    expect(stepSuccessorModel(initialSuccessorModel(), { kind: 'promise', member: 4, view: 1 })).toBeNull();
  });
});
