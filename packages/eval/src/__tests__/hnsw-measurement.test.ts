import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureHnswProcess, parseHnswMeasurement } from '../benchmarks/hnsw-measurement.js';
import { writeMarkdownReport } from '../reporters/markdown.js';
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

it('measures real native HNSW work in a fresh process and rejects unavailable or invalid resource samples', async () => {
  const first = await measureHnswProcess(64), second = await measureHnswProcess(64);
  expect(first.pid).not.toBe(process.pid); expect(second.pid).not.toBe(first.pid);
  expect(first.peakRssBytes).toBeGreaterThan(0); expect(first.insertDurationMs).toBeGreaterThan(0);
  expect(first).toMatchObject({ vectorCount: 64, searchCount: 100, dimensions: 768, seed: 20261017, nodeVersion: process.version });
  for (const change of [{ peakRssBytes: 0 }, { peakRssBytes: -4096 }, { peakRssBytes: NaN }, { finalRssBytes: Infinity },
    { vectorCount: 63 }, { pid: process.pid }, { p95: -1 }]) {
    expect(() => parseHnswMeasurement({ ...first, ...change }, 64, first.pid)).toThrow('Invalid');
  }
}, 20000);

it('bounds a silent or busy child by deadline/cancellation instead of leaving it running', async () => {
  await expect(measureHnswProcess(100000, { timeoutMs: 1 })).rejects.toThrow('timed out');
  const controller = new AbortController(), pending = measureHnswProcess(100000, { signal: controller.signal });
  controller.abort(); await expect(pending).rejects.toThrow('cancelled');
  await expect(measureHnswProcess(64, { signal: controller.signal })).rejects.toThrow();
  for (const count of [0, -1, 100001, 1.5]) await expect(measureHnswProcess(count)).rejects.toThrow('size');
});

it('reports whole-process peak and absolute RSS snapshots with memory units and scope', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hnsw-report-')); directories.push(directory);
  const path = writeMarkdownReport([{ name: 'HNSW process peak RSS (10K)', target: '<4096 MiB', actual: '512.0 MiB', value: 512, passed: true,
    details: { vectorCount: 10000, dimensions: 768, searchCount: 100, seed: 20261017, nodeVersion: 'v24', platform: 'test', arch: 'test',
      baselineRssBytes: 104857600, initializedRssBytes: 209715200, insertedRssBytes: 536870912, finalRssBytes: 524288000 } }], directory);
  const report = readFileSync(path, 'utf8');
  expect(report).toContain('100.0 MiB / 200.0 MiB / 512.0 MiB / 500.0 MiB');
  expect(report).toContain('OS high-water mark'); expect(report).toContain('No heap subtraction');
  expect(report).toContain('neither index-only allocation nor the full application/device memory budget'); expect(report).not.toContain('memUsedMB');
});
