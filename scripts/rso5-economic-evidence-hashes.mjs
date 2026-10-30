import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2), index = args.indexOf('--run-id'), runId = index >= 0 ? args[index + 1] : undefined;
if (!runId || !/^[a-z][a-z0-9-]+$/.test(runId)) throw new Error('Use --run-id <reproduction identity>');
const paths = [
  `delivery/results/econ-lab-manifest-${runId}.json`,
  `delivery/results/econ-lab-summary-${runId}.json`,
  `delivery/results/econ-process-${runId}.json`,
  `delivery/results/econ-disk-${runId}.json`,
  `delivery/results/econ-network-${runId}.json`,
  `delivery/results/econ-work-${runId}.json`,
  `delivery/results/econ-power-${runId}.json`,
  `delivery/results/econ-power-${runId}.csv`,
  `delivery/results/econ-cleanup-${runId}.json`,
  `delivery/results/econ-authorization-${runId}.json`,
  `delivery/results/econ-owner-assumptions-${runId}.json`,
  `delivery/results/econ-decision-${runId}.json`,
  'delivery/results/econ-matrix-driver-final-smoke.json',
  'delivery/results/econ-lab-manifest.json',
  'delivery/results/econ-lab-attempts.json',
  'docs/evals/v04-recovery-economic-evidence-2026-10-28.md',
];
const hashes = Object.fromEntries(paths.map(path => [path, `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`]));
const output = `delivery/results/econ-evidence-hashes-${runId}${args.includes('--review-final') ? '-review-final' : args.includes('--final') ? '-final' : ''}.json`;
writeFileSync(output, `${JSON.stringify({ schema_version: 1, run_id: runId, hashes }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(`Wrote ${output}`);
for (const [path, hash] of Object.entries(hashes)) console.log(`${hash}  ${path}`);
