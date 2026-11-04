import { describe, expect, it } from 'vitest';
import { RECOVERY_BOUNDS, RECOVERY_COHORTS, exploreCertifiedRecovery, fairRecoveryContinuation,
  initialRecoveryState, cohortAuthorizationAdmissible, freshGenesisRecoveryAllowed, recoveredBindingOutcome, recoveryViolation, retiredKeyBoundary, stepRecoveryModel,
  type RecoveryAction, type RecoveryRules, type RecoveryState } from '../certified-recovery-model.js';

function replay(actions: RecoveryAction[], rules: RecoveryRules = {}, initial = initialRecoveryState()) {
  let state = initial;
  for (const action of actions) {
    const next = stepRecoveryModel(state, action, rules);
    if (!next) throw new Error(`Replay refused ${action}`);
    state = next;
  }
  return state;
}
const protectedPair: RecoveryAction[] = ['stage', 'protect', 'stage', 'protect'];

describe('certified semantic recovery decision (eval only)', () => {
  it('exhausts the declared finite event space with productive witnesses and no violation', () => {
    const result = exploreCertifiedRecovery();
    expect(result).toMatchObject({ exhaustive: true, limitReached: false, violation: null, counterexample: null });
    expect(result.exploredStates).toBeGreaterThan(1000);
    expect(result.discoveredStates).toBe(result.exploredStates);
    expect(result.recoveredStates).toBeGreaterThan(0);
    expect(result.secondTransfers).toBeGreaterThan(0);
    expect(result.exactRetries).toBeGreaterThan(0);
    expect(result.serviceStates).toBeGreaterThan(0);
    for (const action of ['cut', 'crash', 'restart', 'expose', 'activate', 'retry', 'serve',
      'missing-suffix', 'stale-cut', 'omit-payload', 'conflicting-successor'] as const) expect(result.coverage).toContain(action);
  }, 15000);

  it('continues through two disjoint transfers and returns the original exact retry', () => {
    const { state, trace } = fairRecoveryContinuation();
    expect(state).toMatchObject({ generation: 2, transfers: 2, chain: [0, 1, 2], retries: 1,
      served: 1, lastRetry: 'accepted:hidden-original-c0-U', preCutBusinessVisits: 0 });
    expect(recoveryViolation(state)).toBeNull();
    expect(new Set(RECOVERY_COHORTS.flat()).size).toBe(15);
    expect(RECOVERY_BOUNDS).toMatchObject({ members: 5, confirmations: 4, byzantine: 1, suffixCap: 2 });
    const evidence = state.cut.semantic.evidence;
    expect(evidence.find(e => e.binding === 'partial-P')).toMatchObject({ context: 'c0/policy0',
      status: 'partial', charged: 1, proposals: ['P', 'Q'], votes: ['c0/m0:P', 'c0/m1:Q'] });
    expect(evidence.find(e => e.binding === 'uncertain-U')).toMatchObject({ context: 'c0/policy0',
      status: 'accepted', charged: 1, certificate: 'hidden-original-c0-U',
      retry: { request: 'request-U', origin: 'c0/policy0', result: 'accepted:hidden-original-c0-U' } });
    expect(state.oracle.evidence.find(e => e.binding === 'new-current')).toMatchObject({
      context: 'c2/policy1', status: 'accepted', charged: 1, certificate: 'original-c2-current' });
    expect(stepRecoveryModel(state, 'old-policy-serve')).toBeNull();
    expect(recoveredBindingOutcome(state.cut.semantic, 'new-current', 'request-current', 1)).toMatchObject({
      outcome: 'authorize-current-policy' });
    expect(evidence[0].retry).toEqual(initialRecoveryState().oracle.evidence[0].retry);
    expect(state.cut.semantic).toMatchObject({ denials: ['permanent-D', 'withdrawn-W'],
      rights: [{ id: 'right-L', expires: 10 }], reservations: [{ id: 'reserved-R', units: 2, expires: 10 }],
      policy: 1, fence: 1, withdrawn: true });
    expect(trace.filter(s => s.action === 'activate')).toHaveLength(2);
    const currentSigners = RECOVERY_COHORTS[2].slice(0, 4);
    expect(freshGenesisRecoveryAllowed(state, [0, 1, 2], currentSigners, true)).toBe(true);
    expect(freshGenesisRecoveryAllowed(state, [0, 2], currentSigners, true)).toBe(false);
    expect(freshGenesisRecoveryAllowed(state, [0, 1, 2], currentSigners, false)).toBe(false);
    expect(freshGenesisRecoveryAllowed(state, [0, 1, 2], currentSigners.slice(0, 3), true)).toBe(false);
    expect(freshGenesisRecoveryAllowed(state, [0, 1, 2], Array(4).fill(currentSigners[0]), true)).toBe(false);
    expect(freshGenesisRecoveryAllowed(state, [0, 1, 2], RECOVERY_COHORTS[0].slice(0, 4), true)).toBe(false);
    expect(recoveredBindingOutcome(state.cut.semantic, 'partial-P', 'P')).toMatchObject({
      outcome: 'refuse', reason: 'partial', charged: 1 });
    expect(recoveredBindingOutcome(state.cut.semantic, 'permanent-D', 'anything')).toMatchObject({
      outcome: 'refuse', reason: 'permanent-denial' });
    expect(recoveredBindingOutcome(state.cut.semantic, 'new-business', 'anything')).toMatchObject({
      outcome: 'refuse', reason: 'fenced-policy' });
    expect(recoveredBindingOutcome(state.cut.semantic, 'uncertain-U', 'request-U')).toEqual({
      outcome: 'exact-retry', result: 'accepted:hidden-original-c0-U', origin: 'c0/policy0' });
  });

  it.each<[string, RecoveryRules, string]>([
    ['dropped uncertain protection', { carryUncertain: false }, 'lost-original-context-obligation'],
    ['uncertified incomplete cut', { validateCut: false }, 'uncertified-cut'],
    ['old barrier/drain bypass', { barrierAndDrain: false }, 'overlapping-old-authority'],
    ['missing/stale suffix', { contiguousSuffix: false }, 'lost-original-context-obligation'],
  ])('finds a shortest BFS violation for %s and replays every retained state', (_label, rules, violation) => {
    const result = exploreCertifiedRecovery(rules);
    expect(result).toMatchObject({ limitReached: false, violation });
    expect(result.counterexample!.length).toBeGreaterThan(0);
    let state = initialRecoveryState();
    for (const step of result.counterexample!) {
      expect(recoveryViolation(state)).toBeNull();
      state = stepRecoveryModel(state, step.action, rules)!;
      expect(state).toEqual(step.state);
    }
    expect(recoveryViolation(state)).toBe(violation);
    if (rules.barrierAndDrain === false) {
      expect(state).toMatchObject({ generation: 1, transfers: 1, chain: [0, 1] });
      expect(cohortAuthorizationAdmissible(state, 0, 'new')).toBe(true);
      expect(cohortAuthorizationAdmissible(state, 0, 'existing')).toBe(true);
      expect(cohortAuthorizationAdmissible(state, 1, 'new')).toBe(true);
      // Repair each actual old-authority fact, independently of the unsafe rule.
      const repaired = structuredClone(state);
      repaired.authorities[0] = { configuration: 0, terminalSequence: 2, observerSealed: true, leaseRemaining: 0 };
      expect(recoveryViolation(repaired)).toBeNull();
      const liveLease = structuredClone(repaired); liveLease.authorities[0].leaseRemaining = 1;
      expect(recoveryViolation(liveLease)).toBe('overlapping-old-authority');
    }
  }, 15000);

  it('requires protection before exposure and retains lost-reply charge across crash and cut', () => {
    expect(stepRecoveryModel(initialRecoveryState(), 'expose')).toBeNull();
    const staged = replay(['stage', 'crash', 'restart']);
    expect(staged.sequence).toBe(0); expect(staged.staged).toBe(false);
    const state = replay([...protectedPair, 'crash', 'restart', 'cut', 'recover']);
    expect(state.exposed).toEqual([]);
    expect(state.recovered!.evidence.find(e => e.binding === 'uncertain-U')).toMatchObject({
      status: 'uncertain', charged: 1, certificate: 'hidden-original-c0-U' });
    expect(state.floor).toBe(2);
    expect(recoveryViolation(state)).toBeNull();
    expect(fairRecoveryContinuation(state).state.lastRetry).toBe('accepted:hidden-original-c0-U');
  });

  it('enforces cap, old authorization barrier, observer seal, full restart drain and readiness', () => {
    let s = replay(protectedPair);
    expect(stepRecoveryModel(s, 'stage')).toBeNull();
    expect(stepRecoveryModel(s, 'bad-cut')).toBeNull();
    s = replay(['conflicting-successor'], {}, s);
    expect(s.rivalProposed).toBe(true);
    expect(stepRecoveryModel(s, 'activate')).toBeNull();
    s = replay(['barrier', 'seal', 'tick', 'tick', 'confirm', 'confirm', 'confirm', 'confirm',
      'recover', 'install', 'install', 'install', 'install', 'crash', 'restart', 'recover'], {}, s);
    expect(s.installations).toBe(4); expect(s.drain).toBe(0);
    expect(stepRecoveryModel(s, 'conflicting-successor')).toBeNull();
    expect(stepRecoveryModel(s, 'late-old-write')).toBeNull();
    expect(stepRecoveryModel(s, 'activate')).toBeNull();
    s = replay(['tick', 'tick'], {}, s);
    expect(stepRecoveryModel(s, 'activate')).toBeNull();
    const successor = replay(['tick', 'activate'], {}, s);
    expect(successor.generation).toBe(1);
    expect(cohortAuthorizationAdmissible(successor, 0, 'new')).toBe(false);
    expect(cohortAuthorizationAdmissible(successor, 0, 'existing')).toBe(false);
    expect(cohortAuthorizationAdmissible(successor, 1, 'new')).toBe(true);
    const unsafeDrain = replay(['activate'], { barrierAndDrain: false }, s);
    expect(unsafeDrain.generation).toBe(1);
    expect(cohortAuthorizationAdmissible(unsafeDrain, 0, 'new')).toBe(false);
    expect(cohortAuthorizationAdmissible(unsafeDrain, 0, 'existing')).toBe(true);
    expect(cohortAuthorizationAdmissible(unsafeDrain, 1, 'new')).toBe(true);
    expect(recoveryViolation(unsafeDrain)).toBe('overlapping-old-authority');
  });

  it('refuses missing bytes, missing suffix, stale cut, configuration and policy mismatch', () => {
    for (const action of ['omit-payload', 'missing-suffix'] as const) {
      const state = replay([...protectedPair, action]);
      expect(stepRecoveryModel(state, 'recover')).toBeNull();
    }
    const cut = replay([...protectedPair, 'cut']);
    expect(stepRecoveryModel(replay(['stale-cut'], {}, cut), 'recover')).toBeNull();
    for (const mutate of [(s: RecoveryState) => { s.cut.configuration = 1; },
      (s: RecoveryState) => { s.cut.policyCutoff = 9; },
      (s: RecoveryState) => { s.floor = s.sequence + 1; }]) {
      const state = structuredClone(cut); mutate(state);
      expect(stepRecoveryModel(state, 'recover')).toBeNull();
    }
  });

  it('marks a truncated search inconclusive and preserves the excluded mobile-key example', () => {
    expect(exploreCertifiedRecovery({ maxStates: 10 })).toMatchObject({
      exhaustive: false, limitReached: true, discoveredStates: 10, violation: null });
    expect(() => exploreCertifiedRecovery({ maxStates: 0 })).toThrow();
    expect(retiredKeyBoundary()).toMatchObject({ inScope: false,
      genesisOnlyClientCanDistinguish: false, requiresNewTrustDecision: true });
    expect(retiredKeyBoundary().compromisedRetiredKeys).toHaveLength(4);
  });
});
