/** Authority plans and opaque claim reservations retained by four pinned volunteers before export. */
import { copyAdmissionSigningKey } from '@resonance/core/admission-witness';
import { parseHistoryCheckpointContext } from '@resonance/core/history-checkpoint';
import { admissionIssuanceAllocationDigest, assertAdmissionIssuanceAllocationCurrent, signAdmissionIssuanceAllocation,
  type SignedAdmissionIssuanceAllocation } from '@resonance/core/admission-issuance-allocation';
import { signAdmissionClaimAssignment, type SignedAdmissionClaimAssignment } from '@resonance/core/admission-claim-assignment';
import { openProtectedAllocationAuthorityHistory, readProtectedAllocationAuthorityHistoryRecoverySource, fenceProtectedAllocationAuthorityHistoryRecoverySource, type ProtectedAllocationAuthorityHistory, type ProtectedAllocationAuthorityHistoryOptions, type ProtectedAllocationAuthorityHistoryRecoveryEvidence } from '@resonance/relay/protected-allocation-authority-history';
import { readPreparedProtectedAllocationAuthorityRestore, type PreparedProtectedAllocationAuthorityRestore } from './admission-allocation-authority-history-restore.js';
import { admissionKeyFingerprint } from './admission-wallet-profile.js';
import { MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES, MAX_ADMISSION_ALLOCATION_ASSIGNMENTS, admissionClaimAssignmentKey,
  assertAdmissionAllocationAuthority, deriveAdmissionAllocationAuthorityEncryptionKey, allocationAuthorityHistoryAnchor,
  parseAdmissionAllocationAuthorityState, assertProtectedAllocationAuthoritySuccessor, assertProtectedAllocationAuthorityGenesis,
  reviewAdmissionAllocationPlan, reviewAdmissionClaimAssignment, type AdmissionAllocationAuthorityState } from './admission-allocation-authority-state.js';

