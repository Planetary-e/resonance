/** Eval only. PBFT-style immutable prefix agreement is ASSUMED, not implemented
 * by these semantic confirmations. Atomic durable writes, authentic signatures,
 * pinned configuration links and complete evidence availability are abstractions.
 * The finite workload and schedules below are deliberately not a production API.
 */
export const RECOVERY_BOUNDS = { members: 5, confirmations: 4, byzantine: 1,
  configurations: 3, suffixCap: 2, drainSeconds: 3 } as const;
export const RECOVERY_COHORTS = [0, 1, 2].map(g => Array.from({ length: 5 }, (_, i) => `c${g}/m${i}`));
export interface Evidence {
  context: string; binding: string; proposals: string[]; votes: string[];
  status: 'partial' | 'uncertain' | 'accepted'; charged: number;
  certificate: string | null; retry: { request: string; result: string; origin: string } | null;
}
export interface SemanticState {
  evidence: Evidence[]; denials: string[]; reservations: { id: string; units: number; expires: number }[];
  rights: { id: string; expires: number }[]; policy: number; fence: number; withdrawn: boolean;
}
export interface Command { seq: number; origin: number; kind: 'conflict' | 'uncertain' | 'accept' | 'withdraw' | 'authorize'; }
export interface Cut {
  configuration: number; seq: number; policyCutoff: number; semantic: SemanticState;
  certified: boolean; payload: boolean;
}
export interface RecoveryState {
  generation: number; next: number; staged: boolean; exposed: number[];
  oracle: SemanticState; cut: Cut; suffix: Command[]; sequence: number; floor: number;
  barrier: boolean; sealed: boolean; drain: number; oldConfirmations: number; installations: number;
  crashed: boolean; crashUsed: boolean; recovered: SemanticState | null;
  chain: number[]; transfers: number; retries: number; preCutBusinessVisits: number;
  authorities: { configuration: number; terminalSequence: number | null; observerSealed: boolean; leaseRemaining: number }[];
  lastRetry: string | null; rivalProposed: boolean; served: number;
}
export interface RecoveryRules {
  carryUncertain?: boolean; validateCut?: boolean; barrierAndDrain?: boolean; contiguousSuffix?: boolean;
}
export type RecoveryAction = 'stage' | 'protect' | 'expose' | 'cut' | 'bad-cut' | 'crash' | 'restart'
  | 'barrier' | 'seal' | 'tick' | 'confirm' | 'recover' | 'install' | 'activate' | 'retry'
  | 'serve' | 'old-policy-serve' | 'omit-payload' | 'stale-cut' | 'missing-suffix' | 'conflicting-successor' | 'late-old-write';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function initialRecoveryState(): RecoveryState {
  const semantic: SemanticState = {
    evidence: [{ context: 'genesis/policy0', binding: 'accepted-A', proposals: ['A'],
      votes: ['c0/m0:A', 'c0/m1:A', 'c0/m2:A', 'c0/m4:A'], status: 'accepted', charged: 1,
      certificate: 'original-c0-A', retry: { request: 'request-A', result: 'accepted:original-c0-A', origin: 'genesis/policy0' } }],
    denials: ['permanent-D'], reservations: [{ id: 'reserved-R', units: 2, expires: 10 }],
    rights: [{ id: 'right-L', expires: 10 }], policy: 0, fence: 0, withdrawn: false,
  };
  return { generation: 0, next: 0, staged: false, exposed: [], oracle: copy(semantic),
    cut: { configuration: 0, seq: 0, policyCutoff: 0, semantic, certified: true, payload: true },
    suffix: [], sequence: 0, floor: 0, barrier: false, sealed: false, drain: 0,
    oldConfirmations: 0, installations: 0, crashed: false, crashUsed: false,
    recovered: null, chain: [0], transfers: 0, retries: 0, preCutBusinessVisits: 0,
    authorities: [{ configuration: 0, terminalSequence: null, observerSealed: false, leaseRemaining: 3 }],
    lastRetry: null, rivalProposed: false, served: 0 };
}
/** Semantic reduction preserves original context rather than localizing imports.
 * A partial conflict remains charged and refuses either conflicting proposal.
 */
