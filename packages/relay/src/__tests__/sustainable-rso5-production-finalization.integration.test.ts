import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { runIndependentRso5LabSmoke } from '../sustainable-rso5-lab.js';

it('finalizes sustained evidence with bounded single-collection traffic handling', async () => {
  const runId = `dec10-finalization-smoke-v2-${randomBytes(8).toString('hex')}`;
  const result = await runIndependentRso5LabSmoke({
    runId, seed: '0xE007B010', scenario: 'full-smoke',
    manifestPath: 'delivery/results/econ-production-baseline-manifest-v2.json',
    window: { runId, seed: '0xE007B010', kind: 'sustained', durationMs: 1000, warmupMs: 0, cooldownMs: 0 },
  });
  expect(result.outcome).toBe('passed');
  expect(result.cleanStops).toBe(52);
  expect(result.exactTrafficAccounting).toBe(true);
  expect(result.privateLeakageDetected).toBe(false);
}, 300_000);
