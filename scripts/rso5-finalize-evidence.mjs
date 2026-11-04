import fs from 'node:fs';
import crypto from 'node:crypto';

const runPath = 'delivery/results/RUN-RSO5-001.json';
const workPath = 'delivery/results/rso5-operation-work.json';
const candidatePath = 'docs/handover/2026-10-26/rso5-candidate-hashes.json';
const receiptPath = 'docs/evals/v04-rso5-recovery-implementation-2026-10-26.md';
const featurePath = 'delivery/work/FEAT-001.md';
const progressPath = 'delivery/progress.md';
const summaryPath = 'delivery/results/rso5-evidence-summary.json';
const operationMaximum = 4718592;
const cumulativeMaximum = 268435456;
const forecast = 270132258;
const number = value => value.toLocaleString('en-US');
const hash = path => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
if (fs.readFileSync(workPath, 'utf8') !== fs.readFileSync(runPath, 'utf8')) throw new Error('Result artifacts differ');
let sum = 0, firstCumulative = null;
for (const operation of run.operations) {
  sum += operation.usage?.usedBytes ?? 0;
  if (!firstCumulative && sum > cumulativeMaximum) firstCumulative = operation;
}
const firstOperation = run.operations.find(operation => (operation.usage?.usedBytes ?? 0) > operationMaximum) ?? null;
const maximumOperation = run.operations.reduce((a, b) => a.usage.usedBytes > b.usage.usedBytes ? a : b);
if (sum !== run.usedBytes || run.operations.at(-1).cumulativeUsedBytes !== sum) throw new Error('Artifact cumulative arithmetic differs');
if (run.firstOperationCrossing?.label !== firstOperation?.label || run.firstCumulativeCrossing?.label !== firstCumulative?.label) throw new Error('Artifact crossing labels differ');
if (!run.inventory.complete || run.forecastComparison.unreachableClasses.length || !run.diagnosticUnbounded || run.acceptanceEvaluation !== 'not_run') throw new Error('Incomplete diagnostic');
for (const operation of run.operations) {
  if (operation.usage.maximumBytes !== null || operation.usage.diagnosticUnbounded !== true) throw new Error(`Bounded operation ${operation.label}`);
}
const summary = {
  diagnosticUnbounded: true,
  acceptanceEvaluation: 'not_run',
  usedBytes: sum,
  forecastBytes: forecast,
  differenceFromForecastBytes: sum - forecast,
  actualExcessBytes: sum - cumulativeMaximum,
  maximumOperation: maximumOperation.label,
  maximumOperationBytes: maximumOperation.usage.usedBytes,
  operationCrossingCount: run.operations.filter(operation => operation.usage.usedBytes > operationMaximum).length,
  firstOperationCrossing: { operation: firstOperation.label, usedBytes: firstOperation.usage.usedBytes, cumulativeUsedBytes: firstOperation.cumulativeUsedBytes },
  firstCumulativeCrossing: { operation: firstCumulative.label, usedBytes: firstCumulative.usage.usedBytes, cumulativeUsedBytes: firstCumulative.cumulativeUsedBytes },
  operationCount: run.operations.length,
  inventory: run.inventory.actual,
  unreachableClasses: run.forecastComparison.unreachableClasses,
  resultSha256: hash(runPath),
};
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
const timestamp = new Date().toISOString();
const featureEvidence = `DEC-004 policy/observer-complete evidence: mandatory proposal, retry request/vote, drain, activation, policy signing/advancement, observer advancement and fresh-policy paths execute inside the unbounded meter with real replay/materialization, parsing, signature, snapshot, I/O and nested helper charges. The complete lifecycle passed with 102 phase calls, 7 retries, 2 view groups/8 member newView calls and 4 full recoveries. Focused manifest is **17/17 PASS** and actual-source noEmit **PASS**. Actual cumulative work is **${number(sum)} B**, ${number(sum - forecast)} B above forecast and ${number(sum - cumulativeMaximum)} B above comparison. First operation crossing is \`${firstOperation.label}\` at ${number(firstOperation.usage.usedBytes)} B; first cumulative crossing is \`${firstCumulative.label}\` at ${number(firstCumulative.cumulativeUsedBytes)} B. Maximum operation is \`${maximumOperation.label}\` at ${number(maximumOperation.usage.usedBytes)} B. Both result artifacts have SHA-256 \`${summary.resultSha256}\`. No unreachable classes or acceptance is claimed.`;
let feature = fs.readFileSync(featurePath, 'utf8');
feature = feature.replace(/updated_at: "[^"]+"/, `updated_at: "${timestamp}"`);
feature = feature.replace(/DEC-004 policy\/observer-complete evidence:.*(?:\n(?!DEC-004|##).*)*/, `${featureEvidence}\n`);
feature = feature.replace(/- v11, .*/, `- v11, 2026-10-26: policy/observer/proposal/retry-complete instrumentation measures ${number(sum)} B; first cumulative crossing is ${firstCumulative.label} at ${number(firstCumulative.cumulativeUsedBytes)} B.`);
fs.writeFileSync(featurePath, feature);
const featuresPath = 'delivery/features.json';
const features = JSON.parse(fs.readFileSync(featuresPath, 'utf8'));
features.features.find(item => item.id === 'FEAT-001').notes = `DEC-004 policy/observer/proposal/retry-complete uncapped diagnostic: mandatory construction, replay, signature, snapshot, I/O and nested helper work is metered. Actual total is ${number(sum)} B versus forecast ${number(forecast)} B (+${number(sum - forecast)} B) and acceptance comparison ${number(cumulativeMaximum)} B (+${number(sum - cumulativeMaximum)} B). First cumulative crossing is ${firstCumulative.label} at ${number(firstCumulative.cumulativeUsedBytes)} B; ${summary.operationCrossingCount} operations exceed the old threshold. Complete inventory passed; this is threshold-failure evidence, not acceptance.`;
fs.writeFileSync(featuresPath, JSON.stringify(features, null, 2) + '\n');
const statePath = 'delivery/state.json';
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.session.updated_at = timestamp;
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
const progressSection = `## ${timestamp} — DEC-004 proposal/retry-complete measurement

- **State and feature:** \`paused\`; FEAT-001 / R1 remains blocked by measured work. No acceptance or K/R result follows.
- **Instrumented paths:** Original votes, all retry requests, returning proposal, observer root/open/ready, drain, activation, policy signing/advancement, observer advancement and fresh-policy checks execute within the unbounded meter using real replay/materialization, parsing and signature hooks. Earlier observer/genesis and transport I/O remain included.
- **Evidence:** Focused manifest **17/17 PASS**; actual-source noEmit **PASS**. Complete lifecycle **PASS**; ${run.operations.length} top-level records and no unreachable classes.
- **Measured work:** ${number(sum)} B versus forecast ${number(forecast)} B (+${number(sum - forecast)} B) and comparison ${number(cumulativeMaximum)} B (+${number(sum - cumulativeMaximum)} B). First operation crossing \`${firstOperation.label}\` at ${number(firstOperation.usage.usedBytes)} B; first cumulative crossing \`${firstCumulative.label}\` at ${number(firstCumulative.cumulativeUsedBytes)} B. Maximum operation \`${maximumOperation.label}\` at ${number(maximumOperation.usage.usedBytes)} B; ${summary.operationCrossingCount} operations cross the old operation threshold.
- **Evidence identity:** Both identical result artifacts have SHA-256 \`${summary.resultSha256}\`. Candidate values and these claims were generated programmatically from the final artifact.
- **Files changed:** Admission witness signature hooks, lifecycle construction paths, finalizer, receipt/candidate manifest, both result files and delivery records. No composed suite, campaign, production routing, Git/CI/install action or acceptance claim occurred.
- **Next action:** Preserve exact complete instrumented evidence for reviewer/owner decision.
`;
let progress = fs.readFileSync(progressPath, 'utf8');
progress = progress.replace(/## \d{4}-\d{2}-\d{2}T[^ ]+ — DEC-004 .*measurement[\s\S]*$/, progressSection);
fs.writeFileSync(progressPath, progress);
const sourcePaths = [
  'packages/core/package.json', 'packages/core/src/admission-work.ts', 'packages/core/src/admission-policy.ts',
  'packages/core/src/admission-policy-advance.ts', 'packages/core/src/admission-policy-freshness.ts',
  'packages/core/src/admission-witness.ts', 'packages/core/src/admission-witness-handoff.ts',
  'packages/relay/src/protected-policy-observer.ts', 'packages/relay/src/witness-handoff-state.ts',
  'packages/relay/src/sustainable-recovery-work.ts', 'packages/relay/src/sustainable-rso5-opaque.ts',
  'packages/relay/src/sustainable-rso5-arena.ts', 'packages/relay/src/sustainable-rso5-protected-arena.ts',
  'packages/relay/src/sustainable-rso5-codec.ts', 'packages/relay/src/sustainable-rso5-manifest.ts',
  'packages/relay/src/sustainable-rso5-runtime.ts', 'packages/relay/src/__tests__/sustainable-rso5-manifest.test.ts',
  'packages/relay/src/__tests__/sustainable-rso5-runtime.integration.test.ts', runPath, workPath, featurePath,
  summaryPath, 'scripts/rso5-finalize-evidence.mjs',
];
const sha256 = Object.fromEntries(sourcePaths.map(path => [path, hash(path)]));
const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
candidate.candidate = 'DEC-004 RSO5 proposal/retry/policy/observer-complete uncapped diagnostic and measured threshold failure';
candidate.acceptance = 'not_run; complete lifecycle is diagnostic only and actual thresholds were crossed';
candidate.results = {
  focused: '17/17 PASS',
  typecheck: 'PASS, exit 0',
  diagnostic: `Complete lifecycle PASS; diagnostic outcome failed on actual thresholds; ${number(sum)} B cumulative`,
  diagnosticUnbounded: true,
  acceptanceEvaluation: 'not_run',
  acceptanceComparison: { operationMaximumBytes: operationMaximum, cumulativeMaximumBytes: cumulativeMaximum },
  usedBytes: sum,
  maximumOperationBytes: maximumOperation.usage.usedBytes,
  maximumOperation: maximumOperation.label,
  operationCrossingCount: summary.operationCrossingCount,
  firstOperationCrossing: { operation: firstOperation.label, usedBytes: firstOperation.usage.usedBytes, cumulativeUsedBytes: firstOperation.cumulativeUsedBytes },
  firstCumulativeCrossing: { operation: firstCumulative.label, usedBytes: firstCumulative.usage.usedBytes, cumulativeUsedBytes: firstCumulative.cumulativeUsedBytes },
  forecastBytes: forecast,
  differenceFromForecastBytes: sum - forecast,
  actualExcessBytes: sum - cumulativeMaximum,
  archiveHeaderLowerBoundBytes: 110592,
  lowerBoundStatus: 'Earlier lower-bound history is preserved; final actual measurement is not normalized or extrapolated',
  completeInventoryMeasured: true,
  completeForecastVerified: false,
  unreachableClasses: [],
  actualInventory: run.inventory.actual,
  evidenceSummary: summaryPath,
  evidenceRun: 'Same unchanged final source and instrumentation as focused/noEmit gates; both result files generated by one final lifecycle invocation; documentation values generated by scripts/rso5-finalize-evidence.mjs',
};
candidate.sha256 = sha256;
fs.writeFileSync(candidatePath, JSON.stringify(candidate, null, 2) + '\n');
const hashLines = Object.entries(sha256).map(([path, digest]) => `${digest}  ${path}`).join('\n');
const receiptSection = `## DEC-004 policy/observer/proposal/retry-complete measurement

Earlier uncapped totals remain lower-bound history. The final run additionally meters
original vote construction, every retry request and the returning handoff proposal using
real admission signature/materialization hooks. Previously instrumented replay, policy,
observer, snapshot, persistence, transport and fresh-policy paths remain included. No
numeric ceiling, output estimate or normalization was introduced.

Final focused result: **17/17 PASS**; actual-source noEmit **PASS, exit 0**. Complete
lifecycle: **PASS**, with ${run.operations.length} top-level records and no unreachable classes. This remains
diagnostic, not acceptance.

- Total actual work: **${number(sum)} B**, **${number(sum - forecast)} B above forecast**.
- Actual excess over ${number(cumulativeMaximum)} B: **${number(sum - cumulativeMaximum)} B**.
- First operation crossing: \`${firstOperation.label}\`, **${number(firstOperation.usage.usedBytes)} B**, cumulative ${number(firstOperation.cumulativeUsedBytes)} B.
- First cumulative crossing: \`${firstCumulative.label}\`, cumulative **${number(firstCumulative.cumulativeUsedBytes)} B**;
  that operation used ${number(firstCumulative.usage.usedBytes)} B.
- Maximum operation: \`${maximumOperation.label}\`, **${number(maximumOperation.usage.usedBytes)} B**.
- **${summary.operationCrossingCount}** operations exceed the old per-operation comparison.

These values and the candidate manifest were generated programmatically from the final
artifact. Earlier labels and totals are not forced to earlier values. Both result files
are identical with SHA-256 \`${summary.resultSha256}\`. \`diagnosticUnbounded:true\` and
\`acceptanceEvaluation:not_run\` remain explicit.

Final same-run hashes:

\`\`\`
${hashLines}
\`\`\`

No composed suite, campaign, production routing, Git/CI/install action or acceptance
claim occurred.
`;
let receipt = fs.readFileSync(receiptPath, 'utf8');
receipt = receipt.replace(/## DEC-004 policy\/observer[^\n]*\n[\s\S]*$/, receiptSection);
fs.writeFileSync(receiptPath, receipt);
if (candidate.results.usedBytes !== sum || candidate.results.firstCumulativeCrossing.operation !== firstCumulative.label
  || candidate.results.firstCumulativeCrossing.cumulativeUsedBytes !== firstCumulative.cumulativeUsedBytes) throw new Error('Candidate values differ from artifact');
const documented = [candidatePath, receiptPath, featurePath, progressPath];
for (const path of documented.slice(1)) {
  const text = fs.readFileSync(path, 'utf8');
  if (!text.includes(number(sum)) || !text.includes(firstCumulative.label) || !text.includes(number(firstCumulative.cumulativeUsedBytes))
    || !text.includes(summary.resultSha256)) throw new Error(`Documented values differ from artifact: ${path}`);
}
for (const [path, expected] of Object.entries(candidate.sha256)) if (hash(path) !== expected) throw new Error(`Hash mismatch: ${path}`);
console.log(JSON.stringify({ ...summary, documentedFilesChecked: documented, hashesVerified: Object.keys(candidate.sha256).length }, null, 2));
