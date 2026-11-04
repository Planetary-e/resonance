/** Bounded single-slot agreement model, not a wire protocol or restore API.
 * Four honest replicas and one Byzantine replica; fixed membership. The faulty
 * replica can sign both values and hide/replay any existing prepare certificate.
 * Signatures, valid complete payloads and atomic durable transitions are assumed.
 * Honest identities are symmetric; sorting permutes their entire event history.
 */
import { memberSets } from './history-checkpoint-model.js';

export type SuccessorValue = 1 | 2;
export interface SuccessorModelReplica {
  view: number;
  prepare: number[];
  confirm: number[];
  /** -1: no report; 0: no prepared proof; otherwise encoded (view, value). */
  reports: number[];
}
export type SuccessorModelState = SuccessorModelReplica[];
export interface SuccessorModelRules {
  /** Negative controls only: either omission must expose a conflicting decision. */
  retainPreparedProof?: boolean;
  fenceLateConfirmations?: boolean;
}
const QUORUM = 4, BYZANTINE = 4;
const VALUES: SuccessorValue[] = [1, 2];
const quorums = memberSets(QUORUM);
const proof = (view: number, value: number) => (view - 1) * 2 + value;
const proofView = (id: number) => Math.ceil(id / 2);
const proofValue = (id: number): SuccessorValue => id % 2 ? 1 : 2;
const clone = (state: SuccessorModelState) => state.map(r => ({ view: r.view,
  prepare: [...r.prepare], confirm: [...r.confirm], reports: [...r.reports] }));
const rowKey = (r: SuccessorModelReplica) => `${r.view}/${r.prepare.join('')}/${r.confirm.join('')}/${r.reports.join(',')}`;
function normalize(state: SuccessorModelState) {
  state.sort((a, b) => rowKey(a).localeCompare(rowKey(b), 'en'));
  return state;
}
const stateKey = (state: SuccessorModelState) => state.map(rowKey).join('|');

export function initialSuccessorModel(views = 2): SuccessorModelState {
  if (!Number.isInteger(views) || views < 1 || views > 3) throw new Error('Model supports one to three views');
  return Array.from({ length: 4 }, () => ({ view: 0, prepare: Array(views).fill(0),
    confirm: Array(views).fill(0), reports: Array(views).fill(-1) }));
}

/** Every possible certificate, even if no coordinator has received its votes.
 * The Byzantine signature is always available to the adversary. Withholding it
 * is represented by delaying/omitting deliveries, not forgetting possible QCs.
 */
export function possibleSuccessorProofs(state: SuccessorModelState, phase: 'prepare' | 'confirm'): number[] {
  const result: number[] = [];
  for (let view = 1; view <= state[0].prepare.length; view++) for (const value of VALUES) {
    if (state.filter(r => r[phase][view - 1] === value).length + 1 >= QUORUM) result.push(proof(view, value));
  }
  return result;
}

/** Each proposal must carry four reports for THIS view. Every replica repeats
 * this selection, rather than trusting the coordinator's claimed highest QC.
 * Byzantine reports may omit proofs or attach any genuine prior prepare QC.
 */
export function permittedSuccessorValues(state: SuccessorModelState, view: number): SuccessorValue[] {
  if (!Number.isInteger(view) || view < 1 || view > state[0].prepare.length) throw new Error('Invalid model view');
  const existing = possibleSuccessorProofs(state, 'prepare');
  const byzantineChoices = [0, ...existing.filter(id => proofView(id) < view)];
  const permitted = new Set<SuccessorValue>();
  for (const quorum of quorums) {
    const honest = quorum.filter(member => member !== BYZANTINE).map(member => state[member].reports[view - 1]);
    if (honest.some(id => id === -1)) continue;
    for (const claimed of quorum.includes(BYZANTINE) ? byzantineChoices : [0]) {
      const reports = [...honest, claimed];
      if (reports.some(id => id && (!existing.includes(id) || proofView(id) >= view))) continue;
      const highestView = Math.max(...reports.map(proofView));
      const highest = new Set(reports.filter(id => id && proofView(id) === highestView).map(proofValue));
      if (highest.size > 1) continue;
      if (!highestView) VALUES.forEach(value => permitted.add(value));
      else highest.forEach(value => permitted.add(value));
    }
  }
  return [...permitted].sort();
}

