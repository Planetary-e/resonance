import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { runIndependentRso5LabSmoke } from '../sustainable-rso5-lab.js';

it('awaits configured warmup and finalizes complete DEC-011 evidence', async () => {
  const runId = `dec11-finalization-smoke-${randomBytes(8).toString('hex')}`;
  const result = await runIndependentRso5LabSmoke({
    runId, seed: '0xE007B011', scenario: 'full-smoke', manifestPath: 'delivery/results/econ-dec11-baseline-manifest.json',
    window: { runId, seed: '0xE007B011', kind: 'sustained', durationMs: 1000, warmupMs: 100, cooldownMs: 100 },
  });
  expect(result.outcome).toBe('passed');
  expect(result.cleanStops).toBe(52);
  expect(result.exactTrafficAccounting).toBe(true);
  const summary = JSON.parse(readFileSync(`delivery/results/econ-lab-summary-${runId}.json`, 'utf8'));
  const [warmup, baseline] = summary.window.phases;
  expect(baseline.monotonic_ms - warmup.monotonic_ms).toBeGreaterThanOrEqual(100);
  const process = JSON.parse(readFileSync(`delivery/results/econ-process-${runId}.json`, 'utf8'));
  expect(process.authorization_id).toBe('DEC-011');
}, 300_000);
