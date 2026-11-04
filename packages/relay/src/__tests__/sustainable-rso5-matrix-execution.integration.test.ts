import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { driveIndependentRso5Matrix } from '../sustainable-rso5-lab.js';

it('executes the approved immutable 20-run matrix in frozen order', async () => {
  const startedAt = new Date().toISOString();
  const retry = Number(process.env.RSO5_MATRIX_RETRY ?? '0'), startIndex = Number(process.env.RSO5_MATRIX_START_INDEX ?? '0');
  const identityPrefix = process.env.RSO5_MATRIX_IDENTITY_PREFIX ?? `ci-${randomBytes(8).toString('hex')}`;
  const suffix = retry > 0 ? `-retry-${retry}` : '';
  const previousPath = process.env.RSO5_MATRIX_PREVIOUS;
  const previous = startIndex > 0 && previousPath ? JSON.parse(readFileSync(previousPath, 'utf8')).completed : [];
  const completed: unknown[] = [...previous];
  const base = {
    schema_version: 1,
    command: `node scripts/rso5-economic-matrix-driver.mjs${suffix}${startIndex > 0 ? ` --start-index=${startIndex}` : ''}`,
    execution_attempt: retry,
    identity_prefix: identityPrefix,
    start_index: startIndex,
    started_at: startedAt,
    previous_entry_failure: "EEXIST: file already exists, open 'delivery/results/econ-matrix-driver-final-smoke.json'",
    previous_failure_phase: 'selection-only entrypoint; no matrix lifecycle executed',
    matrix_runs_executed: 0,
    completed,
    sustained_windows_executed: false,
    acceptance_evaluation: 'not_run',
  };
  try {
    const results = await driveIndependentRso5Matrix({ execute: true, independentReviewApproved: true, executionAttempt: retry, startIndex, identityPrefix,
      onRunComplete: run => { completed.push({ ...run, outcome: 'passed_diagnostic_run' }); } });
    expect(results).toHaveLength(20 - startIndex);
    const allResults = [...previous, ...results].sort((a, b) => a.orderIndex - b.orderIndex);
    expect(allResults).toHaveLength(20);
    expect(allResults.map(run => run.orderIndex)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(new Set(allResults.map(run => run.executionRunId)).size).toBe(20);
    const path = identityPrefix === 'unified' ? 'delivery/results/econ-unified-execution.json'
      : startIndex > 0 ? `delivery/results/econ-matrix-execution-resume-${identityPrefix}-${startIndex}.json` : `delivery/results/econ-matrix-execution-${identityPrefix}${suffix}.json`;
    writeFileSync(path, `${JSON.stringify({ ...base, outcome: 'passed_diagnostic_matrix', completed_at: new Date().toISOString(),
      matrix_runs_executed: 20, results: allResults }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    const path = identityPrefix === 'unified' ? `delivery/results/econ-unified-execution-failure-${Date.now()}.json`
      : `delivery/results/econ-matrix-execution-failure${suffix}-${Date.now()}.json`;
    writeFileSync(path, `${JSON.stringify({ ...base, outcome: 'failed', failed_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error), matrix_runs_executed: completed.length }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' });
    throw error;
  }
}, 3_600_000);