export function reduceRecoveryCommand(input: SemanticState, command: Command): SemanticState {
  const s = copy(input), context = `c${command.origin}/policy${s.policy}`;
  if (command.kind === 'conflict') s.evidence.push({ context, binding: 'partial-P',
    proposals: ['P', 'Q'], votes: ['c0/m0:P', 'c0/m1:Q'], status: 'partial', charged: 1,
    certificate: null, retry: null });
  if (command.kind === 'uncertain') s.evidence.push({ context, binding: 'uncertain-U',
    proposals: ['U'], votes: ['c0/m0:U', 'c0/m1:U', 'c0/m2:U', 'c0/m4:U'],
    status: 'uncertain', charged: 1, certificate: 'hidden-original-c0-U', retry: null });
  if (command.kind === 'accept') {
    const evidence = s.evidence.find(e => e.binding === 'uncertain-U');
    if (!evidence) throw new Error('Missing protected uncertain obligation');
    evidence.status = 'accepted'; evidence.retry = { request: 'request-U',
      result: 'accepted:hidden-original-c0-U', origin: evidence.context };
  }
  if (command.kind === 'authorize') {
    if (s.policy !== 1 || s.denials.includes('new-current') || !s.rights.some(r => r.expires > 1)) {
      throw new Error('No live current-policy authorization');
    }
    s.evidence.push({ context, binding: 'new-current', proposals: ['current'],
      votes: ['c2/m0:current', 'c2/m1:current', 'c2/m2:current', 'c2/m3:current'],
      status: 'accepted', charged: 1, certificate: 'original-c2-current',
      retry: { request: 'request-current', result: 'accepted:original-c2-current', origin: context } });
  }
  if (command.kind === 'withdraw') { s.policy++; s.fence++; s.withdrawn = true; s.denials.push('withdrawn-W'); }
  return s;
}
function projected(s: SemanticState, rules: RecoveryRules) {
  const result = copy(s);
  if (rules.carryUncertain === false) result.evidence = result.evidence.filter(e => e.status !== 'uncertain');
  return result;
}
/** The old cohort may issue a new authorization until its terminal barrier and
 * observer seal, and an already-issued live authorization survives until drain.
 * Retired authority records persist independently of successor activation.
 */
export function cohortAuthorizationAdmissible(s: RecoveryState, configuration: number, kind: 'new' | 'existing') {
  const authority = s.authorities.find(a => a.configuration === configuration);
  if (!authority) return false;
  return kind === 'existing' ? authority.leaseRemaining > 0
    : authority.terminalSequence === null && !authority.observerSealed;
}
export function recoveryViolation(s: RecoveryState): string | null {
  if (cohortAuthorizationAdmissible(s, s.generation, 'new')
    && s.authorities.some(a => a.configuration < s.generation
      && (cohortAuthorizationAdmissible(s, a.configuration, 'new')
        || cohortAuthorizationAdmissible(s, a.configuration, 'existing')))) return 'overlapping-old-authority';
  if (s.preCutBusinessVisits !== 0) return 'pre-cut-business-replay';
  if (s.suffix.length > RECOVERY_BOUNDS.suffixCap) return 'suffix-cap';
  if (s.recovered && !s.cut.certified) return 'uncertified-cut';
  if (s.recovered && !equal(s.recovered, s.oracle)) return 'lost-original-context-obligation';
  if (s.recovered && (s.cut.seq + s.suffix.length !== s.sequence
    || s.suffix.some((command, i) => command.seq !== s.cut.seq + i + 1))) return 'non-contiguous-recovery';
  if (s.transfers !== s.generation || s.chain.length !== s.generation + 1) return 'configuration-continuity';
  return null;
}
/** Reconstruct exclusively from a semantic cut and bounded command suffix.
 * The oracle is used ONLY by the independent invariant, never by recovery.
 */
