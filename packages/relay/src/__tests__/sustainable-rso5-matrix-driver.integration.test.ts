import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { driveIndependentRso5Matrix } from '../sustainable-rso5-lab.js';

it('validates frozen matrix order, scenarios and isolated artifact identities without executing runs', async () => {
  const selected = await driveIndependentRso5Matrix({ execute: false });
  expect(selected).toHaveLength(20);
  expect(new Set(selected.map(run => run.scenario))).toEqual(new Set(['cold', 'returning', 'local-loss', 'new-view']));
  expect(new Set(selected.map(run => run.runId)).size).toBe(20);
  expect(new Set(selected.map(run => run.seed)).size).toBe(20);
  expect(new Set(selected.map(run => run.manifestPath)).size).toBe(20);
  expect(selected.map(run => run.orderIndex)).toEqual(Array.from({ length: 20 }, (_, index) => index));
  expect(selected.filter(run => run.scenario === 'new-view').every(run => run.readiness === 'post-newView-startup')).toBe(true);
  expect(selected.every(run => run.executionRunId === `matrix-${run.runId}`)).toBe(true);
  expect(new Set(selected.map(run => run.executionRunId)).size).toBe(20);
  expect(new Set(selected.map(run => run.executionManifestPath)).size).toBe(20);
  expect(selected.every(run => !['reproduction-02', 'reproduction-16'].includes(run.executionRunId))).toBe(true);
  const manifest = JSON.parse(readFileSync('delivery/results/econ-lab-manifest.json', 'utf8'));
  expect(manifest.randomness).toMatchObject({ source: 'node:crypto.randomBytes', deterministic: false,
    exact_business_replay: false, seed_retrofit_forbidden: true, discard_draws_forbidden: true });
  expect(manifest.analysis_freeze.post_result_changes_forbidden).toBe(true);
  const path = `delivery/results/econ-matrix-execution-plan-${randomBytes(8).toString('hex')}.json`;
  writeFileSync(path, `${JSON.stringify({ schema_version: 1, outcome: 'passed_execution_path_selection', matrix_runs_executed: 0,
    entrypoint: 'driveIndependentRso5Matrix({execute:true,independentReviewApproved:true})',
    execution_guard: 'independentReviewApproved required for execution', scenarios: [...new Set(selected.map(run => run.scenario))].sort(),
    randomness: manifest.randomness, analysis_freeze: manifest.analysis_freeze,
    scenario_readiness: manifest.scenario_readiness, runs: selected }, null, 2)}\n`,
  { mode: 0o600, flag: 'wx' });
}, 30_000);
