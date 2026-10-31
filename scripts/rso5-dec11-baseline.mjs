import { spawnSync } from 'node:child_process';

const result = spawnSync('./node_modules/.bin/vitest', [
  'run', 'packages/relay/src/__tests__/sustainable-rso5-dec11-baseline.integration.test.ts', '--maxWorkers=1',
], { cwd: process.cwd(), stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
