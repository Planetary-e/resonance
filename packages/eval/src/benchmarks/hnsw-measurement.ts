/** Measurements belong to one dedicated process, including runtime/native allocations. */
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
export interface HnswMeasurement {
  version: 1; pid: number; vectorCount: number; searchCount: number; dimensions: number; seed: number;
  nodeVersion: string; platform: string; arch: string;
  insertDurationMs: number; p50: number; p95: number; p99: number; mean: number; cpuTimeMs: number;
  baselineRssBytes: number; initializedRssBytes: number; insertedRssBytes: number; finalRssBytes: number; peakRssBytes: number;
}
export function parseHnswMeasurement(value: unknown, vectorCount: number, pid: number): HnswMeasurement {
  const raw = value as Record<string, unknown> | null;
  const positive = ['baselineRssBytes', 'initializedRssBytes', 'insertedRssBytes', 'finalRssBytes', 'peakRssBytes'];
  const nonnegative = ['insertDurationMs', 'p50', 'p95', 'p99', 'mean', 'cpuTimeMs'];
  if (!raw || raw.version !== 1 || raw.pid !== pid || raw.vectorCount !== vectorCount || raw.searchCount !== 100 || raw.dimensions !== 768
    || raw.seed !== 20261017 || !['nodeVersion', 'platform', 'arch'].every(key => typeof raw[key] === 'string' && (raw[key] as string).length < 100)
    || !positive.every(key => Number.isSafeInteger(raw[key]) && (raw[key] as number) > 0)
    || !nonnegative.every(key => typeof raw[key] === 'number' && Number.isFinite(raw[key]) && (raw[key] as number) >= 0)
    || (raw.p50 as number) > (raw.p95 as number) || (raw.p95 as number) > (raw.p99 as number)) throw new Error('Invalid isolated HNSW measurement');
  return raw as unknown as HnswMeasurement;
}

export async function measureHnswProcess(vectorCount: number, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<HnswMeasurement> {
  if (!Number.isSafeInteger(vectorCount) || vectorCount < 1 || vectorCount > 100000) throw new Error('Invalid HNSW measurement size');
  const timeoutMs = options.timeoutMs ?? 900000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000) throw new Error('Invalid HNSW measurement deadline');
  options.signal?.throwIfAborted();
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const worker = fileURLToPath(new URL(`./hnsw-worker.${extension}`, import.meta.url));
  return new Promise((resolve, reject) => {
    const child = fork(worker, [String(vectorCount)], { execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let message: unknown, messages = 0, failure: Error | undefined, stderr = '';
    const stop = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(new Error('HNSW measurement cancelled'));
    const timer = setTimeout(() => stop(new Error('HNSW measurement timed out')), timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.on('message', value => { if (++messages !== 1) stop(new Error('Duplicate HNSW measurement')); else message = value; });
    child.stderr?.on('data', bytes => { if (stderr.length < 16384) stderr += String(bytes).slice(0, 16384 - stderr.length); });
    child.on('error', error => { failure ??= error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      // Wait for process closure, including cancellation, before reporting a result.
      if (failure) reject(failure);
      else if (code !== 0 || signal || messages !== 1) reject(new Error(`HNSW measurement process failed (${signal ?? code}): ${stderr}`));
      else { try { resolve(parseHnswMeasurement(message, vectorCount, child.pid!)); } catch (error) { reject(error); } }
    });
  });
}