function reconstruct(s: RecoveryState, rules: RecoveryRules): SemanticState | null {
  if (!s.cut.payload) return null;
  if (rules.validateCut !== false && (!s.cut.certified || s.cut.configuration !== s.generation
    || s.cut.policyCutoff !== s.cut.semantic.policy || s.cut.seq > s.sequence)) return null;
  if (rules.contiguousSuffix !== false && (s.cut.seq + s.suffix.length !== s.sequence
    || s.suffix.some((command, i) => command.seq !== s.cut.seq + i + 1)
    || s.sequence < s.floor)) return null;
  try { return s.suffix.reduce(reduceRecoveryCommand, copy(s.cut.semantic)); } catch { return null; }
}
const workload: Command['kind'][][] = [['conflict', 'uncertain'], ['accept', 'withdraw'], []];
export function stepRecoveryModel(input: RecoveryState, action: RecoveryAction,
  rules: RecoveryRules = {}): RecoveryState | null {
  const s = copy(input);
  if (s.crashed && action !== 'restart') return null;
  if (action === 'stage') {
    if (s.generation === 2 || s.staged || s.next === 2 || s.barrier || s.suffix.length === 2) return null;
    s.staged = true;
  } else if (action === 'protect') {
    if (!s.staged || s.barrier || s.suffix.length === 2) return null;
    const command: Command = { seq: s.sequence + 1, origin: s.generation, kind: workload[s.generation][s.next] };
    s.oracle = reduceRecoveryCommand(s.oracle, command); s.suffix.push(command);
    s.sequence++; s.floor = s.sequence; s.next++; s.staged = false; s.recovered = null;
  } else if (action === 'expose') {
    if (!s.next || s.exposed.includes(s.sequence)) return null;
    // Only protected bytes can produce an external response. Omission models a lost reply.
    s.exposed.push(s.sequence);
  } else if (action === 'cut' || action === 'bad-cut') {
    if (!s.suffix.length || s.oldConfirmations || s.installations) return null;
    s.cut = { configuration: s.generation, seq: s.sequence, policyCutoff: s.oracle.policy,
      semantic: projected(s.oracle, rules), certified: action === 'cut', payload: true };
    if (action === 'bad-cut') s.cut.semantic.reservations = [];
    if (rules.validateCut !== false && (!s.cut.certified || !equal(s.cut.semantic, projected(s.oracle, rules)))) return null;
    s.suffix = []; s.recovered = null;
  } else if (action === 'crash') {
    if (s.crashUsed || s.generation === 2) return null;
    s.crashUsed = true; s.crashed = true; s.staged = false; s.recovered = null; s.drain = 0;
    s.authorities[s.generation].leaseRemaining = 3;
    // Installation, floor, barrier and emitted protection are durable, candidate recovery is volatile.
  } else if (action === 'restart') {
    if (!s.crashed) return null;
    s.crashed = false; s.drain = 0;
  } else if (action === 'barrier') {
    if (s.generation === 2 || s.next !== 2 || s.barrier || s.staged) return null;
    s.barrier = true; s.authorities[s.generation].terminalSequence = s.sequence;
  } else if (action === 'seal') {
    if (!s.barrier || s.sealed) return null;
    s.sealed = true; s.authorities[s.generation].observerSealed = true;
  } else if (action === 'tick') {
    if (!s.sealed || s.drain === 3) return null;
    s.drain++; s.authorities[s.generation].leaseRemaining--;
  } else if (action === 'confirm') {
    if (s.generation === 2 || s.oldConfirmations === 4 || s.next !== 2) return null;
    if (rules.barrierAndDrain !== false && (!s.barrier || !s.sealed)) return null;
    // Four honest complete-floor validators; the Byzantine fifth may be silent.
    if (!reconstruct(s, rules)) return null;
    s.oldConfirmations++;
  } else if (action === 'recover') {
    if (s.recovered || s.generation === 2) return null;
    s.recovered = reconstruct(s, rules); if (!s.recovered) return null;
  } else if (action === 'install') {
    if (!s.recovered || s.oldConfirmations !== 4 || s.installations === 4) return null;
    s.installations++;
  } else if (action === 'activate') {
    if (s.installations !== 4 || s.oldConfirmations !== 4 || !s.recovered || s.generation === 2) return null;
    if (rules.barrierAndDrain !== false && (!s.barrier || !s.sealed || s.drain !== 3)) return null;
    s.generation++; s.transfers++; s.chain.push(s.generation);
    s.authorities.push({ configuration: s.generation, terminalSequence: null, observerSealed: false, leaseRemaining: 3 });
    s.cut = { configuration: s.generation, seq: s.sequence, policyCutoff: s.recovered.policy,
      semantic: copy(s.recovered), certified: true, payload: true };
    s.suffix = []; s.next = 0; s.staged = false; s.exposed = []; s.barrier = false;
    s.sealed = false; s.drain = 0; s.oldConfirmations = 0; s.installations = 0;
    s.crashUsed = false; s.recovered = null; s.rivalProposed = false;
  } else if (action === 'serve') {
    if (s.generation !== 2 || s.served || s.suffix.length === 2) return null;
    const current = reconstruct(s, rules);
    if (!current || recoveredBindingOutcome(current, 'new-current', 'request-current', 1).outcome !== 'authorize-current-policy') return null;
    const command: Command = { seq: s.sequence + 1, origin: s.generation, kind: 'authorize' };
    s.oracle = reduceRecoveryCommand(s.oracle, command); s.suffix.push(command);
    s.sequence++; s.floor = s.sequence; s.exposed.push(s.sequence); s.served++;
  } else if (action === 'retry') {
    if (s.generation !== 2 || s.retries || !s.oracle.evidence.find(e => e.binding === 'uncertain-U')?.retry) return null;
    const installed = reconstruct(s, rules);
    if (!installed || !equal(installed.evidence.map(e => e.retry), s.oracle.evidence.map(e => e.retry))) return null;
    s.lastRetry = installed.evidence.find(e => e.binding === 'uncertain-U')!.retry!.result; s.retries++;
  } else if (action === 'omit-payload') {
    if (!s.cut.payload || s.recovered || s.oldConfirmations) return null;
    s.cut.payload = false;
  } else if (action === 'missing-suffix') {
    if (!s.suffix.length || s.recovered || s.oldConfirmations) return null;
    s.suffix.pop();
  } else if (action === 'stale-cut') {
    if (!s.sequence || s.recovered || s.oldConfirmations) return null;
    s.cut.seq = Math.max(0, s.cut.seq - 1);
    // A stale payload without its omitted command cannot satisfy the contiguous floor.
  } else if (action === 'conflicting-successor') {
    // A competing uncommitted proposal is retained; the assumed BFT order selects
    // the one next-cohort barrier. No second independent selection is allowed.
    if (s.barrier || s.rivalProposed || s.generation === 2) return null;
    s.rivalProposed = true;
  } else return null; // Late old writes are excluded by the terminal ordered workload.
  return s;
}

