export interface FixedWindowAttempt {
  bucket: string;
  timestamp: number;
}

export interface RetryCapacityOptions {
  limit?: number;
  windowMs?: number;
}

export function attemptsInFixedWindow(
  attempts: readonly FixedWindowAttempt[],
  bucket: string,
  now: number,
  options: RetryCapacityOptions = {},
): FixedWindowAttempt[] {
  const windowMs = options.windowMs ?? 60_000;
  const ordered = attempts.filter(attempt => attempt.bucket === bucket)
    .sort((first, second) => first.timestamp - second.timestamp);
  if (ordered.length === 0 || ordered[0].timestamp > now) return [];
  let windowStarted = ordered[0].timestamp;
  let active: FixedWindowAttempt[] = [];
  for (const attempt of ordered) {
    if (attempt.timestamp > now) break;
    if (attempt.timestamp - windowStarted > windowMs) {
      windowStarted = attempt.timestamp;
      active = [];
    }
    active.push(attempt);
  }
  return now - windowStarted > windowMs ? [] : active;
}

export function fixedWindowRetryDelayMs(
  attempts: readonly FixedWindowAttempt[],
  bucket: string,
  now: number,
  options: RetryCapacityOptions = {},
): number {
  const limit = options.limit ?? 10;
  const windowMs = options.windowMs ?? 60_000;
  const active = attemptsInFixedWindow(attempts, bucket, now, options);
  if (active.length < limit) return 0;
  const windowStarted = Math.min(...active.map(attempt => attempt.timestamp));
  return Math.max(1, windowStarted + windowMs - now);
}

export async function waitForFixedWindowRetryCapacity(
  attempts: readonly FixedWindowAttempt[],
  bucket: string,
  options: RetryCapacityOptions = {},
): Promise<number> {
  const started = performance.now();
  while (fixedWindowRetryDelayMs(attempts, bucket, Date.now(), options) > 0) {
    const delay = fixedWindowRetryDelayMs(attempts, bucket, Date.now(), options);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return performance.now() - started;
}

export function quietWindowRetryDelayMs(
  attempts: readonly FixedWindowAttempt[],
  bucket: string,
  now: number,
  options: RetryCapacityOptions = {},
): number {
  const windowMs = options.windowMs ?? 60_000;
  const possible = attempts.filter(attempt => attempt.bucket === bucket && attempt.timestamp <= now);
  if (possible.length === 0) return 0;
  const lastPossibleAttempt = Math.max(...possible.map(attempt => attempt.timestamp));
  const remaining = lastPossibleAttempt + windowMs - now;
  return remaining < 0 ? 0 : Math.max(1, remaining);
}

export async function waitForQuietWindowRetryCapacity(
  attempts: readonly FixedWindowAttempt[],
  bucket: string,
  options: RetryCapacityOptions = {},
): Promise<number> {
  const started = performance.now();
  while (quietWindowRetryDelayMs(attempts, bucket, Date.now(), options) > 0) {
    const delay = quietWindowRetryDelayMs(attempts, bucket, Date.now(), options);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return performance.now() - started;
}
