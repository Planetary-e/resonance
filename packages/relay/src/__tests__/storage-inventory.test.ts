import { afterEach, expect, it, vi } from 'vitest';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as promises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureStorageDirectories } from '../storage-inventory.js';
import { runAdmissionHistoryCommand } from '../admission-history-command.js';
vi.mock('node:fs/promises', async original => { const fs = await original<typeof import('node:fs/promises')>(); return { ...fs, lstat: vi.fn(fs.lstat), opendir: vi.fn(fs.opendir) }; });
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() { const directory = realpathSync(mkdtempSync(join(tmpdir(), 'storage-inventory-'))); directories.push(directory); return directory; }

it('counts manifests, staging and payload files across roots without double-counting overlap or hard links', async () => {
  const directory = fixture(), a = join(directory, 'owner'), b = join(directory, 'workspace'), nested = join(a, 'payloads');
  mkdirSync(nested, { recursive: true }); mkdirSync(b);
  const manifest = join(a, 'manifest.json'), payload = join(nested, 'payload.block'), temporary = join(b, '.pending.tmp');
  writeFileSync(manifest, 'secret metadata'); writeFileSync(payload, Buffer.alloc(3000)); writeFileSync(temporary, Buffer.alloc(37));
  linkSync(payload, join(b, 'linked.block'));
  const result = await measureStorageDirectories([a, nested, b, a]);
  expect(result).toMatchObject({ scannedRoots: 2, directories: 3, files: 3, logicalBytes: 3052, atomicSnapshot: false, enforcesQuota: false });
  const blocks = [a, b, nested, manifest, payload, temporary].map(path => lstatSync(path).blocks);
  expect(result.allocatedBytes).toBe(blocks.every(n => n >= 0) ? blocks.reduce((sum, n) => sum + n * 512, 0) : null);
  expect(JSON.stringify(result)).not.toContain(directory); expect(JSON.stringify(result)).not.toContain('secret');
  const command = await runAdmissionHistoryCommand('storage-inventory', [a, b]); expect(command.result.logicalBytes).toBe(result.logicalBytes);
});

it('refuses missing roots and symbolic descendants instead of treating unavailable storage as zero', async () => {
  const directory = fixture(), file = join(directory, 'file'); writeFileSync(file, 'retained');
  await expect(measureStorageDirectories([join(directory, 'missing')])).rejects.toThrow('unavailable');
  await expect(measureStorageDirectories([file])).rejects.toThrow('existing directories');
  await expect(measureStorageDirectories([])).rejects.toThrow('one and 128');
  await expect(measureStorageDirectories(['relative'])).rejects.toThrow('absolute');
  if (process.platform !== 'win32') {
    symlinkSync(directory, join(directory, 'loop'));
    await expect(measureStorageDirectories([directory])).rejects.toThrow('links and special');
  }
});

it('bounds enumeration and depth and cooperatively cancels a scan without touching retained files', async () => {
  const directory = fixture(), nested = join(directory, 'child'); mkdirSync(nested); writeFileSync(join(nested, 'retained'), 'unchanged');
  await expect(measureStorageDirectories([directory], { maximumEntries: 1 })).rejects.toThrow('bounds');
  await expect(measureStorageDirectories([directory], { maximumDepth: 0 })).rejects.toThrow('bounds');
  const controller = new AbortController(), operation = measureStorageDirectories([directory], { signal: controller.signal }); controller.abort();
  await expect(operation).rejects.toThrow();
  await expect(measureStorageDirectories([directory], { signal: controller.signal })).rejects.toThrow();
  expect(lstatSync(join(nested, 'retained')).size).toBe(9);
});