export type SuccessorModelAction =
  | { kind: 'promise'; member: number; view: number }
  | { kind: 'prepare' | 'confirm'; member: number; view: number; value: SuccessorValue };

export function stepSuccessorModel(state: SuccessorModelState, action: SuccessorModelAction,
  rules: SuccessorModelRules = {}): SuccessorModelState | null {
  const { member, view } = action;
  if (!Number.isInteger(member) || member < 0 || member >= 4 || !Number.isInteger(view)
    || view < 1 || view > state[0].prepare.length) return null;
  const old = state[member], next = clone(state), replica = next[member];
  if (action.kind === 'promise') {
    if (view <= old.view) return null;
    let retained = 0;
    old.confirm.forEach((value, i) => { if (value) retained = proof(i + 1, value); });
    replica.view = view;
    // Persist barrier AND its retained-proof report before issuing the report.
    replica.reports[view - 1] = rules.retainPreparedProof === false ? 0 : retained;
  } else if (action.kind === 'prepare') {
    if (!VALUES.includes(action.value) || old.view !== view || old.prepare[view - 1]
      || !permittedSuccessorValues(state, view).includes(action.value)) return null;
    replica.prepare[view - 1] = action.value;
  } else {
    if (!VALUES.includes(action.value) || (rules.fenceLateConfirmations === false ? old.view < view : old.view !== view)
      || old.confirm[view - 1] || old.prepare[view - 1] !== action.value
      || !possibleSuccessorProofs(state, 'prepare').includes(proof(view, action.value))) return null;
    // Recording the complete prepared certificate precedes the confirmation.
    replica.confirm[view - 1] = action.value;
  }
  return normalize(next);
}

function actions(views: number): SuccessorModelAction[] {
  const result: SuccessorModelAction[] = [];
  for (let view = 1; view <= views; view++) for (let member = 0; member < 4; member++) {
    result.push({ kind: 'promise', member, view });
    for (const value of VALUES) for (const kind of ['prepare', 'confirm'] as const) result.push({ kind, member, view, value });
  }
  return result;
}

export interface SuccessorModelTraceStep { action: SuccessorModelAction; state: SuccessorModelState }
/** Breadth-first enumeration with honest-identity symmetry reduction. Reports
 * and votes remain available forever, so delayed replies and hidden certificates
 * can be assembled after later views start. A process restart is a stuttering
 * step because every emitted message is assumed durably recorded first.
 */
