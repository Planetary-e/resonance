export type RelayPolicyObserverSetupInput =
  | { role: 'prepare'; setupFile: string; output: string }
  | { role: 'export-prepared'; setupFile: string; output: string }
  | { role: 'enrollment-export'; configurationFile: string; output: string }
  | { role: 'initialize'; configurationFile: string; operatorTransportFile: string }
  | { role: 'enroll'; enrollmentFile: string; signingKeyFile: string; storageKeyFile: string; directory: string }
  | { role: 'resume-enrollment'; enrollmentFile: string; signingKeyFile: string; storageKeyFile: string; directory: string };
export interface RelayPolicyObserverSetupResult {
  kind?: string; result?: string; approvalDigest?: string; directory?: string; output?: string; anchor?: string;
  contextId?: string; genesisId?: string | null; owner?: string; member?: string; policyRevision?: number;
  members?: Array<{ publicKey: string; endpoint: string }>;
  readiness: 'unverified'; startsService: false;
}
