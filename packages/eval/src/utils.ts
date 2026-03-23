import { normalize } from '@resonance/core';

/** High-resolution timer for async functions */
export async function timeAsync<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

/** High-resolution timer for sync functions */
export function timeSync<T>(fn: () => T): { result: T; durationMs: number } {
  const start = performance.now();
  const result = fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

/** Compute a percentile from a sorted array of numbers */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/** Generate a random unit vector of given dimensions */
export function generateRandomUnitVector(dimensions: number): Float32Array {
  const v = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    v[i] = Math.random() - 0.5;
  }
  return normalize(v);
}

/** Format milliseconds to human-readable string */
export function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Format a percentage */
export function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
