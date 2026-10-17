export interface RelayHistoryRecoveryInput {
  historyConfigFile: string; enrollmentFile: string; storageKeyFile: string; workspaceDirectory: string;
  policyFile: string; historyDirectory: string; operatorTransportFile: string; view: number;
}
export const historyRecoveryActions = ['plan', 'start', 'status', 'step', 'review', 'restore', 'readiness-plan', 'ready'] as const;
export type RelayHistoryRecoveryAction = typeof historyRecoveryActions[number];
export interface RelayHistoryRecoveryResult {
  kind?: 'admission-recovery-freeze' | 'admission-history-restore' | 'admission-restoration-readiness';
  directory?: string; contextId?: string; generation?: number; nextGeneration?: number; view?: number;
  approvalDigest?: string; spends?: number; permanentDenials?: number;
  requestedPolicyRevision?: number; complete?: boolean;
  destinationOccupied?: boolean;
  appliedSpends?: number; pending?: boolean; initializeWriter?: boolean; initializeArchive?: boolean;
  phase?: 'freeze' | 'select' | 'download-and-confirm' | 'provision' | 'review';
  result?: 'recovery-created' | 'history-restored' | 'history-ready'; readiness?: 'confirmed';
}
