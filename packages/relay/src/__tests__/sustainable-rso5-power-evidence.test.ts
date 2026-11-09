import { expect, it } from 'vitest';
// @ts-expect-error The imported JavaScript module has no declaration file.
import { csvForRun, energyCoverage, integratePower, powerEvidence } from '../../../../scripts/rso5-power-lab.mjs';

const start = '2026-01-01T00:00:00.000Z';
const startMs = Date.parse(start);
const end = (durationMs: number) => new Date(startMs + durationMs).toISOString();
const sample = (offsetMs: number, combinedMw = 1000) => ({
  at: new Date(startMs + offsetMs).toISOString(), atMs: startMs + offsetMs,
  cpu_mw: combinedMw, gpu_mw: 0, ane_mw: 0, combined_mw: combinedMw,
});
const run = (durationMs: number) => ({
  run_id: 'offline-fixture', scenario: 'offline-fixture', kind: 'idle',
  started_at: start, completed_at: end(durationMs),
});

it('accepts a first sample just within 1 second and censors one just over 1 second', () => {
  const within = integratePower([sample(999), sample(1500), sample(2000)], start, end(2000));
  expect(within.validity).toBe('valid');
  expect(within.censored).toEqual([]);
  expect(within.retained_seconds).toBe(1.001);
  expect(within.coverage_ratio).toBe(1.001 / 2);

  const over = integratePower([sample(1001), sample(1500), sample(2000)], start, end(2000));
  expect(over.validity).toBe('partial');
  expect(over.censored).toEqual([{ start, reason: 'no initial sample within 1 second' }]);
  expect(over.retained_seconds).toBe(0.999);
  expect(over.coverage_ratio).toBe(0.999 / 2);
});

it('censors genuine gaps and integrates only retained subintervals', () => {
  const result = integratePower([
    sample(0, 1000), sample(1000, 1000), sample(2600, 3000), sample(3600, 3000),
  ], start, end(3600));

  expect(result.censored).toEqual([{
    start: end(1000), end: end(2600), reason: 'sampling gap exceeds 1.5 seconds',
  }]);
  expect(result.energy_joules).toBe(4);
  expect(result.energy_kwh).toBe(4 / 3600000);
  expect(result.average_power_watts).toBe(2);
  expect(result.retained_seconds).toBe(2);
  expect(result.coverage_ratio).toBe(2 / 3.6);
  expect(result.censored_interval_count).toBe(1);
});

it('retains legitimate final censor behavior', () => {
  const result = integratePower([sample(0), sample(1000), sample(1900)], start, end(3000));

  expect(result.censored).toEqual([{ end: end(3000), reason: 'no final sample within 1 second' }]);
  expect(result.validity).toBe('partial');
  expect(result.energy_joules).toBe(1.9);
  expect(result.retained_seconds).toBe(1.9);
  expect(result.coverage_ratio).toBe(1.9 / 3);
});

it('emits every ISO-timestamped actual sample and censor row to CSV', () => {
  const evidence = powerEvidence(run(3000), [sample(8, 1100), sample(1008, 1200), sample(1900, 1300)]);
  const csv = csvForRun(evidence.run_id, evidence.samples, evidence.censored_samples);

  expect(evidence.samples.every((entry: { atMs?: number }) => entry.atMs === undefined)).toBe(true);
  expect(csv.trimEnd().split('\n')).toEqual([
    'at,cpu_mw,gpu_mw,ane_mw,combined_mw,status',
    '2026-01-01T00:00:00.008Z,1100,0,0,1100,sample',
    '2026-01-01T00:00:01.008Z,1200,0,0,1200,sample',
    '2026-01-01T00:00:01.900Z,1300,0,0,1300,sample',
    '2026-01-01T00:00:03.000Z,,,,,no final sample within 1 second',
  ]);
});

it('preserves trapezoidal energy arithmetic and exposes per-run decision coverage', () => {
  const evidence = powerEvidence(run(2000), [sample(0, 1000), sample(1000, 2000), sample(2000, 1000)]);

  expect(evidence.energy_joules).toBe(3);
  expect(evidence.energy_kwh).toBe(3 / 3600000);
  expect(evidence.average_power_watts).toBe(1.5);
  expect(evidence.peak_power_watts).toBe(2);
  expect(evidence.retained_seconds).toBe(2);
  expect(evidence.coverage_ratio).toBe(1);
  expect(energyCoverage(evidence)).toEqual({
    status: 'valid', retained_seconds: 2, coverage_ratio: 1, duration_ms: 2000,
    sample_count: 3, censored_interval_count: 0,
  });
});
