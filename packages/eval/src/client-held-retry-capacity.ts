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

export class FixedWindowOfferScheduler {
  private readonly reservations: FixedWindowAttempt[] = [];
  private readonly completions: FixedWindowAttempt[] = [];
  private readonly pending = new Set<Promise<void>>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: RetryCapacityOptions = {}) {}

  schedule(buckets: readonly string[]): Promise<{ scheduledAt: number; waitedMs: number; complete: () => void }> {
    const unique = [...new Set(buckets)];
    if (unique.length === 0) return Promise.reject(new Error('Offered-load schedule requires a source bucket'));
    const result = this.queue.then(() => this.reserve(unique));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  snapshot(): FixedWindowAttempt[] {
    return this.reservations.map(attempt => ({ ...attempt }));
  }

  private async reserve(
    buckets: readonly string[],
  ): Promise<{ scheduledAt: number; waitedMs: number; complete: () => void }> {
    const started = performance.now();
    while (true) {
      const now = Date.now();
      const delay = Math.max(0, ...buckets.map(bucket => this.capacityDelayMs(bucket, now)));
      if (delay === 0) break;
      if (this.pending.size > 0) {
        await Promise.all([...this.pending]);
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    const scheduledAt = Date.now();
    for (const bucket of buckets) this.reservations.push({ bucket, timestamp: scheduledAt });
    let accept!: () => void;
    const completion = new Promise<void>(resolve => { accept = resolve; });
    this.pending.add(completion);
    let completed = false;
    return {
      scheduledAt,
      waitedMs: performance.now() - started,
      complete: () => {
        if (completed) return;
        completed = true;
        const timestamp = Date.now();
        for (const bucket of buckets) this.completions.push({ bucket, timestamp });
        this.pending.delete(completion);
        accept();
      },
    };
  }

  private capacityDelayMs(bucket: string, now: number): number {
    const limit = this.options.limit ?? 10;
    if (attemptsInFixedWindow(this.reservations, bucket, now, this.options).length < limit) return 0;
    return Math.max(
      fixedWindowRetryDelayMs(this.reservations, bucket, now, this.options),
      quietWindowRetryDelayMs(this.completions, bucket, now, this.options),
    );
  }
}
