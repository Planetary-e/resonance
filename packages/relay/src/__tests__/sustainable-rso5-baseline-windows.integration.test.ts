import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { runIndependentRso5LabSmoke, type IndependentLabWindow } from '../sustainable-rso5-lab.js';

it('runs one continuous 30-minute idle baseline and one continuous 30-minute sustained recovery baseline', async () => {
  const startedAt = new Date().toISOString(), completed: unknown[] = [], manifestPath = 'delivery/results/econ-baseline-windows-manifest-v6.json';
  const runSuffix = randomBytes(8).toString('hex');
  const definitions = (JSON.parse(readFileSync(manifestPath, 'utf8')).baseline_windows as any[]).map(window => ({
    ...window, runId: window.run_id, durationMs: window.duration_ms, warmupMs: window.warmup_ms, cooldownMs: window.cooldown_ms,
  })) as IndependentLabWindow[];
  expect(definitions.map(window => window.kind)).toEqual(['idle', 'sustained']);
  expect(definitions.map(window => window.runId)).toEqual(['idle-baseline-complete', 'sustained-max-envelope-complete']);
  try {
    for (const window of definitions) {
      const runId = `${window.runId}-${runSuffix}`;
      const result = await runIndependentRso5LabSmoke({ runId, seed: window.seed, scenario: 'full-smoke', manifestPath, window: { ...window, runId } });
      completed.push({ run_id: result.runId, scenario: result.scenario, outcome: result.outcome,
        workers: result.workerCount, clean_stops: result.cleanStops, messages: result.trafficMessages, frame_bytes: result.trafficFrameBytes });
    }
    expect(completed).toHaveLength(2);
    const path = `delivery/results/econ-baseline-windows-execution-${runSuffix}.json`;
    writeFileSync(path, `${JSON.stringify({ schema_version: 1, command: 'node scripts/rso5-baseline-windows.mjs',
      started_at: startedAt, completed_at: new Date().toISOString(), completed,
      matrix_runs_executed: 0, sustained_windows_executed: true, acceptance_evaluation: 'not_run' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    const path = `delivery/results/econ-baseline-windows-failure-${Date.now()}.json`;
    writeFileSync(path, `${JSON.stringify({ schema_version: 1, command: 'node scripts/rso5-baseline-windows.mjs',
      started_at: startedAt, failed_at: new Date().toISOString(), completed,
      error: error instanceof Error ? error.message : String(error), matrix_runs_executed: 0,
      sustained_windows_executed: false, acceptance_evaluation: 'not_run' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    throw error;
  }
}, 4_500_000);
