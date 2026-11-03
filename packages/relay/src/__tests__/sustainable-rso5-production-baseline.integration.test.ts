import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { runIndependentRso5LabSmoke, type IndependentLabWindow } from '../sustainable-rso5-lab.js';

it('runs corrected continuous idle and sustained production-evaluation baselines', async () => {
  const startedAt = new Date().toISOString(), completed: unknown[] = [], manifestPath = 'delivery/results/econ-production-baseline-manifest-v2.json';
  const runSuffix = randomBytes(8).toString('hex');
  const definitions = (JSON.parse(readFileSync(manifestPath, 'utf8')).baseline_windows as any[]).map(window => ({
    ...window, runId: window.run_id, durationMs: window.duration_ms, warmupMs: window.warmup_ms, cooldownMs: window.cooldown_ms,
  })) as IndependentLabWindow[];
  expect(definitions.map(window => window.kind)).toEqual(['idle', 'sustained']);
  expect(definitions.map(window => window.runId)).toEqual(['idle-production-baseline-v2', 'sustained-production-max-envelope-v2']);
  try {
    for (const window of definitions) {
      const runId = `${window.runId}-${runSuffix}`;
      const result = await runIndependentRso5LabSmoke({ runId, seed: window.seed, scenario: 'full-smoke', manifestPath, window: { ...window, runId } });
      completed.push({ run_id: result.runId, scenario: result.scenario, outcome: result.outcome,
        workers: result.workerCount, clean_stops: result.cleanStops, messages: result.trafficMessages, frame_bytes: result.trafficFrameBytes });
    }
    expect(completed).toHaveLength(2);
    writeFileSync(`delivery/results/econ-production-baseline-execution-${runSuffix}.json`, `${JSON.stringify({ schema_version: 1,
      authorization_id: 'DEC-010', command: 'node scripts/rso5-production-baseline.mjs', started_at: startedAt,
      completed_at: new Date().toISOString(), completed, matrix_runs_executed: 0,
      sustained_windows_executed: true, acceptance_evaluation: 'not_run' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    writeFileSync(`delivery/results/econ-production-baseline-failure-${Date.now()}.json`, `${JSON.stringify({ schema_version: 1,
      authorization_id: 'DEC-010', command: 'node scripts/rso5-production-baseline.mjs', started_at: startedAt,
      failed_at: new Date().toISOString(), completed, error: error instanceof Error ? error.message : String(error),
      matrix_runs_executed: 0, sustained_windows_executed: false, acceptance_evaluation: 'not_run' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    throw error;
  }
}, 4_500_000);