it('rejects file changes and unreadable metadata with aggregate errors that omit filenames', async () => {
  const directory = fixture(), file = join(directory, 'private-file-name'); writeFileSync(file, 'original');
  let reads = 0;
  vi.mocked(promises.lstat).mockImplementation(async (...args: Parameters<typeof actual.lstat>) => {
    if (String(args[0]) === file && ++reads === 2) writeFileSync(file, 'different size');
    return actual.lstat(...args);
  });
  await expect(measureStorageDirectories([directory])).rejects.toThrow('changed');
  vi.mocked(promises.lstat).mockImplementation(async (...args: Parameters<typeof actual.lstat>) => {
    if (String(args[0]) === file) throw Object.assign(new Error(file), { code: 'EACCES' });
    return actual.lstat(...args);
  });
  const error = await measureStorageDirectories([directory]).catch(error => error as Error);
  expect(error).toBeInstanceOf(Error); if (!(error instanceof Error)) throw new Error('Expected unavailable inventory');
  expect(error.message).toContain('unavailable'); expect(error.message).not.toContain('private-file-name');
});


it('counts exact output files and hard-link aliases without scanning their unrelated parent', async () => {
  const directory = fixture(), runtime = join(directory, 'runtime'), nested = join(runtime, 'same-file'), output = join(directory, 'export.json');
  mkdirSync(runtime); writeFileSync(nested, 'abc'); writeFileSync(output, 'output');
  const alias = join(directory, 'export-alias'); linkSync(output, alias); writeFileSync(join(directory, 'unselected-secrets'), Buffer.alloc(1000000));
  const result = await measureStorageDirectories([runtime], { files: [output, alias, nested, output] });
  expect(result).toMatchObject({ selectedFiles: 3, scannedRoots: 1, files: 2, logicalBytes: 9 });
  const command = await runAdmissionHistoryCommand('storage-inventory', [runtime, '--file', output, '--file', alias]);
  expect(command.result).toMatchObject({ selectedFiles: 2, files: 2, logicalBytes: 9 });
  expect(JSON.stringify(result)).not.toContain('export'); expect(JSON.stringify(result)).not.toContain(directory);
});
it('refuses missing or linked explicit files, unknown CLI options and excess selections', async () => {
  const directory = fixture(), runtime = join(directory, 'runtime'), file = join(directory, 'file'); mkdirSync(runtime); writeFileSync(file, 'known');
  await expect(measureStorageDirectories([runtime], { files: [join(directory, 'missing')] })).rejects.toThrow(/unavailable/);
  await expect(measureStorageDirectories([runtime], { files: [runtime] })).rejects.toThrow(/ordinary existing files/);
  await expect(measureStorageDirectories([runtime], { files: Array(129).fill(file) })).rejects.toThrow(/128/);
  await expect(measureStorageDirectories([runtime], { files: [file], maximumEntries: 1 })).rejects.toThrow(/bounds/);
  await expect(runAdmissionHistoryCommand('storage-inventory', [runtime, '--file'])).rejects.toThrow(/needs one explicit path/);
  await expect(runAdmissionHistoryCommand('storage-inventory', [runtime, '--unknown', file])).rejects.toThrow(/Unknown/);
  if (process.platform !== 'win32') {
    const alias = join(directory, 'alias'); symlinkSync(file, alias);
    await expect(measureStorageDirectories([runtime], { files: [alias] })).rejects.toThrow(/ordinary existing files/);
  }
});


it('never traverses a selected output that is replaced with a directory during the scan', async () => {
  const directory = fixture(), runtime = join(directory, 'runtime'), file = join(directory, 'export'); mkdirSync(runtime); writeFileSync(file, 'output');
  let reads = 0; vi.mocked(promises.opendir).mockClear();
  vi.mocked(promises.lstat).mockImplementation(async (...args: Parameters<typeof actual.lstat>) => {
    if (String(args[0]) === file && ++reads === 2) { rmSync(file); mkdirSync(file); writeFileSync(join(file, 'not-selected'), 'private'); }
    return actual.lstat(...args);
  });
  await expect(measureStorageDirectories([runtime], { files: [file] })).rejects.toThrow(/Explicit storage file changed/);
  expect(vi.mocked(promises.opendir).mock.calls.some(args => String(args[0]) === file)).toBe(false);
});