type State = Extract<AdmissionAllocationAuthorityState, { version: 2 }>;
type HistoryOptions = ProtectedAllocationAuthorityHistoryOptions<State>;
export interface ProtectedAllocationAuthorityRecoverySource {
  readonly path: string; readonly writerDirectory: string; readonly contextId: string; readonly genesisId: string;
  readonly rootId: string; readonly generation: number; readonly stateDigest: string;
}
export interface ProtectedAllocationAuthorityRecoveryEvidence extends ProtectedAllocationAuthorityHistoryRecoveryEvidence<AdmissionAllocationAuthorityState> {
  authority: string;
}
const recoverySources = new WeakMap<ProtectedAllocationAuthorityRecoverySource, { read(): ProtectedAllocationAuthorityRecoveryEvidence; fence(): Promise<void> }>();
export function readProtectedAllocationAuthorityRecoverySource(source: ProtectedAllocationAuthorityRecoverySource): ProtectedAllocationAuthorityRecoveryEvidence {
  const record = recoverySources.get(source);
  if (!record) throw new Error('Allocation authority recovery requires a live authenticated source capability');
  return record.read();
}
export async function fenceProtectedAllocationAuthorityRecoverySource(source: ProtectedAllocationAuthorityRecoverySource): Promise<void> {
  const record = recoverySources.get(source);
  if (!record) throw new Error('Allocation authority recovery requires a live authenticated source capability');
  await record.fence();
}
export interface ProtectedAdmissionAllocationAuthorityOptions {
  path: string; authority: string; secretKey: Uint8Array; mode: 'create-new' | 'open-existing'; now?: () => number;
  /** Complete-history review capability; only creates a new protected owner destination. */
  restore?: { preparation: PreparedProtectedAllocationAuthorityRestore; approvedDigest: string };
  protection: Pick<HistoryOptions, 'context' | 'signingKey' | 'members' | 'writerDirectory' | 'transport' | 'timeoutMs' | 'maxArchiveBlocks' | 'maxArchiveBytes'>;
}
export async function openProtectedAdmissionAllocationAuthority(options: ProtectedAdmissionAllocationAuthorityOptions) {
  const allowed = ['path', 'authority', 'secretKey', 'mode', 'protection', 'now', 'restore'];
  const protectionFields = ['context', 'signingKey', 'members', 'writerDirectory', 'transport', 'timeoutMs', 'maxArchiveBlocks', 'maxArchiveBytes'];
  if (!options || Object.keys(options).some(key => !allowed.includes(key)) || !options.protection
    || Object.keys(options.protection).some(key => !protectionFields.includes(key))) throw new Error('Protected allocation authority storage, role and validation options are fixed');
  const authority = options.authority, path = options.path, mode = options.mode, now = options.now ?? Date.now;
  const restore = options.restore === undefined ? undefined : { preparation: options.restore.preparation, approvedDigest: options.restore.approvedDigest };
  if (restore && mode !== 'create-new') throw new Error('Allocation authority restore capability only creates a new destination');
  assertAdmissionAllocationAuthority(authority);
  if (mode !== 'create-new' && mode !== 'open-existing') throw new Error('Protected allocation authority requires explicit creation or opening');
  const context = parseHistoryCheckpointContext(structuredClone(options.protection.context));
  if (context.role !== 'admission-allocation-authority' || context.authority !== authority || context.policyDigest !== allocationAuthorityHistoryAnchor(authority)) throw new Error('Protected allocation authority history differs from its independent role, authority or genesis pin');
  // Capture both independent keys and all caller-owned pins before asynchronous validation.
  const protectionInput = { ...options.protection, context, members: structuredClone(options.protection.members) };
  const secret = Uint8Array.from(options.secretKey);
  let signer: ReturnType<typeof copyAdmissionSigningKey> | undefined;
  let storage: ProtectedAllocationAuthorityHistory<State> | undefined, closed = false, busy = false;
  try {
    signer = copyAdmissionSigningKey(protectionInput.signingKey);
    const protection = { ...protectionInput, signingKey: signer };
    const encryptionKey = deriveAdmissionAllocationAuthorityEncryptionKey(secret, authority);
    try {
      const restored = restore === undefined ? undefined : readPreparedProtectedAllocationAuthorityRestore(restore.preparation, restore.approvedDigest,
        { path, writerDirectory: protection.writerDirectory, context, authority });
      if (restored && restored.baseline.version !== 2) throw new Error('Protected allocation authority restoration requires v2 state');
      storage = await openProtectedAllocationAuthorityHistory<State>({ ...protection, path, encryptionKey,
        initial: { version: 2, authority, manifests: [], assignments: [] }, initialize: mode === 'create-new',
        ...(restored ? { restore: { ...restored, baseline: restored.baseline as State } } : {}),
        validate: async value => {
          const state = await parseAdmissionAllocationAuthorityState(value, authority);
          if (state.version !== 2) throw new Error('Protected allocation authority requires v2 state without conversion');
          return state;
        }, assertTransition: assertProtectedAllocationAuthoritySuccessor,
        validateGenesis: state => assertProtectedAllocationAuthorityGenesis(state, context) });
    } finally { encryptionKey.fill(0); }
  } catch (error) { storage?.close(); secret.fill(0); throw error; }
  finally { signer?.secretKey.fill(0); }
  const store = storage;
  function ensureOpen() { if (closed) throw new Error('Protected allocation authority is closed'); store.read(); }
  function requireNewDecision() { ensureOpen(); store.assertServing(); }
  function available() { ensureOpen(); if (busy) throw new Error('Allocation signing or readiness is already in progress'); }
  function current(community: 'public', epoch: string) {
    ensureOpen(); const manifest = store.read().manifests.find(entry => entry.community === community && entry.epoch === epoch);
    return manifest ? structuredClone(manifest) : undefined;
  }
  async function reviewAssignment(value: unknown) { ensureOpen(); return reviewAdmissionClaimAssignment(store.read(), value); }
  return {
    async reviewRecoverySource(): Promise<ProtectedAllocationAuthorityRecoverySource> {
      available(); busy = true;
      try {
        const captured = await store.reviewRecoverySource();
        const source = Object.freeze({ path: captured.path, writerDirectory: captured.writerDirectory, contextId: captured.contextId, genesisId: captured.genesisId,
          rootId: captured.rootId, generation: captured.generation, stateDigest: captured.stateDigest });
        recoverySources.set(source, { read() { return { ...readProtectedAllocationAuthorityHistoryRecoverySource<State>(captured), authority }; },
          async fence() {
            available(); busy = true;
            try { await fenceProtectedAllocationAuthorityHistoryRecoverySource(captured); } finally { busy = false; }
          } });
        return source;
      } finally { busy = false; }
    },
    current,
    reviewAssignment,
    async review(value: unknown) { ensureOpen(); return reviewAdmissionAllocationPlan(value, authority); },
    currentAssignment(community: 'public', epoch: string, claimHandle: string) {
      ensureOpen(); const assignment = store.read().assignments.find(entry => admissionClaimAssignmentKey(entry) === admissionClaimAssignmentKey({ community, epoch, claimHandle }));
      return assignment ? structuredClone(assignment) : undefined;
    },
    async sign(value: unknown, approvedDigest: string): Promise<SignedAdmissionIssuanceAllocation> {
      available(); busy = true;
      try {
        const reviewed = await reviewAdmissionAllocationPlan(value, authority); ensureOpen();
        if (approvedDigest !== reviewed.approvalDigest) throw new Error('Approval digest does not match this allocation plan; review it again');
        const state = store.read(), previous = state.manifests.find(entry => entry.community === reviewed.body.community && entry.epoch === reviewed.body.epoch);
        if (previous) {
          const { authority: _authority, signature: _signature, ...body } = previous;
          if (JSON.stringify(body) !== JSON.stringify(reviewed.body)) throw new Error('Conflicting allocation already signed for this community epoch');
          return structuredClone(previous);
        }
        requireNewDecision();
        if (state.manifests.length >= MAX_ADMISSION_ALLOCATION_JOURNAL_ENTRIES) throw new Error('Allocation authority journal is full; retained periods cannot be pruned or refunded');
        assertAdmissionIssuanceAllocationCurrent(reviewed.body, now());
        const manifest = await signAdmissionIssuanceAllocation(reviewed.body, authority, secret); requireNewDecision();
        assertAdmissionIssuanceAllocationCurrent(manifest, now());
        await store.commit({ ...state, manifests: [...state.manifests, manifest] }, () => assertAdmissionIssuanceAllocationCurrent(manifest, now()));
        requireNewDecision(); assertAdmissionIssuanceAllocationCurrent(manifest, now());
        return structuredClone(manifest);
      } finally { busy = false; }
    },
    async assignClaim(value: unknown, approvedDigest: string): Promise<SignedAdmissionClaimAssignment> {
      available(); busy = true;
      try {
        const reviewed = await reviewAdmissionClaimAssignment(store.read(), value); ensureOpen();
        if (approvedDigest !== reviewed.approvalDigest) throw new Error('Approval digest does not match this claim assignment; review it again');
        const state = store.read(), previous = state.assignments.find(entry => admissionClaimAssignmentKey(entry) === admissionClaimAssignmentKey(reviewed.body));
        if (previous) {
          if (previous.issuerKeyFingerprint !== reviewed.body.issuerKeyFingerprint) throw new Error('Claim already assigned to a different issuer');
          return structuredClone(previous);
        }
        requireNewDecision();
        if (state.assignments.length >= MAX_ADMISSION_ALLOCATION_ASSIGNMENTS) throw new Error('Claim assignment journal is full; reservations cannot be pruned or refunded');
        const manifest = state.manifests.find(entry => admissionIssuanceAllocationDigest(entry) === reviewed.body.allocationDigest)!;
        const issuer = manifest.allocations.find(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === reviewed.body.issuerKeyFingerprint)!;
        if (state.assignments.filter(entry => entry.allocationDigest === reviewed.body.allocationDigest && entry.issuerKeyFingerprint === reviewed.body.issuerKeyFingerprint).length >= issuer.maxPermits) throw new Error('Claim assignment issuer capacity is exhausted');
        assertAdmissionIssuanceAllocationCurrent(manifest, now());
        const assignment = await signAdmissionClaimAssignment(reviewed.body, manifest, authority, secret); requireNewDecision();
        assertAdmissionIssuanceAllocationCurrent(manifest, now());
        await store.commit({ ...state, assignments: [...state.assignments, assignment] }, () => assertAdmissionIssuanceAllocationCurrent(manifest, now()));
        requireNewDecision(); assertAdmissionIssuanceAllocationCurrent(manifest, now());
        return structuredClone(assignment);
      } finally { busy = false; }
    },
    digest(manifest: SignedAdmissionIssuanceAllocation) { ensureOpen(); return admissionIssuanceAllocationDigest(manifest); },
    async ready() { available(); busy = true; try { await store.ready(); } finally { busy = false; } },
    enrollment() { ensureOpen(); return store.enrollment(); },
    status() { ensureOpen(); const state = store.read(); return { authority, manifestCount: state.manifests.length, assignmentCount: state.assignments.length, protection: store.status() }; },
    close() { if (!closed) { closed = true; secret.fill(0); store.close(); } },
  };
}
export type ProtectedAdmissionAllocationAuthority = Awaited<ReturnType<typeof openProtectedAdmissionAllocationAuthority>>;
