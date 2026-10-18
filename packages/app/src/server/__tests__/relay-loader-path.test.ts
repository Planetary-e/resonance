import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { linuxServiceUnit, macServicePlist, relayServiceRuntime, windowsServiceScript } from '../relay-supervisor.js';

afterEach(() => { vi.unstubAllEnvs(); });
it('resolves the source loader to a file URL instead of passing a drive-letter path to Node import', () => {
  vi.stubEnv('RESONANCE_RELAY_ENTRY', join(tmpdir(), 'source main.ts'));
  const runtime = relayServiceRuntime();
  expect(new URL(runtime.tsxImportPath!).protocol).toBe('file:'); expect(runtime.tsxImportPath).toContain('/tsx/');
});
it('escapes spaces, hashes and percent signs in legacy absolute loader paths in every native service format', () => {
  const directory = join(tmpdir(), 'relay # 100%'), loader = join(directory, 'loader #1.mjs'), uri = pathToFileURL(loader).href;
  const options = { port: 9091, dataDir: directory, adminKey: 'fixture', contacts: [], nodePath: process.execPath,
    entryPath: join(directory, 'main.ts'), workingDirectory: directory, tsxImportPath: loader };
  expect(uri).toContain('%23'); expect(uri).toContain('%25');
  expect(macServicePlist(options)).toContain(`<string>${uri}</string>`);
  expect(linuxServiceUnit(options)).toContain(uri.replaceAll('%', '%%'));
  expect(windowsServiceScript(options)).toContain(`'${uri}'`);
  expect(windowsServiceScript({ ...options, tsxImportPath: uri })).toContain(`'${uri}'`);
  expect(windowsServiceScript({ ...options, entryPath: join(directory, 'main.mjs') })).not.toContain('--import');
});
