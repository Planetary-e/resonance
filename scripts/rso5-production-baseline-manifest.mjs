import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const base = JSON.parse(readFileSync('delivery/results/econ-lab-manifest.json', 'utf8'));
const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const extra = ['scripts/rso5-production-baseline.mjs', 'scripts/rso5-production-baseline-manifest.mjs',
  'packages/relay/src/__tests__/sustainable-rso5-production-baseline.integration.test.ts'];
const v2 = process.argv.includes('--v2'), suffix = v2 ? '-v2' : '';
const output = v2 ? 'delivery/results/econ-production-baseline-manifest-v2.json' : 'delivery/results/econ-production-baseline-manifest.json';
const manifest = {
  ...base,
  authorization_id: 'DEC-010',
  created_at: new Date().toISOString(),
  source_hashes: Object.fromEntries([...new Set([...Object.keys(base.source_hashes), ...extra])].map(path => [path, sha256(readFileSync(path))])),
  execution_scope: {
    ...base.execution_scope,
    matrix_status: 'not_executed',
    active_run_id: null,
    active_scenario: null,
    active_seed: null,
    baseline_windows: `idle-production-baseline${suffix} and sustained-production-max-envelope${suffix}, sequential, no matrix`,
    production_evaluation: 'diagnostic evidence only; no production or economic acceptance',
  },
  analysis_freeze: {
    ...base.analysis_freeze,
    run_count: 2,
    analysis: 'Monotonic minimum phase durations; bounded single-collection finalization without spread append; exact per-role work and request+response/edge reconciliation; preserve every failure',
  },
  baseline_windows: [
    { run_id: `idle-production-baseline${suffix}`, scenario: 'full-smoke', seed: '0xE007B001', kind: 'idle', duration_ms: 1800000, warmup_ms: 60000, cooldown_ms: 60000 },
    { run_id: `sustained-production-max-envelope${suffix}`, scenario: 'full-smoke', seed: '0xE007B002', kind: 'sustained', duration_ms: 1800000, warmup_ms: 60000, cooldown_ms: 60000 },
  ],
};
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(`Wrote ${output}`);
