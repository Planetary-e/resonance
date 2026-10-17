export type RelayHistorySetupInput =
  | { role: 'configuration'; ownerKeyFile: string; authorityFile: string; policyFile: string; membersFile: string; output: string; historyId: string }
  | { role: 'owner'; historyConfigFile: string; policyFile: string; storageKeyFile: string; directory: string; output: string; mode: 'new' | 'resume' | 'export' }
  | { role: 'volunteer'; enrollmentFile: string; signingKeyFile: string; storageKeyFile: string; directory: string }
  | { role: 'volunteer-resume'; enrollmentFile: string; signingKeyFile: string; storageKeyFile: string; directory: string }
  | { role: 'owner-limits'; historyConfigFile: string; enrollmentFile: string; policyFile: string; storageKeyFile: string; directory: string; output: string; archiveMiB: number; archiveBlocks: number }
  | { role: 'readiness'; historyConfigFile: string; enrollmentFile: string; policyFile: string; storageKeyFile: string; directory: string; operatorTransportFile: string };
export interface RelayHistorySetupResult {
  kind?: 'new-owner-configuration' | 'owner-history-setup' | 'owner-history-limits' | 'history-volunteer-enrollment' | 'history-volunteer-resumption' | 'admission-initial-readiness';
  archiveBytes?: number; archiveBlocks?: number; retainedCiphertextBytes?: number; pendingUnarchivedBytes?: number;
  phase?: 'genesis-pending' | 'retained'; retainedBlocks?: number;
  result?: string; approvalDigest?: string; contextId?: string; genesisId?: string | null; historyId?: string;
  owner?: string; authority?: string; member?: string; members?: Array<{ publicKey: string; endpoint: string }>;
  directory?: string; output?: string; mode?: 'new' | 'resume' | 'export'; spends?: number; permanentDenials?: number;
  initializeWriter?: boolean; initializeArchive?: boolean; pending?: boolean; appliedSpends?: number; requestedPolicyRevision?: number;
  maximumGenerations?: number; generationByteLimit?: number; ancestryByteLimit?: number;
  readiness: 'unverified' | 'confirmed'; startsService: false;
}
