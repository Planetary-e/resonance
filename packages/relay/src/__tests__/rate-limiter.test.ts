import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../rate-limiter.js';

describe('RateLimiter', () => {
  it('allows up to the publish limit', () => {
    const limiter = new RateLimiter({ maxPublishesPerMin: 3 });
    expect(limiter.check('did:a', 'publish')).toBe(true);
    expect(limiter.check('did:a', 'publish')).toBe(true);
    expect(limiter.check('did:a', 'publish')).toBe(true);
    expect(limiter.check('did:a', 'publish')).toBe(false);
  });

  it('allows up to the search limit', () => {
    const limiter = new RateLimiter({ maxSearchesPerMin: 2 });
    expect(limiter.check('did:a', 'search')).toBe(true);
    expect(limiter.check('did:a', 'search')).toBe(true);
    expect(limiter.check('did:a', 'search')).toBe(false);
  });

  it('tracks publish and search independently', () => {
    const limiter = new RateLimiter({ maxPublishesPerMin: 1, maxSearchesPerMin: 1 });
    expect(limiter.check('did:a', 'publish')).toBe(true);
    expect(limiter.check('did:a', 'search')).toBe(true);
    expect(limiter.check('did:a', 'publish')).toBe(false);
    expect(limiter.check('did:a', 'search')).toBe(false);
  });

  it('tracks different DIDs independently', () => {
    const limiter = new RateLimiter({ maxPublishesPerMin: 1 });
    expect(limiter.check('did:a', 'publish')).toBe(true);
    expect(limiter.check('did:b', 'publish')).toBe(true);
    expect(limiter.check('did:a', 'publish')).toBe(false);
    expect(limiter.check('did:b', 'publish')).toBe(false);
  });

  it('resets after window expires', () => {
    const limiter = new RateLimiter({ maxPublishesPerMin: 1, windowMs: 10 });
    expect(limiter.check('did:a', 'publish')).toBe(true);
    expect(limiter.check('did:a', 'publish')).toBe(false);

    // Wait for window to expire
    const start = Date.now();
    while (Date.now() - start < 15) { /* spin */ }

    expect(limiter.check('did:a', 'publish')).toBe(true);
  });

  it('cleanup removes expired windows', () => {
    const limiter = new RateLimiter({ windowMs: 10 });
    limiter.check('did:a', 'publish');

    const start = Date.now();
    while (Date.now() - start < 15) { /* spin */ }

    limiter.cleanup();
    // After cleanup, the window is gone — next check starts fresh
    expect(limiter.check('did:a', 'publish')).toBe(true);
  });
});
