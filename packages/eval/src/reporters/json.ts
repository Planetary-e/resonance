import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { BenchmarkResult, EvalReport } from '@resonance/core';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function writeJsonReport(results: BenchmarkResult[]): string {
  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    platform: {
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    },
    results,
  };

  const resultsDir = join(__dirname, '../../results');
  mkdirSync(resultsDir, { recursive: true });

  const filename = `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const filepath = join(resultsDir, filename);

  writeFileSync(filepath, JSON.stringify(report, null, 2));
  return filepath;
}
