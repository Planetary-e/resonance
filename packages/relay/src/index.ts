export { HammingIndex, ComplementaryHammingIndex, type HashMetadata, type HammingMatch } from './hamming-index.js';
export { MatchingEngine, type MatchNotification, type SearchResult, type MatchingEngineConfig } from './matching-engine.js';
export { RateLimiter, type RateLimiterConfig } from './rate-limiter.js';
export { createRelayServer, type RelayConfig, type RelayServer, type RelayStats } from './server.js';
export {
  PublicationOperationStore,
  type PublicationApplyResult,
  type PublicationApplyStatus,
} from './publication-store.js';
export { MailboxStore } from './mailbox-store.js';
export {
  MatchOperationStore,
  type MatchOperationApplyResult,
  type MatchOperationApplyStatus,
} from './match-operation-store.js';
export {
  RelayOperationLog,
  RELAY_OPERATION_LOG_FILENAME,
  type RelayOperationLogEntry,
  type RelayOperationLogRecord,
} from './operation-log.js';
export {
  loadOrCreateRelayIdentity,
  RELAY_IDENTITY_FILENAME,
} from './relay-identity-store.js';
export {
  type AdmissionCapabilityVerifierV2,
  type AdmissionDecisionV2,
  type AdmissionVerificationContextV2,
} from './admission.js';
export { type ClientState, type HandlerContext } from './handler.js';
export { log } from './logger.js';

// Legacy exports (kept for eval benchmarks that still use HNSW)
export { HnswIndex, MatchingIndex, type HnswIndexConfig, type VectorMetadata } from './hnsw.js';