/** Observable decisions consume the recovered obligations, including original
 * retry provenance. A timeout cannot turn uncertain/partial evidence into credit.
 */
export function recoveredBindingOutcome(semantic: SemanticState, binding: string, request: string, policy = 0) {
  const evidence = semantic.evidence.find(e => e.binding === binding);
  if (evidence?.status === 'accepted' && evidence.retry?.request === request) {
    return { outcome: 'exact-retry', result: evidence.retry.result, origin: evidence.retry.origin };
  }
  if (evidence) return { outcome: 'refuse', reason: evidence.status, charged: evidence.charged };
  if (semantic.denials.includes(binding)) return { outcome: 'refuse', reason: 'permanent-denial' };
  if (policy < semantic.fence || policy !== semantic.policy) return { outcome: 'refuse', reason: 'fenced-policy' };
  if (semantic.rights.some(r => r.expires > 1)) return { outcome: 'authorize-current-policy' };
  return { outcome: 'refuse', reason: 'no-live-right' };
}

/** Authenticity of each chain link/signature and current-authority freshness are
 * external premises; this checks the model's pinned membership/continuity floor.
 */
export function freshGenesisRecoveryAllowed(state: RecoveryState, chain: number[],
  currentSigners: string[], fresh: boolean) {
  const pinned = RECOVERY_COHORTS[state.generation];
  return fresh && state.cut.payload && chain.length === state.generation + 1
    && chain.every((configuration, i) => configuration === i)
    && new Set(currentSigners).size >= 4
    && currentSigners.every(signer => pinned.includes(signer));
}
export interface RecoveryTraceStep { action: RecoveryAction; state: RecoveryState }
export const RECOVERY_ACTIONS: RecoveryAction[] = ['stage', 'protect', 'expose', 'cut', 'bad-cut',
  'crash', 'restart', 'barrier', 'seal', 'tick', 'confirm', 'recover', 'install', 'activate', 'retry',
  'serve', 'old-policy-serve', 'omit-payload', 'stale-cut', 'missing-suffix', 'conflicting-successor', 'late-old-write'];
