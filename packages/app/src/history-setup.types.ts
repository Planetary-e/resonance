export type RelayHistorySetupInput =
  | { role: 'configuration'; ownerKeyFile: string; authorityFile: string; policyFile: string; membersFile: string; output: string; historyId: string }
  | { role: 'owner'; historyConfigFile: string; policyFile: string; storageKeyFile: string; directory: string; output: string; mode: 'new' | 'resume' | 'export' }
  | { role: 'volunteer'; enrollmentFile: string; signingKeyFile: string; storageKeyFile: string; directory: string }
  | { role: 'volunteer-resume'; enrollmentFile: string; signingKeyFile: string; storageKeyFile: string; directory: string }
  | { role: 'owner-limits'; historyConfigFile: string; enrollmentFile: string; policyFile: string; storageKeyFile: string; directory: string; output: string; archiveMiB: number; archiveBlocks: number }
  | { role: 'admission-role-capture'; historyConfigFile: string; policyFile: string; storageKeyFile: string; directory: string; localRoleDirectory: string; selection: 'witness' | 'coordinator' | 'both'; operatorTransportFile: string }
  | { role: 'admission-role-setup'; storageKeyFile: string; directory: string; output: string; mode: 'new' | 'resume'; selection: 'witness' | 'coordinator' }
  | { role: 'admission-role-key-export'; historyConfigFile: string; policyFile: string; storageKeyFile: string; directory: string; localRoleDirectory: string; output: string; selection: 'witness' | 'coordinator'; operatorTransportFile: string }
  | { role: 'readiness'; historyConfigFile: string; enrollmentFile: string; policyFile: string; storageKeyFile: string; directory: string; operatorTransportFile: string };
export interface RelayHistorySetupResult {
  kind?: 'new-owner-configuration' | 'owner-history-setup' | 'owner-history-limits' | 'history-volunteer-enrollment' | 'history-volunteer-resumption' | 'admission-initial-readiness' | 'admission-local-role-capture' | 'fresh-admission-role-setup' | 'protected-admission-role-key-export';
  publicKey?: string | null; selection?: 'witness' | 'coordinator'; secretKeyExported?: false;
  localRoles?: Array<'witness' | 'coordinator'>; fencedRoles?: number; alreadyCaptured?: boolean;
  witnessVotes?: number; coordinatorCertificates?: number; witnessDenials?: number; coordinatorDenials?: number;
  fits?: boolean; requiredBlocks?: number; requiredCiphertextBytes?: number; availableBlocks?: number; availableCiphertextBytes?: number;
  archiveBytes?: number; archiveBlocks?: number; retainedCiphertextBytes?: number; pendingUnarchivedBytes?: number;
  phase?: 'genesis-pending' | 'retained' | 'new' | 'preparing' | 'prepared'; retainedBlocks?: number;
  result?: string; approvalDigest?: string; contextId?: string; genesisId?: string | null; historyId?: string;
  owner?: string; authority?: string; member?: string; members?: Array<{ publicKey: string; endpoint: string }>;
  directory?: string; output?: string; mode?: 'new' | 'resume' | 'export'; spends?: number; permanentDenials?: number;
  initializeWriter?: boolean; initializeArchive?: boolean; pending?: boolean; appliedSpends?: number; requestedPolicyRevision?: number;
  maximumGenerations?: number; generationByteLimit?: number; ancestryByteLimit?: number;
  readiness: 'unverified' | 'confirmed'; startsService: false;
}
