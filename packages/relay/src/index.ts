export { HammingIndex, ComplementaryHammingIndex, type HashMetadata, type HammingMatch } from './hamming-index.js';
export { MatchingEngine, type MatchNotification, type SearchResult, type MatchingEngineConfig } from './matching-engine.js';
export { RateLimiter, type RateLimiterConfig } from './rate-limiter.js';
export { createRelayServer, type RelayConfig, type RelayServer, type RelayStats } from './server.js';
export { type ClientState, type HandlerContext } from './handler.js';
export { log } from './logger.js';

// Legacy exports (kept for eval benchmarks that still use HNSW)
export { HnswIndex, MatchingIndex, type HnswIndexConfig, type VectorMetadata } from './hnsw.js';
