export { HammingIndex, ComplementaryHammingIndex, type HashMetadata, type HammingMatch } from './hamming-index.js';
export { MatchingEngine, type MatchNotification, type SearchResult, type MatchingEngineConfig } from './matching-engine.js';
export { RateLimiter, type RateLimiterConfig } from './rate-limiter.js';
export {
  createRelayServer,
  type RelayConfig,
  type RelayDiscoveryConfig,
  type RelayDiscoveryIngestResult,
  type RelayServer,
  type RelayStats,
} from './server.js';
export {
  RelayDirectory,
  type RelayDescriptorObservation,
  type RelayDirectorySelection,
} from './relay-directory.js';
export {
  discoverRelayContactV1,
  type RelayContactDiscoveryOptions,
  type RelayContactDiscoveryResult,
} from './relay-discovery-client.js';
export {
  connectRelayLinkV1,
  RelayLinkManager,
  type RelayLinkClientOptions,
  type RelayLinkClose,
  type RelayLinkConnection,
  type ConnectedRelayPeer,
  type RelayLinkManagerEvent,
  type RelayLinkManagerOptions,
  type RelayLinkManagerStatus,
} from './relay-link-client.js';
export {
  DEFAULT_DESIRED_REPLICA_COUNT,
  DEFAULT_MINIMUM_HEALTHY_REPLICA_COUNT,
  MAX_PERMANENTLY_REJECTED_REPLICA_TARGETS,
  MAX_RECONCILIATION_REQUIRED_REPLICA_TARGETS,
  MAX_REPLICA_TARGETS,
  createReplicaPlacementIntent,
  isPermanentReplicaRejection,
  isReconciliationRequiredReplicaRejection,
  verifyReplicaPlacementIntent,
  placementMatchesOperation,
  ReplicaPlacementTracker,
  ReplicaReconciliationScheduler,
  type ReplicaPlacementPolicy,
  type ReplicaPlacementIntentV1,
  type ReplicaReconciliationRequirementV1,
  type ReplicaPlacementStatus,
} from './replica-placement.js';
export {
  observedReplicaFailureDomain,
  prioritizeReplicaDiversity,
  type ReplicaDiversityCandidate,
} from './replica-diversity.js';
export {
  PublicationOperationStore,
  type PublicationApplyResult,
  type PublicationApplyStatus,
} from './publication-store.js';
export {
  FIRST_SEEN_TOMBSTONE_RESERVE_BYTES,
  ReplicaStorageLedger,
  TOMBSTONE_HEADROOM_BYTES,
  publicationStorageAllocatableBytes,
  publicationStorageReservationBytes,
  type ReplicaStorageAllocation,
  type PublicationStorageAllocationOrigin,
  type PublicationStorageAllocationPrincipal,
} from './replica-storage-ledger.js';
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
export { createLocalBlindAdmissionVerifierV2 } from './blind-admission-verifier.js';
export { openAdmissionSpendHistory } from './admission-spend-history.js';
export { openProtectedAdmissionSpendHistory, inspectProtectedAdmissionSpendHistory, type AdmissionHistoryProtection } from './protected-admission-history.js';
export { replayAdmissionHistory } from './admission-history-replay.js';
export { prepareAdmissionHistoryRestore, type PreparedAdmissionHistoryRestore } from './admission-history-restore.js';
export { loadAdmissionHistoryProtectionFile } from './admission-history-config.js';
export type { AdmissionLegacySpendProof, AdmissionLegacyRecoveryPlan } from './admission-legacy-recovery.js';
export type { PrivateEntryMixOptions } from './private-entry-mix.js';
export { type ClientState, type HandlerContext } from './handler.js';
export { log } from './logger.js';

// Legacy exports (kept for eval benchmarks that still use HNSW)
export { HnswIndex, MatchingIndex, type HnswIndexConfig, type VectorMetadata } from './hnsw.js';

