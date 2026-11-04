import fs from 'node:fs';
import crypto from 'node:crypto';

const runPath = 'delivery/results/RUN-RSO5-DEC-012.json';
const workPath = 'delivery/results/rso5-dec012-operation-work.json';
const summaryPath = 'delivery/results/rso5-dec012-evidence-summary.json';
const candidatePath = 'docs/handover/2026-10-31/rso5-dec012-candidate-hashes.json';
const receiptPath = 'docs/evals/v04-rso5-dec012-bounded-research-2026-10-31.md';
const operationMaximum = 26611731, cumulativeMaximum = 1016959841, forecast = 270132258;
const number = value => value.toLocaleString('en-US');
const hash = path => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
if (fs.readFileSync(workPath, 'utf8') !== fs.readFileSync(runPath, 'utf8')) throw new Error('Result artifacts differ');
if (run.diagnosticUnbounded !== false || run.budgetId !== 'DEC-012'
  || run.acceptanceComparison.operationMaximumBytes !== operationMaximum
  || run.acceptanceComparison.cumulativeMaximumBytes !== cumulativeMaximum) throw new Error('DEC-012 identity or comparison invalid');
let sum = 0, firstCumulative = null;
for (const operation of run.operations) {
  if (operation.usage.maximumBytes !== operationMaximum || operation.usage.diagnosticUnbounded === true) throw new Error(`Non-DEC-012 meter: ${operation.label}`);
  sum += operation.usage.usedBytes;
  if (!firstCumulative && sum > cumulativeMaximum) firstCumulative = operation;
}
const firstOperation = run.operations.find(operation => operation.usage.usedBytes > operationMaximum) ?? null;
const maximumOperation = run.operations.reduce((a, b) => a.usage.usedBytes > b.usage.usedBytes ? a : b);
if (sum !== run.usedBytes || run.operations.at(-1).cumulativeUsedBytes !== sum) throw new Error('Cumulative arithmetic differs');
if ((run.firstOperationCrossing?.label ?? null) !== (firstOperation?.label ?? null)
  || (run.firstCumulativeCrossing?.label ?? null) !== (firstCumulative?.label ?? null)) throw new Error('Crossing labels differ');
