import { afterEach, expect, it, vi } from 'vitest';
import { fsyncSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openResourceCheckpoint, RESOURCE_CHECKPOINT_BYTES } from '../resource-checkpoint.js';
import { OwnerResourcePolicy } from '../owner-resource-policy.js';
import { RelayTrafficMeter } from '../relay-resource-meter.js';
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, writeSync: vi.fn(fs.writeSync), fsyncSync: vi.fn(fs.fsyncSync) };
});
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const directories: string[] = [];
afterEach(() => {
  vi.mocked(writeSync).mockImplementation(actual.writeSync); vi.mocked(fsyncSync).mockImplementation(actual.fsyncSync);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() { const directory = mkdtempSync(join(tmpdir(), 'resonance-resource-checkpoint-')); directories.push(directory); return directory; }
type Counter = { total: number };
function valid(value: unknown): value is Counter {
  return !!value && typeof value === 'object' && Object.keys(value).join(',') === 'total'
    && Number.isSafeInteger((value as Counter).total) && (value as Counter).total >= 0;
}
it('bounds reads, replacements and unknown state without truncating retained counters', () => {
  const directory = fixture(), path = join(directory, 'count.json');
  const file = openResourceCheckpoint(path, valid); expect(file.read()).toBeUndefined(); file.write({ total: 17 });
  const original = readFileSync(path); expect(openResourceCheckpoint(path, valid).read()).toEqual({ total: 17 });
  const permissive = openResourceCheckpoint(path, (value): value is object => !!value && typeof value === 'object');
  expect(() => permissive.write({ long: 'x'.repeat(RESOURCE_CHECKPOINT_BYTES) })).toThrow(/byte limit/);
  expect(readFileSync(path)).toEqual(original); expect(readdirSync(directory)).toEqual(['count.json']);
  writeFileSync(`${path}.next`, 'x'.repeat(RESOURCE_CHECKPOINT_BYTES + 1));
  expect(() => openResourceCheckpoint(path, valid)).toThrow(/bounded/); expect(readFileSync(path)).toEqual(original);
  rmSync(`${path}.next`); writeFileSync(path, 'x'.repeat(RESOURCE_CHECKPOINT_BYTES + 1));
  expect(() => openResourceCheckpoint(path, valid)).toThrow(/bounded/);
  writeFileSync(path, '{"secret-should-not-be-echoed":');
  expect(() => openResourceCheckpoint(path, valid)).toThrow('Resource checkpoint is not valid JSON');
});
it('handles short writes, refuses uncertain reuse and preserves the previous committed counters', () => {
  const path = join(fixture(), 'count.json'), file = openResourceCheckpoint(path, valid); file.write({ total: 10 });
  vi.mocked(writeSync).mockImplementation(((fd: number, bytes: Uint8Array, offset: number, length: number) =>
    actual.writeSync(fd, bytes, offset, Math.min(length, 3))) as typeof writeSync);
  file.write({ total: 20 }); expect(openResourceCheckpoint(path, valid).read()).toEqual({ total: 20 });
  vi.mocked(writeSync).mockImplementationOnce(() => 0);
  expect(() => file.write({ total: 30 })).toThrow(/stopped/);
  expect(() => file.write({ total: 40 })).toThrow(/reopen/);
  const reopened = openResourceCheckpoint(path, valid); expect(reopened.read()).toEqual({ total: 20 }); reopened.write({ total: 50 });
  expect(openResourceCheckpoint(path, valid).read()).toEqual({ total: 50 });
  expect(statSync(path).size).toBeLessThanOrEqual(RESOURCE_CHECKPOINT_BYTES);
  expect(readdirSync(join(path, '..'))).toEqual(['count.json']);
});
it.each(['file', 'directory'] as const)('retains counters through a failed %s flush and refuses more work on the uncertain handle', kind => {
  if (kind === 'directory' && process.platform === 'win32') return;
  const path = join(fixture(), 'count.json'), file = openResourceCheckpoint(path, valid); file.write({ total: 10 });
  let calls = 0;
  vi.mocked(fsyncSync).mockImplementation(fd => { if (++calls === (kind === 'file' ? 1 : 2)) throw new Error('injected flush failure'); actual.fsyncSync(fd); });
  expect(() => file.write({ total: 20 })).toThrow(/flush failure/);
  expect(() => file.write({ total: 30 })).toThrow(/reopen/);
  expect(openResourceCheckpoint(path, valid).read()).toEqual({ total: kind === 'file' ? 10 : 20 });
});
it('refuses a missing or changed current checkpoint and incomplete first initialization', () => {
  const path = join(fixture(), 'count.json'), file = openResourceCheckpoint(path, valid); file.write({ total: 10 });
  writeFileSync(path, '{"total":2}'); expect(() => file.write({ total: 11 })).toThrow(/changed/);
  const reopened = openResourceCheckpoint(path, valid); rmSync(path);
  expect(() => reopened.write({ total: 3 })).toThrow(/changed/);
  writeFileSync(`${path}.next`, '{'); expect(() => openResourceCheckpoint(path, valid)).toThrow(/interrupted/);
});
it.skipIf(process.platform === 'win32')('refuses symbolic links and hard links in current and replacement files', () => {
  const directory = fixture(), path = join(directory, 'count.json'), victim = join(directory, 'unrelated');
  writeFileSync(victim, '{"total":42}'); symlinkSync(victim, path);
  expect(() => openResourceCheckpoint(path, valid)).toThrow(/ordinary/); rmSync(path);
  linkSync(victim, path); expect(() => openResourceCheckpoint(path, valid)).toThrow(/ordinary/); rmSync(path);
  for (const link of [symlinkSync, linkSync]) {
    const file = openResourceCheckpoint(path, valid); link(victim, `${path}.next`);
    expect(() => file.write({ total: 1 })).toThrow(/ordinary/); rmSync(`${path}.next`);
    expect(readFileSync(victim, 'utf8')).toBe('{"total":42}');
  }
});
it('keeps failed owner writes closed to new work and preserves durable traffic and ingress on reopen', () => {
  const directory = fixture(); let now = 10_000;
  const meter = new RelayTrafficMeter(directory); meter.recordLanIngress(40); meter.recordLanEgress(10);
  const options = { persistDir: directory, now: () => now, cpuMicros: () => 0, maxNewWorkIngressBytesPerHour: 100,
    totalBandwidthBytes: () => meter.snapshot().totalBandwidthBytes, checkpointUsage: () => meter.checkpoint() };
  const policy = new OwnerResourcePolicy(options); expect(policy.allowNewWork(70)).toBe(true);
  vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('disk failure'); });
  expect(policy.allowNewWork(10)).toBe(false);
  now += 3_600_000; expect(policy.allowNewWork(1)).toBe(false);
  const restoredMeter = new RelayTrafficMeter(directory); expect(restoredMeter.snapshot().totalBandwidthBytes).toBe(50);
  now = 10_001;
  const restored = new OwnerResourcePolicy({ ...options, checkpointUsage: () => restoredMeter.checkpoint() });
  expect(restored.allowNewWork(31)).toBe(false); expect(restored.allowNewWork(30)).toBe(true);
  for (const name of readdirSync(directory)) expect(statSync(join(directory, name)).size).toBeLessThanOrEqual(RESOURCE_CHECKPOINT_BYTES);
});
it('refuses unsafe measurements, counter overflow and clock rollback without refreshing allowance', () => {
  let now = 10_000, cpu = 100, traffic = 50;
  const policy = new OwnerResourcePolicy({ now: () => now, cpuMicros: () => cpu, totalBandwidthBytes: () => traffic, maxNewWorkIngressBytesPerHour: 10 });
  expect(policy.allowNewWork(10)).toBe(true); now--;
  expect(policy.allowNewWork(1)).toBe(false); now += 2; expect(policy.allowNewWork(1)).toBe(false);
  traffic = Number.NaN; expect(policy.allowNewWork(0)).toBe(false); traffic = 49; expect(policy.allowNewWork(0)).toBe(false);
  traffic = 50; cpu = 99; expect(policy.allowNewWork(0)).toBe(false); cpu = 100;
  expect(policy.allowNewWork(0)).toBe(true);
  const meter = new RelayTrafficMeter(); meter.recordLanIngress(Number.MAX_SAFE_INTEGER);
  expect(() => meter.recordLanIngress(1)).toThrow(/bound/); meter.recordLanEgress(1);
  expect(() => meter.snapshot()).toThrow(/bound/);
});
it.skipIf(process.platform === 'win32')('survives real process death before/after replacement and fences a partial first checkpoint', async () => {
  for (const boundary of ['partial', 'before-rename', 'after-rename']) {
    const path = join(fixture(), 'count.json');
    if (boundary !== 'partial') openResourceCheckpoint(path, valid).write({ total: 10 });
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/resource-checkpoint-kill.ts', import.meta.url)), path, boundary], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
    const exit = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { expect(await exit).toEqual([null, 'SIGKILL']); expect(stderr).toBe(''); } finally { clearTimeout(timer); }
    if (boundary === 'partial') expect(() => openResourceCheckpoint(path, valid)).toThrow(/interrupted/);
    else expect(openResourceCheckpoint(path, valid).read()).toEqual({ total: boundary === 'before-rename' ? 10 : 20 });
  }
}, 35000);
