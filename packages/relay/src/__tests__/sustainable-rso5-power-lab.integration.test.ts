import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { runIndependentRso5LabSmoke, type IndependentLabScenario, type IndependentLabWindow } from '../sustainable-rso5-lab.js';

it('runs the frozen DEC-013 full power laboratory with matched idle windows', async () => {
  const manifestPath = 'delivery/results/econ-power-lab-manifest.json';
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  expect(manifest.authorization_id).toBe('DEC-013');
  expect(manifest.execution_scope.full_runs_status).toBe('pending');
  const startedAt = new Date().toISOString(), completed: unknown[] = [];
  const writeExecution = (status: string, error?: unknown) => {
    writeFileSync('delivery/results/econ-power-lab-execution.json', `${JSON.stringify({ schema_version: 1,
      authorization_id: 'DEC-013', command: 'sudo node scripts/rso5-power-lab.mjs --full', status,
      started_at: startedAt, recorded_at: new Date().toISOString(), completed,
      error: error instanceof Error ? error.message : error ?? null, matrix_runs_executed: status === 'complete' ? 20 : completed.length,
      sustained_windows_executed: status === 'complete', acceptance_evaluation: 'not_run' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  };
  const run = async (runId: string, seed: string, scenario: IndependentLabScenario, window?: IndependentLabWindow) => {
    const started = new Date().toISOString();
    try {
      const result = await runIndependentRso5LabSmoke({ runId, seed, scenario, manifestPath, window });
      const row = { run_id: runId, scenario, kind: window?.kind ?? 'scenario', seed, started_at: started,
        completed_at: new Date().toISOString(), outcome: result.outcome, workers: result.workerCount,
        clean_stops: result.cleanStops, messages: result.trafficMessages, frame_bytes: result.trafficFrameBytes };
      completed.push(row);
      return row;
    } catch (error) {
      completed.push({ run_id: runId, scenario, kind: window?.kind ?? 'scenario', seed, started_at: started,
        completed_at: new Date().toISOString(), outcome: 'failed', workers: 52, clean_stops: null,
        messages: null, frame_bytes: null, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
  try {
    for (const scenarioRun of manifest.power_scenarios) {
      await run(scenarioRun.pre_idle.run_id, scenarioRun.pre_idle.seed, 'full-smoke', scenarioRun.pre_idle.window);
      await run(scenarioRun.run.run_id, scenarioRun.run.seed, scenarioRun.run.scenario);
      await run(scenarioRun.post_idle.run_id, scenarioRun.post_idle.seed, 'full-smoke', scenarioRun.post_idle.window);
    }
    for (const baseline of manifest.baseline_windows) await run(baseline.run_id, baseline.seed, 'full-smoke', baseline.window);
    writeExecution('complete');
  } catch (error) {
    writeExecution('failed', error);
    throw error;
  }
}, 21_600_000);