if (!run.inventory.complete || run.forecastComparison.unreachableClasses.length) throw new Error('Complete inventory missing');
const expectedOutcome = sum <= cumulativeMaximum && maximumOperation.usage.usedBytes <= operationMaximum ? 'passed' : 'failed';
if (run.outcome !== expectedOutcome || run.acceptanceEvaluation !== 'passed_revised_budget_research') throw new Error('Bounded result or acceptance evaluation differs');
const operationCrossingCount = run.operations.filter(operation => operation.usage.usedBytes > operationMaximum).length;
const summary = {
  diagnosticUnbounded: false,
  budgetId: 'DEC-012',
  acceptanceEvaluation: run.acceptanceEvaluation,
  usedBytes: sum,
  forecastBytes: forecast,
  differenceFromForecastBytes: sum - forecast,
  actualExcessBytes: Math.max(0, sum - cumulativeMaximum),
  maximumOperation: maximumOperation.label,
  maximumOperationBytes: maximumOperation.usage.usedBytes,
  operationCrossingCount,
  firstOperationCrossing: firstOperation ? { operation: firstOperation.label, usedBytes: firstOperation.usage.usedBytes, cumulativeUsedBytes: firstOperation.cumulativeUsedBytes } : null,
  firstCumulativeCrossing: firstCumulative ? { operation: firstCumulative.label, usedBytes: firstCumulative.usage.usedBytes, cumulativeUsedBytes: firstCumulative.cumulativeUsedBytes } : null,
  operationCount: run.operations.length,
  inventory: run.inventory.actual,
  unreachableClasses: run.forecastComparison.unreachableClasses,
  resultSha256: hash(runPath),
};
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
const sourcePaths = [
  'packages/core/package.json', 'packages/core/src/admission-work.ts', 'packages/core/src/admission-policy.ts',
  'packages/core/src/admission-policy-advance.ts', 'packages/core/src/admission-policy-freshness.ts',
  'packages/core/src/admission-witness.ts', 'packages/core/src/admission-witness-handoff.ts',
  'packages/relay/src/protected-policy-observer.ts', 'packages/relay/src/witness-handoff-state.ts',
  'packages/relay/src/sustainable-recovery-work.ts', 'packages/relay/src/sustainable-rso5-opaque.ts',
  'packages/relay/src/sustainable-rso5-arena.ts', 'packages/relay/src/sustainable-rso5-protected-arena.ts',
  'packages/relay/src/sustainable-rso5-codec.ts', 'packages/relay/src/sustainable-recovery-manifest.ts',
  'packages/relay/src/sustainable-rso5-manifest.ts', 'packages/relay/src/sustainable-rso5-runtime.ts',
  'packages/relay/src/__tests__/sustainable-rso5-manifest.test.ts', 'packages/relay/src/__tests__/sustainable-rso5-runtime.integration.test.ts',
  runPath, workPath, summaryPath, 'scripts/rso5-dec012-finalize-evidence.mjs',
];
const sha256 = Object.fromEntries(sourcePaths.map(path => [path, hash(path)]));
const candidate = {
  candidate: 'DEC-012 RSO5 scenario-fit bounded research lifecycle',
  acceptance: 'passed_revised_budget_research only; not production, K/R, deployment or economic approval',
  environment: { node: 'v24.19.0', vitest: '4.1.11', platform: 'darwin-arm64' },
  commands: {
    focused: './node_modules/.bin/vitest run --maxWorkers=1 packages/relay/src/__tests__/sustainable-rso5-manifest.test.ts',
    typecheck: './node_modules/.bin/tsc -p docs/handover/2026-10-24/source-tsconfig.json --noEmit',
    diagnostic: './node_modules/.bin/vitest run --maxWorkers=1 packages/relay/src/__tests__/sustainable-rso5-runtime.integration.test.ts',
  },
  results: {
    focused: '17/17 PASS', typecheck: 'PASS, exit 0',
    diagnostic: 'Complete bounded lifecycle PASS with complete inventory',
    diagnosticUnbounded: false,
    budgetId: 'DEC-012',
    acceptanceEvaluation: run.acceptanceEvaluation,
    acceptanceComparison: { operationMaximumBytes: operationMaximum, cumulativeMaximumBytes: cumulativeMaximum },
    usedBytes: sum,
    maximumOperationBytes: maximumOperation.usage.usedBytes,
    maximumOperation: maximumOperation.label,
    operationCrossingCount,
    firstOperationCrossing: null,
    firstCumulativeCrossing: null,
    forecastBytes: forecast,
    differenceFromForecastBytes: sum - forecast,
    actualExcessBytes: Math.max(0, sum - cumulativeMaximum),
    archiveHeaderLowerBoundBytes: 110592,
    lowerBoundStatus: 'Original-cap and uncapped histories are preserved unchanged; DEC-012 actual bounded values are not normalized or extrapolated',
    completeInventoryMeasured: true,
    completeForecastVerified: false,
    unreachableClasses: [],
    actualInventory: run.inventory.actual,
    evidenceSummary: summaryPath,
    evidenceRun: 'One bounded lifecycle invocation generated both identical DEC-012 result files; summary/candidate/receipt generated by scripts/rso5-dec012-finalize-evidence.mjs',
  },
  sha256,
};
fs.writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
const hashLines = Object.entries(sha256).map(([path, digest]) => `${digest}  ${path}`).join('\n');
const receipt = `# RSO5 DEC-012 bounded research lifecycle receipt — October 31, 2026

**Status: bounded lifecycle and complete inventory PASS for revised-budget research only; no production, K/R, deployment or economic approval.** Original-cap failures and uncapped diagnostics are preserved unchanged.

## Contract and result

DEC-012 sets per-operation work to **${number(operationMaximum)} B** and cumulative work to **${number(cumulativeMaximum)} B**, with arrival intensity limited to <=4.13% of the DEC-011 measured sustained rate. This lifecycle used normal bounded metering for every operation: \`diagnosticUnbounded:false\`, \`budgetId:'DEC-012'\`, and every operation's \`maximumBytes=${number(operationMaximum)}\`.

Focused RSO5 manifest: **17/17 PASS**. Actual-source noEmit: **PASS, exit 0**. Complete lifecycle: **PASS**, with ${run.operations.length} top-level records and complete required inventory.

- Actual cumulative work: **${number(sum)} B**, below the DEC-012 cumulative budget by ${number(cumulativeMaximum - sum)} B.
- Maximum operation: \`${maximumOperation.label}\`, **${number(maximumOperation.usage.usedBytes)} B**, below the per-operation budget by ${number(operationMaximum - maximumOperation.usage.usedBytes)} B.
- Operations crossing the DEC-012 per-operation budget: **${operationCrossingCount}**.
- First operation/cumulative crossings: **none**.
- Forecast difference: **${number(sum - forecast)} B** above the historical forecast of ${number(forecast)} B; the historical forecast is not used as the DEC-012 cap.
- Actual inventory: ${JSON.stringify(run.inventory.actual)}.
- Unreachable classes: **none**.
- Acceptance evaluation: \`${run.acceptanceEvaluation}\`.

Both result artifacts are identical with SHA-256 \`${summary.resultSha256}\`. The summary is \`${summaryPath}\`, and the candidate manifest is \`${candidatePath}\`.

## Remaining limitations

This is a scenario-fit research result only. It does not establish production affordability, physical power, physical-network cost, labor, representative maxima, lifetime/history growth, E3 or K1–K8. Arrival intensity must remain <=4.13% of the DEC-011 measured sustained rate. Power remains blocked with no samples; loopback is not Internet evidence. Production and any revised production budget require separate owner decisions and independent physical/operational evidence.

Final same-run hashes:

\`\`\`
${hashLines}
\`\`\`

No failure was tuned and no campaign, deployment or release action occurred. Parent owns commit/push.
`;
fs.writeFileSync(receiptPath, receipt);
for (const [path, expected] of Object.entries(sha256)) if (hash(path) !== expected) throw new Error(`Hash mismatch: ${path}`);
console.log(JSON.stringify({ ...summary, candidate: candidatePath, receipt: receiptPath, hashesVerified: Object.keys(sha256).length }, null, 2));