export { createConfiguredAdmissionVerifier } from './configured-admission-verifier.js';
export { createAdmissionWitness, createAdmissionQuorumGate, type AdmissionWitness, type AdmissionWitnessTransport } from './admission-witness.js';
export { openHistoryCheckpointStore, type HistoryCheckpointStoreOptions } from './history-checkpoint-store.js';
export { createHistoryCheckpointReplica, listenHistoryCheckpointReplica, exchangeHistoryCheckpoint,
  readHistoryCheckpoint, type HistoryCheckpointTransport, type HistoryReplicaEndpoint } from './history-checkpoint-exchange.js';
export { createHistoryCheckpointWriter, type HistoryCheckpointWriterState } from './history-checkpoint-quorum.js';
export { createRetainedHistoryCheckpointWriter } from './history-retained-writer.js';
export { createHistoryCheckpointRecovery } from './history-checkpoint-recovery.js';
export { createHistoryCheckpointSuccessor } from './history-checkpoint-successor.js';
export { createHistoryAgreementReplica } from './history-checkpoint-agreement.js';
export { listenHistoryAgreementReplica, exchangeHistoryAgreement, exchangeHistoryAgreementData, exchangeHistoryProvision,
  type HistoryAgreementDataTransport, type HistoryAgreementTransport, type HistoryProvisionTransport } from './history-agreement-exchange.js';
export { createHistoryAgreementCoordinator, type HistoryAgreementSelection } from './history-agreement-coordinator.js';
export { openHistoryGenerationProvisioner, createHistoryGenerationReplica } from './history-generation-provisioner.js';
export { createHistoryProvisionCoordinator } from './history-provision-coordinator.js';
export { createHistoryAncestryDownload } from './history-ancestry-download.js';
export { openHistoryVolunteerService } from './history-volunteer-service.js';
export { HistoryRelayRouter } from './history-relay-router.js';
export { readHistoryBridgeConfigurationFile } from './history-bridge-config.js';
export type { RelayHistoryHealth, HistoryOwnerHealth, HistoryVolunteerHealth, HistoryTransportHealth, HistoryRoleHealth } from './history-health.js';
export { parseRelayHistoryHealth } from './history-health.js';
export type { HistoryRelayMemberRoute, HistoryRelayBridgeRoute } from './history-relay-bridge.js';
export { readHistoryVolunteerConfigurationFile, openConfiguredHistoryVolunteer } from './history-volunteer-config.js';
export { discoverHistoryContinuations, type HistoryContinuationDiscovery } from './history-continuation-discovery.js';
export { prepareAdmissionHistoryRecovery, openAdmissionHistoryRecovery, type AdmissionRecoveryReview } from './admission-history-recovery.js';

export { runAdmissionHistoryCommand, readHistoryEnrollmentFile, type AdmissionHistoryCommandOptions } from './admission-history-command.js';
export { openAdmissionHistoryActivation, type AdmissionHistoryActivationOptions, type AdmissionHistoryActivationReview } from './admission-history-activation.js';
export { openAdmissionRestorationReadiness, openAdmissionInitialReadiness, type AdmissionRestorationReadinessReview, type AdmissionInitialReadinessReview } from './admission-history-readiness.js';
export { beginRelayMaintenance, readRelayMaintenance, assertRelayNotInMaintenance, acquireStoppedRelayMaintenance, finishRelayMaintenance, RELAY_MAINTENANCE_FILENAME, type RelayMaintenanceState } from './relay-maintenance.js';
export { readOperatorJson, writeOperatorJsonNew } from './admission-operator-files.js';
export { reviewAdmissionOwnerConfiguration, openAdmissionOwnerSetup, canonicalHistorySetupPath, historySetupContains } from './admission-history-setup.js';
export type { AdmissionOwnerConfigurationInput, AdmissionOwnerSetupInput, AdmissionOwnerSetupMode } from './admission-history-setup.js';

export { openHistoryVolunteerEnrollmentResume } from './history-volunteer-enrollment.js';
export { openAdmissionOwnerLimits, type AdmissionOwnerLimitsInput } from './admission-history-limits.js';

export { measureStorageDirectories, parseStorageDirectories, parseStorageFiles } from "./storage-inventory.js";
export type { StorageInventory } from "./storage-inventory.js";