export function exploreSuccessorAgreement(options: SuccessorModelRules & {
  views?: number; maxStates?: number; checkStableContinuation?: boolean;
} = {}) {
  const views = options.views ?? 2, maxStates = options.maxStates ?? 250_000;
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 2_000_000) throw new Error('Invalid model state budget');
  const initial = initialSuccessorModel(views), allActions = actions(views);
  const nodes: Array<{ state: SuccessorModelState; parent: number; action?: SuccessorModelAction }> = [{ state: initial, parent: -1 }];
  const seen = new Set([stateKey(initial)]);
  let edges = 0, decidedStates = 0, carriedProofStates = 0;
  const stableContinuation = { cases: 0, completed: 0, blocked: 0, conflicting: 0 };
  function trace(index: number): SuccessorModelTraceStep[] {
    const result: SuccessorModelTraceStep[] = [];
    for (let node = nodes[index]; node.parent >= 0; node = nodes[node.parent]) result.push({ action: node.action!, state: node.state });
    return result.reverse();
  }
  for (let index = 0; index < nodes.length; index++) {
    const state = nodes[index].state;
    const decisions = new Set(possibleSuccessorProofs(state, 'confirm').map(proofValue));
    if (decisions.size > 1) return { views, exhaustive: false, exploredStates: index + 1, discoveredStates: seen.size,
      edges, decidedStates, carriedProofStates, stableContinuation, conflictingDecisions: 1, counterexample: trace(index), limitReached: false };
    if (decisions.size) decidedStates++;
    if (state.some(r => r.reports.some(id => id > 0))) carriedProofStates++;
    if (options.checkStableContinuation) for (const preferred of VALUES) {
      stableContinuation.cases++;
      try {
        const resumed = finishWithHonestQuorum(state, preferred);
        if (resumed.honestConfirmations === QUORUM) stableContinuation.completed++;
        else stableContinuation.blocked++;
        if (new Set(possibleSuccessorProofs(resumed.state, 'confirm').map(proofValue)).size > 1) stableContinuation.conflicting++;
      } catch { stableContinuation.blocked++; }
    }
    for (const action of allActions) {
      const next = stepSuccessorModel(state, action, options);
      if (!next) continue;
      edges++;
      const key = stateKey(next);
      if (seen.has(key)) continue;
      if (seen.size >= maxStates) return { views, exhaustive: false, exploredStates: index + 1, discoveredStates: seen.size,
        edges, decidedStates, carriedProofStates, stableContinuation, conflictingDecisions: 0, counterexample: null, limitReached: true };
      seen.add(key); nodes.push({ state: next, parent: index, action });
    }
  }
  return { views, exhaustive: true, exploredStates: nodes.length, discoveredStates: seen.size, edges,
    decidedStates, carriedProofStates, stableContinuation, conflictingDecisions: 0, counterexample: null, limitReached: false };
}

/** Stable-owner continuation after a finite prefix. Four honest members remain
 * online and no further competing view interrupts them. The fifth stays silent.
 * This is a conditional progress check, not a leader-election or timing model.
 */
export function finishWithHonestQuorum(input: SuccessorModelState, preferred: SuccessorValue = 2) {
  let state = clone(input);
  const view = Math.max(...state.map(r => r.view)) + 1;
  state.forEach(r => { while (r.prepare.length < view) { r.prepare.push(0); r.confirm.push(0); r.reports.push(-1); } });
  for (let n = 0; n < 4; n++) {
    const member = state.findIndex(r => r.view < view);
    state = stepSuccessorModel(state, { kind: 'promise', member, view })!;
  }
  const proofs = state.map(r => r.reports[view - 1]);
  const highest = Math.max(...proofs);
  const value = highest ? proofValue(highest) : preferred;
  for (const kind of ['prepare', 'confirm'] as const) for (let n = 0; n < 4; n++) {
    const member = state.findIndex(r => !r[kind][view - 1]);
    const next = stepSuccessorModel(state, { kind, member, view, value });
    if (!next) throw new Error('Honest continuation blocked');
    state = next;
  }
  return { view, value, state, honestConfirmations: state.filter(r => r.confirm[view - 1] === value).length };
}

/** The installed one-shot reservation is a different protocol. These traces
 * explain why its existing promises cannot silently become tentative votes.
 */
export function oneShotSuccessorCounterexamples() {
  return {
    split: { honestVotes: ['A', 'A', 'B', 'B'], byzantineVotes: ['A', 'B'], receiptsA: 3, receiptsB: 3,
      timeoutChangesDurableVotes: false },
    reset: {
      steps: ['Three honest members and the Byzantine member sign A; replies are withheld',
        'A timeout clears honest reservations', 'Three honest members and the Byzantine member sign B',
        'Delayed A replies now also form a four-member certificate'], conflictingCertificates: ['A', 'B'],
    },
    indistinguishableReports: {
      observed: ['member-0:A', 'member-1:A', 'member-2:B', 'member-3:B'], missing: 'member-4',
      worldA: { byzantine: 3, honestVotes: { 0: 'A', 1: 'A', 2: 'B', 4: 'A' }, possibleCertificate: [0, 1, 3, 4] },
      worldB: { byzantine: 0, honestVotes: { 1: 'A', 2: 'B', 3: 'B', 4: 'B' }, possibleCertificate: [0, 2, 3, 4] },
      conclusion: 'The same four reports can hide either certificate; they cannot authorize resetting the other value.',
    },
  };
}
