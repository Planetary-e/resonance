import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const base = JSON.parse(readFileSync('delivery/results/econ-lab-manifest.json', 'utf8'));
const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const extra = ['scripts/rso5-dec11-baseline.mjs', 'scripts/rso5-dec11-baseline-manifest.mjs',
  'packages/relay/src/__tests__/sustainable-rso5-dec11-baseline.integration.test.ts'];
const manifest = {
  ...base,
  authorization_id: 'DEC-011',
  created_at: new Date().toISOString(),
  source_hashes: Object.fromEntries([...new Set([...Object.keys(base.source_hashes), ...extra])].map(path => [path, sha256(readFileSync(path))])),
  execution_scope: {
    ...base.execution_scope,
    matrix_status: 'not_executed',
    active_run_id: null,
    active_scenario: null,
    active_seed: null,
    baseline_windows: 'idle-dec11-baseline and sustained-dec11-max-envelope, sequential, no matrix',
    production_evaluation: 'corrected full-warmup diagnostic evidence only; no production or economic acceptance',
  },
  analysis_freeze: {
    ...base.analysis_freeze,
    run_count: 2,
    analysis: 'Require monotonic warmup/baseline/cooldown minima; bounded single-collection finalization without spread append; exact per-role work and request+response/edge reconciliation; preserve every failure',
  },
  baseline_windows: [
    { run_id: 'idle-dec11-baseline', scenario: 'full-smoke', seed: '0xE007B001', kind: 'idle', duration_ms: 1800000, warmup_ms: 60000, cooldown_ms: 60000 },
    { run_id: 'sustained-dec11-max-envelope', scenario: 'full-smoke', seed: '0xE007B002', kind: 'sustained', duration_ms: 1800000, warmup_ms: 60000, cooldown_ms: 60000 },
  ],
};
writeFileSync('delivery/results/econ-dec11-baseline-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log('Wrote delivery/results/econ-dec11-baseline-manifest.json');
