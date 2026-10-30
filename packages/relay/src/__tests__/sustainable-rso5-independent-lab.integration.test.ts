import { expect, it } from 'vitest';
import { runIndependentRso5LabSmoke } from '../sustainable-rso5-lab.js';

it('runs one independent-process RSO5 laboratory smoke lifecycle', async () => {
  const result = await runIndependentRso5LabSmoke({ runId: 'reproduction-16', seed: '0xE0075A16', scenario: 'full-smoke' });
  expect(result).toMatchObject({
    runId: 'reproduction-16',
    scenario: 'full-smoke',
    outcome: 'passed',
    runtimeCount: 8,
    replicaCount: 40,
    observerCount: 4,
    workerCount: 52,
    cleanStops: 52,
    exactTrafficAccounting: true,
    privateLeakageDetected: false,
  });
  expect(result.logicalCopyAudits).toBeGreaterThan(0);
  expect(result.recoveredProofs).toBeGreaterThan(0);
}, 900_000);
