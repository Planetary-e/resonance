/** Offline finite evaluation. No real keys, histories, volunteers or network. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { exploreSuccessorAgreement, oneShotSuccessorCounterexamples } from './history-successor-model.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({ options: { out: { type: 'string', default: 'docs/evals/history-successors-2026-10-15.json' } } });
const sources = ['packages/eval/src/history-successor-model.ts', 'packages/eval/src/history-checkpoint-model.ts',
  'packages/eval/src/history-successors.ts',
  'packages/eval/src/__tests__/history-successor-model.test.ts'];
const report = {
  generatedAt: new Date().toISOString(),
  sourceBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  worktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceSha256: Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])),
  model: 'two-view single-slot agreement with prepared proofs and explicit view-change evidence; not the installed reservation protocol',
  assumptions: { members: 5, byzantineMembers: 1, quorum: 4, honestIdentitiesSymmetric: true,
    proposedValues: ['A', 'B'], views: [1, 2], onePredecessorAndSuccessorGeneration: true,
    durableAtomicTransitions: true, cryptographyAndPayloadValidationAbstracted: true,
    bothCompleteOwnerValidValuesAvailable: true, lostVotesRemainAvailableToAdversary: true,
    byzantineCanEquivocateOmitOrReplayExistingCertificates: true,
    stableContinuationRequiresFourHonestOnlineAndNoCompetingHigherView: true,
    excludesLiveRestoreGenerationAncestryMembershipChangesAndPhysicalPowerLoss: true },
  oneShot: oneShotSuccessorCounterexamples(),
  agreement: exploreSuccessorAgreement({ checkStableContinuation: true }),
  negativeControls: {
    forgetPreparedProof: exploreSuccessorAgreement({ retainPreparedProof: false }),
    allowLateConfirmation: exploreSuccessorAgreement({ fenceLateConfirmations: false }),
  },
};
if (!report.agreement.exhaustive || report.agreement.conflictingDecisions || report.agreement.stableContinuation.blocked
  || report.agreement.stableContinuation.conflicting || Object.values(report.negativeControls).some(r => !r.conflictingDecisions)) {
  throw new Error('Successor evaluation did not satisfy its bounded checks');
}
const output = resolve(root, values.out!);
mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: output, agreement: report.agreement,
  negativeControls: Object.fromEntries(Object.entries(report.negativeControls).map(([name, r]) => [name, {
    exploredStates: r.exploredStates, conflictingDecisions: r.conflictingDecisions, traceSteps: r.counterexample!.length,
  }])) }, null, 2));
