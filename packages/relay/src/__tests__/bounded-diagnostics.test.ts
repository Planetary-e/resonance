import { afterEach, expect, it, vi } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DIAGNOSTIC_FILE_BYTES, openBoundedDiagnostics } from '../bounded-diagnostics.js';
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs, writeSync: vi.fn(fs.writeSync) }; });
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.mocked(writeSync).mockImplementation(actualFs.writeSync); for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'resonance-diagnostics-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, logs: join(directory, 'relay-diagnostics') };
}
function open(directory: string, maximum = 512) { const log = openBoundedDiagnostics(directory, maximum); cleanup.push(log.close); return log; }
it('rotates two bounded diagnostic files, preserves recent records and resumes after an incomplete final line', () => {
  const n = fixture(); let log = open(n.logs);
  for (let index = 0; index < 100; index++) log.write(JSON.stringify({ index, event: 'bounded', detail: 'x'.repeat(60) }));
  log.close();
  const names = readdirSync(n.logs).sort(); expect(names).toEqual(['current.ndjson', 'previous.ndjson']);
  expect(names.reduce((sum, name) => sum + statSync(join(n.logs, name)).size, 0)).toBeLessThanOrEqual(1024);
  const current = join(n.logs, 'current.ndjson'); expect(readFileSync(current, 'utf8')).toContain('"index":99');
  writeFileSync(current, 'partial', { flag: 'a' });
  log = open(n.logs); log.write(JSON.stringify({ event: 'after-reopen' }));
  expect(log.status()).toEqual({ available: true, maximumBytes: 1024, droppedRecords: 0 });
  expect(readFileSync(current, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).at(-1)).toEqual({ event: 'after-reopen' });
});
it('drops oversized diagnostic contents and reports disk-write failure without throwing into protocol code', () => {
  const n = fixture(), log = open(n.logs);
  log.write('private oversized payload '.repeat(100));
  expect(readFileSync(join(n.logs, 'current.ndjson'), 'utf8')).toContain('diagnostic_record_dropped');
  expect(readFileSync(join(n.logs, 'current.ndjson'), 'utf8')).not.toContain('private oversized');
  vi.mocked(writeSync).mockImplementationOnce(() => 0);
  expect(() => log.write('{"event":"unavailable"}')).not.toThrow();
  expect(log.status()).toEqual({ available: false, maximumBytes: 1024, droppedRecords: 2 });
  const before = readFileSync(join(n.logs, 'current.ndjson')); log.write('another');
  expect(readFileSync(join(n.logs, 'current.ndjson'))).toEqual(before);
});
it('refuses simultaneous writers, unknown files and oversized existing files instead of deleting them', () => {
  const n = fixture(), log = open(n.logs);
  expect(() => openBoundedDiagnostics(n.logs, 512)).toThrow(/already open/); log.close();
  writeFileSync(join(n.logs, 'retained-history'), 'must remain');
  expect(() => openBoundedDiagnostics(n.logs, 512)).toThrow(/unexpected/);
  expect(readFileSync(join(n.logs, 'retained-history'), 'utf8')).toBe('must remain'); rmSync(join(n.logs, 'retained-history'));
  writeFileSync(join(n.logs, 'current.ndjson'), 'x'.repeat(513)); expect(() => openBoundedDiagnostics(n.logs, 512)).toThrow(/oversized/);
});
it.skipIf(process.platform === 'win32')('refuses symbolic/hard links and stops logging if its output is replaced', () => {
  const n = fixture(), victim = join(n.directory, 'unrelated'); writeFileSync(victim, 'preserve me'); mkdirSync(n.logs);
  const current = join(n.logs, 'current.ndjson'); symlinkSync(victim, current);
  expect(() => openBoundedDiagnostics(n.logs, 512)).toThrow(/unsafe/); rmSync(current); linkSync(victim, current);
  expect(() => openBoundedDiagnostics(n.logs, 512)).toThrow(/unsafe/); rmSync(current);
  const log = open(n.logs); renameSync(current, join(n.directory, 'moved-diagnostic')); symlinkSync(victim, current);
  log.write('must not follow this path'); expect(log.status().available).toBe(false); expect(readFileSync(victim, 'utf8')).toBe('preserve me');
});
async function child(script: string, args: string[], env: NodeJS.ProcessEnv, capture = false) {
  const process_ = spawn(process.execPath, ['--import', 'tsx', script, ...args], { env, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
  let stderr = '', stdout = ''; process_.stderr!.on('data', chunk => { stderr += chunk.toString(); }); process_.stdout?.on('data', chunk => { stdout += chunk.toString(); });
  const exited = once(process_, 'exit'), timer = setTimeout(() => process_.kill('SIGKILL'), 15000);
  try { return { exit: await exited, stderr, stdout }; } finally { clearTimeout(timer); }
}
it.skipIf(process.platform === 'win32')('keeps a real process log flood below two MiB across SIGKILL and restart', async () => {
  const n = fixture();
  const result = await child(fileURLToPath(new URL('./fixtures/diagnostics-flood.ts', import.meta.url)), [n.logs], process.env);
  expect(result.exit).toEqual([null, 'SIGKILL']); expect(result.stderr).toBe('');
  expect(readFileSync(join(n.logs, 'current.ndjson'), 'utf8')).toContain('last-before-process-death');
  const sizes = ['current.ndjson', 'previous.ndjson'].map(name => statSync(join(n.logs, name)).size);
  expect(sizes.every(size => size <= DIAGNOSTIC_FILE_BYTES)).toBe(true);
  expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2 * DIAGNOSTIC_FILE_BYTES);
  const log = open(n.logs, DIAGNOSTIC_FILE_BYTES); log.write('{"event":"restart"}'); expect(log.status().available).toBe(true);
}, 20000);
it('records an early real relay startup error and exits, while ordinary CLI runs still report to stdout', async () => {
  const n = fixture(), entry = fileURLToPath(new URL('../main.ts', import.meta.url));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('RELAY_')));
  const env = { ...inherited, RELAY_PORT: 'invalid', RELAY_DATA_DIR: join(n.directory, 'data') };
  const service = await child(entry, [], { ...env, RELAY_DIAGNOSTICS_DIRECTORY: n.logs });
  expect(service.exit).toEqual([1, null]);
  const output = readFileSync(join(n.logs, 'current.ndjson'), 'utf8'); expect(output).toContain('relay_startup_failed'); expect(output).toContain('RELAY_PORT');
  const cli = await child(entry, [], env, true); expect(cli.exit).toEqual([1, null]); expect(cli.stdout).toContain('relay_startup_failed');
}, 20000);
