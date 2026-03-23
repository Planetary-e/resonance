import Table from 'cli-table3';
import type { BenchmarkResult } from '@resonance/core';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

export function printResults(results: BenchmarkResult[]): void {
  console.log(`\n${BOLD}=== Evaluation Results ===${RESET}\n`);

  const table = new Table({
    head: ['Metric', 'Target', 'Actual', 'Status'],
    colWidths: [35, 15, 35, 10],
    style: { head: [], border: [] },
  });

  for (const r of results) {
    const status = r.target === 'info'
      ? `${YELLOW}INFO${RESET}`
      : r.passed
        ? `${GREEN}PASS${RESET}`
        : `${RED}FAIL${RESET}`;

    table.push([r.name, r.target, r.actual, status]);
  }

  console.log(table.toString());

  // Summary
  const testable = results.filter(r => r.target !== 'info');
  const passed = testable.filter(r => r.passed).length;
  const total = testable.length;
  const allPassed = passed === total;

  console.log(`\n${BOLD}Summary:${RESET} ${passed}/${total} metrics passed ${allPassed ? GREEN + '✓' : RED + '✗'}${RESET}\n`);
}
