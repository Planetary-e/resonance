/** Explicitly opt-in, frozen loopback cases; never starts on import. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runPrivateScheduleTls, type TlsScheduleCase } from './private-schedule-tls.js';

export async function runFrozenTlsScheduleCases() {
  const cases: TlsScheduleCase[] = ['idle', 'D0', 'D1000', 'D12000'];
  const results: Array<Awaited<ReturnType<typeof runPrivateScheduleTls>> | { case: TlsScheduleCase; error: string; submitted: number; completed: number; failed: number; infiniteLatency: true }> = [];
  for (const name of cases) {
    try { results.push(await runPrivateScheduleTls({ case: name })); }
    catch (error) { results.push({ case: name, error: (error as Error).message, submitted: name === 'idle' ? 0 : 1, completed: 0, failed: name === 'idle' ? 0 : 1, infiniteLatency: true }); }
  }
  return results;
}
async function main() {
  const { values } = parseArgs({ options: { run: { type: 'boolean' }, out: { type: 'string' } }, strict: true });
  if (!values.run || !values.out) throw new Error('Explicit --run --out NEW_REPORT.json required');
  const output = resolve(values.out), root = fileURLToPath(new URL('../../../', import.meta.url));
  const sources = ['packages/eval/src/private-schedule-tls.ts', 'packages/eval/src/run-private-schedule-tls.ts',
    'packages/eval/src/__tests__/private-schedule-tls.test.ts'];
  // Reserve the result destination before any measurement; existing reports are never replaced.
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, '', { flag: 'wx' });
  const report = { generatedAt: new Date().toISOString(), classification: 'tls-loopback-component-only',
    sourceHashes: Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])),
    runtime: { node: process.version, platform: process.platform, architecture: process.arch }, results: await runFrozenTlsScheduleCases() };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report: output, results: report.results.map(row => ({ case: row.case, completed: row.completed, failed: row.failed })) }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
