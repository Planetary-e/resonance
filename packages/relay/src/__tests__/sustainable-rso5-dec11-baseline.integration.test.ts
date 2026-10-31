import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { runIndependentRso5LabSmoke, type IndependentLabWindow } from '../sustainable-rso5-lab.js';

it('runs DEC-011 full-warmup idle and sustained baseline repetition', async () => {
  const startedAt = new Date().toISOString(), completed: unknown[] = [], manifestPath = 'delivery/results/econ-dec11-baseline-manifest.json';
  const definitions = (JSON.parse(readFileSync(manifestPath, 'utf8')).baseline_windows as any[]).map(window => ({
    ...window, runId: window.run_id, durationMs: window.duration_ms, warmupMs: window.warmup_ms, cooldownMs: window.cooldown_ms,
  })) as IndependentLabWindow[];
  expect(definitions.map(window => window.kind)).toEqual(['idle', 'sustained']);
  expect(definitions.map(window => window.runId)).toEqual(['idle-dec11-baseline', 'sustained-dec11-max-envelope']);
  try {
    for (const window of definitions) {
      const result = await runIndependentRso5LabSmoke({ runId: window.runId, seed: window.seed, scenario: 'full-smoke', manifestPath, window });
      completed.push({ run_id: result.runId, scenario: result.scenario, outcome: result.outcome,
        workers: result.workerCount, clean_stops: result.cleanStops, messages: result.trafficMessages, frame_bytes: result.trafficFrameBytes });
    }
    expect(completed).toHaveLength(2);
    writeFileSync('delivery/results/econ-dec11-baseline-execution.json', `${JSON.stringify({ schema_version: 1,
      authorization_id: 'DEC-011', command: 'node scripts/rso5-dec11-baseline.mjs', started_at: startedAt,
      completed_at: new Date().toISOString(), completed, matrix_runs_executed: 0,
      sustained_windows_executed: true, acceptance_evaluation: 'not_run' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    writeFileSync(`delivery/results/econ-dec11-baseline-failure-${Date.now()}.json`, `${JSON.stringify({ schema_version: 1,
      authorization_id: 'DEC-011', command: 'node scripts/rso5-dec11-baseline.mjs', started_at: startedAt,
      failed_at: new Date().toISOString(), completed, error: error instanceof Error ? error.message : String(error),
      matrix_runs_executed: 0, sustained_windows_executed: false, acceptance_evaluation: 'not_run' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    throw error;
  }
}, 4_500_000);
