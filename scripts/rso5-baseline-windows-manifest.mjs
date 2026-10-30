import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const base = JSON.parse(readFileSync('delivery/results/econ-lab-manifest.json', 'utf8'));
const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const extra = ['scripts/rso5-baseline-windows.mjs', 'scripts/rso5-baseline-windows-manifest.mjs',
  'packages/relay/src/__tests__/sustainable-rso5-baseline-windows.integration.test.ts'];
const manifest = {
  ...base,
  created_at: new Date().toISOString(),
  source_hashes: Object.fromEntries([...new Set([...Object.keys(base.source_hashes), ...extra])].map(path => [path, sha256(readFileSync(path))])),
  execution_scope: {
    ...base.execution_scope,
    matrix_status: 'not_executed',
    active_run_id: null,
    active_scenario: null,
    active_seed: null,
    baseline_windows: 'idle-baseline-complete and sustained-max-envelope-complete, sequential, no matrix',
  },
  baseline_windows: [
    { run_id: 'idle-baseline-complete', scenario: 'full-smoke', seed: '0xE007B001', kind: 'idle', duration_ms: 1800000, warmup_ms: 60000, cooldown_ms: 60000 },
    { run_id: 'sustained-max-envelope-complete', scenario: 'full-smoke', seed: '0xE007B002', kind: 'sustained', duration_ms: 1800000, warmup_ms: 60000, cooldown_ms: 60000 },
  ],
};
const output = process.argv.includes('--v6') ? 'delivery/results/econ-baseline-windows-manifest-v6.json'
  : process.argv.includes('--v5') ? 'delivery/results/econ-baseline-windows-manifest-v5.json'
  : process.argv.includes('--v4') ? 'delivery/results/econ-baseline-windows-manifest-v4.json'
  : process.argv.includes('--v3') ? 'delivery/results/econ-baseline-windows-manifest-v3.json'
  : process.argv.includes('--v2') ? 'delivery/results/econ-baseline-windows-manifest-v2.json' : 'delivery/results/econ-baseline-windows-manifest.json';
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(`Wrote ${output}`);
