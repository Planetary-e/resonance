export interface RelayPolicyObserverRecoveryInput {
  configurationFile: string; workspaceDirectory: string; restoredDirectory: string; outputFile: string;
  operatorTransportFile: string; source: 'available' | 'unavailable'; view: number;
}
export type RelayPolicyObserverRecoveryAction = 'plan' | 'start' | 'status' | 'step' | 'review' | 'restore' | 'resume-plan' | 'resume' | 'export-plan' | 'export';
export interface RelayPolicyObserverRecoveryResult {
  kind?: string; result?: string; approvalDigest?: string; directory?: string; output?: string; rootId?: string;
  generation?: number; nextGeneration?: number; view?: number; localStateDigest?: string | null;
  policyRevision?: number; blocked?: boolean; blocks?: number; bytes?: number; generations?: number;
  initializeWriter?: boolean; initializeArchive?: boolean; complete?: boolean; destinationOccupied?: boolean;
  phase?: 'freeze' | 'select' | 'download-and-confirm' | 'provision' | 'review';
  readiness: 'unverified'; startsService: false;
}
