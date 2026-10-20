/** Offline mathematical screen. Never measures or certifies a volunteer service. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { minimumVolunteerAvailability, serviceAvailabilityFeasibilityScenarios } from './service-availability-feasibility.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({ options: { out: { type: 'string' } }, strict: true });
if (!values.out) throw new Error('Provide --out with a new JSON report path');
const sources = ['packages/eval/src/witness-availability.ts', 'packages/eval/src/service-availability-feasibility.ts',
  'packages/eval/src/run-service-availability-feasibility.ts'];
const report = {
  generatedAt: new Date().toISOString(),
  sourceBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])),
  classification: 'offline-component-feasibility-only',
  k8Status: 'not-qualified',
  ...serviceAvailabilityFeasibilityScenarios(),
  k1Sensitivity: [1, 2].map(requiredCohorts => {
    const assumptions = { requiredCohorts, cohortDependence: 'independent' as const,
      commonOutageFraction: 0, permanentlyWithholdingPerCohort: 0 as const, conditionalOperationSuccess: 0.995 };
    return { assumptions, targetFeasibility: minimumVolunteerAvailability(0.99, assumptions) };
  }),
};
const output = resolve(values.out);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ report: output, classification: report.classification, k8Status: report.k8Status,
  scenarios: report.scenarios.length, points: report.scenarios.flatMap(row => row.points).length }));
