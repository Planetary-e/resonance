import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it('imports and serves the actual desktop API with native addons disabled, requiring HNSW only on explicit use', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'no-native-desktop-'));
  try {
    const result = await promisify(execFile)(process.execPath, ['--no-addons', '--import', import.meta.resolve('tsx'),
      fileURLToPath(new URL('./fixtures/native-import-boundary.ts', import.meta.url))], {
      env: { ...process.env, RESONANCE_DATA_DIR: directory }, timeout: 15000,
    });
    expect(result.stdout).toContain('desktop-started-without-native-addons');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 20000);
