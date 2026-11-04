import { spawnSync } from 'node:child_process';

const selectionOnly = process.argv.includes('--select-only');
const retryArgument = process.argv.find(argument => argument.startsWith('--retry='));
const retry = retryArgument ? Number(retryArgument.slice('--retry='.length)) : 0;
if (!Number.isSafeInteger(retry) || retry < 0) throw new Error('Invalid matrix retry');
const startArgument = process.argv.find(argument => argument.startsWith('--start-index='));
const startIndex = startArgument ? Number(startArgument.slice('--start-index='.length)) : 0;
if (!Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex > 19) throw new Error('Invalid matrix start index');
const previousArgument = process.argv.find(argument => argument.startsWith('--previous='));
const previous = previousArgument ? previousArgument.slice('--previous='.length) : '';
const test = selectionOnly
  ? 'packages/relay/src/__tests__/sustainable-rso5-matrix-driver.integration.test.ts'
  : 'packages/relay/src/__tests__/sustainable-rso5-matrix-execution.integration.test.ts';
const result = spawnSync('./node_modules/.bin/vitest', ['run', test, '--maxWorkers=1'], {
  cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, RSO5_MATRIX_RETRY: String(retry),
    RSO5_MATRIX_START_INDEX: String(startIndex), RSO5_MATRIX_PREVIOUS: previous,
    RSO5_MATRIX_IDENTITY_PREFIX: process.env.RSO5_MATRIX_IDENTITY_PREFIX ?? 'unified' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
