import { expect, it } from 'vitest';
import { runIndependentRso5LabSmoke } from '../sustainable-rso5-lab.js';

it('finalizes sustained evidence with bounded single-collection traffic handling', async () => {
  const result = await runIndependentRso5LabSmoke({
    runId: 'dec10-finalization-smoke-v2', seed: '0xE007B010', scenario: 'full-smoke',
    manifestPath: 'delivery/results/econ-production-baseline-manifest-v2.json',
    window: { runId: 'dec10-finalization-smoke-v2', seed: '0xE007B010', kind: 'sustained', durationMs: 1000, warmupMs: 0, cooldownMs: 0 },
  });
  expect(result.outcome).toBe('passed');
  expect(result.cleanStops).toBe(52);
  expect(result.exactTrafficAccounting).toBe(true);
  expect(result.privateLeakageDetected).toBe(false);
}, 300_000);
