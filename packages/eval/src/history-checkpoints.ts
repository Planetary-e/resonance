/** Offline evaluation; never reads or restores any real admission history. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { historyCheckpointReport } from './history-checkpoint-model.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({ options: { out: { type: 'string', default: 'docs/evals/history-checkpoints-2026-10-04.json' } } });
const sources = ['packages/eval/src/history-checkpoint-model.ts', 'packages/eval/src/history-checkpoints.ts'];
const report = {
  generatedAt: new Date().toISOString(),
  sourceBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  worktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceSha256: Object.fromEntries(sources.map(path => [path, createHash('sha256')
    .update(readFileSync(resolve(root, path))).digest('hex')])),
  ...historyCheckpointReport(),
};
const output = resolve(root, values.out!);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: output, intersections: report.intersections,
  readRepair: report.readRepair, generationFreeze: report.generationFreeze }, null, 2));
