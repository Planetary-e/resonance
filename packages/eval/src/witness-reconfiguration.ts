/** Offline, bounded membership analysis. Does not contact or change any relay. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { membershipReport } from './witness-membership.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({ options: { out: { type: 'string', default: 'docs/evals/witness-reconfiguration-2026-10-01.json' } } });
const sources = ['packages/eval/src/witness-membership.ts', 'packages/eval/src/witness-reconfiguration.ts'];
const report = {
  generatedAt: new Date().toISOString(),
  sourceBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  worktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceSha256: Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])),
  ...membershipReport(),
};
const output = resolve(root, values.out!);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: output, pairsChecked: report.replacements.reduce((sum, row) => sum + row.comparedPairs, 0),
  results: report.replacements.map(({ replaced, minimumIntersection, unsafePairs }) => ({ replaced, minimumIntersection, unsafePairs })) }, null, 2));
