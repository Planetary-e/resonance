/**
 * Fixed-window rate limiter per caller key.
 * Resets counters every 60 seconds.
 */

export interface RateLimiterConfig {
  maxPublishesPerMin: number;
  maxSearchesPerMin: number;
  maxDiscoveriesPerMin: number;
  maxReplicasPerMin: number;
  windowMs: number;
}

interface Window {
  publish: number;
  search: number;
  discovery: number;
  replica: number;
  start: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();
  private config: RateLimiterConfig;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = {
      maxPublishesPerMin: config?.maxPublishesPerMin ?? 10,
      maxSearchesPerMin: config?.maxSearchesPerMin ?? 30,
      maxDiscoveriesPerMin: config?.maxDiscoveriesPerMin ?? 60,
      maxReplicasPerMin: config?.maxReplicasPerMin ?? 120,
      windowMs: config?.windowMs ?? 60_000,
    };
  }

  /** Returns true if the action is allowed, false if rate limited. */
  check(did: string, action: 'publish' | 'search' | 'discovery' | 'replica'): boolean {
    const now = Date.now();
    let window = this.windows.get(did);

    if (!window || now - window.start > this.config.windowMs) {
      window = { publish: 0, search: 0, discovery: 0, replica: 0, start: now };
      this.windows.set(did, window);
    }

    const limit = action === 'publish'
      ? this.config.maxPublishesPerMin
      : action === 'search'
        ? this.config.maxSearchesPerMin
        : action === 'discovery'
          ? this.config.maxDiscoveriesPerMin
          : this.config.maxReplicasPerMin;

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
