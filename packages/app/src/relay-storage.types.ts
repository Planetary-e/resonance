/** Browser-visible storage summaries. No filesystem or server imports. */
export interface RelayStorageBudget {
  authorityId: string; revision: number; limitBytes: number; reservedBytes: number; availableBytes: number;
  components: number; controlBytes: number; adoptedSelections: number; adoptedBytes: number;
}
export interface RelayStorageStatus {
  phase: 'unconfigured' | 'preparing' | 'selected' | 'recovery-required'; maintenanceActive: boolean; budget: RelayStorageBudget | null;
}
export type RelayStorageOperation = 'bootstrap' | 'adoption' | 'activation' | 'limit';
interface Target { path: string; scope: 'file' | 'directory' }
export type RelayStorageReview = { approvalDigest: string } & (
  { kind: 'desktop-storage-bootstrap-review'; mode: 'new' | 'recover'; intent: { limitBytes: number } }
  | { kind: 'desktop-storage-adoption-review'; existing: { observedBytes: number; targets: Target[] };
    future: { targets: Target[] } | null; reusable: { targets: Target[] } | null; fits: boolean;
    reservedBytesAfterAdoption: number; limit: { limitBytes: number } }
  | { kind: 'desktop-storage-activation-review'; fits: boolean; budget: { reservedBytes: number; limitBytes: number } }
  | { kind: 'desktop-storage-limit-review'; limit: { previousLimitBytes: number; limitBytes: number; reservedBytes: number } }
);
