/**
 * Fixed-window rate limiter per DID.
 * Resets counters every 60 seconds.
 */

export interface RateLimiterConfig {
  maxPublishesPerMin: number;
  maxSearchesPerMin: number;
  windowMs: number;
}

interface Window {
  publish: number;
  search: number;
  start: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();
  private config: RateLimiterConfig;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = {
      maxPublishesPerMin: config?.maxPublishesPerMin ?? 10,
      maxSearchesPerMin: config?.maxSearchesPerMin ?? 30,
      windowMs: config?.windowMs ?? 60_000,
    };
  }

  /** Returns true if the action is allowed, false if rate limited. */
  check(did: string, action: 'publish' | 'search'): boolean {
    const now = Date.now();
    let window = this.windows.get(did);

    if (!window || now - window.start > this.config.windowMs) {
      window = { publish: 0, search: 0, start: now };
      this.windows.set(did, window);
    }

    const limit = action === 'publish'
      ? this.config.maxPublishesPerMin
      : this.config.maxSearchesPerMin;

    if (window[action] >= limit) return false;
    window[action]++;
    return true;
  }

  /** Remove expired windows to prevent memory growth. */
  cleanup(): void {
    const now = Date.now();
    for (const [did, window] of this.windows) {
      if (now - window.start > this.config.windowMs) {
        this.windows.delete(did);
      }
    }
  }
}