/** BFS enumerates the declared action space with exact-state deduplication.
 * Counterexamples are shortest within this workload/action space, not globally.
 */
export function exploreCertifiedRecovery(options: RecoveryRules & { maxStates?: number } = {}) {
  const maxStates = options.maxStates ?? 80_000;
  if (!Number.isSafeInteger(maxStates) || maxStates < 1 || maxStates > 500_000) throw new Error('Invalid state cap');
  const initial = initialRecoveryState();
  const nodes: { state: RecoveryState; parent: number; action?: RecoveryAction }[] = [{ state: initial, parent: -1 }];
  const seen = new Set([JSON.stringify(initial)]);
  let edges = 0, refusals = 0, recoveredStates = 0, secondTransfers = 0, exactRetries = 0, serviceStates = 0;
  const coverage = new Set<RecoveryAction>();
  function trace(index: number): RecoveryTraceStep[] {
    const out: RecoveryTraceStep[] = [];
    for (let n = nodes[index]; n.parent >= 0; n = nodes[n.parent]) out.push({ action: n.action!, state: n.state });
    return out.reverse();
  }
  const result = (exhaustive: boolean, limitReached: boolean, index: number, violation: string | null) => ({
    exhaustive, limitReached, exploredStates: index + 1, discoveredStates: seen.size, edges, refusals,
    recoveredStates, secondTransfers, exactRetries, serviceStates, coverage: [...coverage].sort(), violation,
    counterexample: violation ? trace(index) : null,
  });
  for (let index = 0; index < nodes.length; index++) {
    const s = nodes[index].state;
    const violation = recoveryViolation(s);
    if (violation) return result(false, false, index, violation);
    if (s.recovered) recoveredStates++;
    if (s.transfers === 2) secondTransfers++;
    if (s.retries) exactRetries++;
    if (s.served) serviceStates++;
    for (const action of RECOVERY_ACTIONS) {
      const next = stepRecoveryModel(s, action, options);
      if (!next) { refusals++; continue; }
      edges++; coverage.add(action);
      const key = JSON.stringify(next); if (seen.has(key)) continue;
      if (seen.size === maxStates) return result(false, true, index, null);
      seen.add(key); nodes.push({ state: next, parent: index, action });
    }
  }
  return result(true, false, nodes.length - 1, null);
}
/** Fair suffix after adversarial finite prefixes: four honest members available,
 * no missing required bytes, no further crash; no real-time liveness claim.
 */
export function fairRecoveryContinuation(input = initialRecoveryState()) {
  let s = copy(input); const trace: RecoveryTraceStep[] = [];
  const apply = (action: RecoveryAction) => {
    const next = stepRecoveryModel(s, action); if (!next) throw new Error(`Fair continuation refused ${action}`);
    s = next; trace.push({ action, state: copy(s) });
  };
  if (s.crashed) apply('restart');
  while (s.generation < 2) {
    while (s.next < 2) {
      if (s.suffix.length === 2) apply('cut');
      if (!s.staged) apply('stage'); apply('protect');
    }
    if (!s.barrier) apply('barrier'); if (!s.sealed) apply('seal');
    while (s.drain < 3) apply('tick');
    while (s.oldConfirmations < 4) apply('confirm');
    if (!s.recovered) apply('recover');
    while (s.installations < 4) apply('install'); apply('activate');
  }
  if (!s.served) apply('serve');
  if (!s.retries) apply('retry');
  return { state: s, trace };
}
/** Explicitly OUT OF SCOPE: violates historical non-equivocating honest keys.
 * This is a boundary fixture, not a finding against the accepted fault model.
 */
export function retiredKeyBoundary() {
  return { inScope: false, compromisedRetiredKeys: RECOVERY_COHORTS[0].slice(0, 4),
    genuineHistory: ['genesis', 'c0->c1', 'c1->c2'], forgedHistory: ['genesis', 'c0->attacker'],
    genesisOnlyClientCanDistinguish: false, requiresNewTrustDecision: true };
}
