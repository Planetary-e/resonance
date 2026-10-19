import { admissionPolicyProofReference, parseAdmissionPolicyProofAppend, parseArchivedAdmissionPolicyAdvance, verifyArchivedAdmissionPolicy, archivedAdmissionPolicyDigest, assertArchivedAdmissionPolicyCurrent, type ArchivedAdmissionPolicy, type AdmissionPolicyArchiveLimits, type AdmissionPolicyHistoryMembership } from '@resonance/core/admission-policy-archive';
import { parseAdmissionPolicyTrust, inspectAdmissionPolicyObservation, type AdmissionPolicyTrust, type AdmissionPolicyObservation } from '@resonance/core/admission-policy-trust';
import { sameAdmissionPolicyHead } from '@resonance/core/admission-policy-advance';
import { createAdmissionPolicyHistoryProof, type PolicyProofHistory, type PolicyProofOperation, type PolicyProofCache } from './admission-policy-history-proof.js';
/** Same-file protection fence, durable pending ciphertext, four copies, then live admission state. */
import { join, resolve } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import type { SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields, type AdmissionSpendCertificate } from '@resonance/core/admission-witness';
import { admissionKeyFingerprint, assertAdmissionPolicySuccessor, isArchivedAdmissionKey } from '@resonance/core/admission-policy';
import { HISTORY_DELTA_MAX_PAYLOAD, historyCheckpointContextId, historyCheckpointEnvelopeId, historyCheckpointEnvelopeByteLength, historyCheckpointReserveBucket, historyDigest, isHistoryDigest, openHistoryCheckpoint, parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, sealHistoryCheckpoint, type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { historySuccessorProposalId } from '@resonance/core/history-successor';
import { createHistoryCompactionProposal } from '@resonance/core/history-compaction';
import { collectHistoryCompactionCertificate } from './history-compaction-coordinator.js';
import { createRetainedHistoryCheckpointWriter } from './history-retained-writer.js';
import { admissionHistoryReplayDigest } from './admission-history-replay.js';
import { readPreparedAdmissionRestore, type AdmissionHistoryRestoration, type PreparedAdmissionHistoryRestore } from './admission-history-restore.js';
import { decodeLegacyAdmissionSpendState, parseAdmissionSpendState, type AdmissionSpendRecord } from './admission-spend-history.js';
import { checkAdmissionLegacyRecovery, type AdmissionSpendState } from './admission-legacy-recovery.js';
import { planAdmissionHistoryRetirement } from './admission-history-retirement.js';
import { encodeAdmissionHistoryRecord, parseAdmissionHistoryImage, reduceAdmissionHistory, type AdmissionHistoryImage, type AdmissionHistoryMutation, type AdmissionHistoryRecord, type AdmissionHistoryStateCheckpoint, type AdmissionHistoryRoleCheckpoint, type AdmissionHistoryProofCheckpoint } from './admission-history-records.js';
import { admissionRoleHistoriesIdentity, assertAdmissionRoleRetention, parseAdmissionRoleHistories, type AdmissionRoleHistories, type AdmissionRoleMutation } from './admission-role-history.js';

export type ProtectedAdmissionState = {
  context: HistoryCheckpointContext; root: HistoryCheckpointEnvelope;
  image: AdmissionHistoryImage; applied: { sequence: number; id: string } | null;
  pending: HistoryCheckpointEnvelope | null;
} & ({ version: 3 } | { version: 4; restoration: AdmissionHistoryRestoration });
type WriterOptions = Parameters<typeof createRetainedHistoryCheckpointWriter>[0];
export interface AdmissionHistoryProtection {
  context: HistoryCheckpointContext; signingKey: SigningKeyPair; members: WriterOptions['members'];
  /** Explicit creation/recovery of a pristine writer; never recreates committed missing history. */
  initializeWriter?: boolean; initializeArchive?: boolean;
  /** Only explicitly reviewed completion of an unpublished pristine archive. */
  resumePristineArchive?: boolean;
  /** Explicit same-file promotion of an intact existing local ledger. */
  promoteLocalHistory?: boolean;
  /** Creation only, into the independently reviewed new directory. Reopen omits this capability. */
  restore?: { preparation: PreparedAdmissionHistoryRestore; approvedDigest: string };
  ancestrySource?: () => Iterable<HistoryCheckpointEnvelope>;
  timeoutMs?: number; transport?: WriterOptions['transport']; maxArchiveBlocks?: number; maxArchiveBytes?: number;
}

interface ProtectedHistoryOptions {
  directory: string; encryptionKey: Uint8Array; authority: string; policy: unknown;
  initialize?: boolean; maxSpends?: number; now?: () => number; protection: AdmissionHistoryProtection;
  /** Reviewed local state must still match before any pristine writer creation. */
  expectedStateDigest?: string;
  policyAdvance?: unknown; policyPages?: Array<{ digest: string; bytes: Uint8Array }>;
  policyTrust?: AdmissionPolicyTrust;
}
export async function openProtectedAdmissionSpendHistory(options: ProtectedHistoryOptions) {
  return openProtectedHistory(options, false);
}
/** Validates and locks existing encrypted owner state without opening or creating
 * a writer/archive. This is local inspection, never network readiness evidence. */
export async function inspectProtectedAdmissionSpendHistory(options: Omit<ProtectedHistoryOptions, 'initialize'>) {
  const p = options.protection;
  if (p.initializeWriter || p.initializeArchive || p.resumePristineArchive || p.promoteLocalHistory || p.restore) throw new Error('History inspection cannot initialize, promote or restore state');
  const directory = realpathSync(options.directory);
  if (!statSync(directory).isDirectory()) throw new Error('History inspection requires an existing directory');
  const history = await openProtectedHistory({ ...options, directory, initialize: false }, true);
  return { read: history.read, close: history.close };
}
async function openProtectedHistory(options: ProtectedHistoryOptions, inspectionOnly: boolean) {
  if (options.expectedStateDigest !== undefined && !isHistoryDigest(options.expectedStateDigest)) throw new Error('Invalid reviewed history state digest');
  const limit = options.maxSpends ?? 10000, now = options.now ?? Date.now;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid admission spend history capacity');
  const policy = await verifyArchivedAdmissionPolicy(options.policy, options.authority);
  assertArchivedAdmissionPolicyCurrent(policy, now());
  const p = options.protection, context = parseHistoryCheckpointContext(p.context), contextId = historyCheckpointContextId(context);
  if (context.role !== 'relay-admission-spends') throw new Error('Admission history requires its own history role');
  if (context.authority !== options.authority) throw new Error('Wrong admission history authority');
  if (options.expectedStateDigest !== undefined && (options.initialize || p.promoteLocalHistory)) {
    throw new Error('Reviewed state only opens existing protected history');
  }
  if (p.restore && !options.initialize) throw new Error('Reviewed restore only initializes a new protected history');
  const key = Buffer.from(options.encryptionKey), signer = copyAdmissionSigningKey(p.signingKey);
  if (key.length !== 32 || Buffer.from(signer.publicKey).toString('base64url') !== context.owner) {
    key.fill(0); signer.secretKey.fill(0); throw new Error('Wrong admission history owner or encryption key');
  }
  const participant = resolve(options.directory);
  let proofSignal: AbortSignal | undefined;
  let proofOperation: PolicyProofOperation = {};
  const proofCache: PolicyProofCache = new Map();
  const membershipCache = new Map<string, AdmissionPolicyHistoryMembership>();
  function* source(): Iterable<HistoryCheckpointEnvelope> { read(); if (p.ancestrySource) yield* p.ancestrySource(); if (writer) yield* writer.history(); }
  const proofHistory: PolicyProofHistory = { source, context, encryptionKey: key, cache: proofCache, membershipCache, get operation() { return proofOperation; }, get signal() { return proofSignal; } };
  let storage: ReturnType<typeof openEncryptedLocalState<AdmissionSpendState | ProtectedAdmissionState>> | undefined;
  let writer: ReturnType<typeof createRetainedHistoryCheckpointWriter> | undefined;
  let closed = false, active = false, readyConfirmed = false;
  let certificationController: AbortController | undefined;
  function baseline(state: AdmissionSpendState): ProtectedAdmissionState {
    if (policy.version === 3) throw new Error('Fresh protected v3 enrollment is unsupported; enroll original genesis first');
    if (context.policyDigest !== `sha256:${archivedAdmissionPolicyDigest(policy)}`) throw new Error('Baseline policy does not match pinned history');
    const image: AdmissionHistoryImage = { version: 1, kind: 'admission-spend-checkpoint', policy, state: parseAdmissionSpendState(state, policy, limit) };
    const root = sealHistoryCheckpoint({ context, header: { kind: 'checkpoint', generation: 0, sequence: 0, previous: null },
      plaintext: encodeAdmissionHistoryRecord(image), encryptionKey: key, signingKey: signer });
    return { version: 3, context, root, image, applied: null, pending: root };
  }
  function read(): ProtectedAdmissionState {
    if (closed) throw new Error('Protected admission history is closed');
    const state = storage!.read();
    if (state.version !== 3 && state.version !== 4) throw new Error('Admission history has not been protected');
    return state;
  }
  function decode(block: HistoryCheckpointEnvelope): unknown {
    const bytes = openHistoryCheckpoint(block, context, key);
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error('Invalid encrypted admission history record'); }
    finally { bytes.fill(0); }
  }
  const id = historyCheckpointEnvelopeId;
  function writerMatches() {
    const local = read(), remote = writer!.read();
    const committed = remote.committed?.envelope;
    if (remote.pending && (!local.pending || id(remote.pending) !== id(local.pending))) throw new Error('Protected admission pending histories disagree');
    if (committed ? !((local.applied?.id === id(committed) && local.applied.sequence === committed.sequence)
      || (local.pending && id(local.pending) === id(committed))) : local.applied !== null) {
      throw new Error('Protected admission committed histories disagree; restore complete history');
    }
  }
  async function nextImage(state: ProtectedAdmissionState): Promise<AdmissionHistoryImage> {
    if (!state.pending) return state.image;
    if (state.pending.sequence === 0) return state.version === 4
      ? parseAdmissionHistoryImage(state.restoration.baseline, context.authority, limit, proofHistory)
      : parseAdmissionHistoryImage(decode(state.pending), context.authority, limit, proofHistory);
    if (state.pending.kind === 'continuation') throw new Error('Protected admission restore requires reviewed successor activation');
    return (await reduceAdmissionHistory(state.image, decode(state.pending), limit, state.pending.kind, proofHistory)).image;
  }
  function available() {
    const state = read();
    if (state.pending || !state.applied) throw new Error('Protected admission history needs durable completion');
    return state;
  }
  function serving() {
    read(); if (!readyConfirmed) throw new Error('Protected admission history needs fresh readiness confirmation');
    return available();
  }
  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    read(); if (active) throw new Error('Protected admission history operation is in progress');
    active = true; proofOperation = {};
    try { return await operation(); } finally { active = false; }
  }
  async function finishPending(): Promise<boolean> {
    const before = read(), pending = before.pending;
    if (!pending) return false;
    const image = await nextImage(before); read(); writerMatches();
    // A certificate already flushed by this writer completes an interrupted local apply.
    // It is not permission for a different new write or an old-generation restore.
    const committed = writer!.read().committed;
    const fresh = !committed || id(committed.envelope) !== id(pending);
    if (fresh) await writer!.replicate(pending);
    read();
    storage!.write({ ...before, image, applied: { sequence: pending.sequence, id: id(pending) }, pending: null });
    return fresh;
  }
  function recordHeadroom(header: Parameters<typeof historyCheckpointEnvelopeByteLength>[0]['header'], payloadBytes: number,
    image: AdmissionHistoryImage, checkpoint: boolean) {
    const usage = writer!.historyUsage(); let reservedBytes = 0;
    if (!checkpoint) {
      if (header.sequence >= Number.MAX_SAFE_INTEGER - 1) throw new Error('History checkpoint sequence headroom exhausted');
      const complete = encodeAdmissionHistoryRecord({ version: 1, kind: 'admission-state-checkpoint', at: Number.MAX_SAFE_INTEGER, image });
      try { reservedBytes = historyCheckpointEnvelopeByteLength({ context, header: { ...header, kind: 'checkpoint', sequence: header.sequence + 1 }, plaintextBytes: complete.length }); }
      finally { complete.fill(0); }
    }
    const reservedHeader = checkpoint ? header : { ...header, checkpointReserveBytes: historyCheckpointReserveBucket(reservedBytes) };
    const requiredCiphertextBytes = historyCheckpointEnvelopeByteLength({ context, header: reservedHeader, plaintextBytes: payloadBytes }) + reservedBytes;
    const requiredBlocks = checkpoint ? 1 : 2, availableBlocks = usage.maximumBlocks - usage.retainedBlocks;
    const availableCiphertextBytes = usage.maximumCiphertextBytes - usage.retainedCiphertextBytes;
    return { header: reservedHeader, capacity: { requiredBlocks, requiredCiphertextBytes, availableBlocks, availableCiphertextBytes,
      fits: requiredBlocks <= availableBlocks && requiredCiphertextBytes <= availableCiphertextBytes } };
  }
  async function commit(value: AdmissionHistoryMutation | AdmissionHistoryStateCheckpoint | AdmissionHistoryRoleCheckpoint | AdmissionHistoryProofCheckpoint): Promise<void> {
    const before = available();
    if (before.applied!.sequence >= Number.MAX_SAFE_INTEGER - 1) throw new Error('History sequence capacity exhausted');
    const kind = value.kind === 'admission-state-checkpoint' || value.kind === 'admission-roles-checkpoint' || value.kind === 'admission-policy-proof-checkpoint'
      || value.kind === 'policy' && Buffer.byteLength(JSON.stringify(value)) > HISTORY_DELTA_MAX_PAYLOAD ? 'checkpoint' : 'delta';
    const record: AdmissionHistoryRecord = kind === 'checkpoint' && value.kind === 'policy'
      ? { version: 1, kind: 'admission-policy-checkpoint', at: value.at, image: { ...before.image, policy: value.policy } } : value;
    const reduced = await reduceAdmissionHistory(before.image, record, limit, kind, proofHistory); read();
    const header = { kind, generation: before.root.generation, sequence: before.applied!.sequence + 1, previous: before.applied!.id } as const;
    const plaintext = encodeAdmissionHistoryRecord(reduced.record);
    let pending: HistoryCheckpointEnvelope;
    try {
      const checkpoint = value.kind === 'admission-state-checkpoint' || value.kind === 'admission-policy-proof-checkpoint';
      const prepared = recordHeadroom(header, plaintext.length, reduced.image, checkpoint);
      if (!prepared.capacity.fits) {
        throw new Error(checkpoint ? 'State checkpoint needs retained archive headroom; no checkpoint intent was written'
          : 'Admission history needs checkpoint headroom; publish, certify and retire a checkpoint or review archive limits before new work');
      }
      pending = sealHistoryCheckpoint({ context, header: prepared.header, plaintext, encryptionKey: key, signingKey: signer });
    } finally { plaintext.fill(0); }
    proofSignal?.throwIfAborted();
    storage!.write({ ...before, pending });
    await finishPending();
  }
  function checkpointPlan() {
    const state = available(), at = now(); assertArchivedAdmissionPolicyCurrent(state.image.policy, at);
    if (state.applied!.sequence >= Number.MAX_SAFE_INTEGER - 1) throw new Error('History sequence capacity exhausted');
    const plaintext = encodeAdmissionHistoryRecord({ version: 1, kind: 'admission-state-checkpoint', at, image: state.image });
    const payloadBytes = plaintext.length; plaintext.fill(0);
    return { kind: 'admission-history-state-checkpoint' as const, generation: state.root.generation,
      sequence: state.applied!.sequence + 1, recordsRetained: state.image.state.spends.length,
      unattributedRecordsRetained: state.image.state.spends.filter(row => row.issuerKey === null).length,
      permanentDenialsRetained: state.image.state.retiredIssuerKeys.length, payloadBytes,
      filesRemoved: 0 as const, bytesReclaimed: 0 as const,
      approvalDigest: historyDigest(`resonance:admission-history-state-checkpoint-review:v1\n${JSON.stringify([
        participant, contextId, id(state.root), state.applied, state.image,
      ])}`),
      notice: 'Publishes an unchanged encrypted state on four volunteers. Retains all earlier history; this is not permission to prune or restore from a snapshot alone.' };
  }
  async function roleCapturePlan(value: AdmissionRoleHistories) {
    const state = available(), roles = parseAdmissionRoleHistories(value, state.image.policy, limit);
    const image: AdmissionHistoryImage & { version: 2 } = { ...state.image, version: 2, roles };
    const record: AdmissionHistoryRoleCheckpoint = { version: 1, kind: 'admission-roles-checkpoint', at: now(), image };
    await reduceAdmissionHistory(state.image, record, limit, 'checkpoint', proofHistory); read();
    const alreadyCaptured = state.image.version === 2 && admissionRoleHistoriesIdentity(state.image.roles) === admissionRoleHistoriesIdentity(roles);
    let capacity = { fits: true, requiredBlocks: 0, requiredCiphertextBytes: 0, availableBlocks: 0, availableCiphertextBytes: 0 };
    if (!alreadyCaptured) {
      const plaintext = encodeAdmissionHistoryRecord(record);
      try { capacity = recordHeadroom({ kind: 'checkpoint', generation: state.root.generation, sequence: state.applied!.sequence + 1,
        previous: state.applied!.id }, plaintext.length, image, false).capacity; }
      finally { plaintext.fill(0); }
    }
    return { roles, image, review: { kind: 'admission-history-role-capture' as const,
      witnessVotes: roles.witness?.votes.length ?? 0, coordinatorCertificates: roles.coordinator?.certificates.length ?? 0,
      witnessDenials: roles.witness?.retiredIssuerKeys.length ?? 0, coordinatorDenials: roles.coordinator?.retiredIssuerKeys.length ?? 0,
      alreadyCaptured, ...capacity,
      approvalDigest: historyDigest(`resonance:admission-history-role-capture:v1\n${JSON.stringify([participant, contextId, id(state.root), state.applied, state.image, roles])}`) } };
  }
  function roleRetirement(role: 'witness' | 'coordinator', issuerKey: string) {
    const image = available().image, state = image.version === 2 ? image.roles[role] : null;
    if (!state) throw new Error('Admission role has not been captured');
    const claims = 'votes' in state ? state.votes : state.certificates.map(cert => cert.votes[0]);
    return planAdmissionHistoryRetirement({ role, participant: 'witness' in state ? state.witness : state.coordinator,
      policy: image.policy, issuerKey, state, retiredIssuerKeys: state.retiredIssuerKeys, entries: claims.length,
      remove: claims.filter(claim => claim.issuerKey === issuerKey).length, maximumEntries: limit, now: now() });
  }
  function certificationCheckpoint() {
    const state = available();
    if (state.image.policyProof) throw new Error('Policy proof ancestry requires proof-preserving certification; business-only certification is unsupported'); writerMatches();
    const checkpoint = writer!.read().committed?.envelope;
    if (!checkpoint || checkpoint.kind !== 'checkpoint' || checkpoint.sequence === 0
      || id(checkpoint) !== state.applied!.id) throw new Error('Certification requires the latest applied complete state checkpoint');
    const record = decode(checkpoint);
    if (!exactWitnessFields(record, ['version', 'kind', 'image', 'at']) || record.version !== 1
      || record.kind !== 'admission-state-checkpoint' || !Number.isSafeInteger(record.at)
      || JSON.stringify(record.image) !== JSON.stringify(state.image)) {
      throw new Error('Certification checkpoint does not preserve the current complete state');
    }
    assertArchivedAdmissionPolicyCurrent(state.image.policy, record.at as number);
    const genesisId = state.version === 4 ? id(state.restoration.genesis) : id(state.root);
    const facts = { kind: 'admission-history-checkpoint-certification' as const, contextId, genesisId,
      rootId: id(state.root), generation: checkpoint.generation, sequence: checkpoint.sequence, envelopeId: id(checkpoint),
      enableLocalCheckpointRepair: true as const, enableReplicaPrefixRetirement: true as const };
    return { checkpoint, plan: { ...facts, recordsRetained: state.image.state.spends.length,
      permanentDenialsRetained: state.image.state.retiredIssuerKeys.length,
      filesRemoved: 0 as const, bytesReclaimed: 0 as const,
      approvalDigest: historyDigest(`resonance:admission-history-checkpoint-certification-review:v1\n${JSON.stringify([participant, facts])}`),
      notice: 'Retains proof locally and enables authenticated checkpoint repair with certified redundant-prefix retirement on volunteers. Owner history remains retained; fresh writer acknowledgements are still required.' } };
  }
  function retirement(issuerKey: string) {
    const { image } = available(), state = image.state;
    return { ...planAdmissionHistoryRetirement({ role: 'local-spends', participant, policy: image.policy, issuerKey, state,
      retiredIssuerKeys: state.retiredIssuerKeys, entries: state.spends.length,
      remove: state.spends.filter(row => row.issuerKey === issuerKey).length, maximumEntries: limit, now: now() }),
      unattributedRecordsRetained: state.spends.filter(row => row.issuerKey === null).length };
  }
  function prefixRetirement() {
    const { checkpoint } = certificationCheckpoint(), state = available(), proof = writer!.compactionAnchor();
    if (state.image.policyProof) throw new Error('Policy proof ancestry cannot be retired by business-only checkpoints');
    if (!proof || proof.proposal.envelopeId !== id(checkpoint)) throw new Error('Prefix retirement requires certification of the latest complete state');
    const archive = writer!.planPrefixRetirement();
    return { archive, review: { ...archive, kind: 'admission-history-prefix-retirement' as const,
      recordsRetained: state.image.state.spends.length, permanentDenialsRetained: state.image.state.retiredIssuerKeys.length,
      approvalDigest: historyDigest(`resonance:admission-history-prefix-retirement:v1\n${JSON.stringify([participant, archive.approvalDigest, state.image])}`) } };
  }
  function close() {
    if (!closed) { closed = true; certificationController?.abort(); proofCache.clear(); membershipCache.clear(); writer?.close(); storage?.close(); key.fill(0); signer.secretKey.fill(0); }
  }
  try {
    let initial: ProtectedAdmissionState | undefined;
    if (options.initialize) {
      if (p.restore) {
        const restored = readPreparedAdmissionRestore(p.restore.preparation, p.restore.approvedDigest, participant, context, policy);
        // Check this handle's encryption key before any initialization can publish state.
        await parseAdmissionHistoryImage(decode(restored.restoration.genesis), context.authority, limit, proofHistory);
        initial = { version: 4, context, ...restored, image: structuredClone(restored.restoration.baseline), applied: null, pending: restored.root };
      } else initial = baseline({ version: 2, authority: policy.authority, spends: [], retiredIssuerKeys: [] });
    }
    // v3/v4 share the original path and encryption domain. Older local-only readers reject both.
    storage = openEncryptedLocalState<AdmissionSpendState | ProtectedAdmissionState>({
      path: join(participant, 'admission-spends-v2.jsonl'), key, domain: 'resonance:admission-local-spends:v2', maxBytes: 32 * 1024 * 1024,
      mode: options.initialize ? 'create-new' : 'open-existing',
      initial: initial!,
      decodeLegacy: bytes => decodeLegacyAdmissionSpendState(bytes, policy.authority, limit),
      validate(value): value is AdmissionSpendState | ProtectedAdmissionState {
        if (exactWitnessFields(value, ['version','context','root','image','applied','pending']) && value.version === 3) return true;
        if (exactWitnessFields(value, ['version','context','root','image','applied','pending','restoration']) && value.version === 4) return true;
        try { parseAdmissionSpendState(value, policy, limit); return true; } catch { return false; }
      },
    });
    const previous = storage.read();
    if (previous.version === 2) {
      if (!p.promoteLocalHistory) throw new Error('Local admission history needs explicit protection promotion');
      storage.write(baseline(previous)); // Keep the same lock across validation, capture and format fencing.
    }
    const state = read();
    if (options.expectedStateDigest !== undefined && historyDigest(JSON.stringify(state)) !== options.expectedStateDigest) {
      throw new Error('Retained admission state changed after review');
    }
    if (historyCheckpointContextId(state.context) !== contextId) throw new Error('Protected admission history pins changed');
    const root = parseHistoryCheckpointEnvelope(state.root, context);
    if (root.sequence !== 0 || (state.version === 3 ? root.generation !== 0 || root.kind !== 'checkpoint' : root.kind !== 'continuation')) {
      throw new Error('Invalid protected admission baseline');
    }
    if (state.version === 4 && (!exactWitnessFields(state.restoration, ['genesis','baseline','replayDigest']) || !isHistoryDigest(state.restoration.replayDigest))) {
      throw new Error('Invalid protected restoration capture');
    }
    const genesis = state.version === 4 ? parseHistoryCheckpointEnvelope(state.restoration.genesis, context) : root;
    if (genesis.generation !== 0 || genesis.sequence !== 0 || genesis.kind !== 'checkpoint') throw new Error('Invalid protected admission genesis');
    const creatingWriter = p.initializeWriter || p.initializeArchive || p.resumePristineArchive;
    function openWriter() {
      if (p.initializeWriter && state.applied !== null) throw new Error('Cannot initialize a writer for already applied admission history');
      writer = createRetainedHistoryCheckpointWriter({ directory: join(participant, 'admission-history-writer'), localKey: key,
        context, signingKey: signer, rootId: id(root), generation: root.generation, members: p.members,
        genesisId: state.version === 4 ? id(state.restoration.genesis) : id(root),
        requireCurrentHead: true,
        ...(root.kind === 'continuation' ? { continuation: root } : {}),
        initialize: p.initializeWriter, initializeArchive: p.initializeArchive, resumePristineArchive: p.resumePristineArchive, timeoutMs: p.timeoutMs, transport: p.transport,
        maxArchiveBlocks: p.maxArchiveBlocks, maxArchiveBytes: p.maxArchiveBytes });
      writerMatches();
    }
    // Existing v3 proofs read the retained writer. New writer/archive creation
    // waits until the complete image and its explicit original ancestry validate.
    if (!inspectionOnly && !creatingWriter) openWriter();
    const originalGenesis = await parseAdmissionHistoryImage(decode(genesis), context.authority, limit, proofHistory);
    if (`sha256:${archivedAdmissionPolicyDigest(originalGenesis.policy)}` !== context.policyDigest) throw new Error('Protected baseline policy mismatch');
    const original = state.version === 4 ? await parseAdmissionHistoryImage(state.restoration.baseline, context.authority, limit, proofHistory) : originalGenesis;
    if (originalGenesis.policy.version !== 3 && original.policy.version !== 3) assertAdmissionPolicySuccessor(originalGenesis.policy, original.policy); else if (!original.policyProof) throw new Error('Restored v3 baseline lacks original policy proof');
    if (state.version === 4 && (root.kind !== 'continuation' || state.restoration.replayDigest !== admissionHistoryReplayDigest(contextId, id(genesis),
      historySuccessorProposalId(root.proposal), original))) throw new Error('Protected restoration does not match its selected image');
    const image = await parseAdmissionHistoryImage(state.image, context.authority, limit, proofHistory);
    if (original.policy.version !== 3 && image.policy.version !== 3) assertAdmissionPolicySuccessor(original.policy, image.policy); else if (!image.policyProof) throw new Error('V3 image lacks retained original proof');
    if (image.policy.version !== 3 && policy.version !== 3) assertAdmissionPolicySuccessor(image.policy, policy); else if (policy.revision < image.policy.revision || policy.revision === image.policy.revision && archivedAdmissionPolicyDigest(policy) !== archivedAdmissionPolicyDigest(image.policy)) throw new Error('Configured policy differs from retained protected head');
    if (original.state.retiredIssuerKeys.some(key => !image.state.retiredIssuerKeys.includes(key))) throw new Error('Protected history lost a baseline denial');
    if (original.version === 2) assertAdmissionRoleRetention(original.roles, image.version === 2 ? image.roles : { witness: null, coordinator: null });
    if (state.applied === null) {
      if (!state.pending || id(parseHistoryCheckpointEnvelope(state.pending, context)) !== id(root)
        || JSON.stringify(image) !== JSON.stringify(original)) throw new Error('Incomplete protected baseline');
    } else {
      if (!exactWitnessFields(state.applied, ['sequence','id']) || !Number.isSafeInteger(state.applied.sequence)
        || state.applied.sequence < 0 || !isHistoryDigest(state.applied.id)
        || (state.applied.sequence === 0 && state.applied.id !== id(root))) throw new Error('Invalid applied admission history head');
      if (state.pending !== null) {
        const pending = parseHistoryCheckpointEnvelope(state.pending, context);
        if (pending.generation !== root.generation || pending.kind === 'continuation' || pending.sequence !== state.applied.sequence + 1
          || pending.previous !== state.applied.id) throw new Error('Invalid pending admission history successor');
        await nextImage(state);
      }
    }
    if (!inspectionOnly && creatingWriter) openWriter();

  } catch (error) { close(); throw error; }

  return {
    /** Opening and enrollment are offline; the caller enrolls this exact root on the pinned replicas. */
    enrollment() { return { context: structuredClone(context), root: structuredClone(read().root) }; },
    read() { return structuredClone(read()); },
    /** Current-generation accounting only; neither a fresh audit nor a remote copy count. */
    health() { const state = read(); return { initialized: readyConfirmed, busy: active, pending: state.pending !== null,
      ...writer!.historyUsage() }; },
    /** Local limit review: absolute position distinguishes archived intent from
     * retained payload count after prefix retirement. No peer data is exposed. */
    pendingUnarchivedBytes() {
      const state = read(), status = writer!.historyStatus();
      return state.pending && state.pending.sequence >= status.sequenceSlots ? Buffer.byteLength(JSON.stringify(state.pending)) : 0;
    },
    policy(): ArchivedAdmissionPolicy { return structuredClone(serving().image.policy); },
    /** Trusted role adapters validate membership and retry identity before signing.
     * Pending state remains visible so an exact uncertain decision can resume. */
    roleState() {
      if (!readyConfirmed) throw new Error('Protected admission history needs fresh readiness confirmation');
      const image = read().image;
      return image.version === 2 ? structuredClone(image.roles) : { witness: null, coordinator: null };
    },
    pendingRoleDecision(): Exclude<AdmissionRoleMutation, { kind: 'role-retire' }> | null {
      if (!readyConfirmed) throw new Error('Protected admission history needs fresh readiness confirmation');
      const pending = read().pending; if (!pending) return null;
      const record = decode(pending) as AdmissionHistoryRecord;
      if (record.kind === 'authorized-spend') return { version: 1, kind: 'coordinator-certificate', at: record.at, certificate: structuredClone(record.certificate) };
      return record.kind === 'witness-vote' || record.kind === 'coordinator-certificate' ? structuredClone(record) : null;
    },
    planRoleCapture(value: AdmissionRoleHistories) { return exclusive(async () => (await roleCapturePlan(value)).review); },
    captureRoles(value: AdmissionRoleHistories, approvedDigest: string) { return exclusive(async () => {
      serving(); const captured = await roleCapturePlan(value);
      if (captured.review.approvalDigest !== approvedDigest) throw new Error('Admission role capture approval changed');
      if (!captured.review.fits) throw new Error('Admission role capture needs checkpoint headroom');
      if (!captured.review.alreadyCaptured) await commit({ version: 1, kind: 'admission-roles-checkpoint', at: now(), image: captured.image });
      return captured.review;
    }); },
    writeRoleDecision(value: Omit<Extract<AdmissionRoleMutation, { kind: 'witness-vote' }>, 'version' | 'at'>
      | Omit<Extract<AdmissionRoleMutation, { kind: 'coordinator-certificate' }>, 'version' | 'at'>) {
      const decision = structuredClone(value);
      return exclusive(async () => {
        if (!readyConfirmed) throw new Error('Protected admission history needs fresh readiness confirmation');
        const state = read(), record = { version: 1 as const, at: now(), ...decision };
        if (state.pending) {
          const pending = decode(state.pending) as AdmissionRoleMutation;
          const field = decision.kind === 'witness-vote' ? 'vote' : 'certificate';
          if (!exactWitnessFields(pending, ['version', 'kind', 'at', field]) || pending.kind !== decision.kind
            || JSON.stringify((pending as unknown as Record<string, unknown>)[field]) !== JSON.stringify((decision as unknown as Record<string, unknown>)[field])) {
            throw new Error('Complete the pending protected history operation first');
          }
          await finishPending();
        }
        const before = available().image, reduced = await reduceAdmissionHistory(before, record, limit, 'delta', proofHistory); read();
        if (before.version !== 2 || reduced.image.version !== 2) throw new Error('Admission role has not been captured');
        if (admissionRoleHistoriesIdentity(before.roles) !== admissionRoleHistoriesIdentity(reduced.image.roles)) await commit(record);
      });
    },
    planRoleRetirement(role: 'witness' | 'coordinator', issuerKey: string) {
      if (active) throw new Error('Protected admission history operation is in progress'); return roleRetirement(role, issuerKey);
    },
    retireRole(role: 'witness' | 'coordinator', issuerKey: string, approvedDigest: string) { return exclusive(async () => {
      serving(); const review = roleRetirement(role, issuerKey);
      if (review.approvalDigest !== approvedDigest) throw new Error('Admission role retirement approval changed');
      await commit({ version: 1, kind: 'role-retire', at: now(), role, issuerKey }); return review;
    }); },
    ready() { return exclusive(async () => {
      readyConfirmed = false;
      let fresh = await finishPending();
      if (archivedAdmissionPolicyDigest(read().image.policy) !== archivedAdmissionPolicyDigest(policy)) {
        const current = available().image;
        if (current.policyProof) {
          if (!current.policyTrust || !sameAdmissionPolicyHead(current.policyProof.head, current.policyTrust.installed)) throw new Error('Finish exact protected proof backfill before policy installation');
          const advance = await parseArchivedAdmissionPolicyAdvance(options.policyAdvance, current.policyProof.context);
          if (!sameAdmissionPolicyHead(advance.commitment.previous, current.policyTrust.installed) || archivedAdmissionPolicyDigest(advance.policy) !== archivedAdmissionPolicyDigest(policy)) throw new Error('Relay policy installation requires its exact immediate signed advance');
          const append = parseAdmissionPolicyProofAppend({ version: 1, kind: 'advance', advance, pages: (options.policyPages ?? []).map(page => ({ digest: page.digest, data: Buffer.from(page.bytes).toString('base64url') })) });
          const beforeTrust = options.policyTrust ?? current.policyTrust, head = advance.commitment.next;
          const policyTrust = parseAdmissionPolicyTrust({ ...beforeTrust, installed: head, observed: head.revision > beforeTrust.observed.revision ? head : beforeTrust.observed }, policy);
          await commit({ version: 1, kind: 'admission-policy-proof-checkpoint', at: now(), image: { ...current, policy,
            policyTrust, policyProof: admissionPolicyProofReference(current.policyProof.context, head, current.policyProof.limits), policyProofAppend: append } });
        } else {
          if (policy.version === 3) throw new Error('Backfill original protected relay policy proof before installing v3');
          await commit({ version: 1, kind: 'policy', at: now(), policy });
        }
        fresh = true;
      }
      // Reopen must not turn a coherent stale owner backup or an old root receipt into live admission.
      if (!fresh) await writer!.replicate(writer!.read().committed!.envelope);
      assertArchivedAdmissionPolicyCurrent(available().image.policy, now());
      readyConfirmed = true;
    }); },
    async resolvedPolicy(signal?: AbortSignal) {
      const image = serving().image;
      if (!image.policyProof || !image.policyTrust || !sameAdmissionPolicyHead(image.policyProof.head, image.policyTrust.installed)) throw new Error('Protected relay has not completed exact original proof backfill');
      const proof = createAdmissionPolicyHistoryProof({ ...proofHistory, reference: image.policyProof, candidate: image, signal });
      return { capability: await proof.matches(image.policy), reference: image.policyProof, freshness: image.policyTrust };
    },
    backfillPolicyProof(appendValue: unknown, trustValue: AdmissionPolicyTrust, limits?: AdmissionPolicyArchiveLimits, signal?: AbortSignal) {
      const append = parseAdmissionPolicyProofAppend(appendValue), trust = structuredClone(trustValue);
      return exclusive(async () => {
        serving(); const image = available().image; proofSignal = signal;
        try {
          signal?.throwIfAborted(); const policyTrust = parseAdmissionPolicyTrust(trust, image.policy);
          if (image.policyTrust && JSON.stringify(image.policyTrust) !== JSON.stringify(policyTrust)) throw new Error('Proof backfill must preserve retained installed freshness');
          let head;
          if (!image.policyProof) { if (append.kind !== 'genesis' || !limits) throw new Error('Relay proof backfill starts with original genesis and explicit limits'); head = policyTrust.context.genesis; }
          else { if (append.kind !== 'advance' || !sameAdmissionPolicyHead(append.advance.commitment.previous, image.policyProof.head)) throw new Error('Relay proof backfill requires one exact next step'); head = append.advance.commitment.next; }
          if (head.revision > policyTrust.installed.revision) throw new Error('Relay proof backfill exceeds installed head');
          const policyProof = admissionPolicyProofReference(policyTrust.context, head, image.policyProof?.limits ?? limits!);
          await commit({ version: 1, kind: 'admission-policy-proof-checkpoint', at: now(), image: { ...image, proofVersion: 1, policyTrust, policyProof, policyProofAppend: append } });
          return { head, complete: sameAdmissionPolicyHead(head, policyTrust.installed) };
        } finally { proofSignal = undefined; }
      });
    },
    observePolicy(observation: AdmissionPolicyObservation) { return exclusive(async () => {
      const image = serving().image; if (!image.policyTrust) throw new Error('Protected relay policy observers are absent');
      const checked = inspectAdmissionPolicyObservation(image.policyTrust, observation, now());
      if (checked.state !== image.policyTrust) await commit({ version: 1, kind: 'admission-policy-proof-checkpoint', at: now(), image: { ...image, policyTrust: checked.state } });
      if (checked.error) throw new Error(checked.error);
    }); },
    size() { return serving().image.state.spends.length; },
    get(spend: string) { const row = serving().image.state.spends.find(row => row.spend === spend); return row ? { ...row } : undefined; },
    isRetired(issuerKey: string) { const { image } = serving(); return image.state.retiredIssuerKeys.includes(issuerKey) || (image.policy.version === 3 ? !image.policy.keys.some(entry => admissionKeyFingerprint(entry.profile.issuerPublicKey) === issuerKey) : isArchivedAdmissionKey(image.policy, issuerKey)); },
    planCheckpoint() { if (active) throw new Error('Protected admission history operation is in progress'); return checkpointPlan(); },
    checkpoint(approvedDigest: string) { return exclusive(async () => {
      const before = serving(), plan = checkpointPlan();
      if (approvedDigest !== plan.approvalDigest) throw new Error('History changed or checkpoint approval does not match; review again');
      await commit({ version: 1, kind: 'admission-state-checkpoint', at: now(), image: before.image });
      const applied = available().applied!;
      return { ...plan, envelopeId: applied.id, sequence: applied.sequence, durableCopies: 4 as const };
    }); },
    planCheckpointCertification() {
      if (active) throw new Error('Protected admission history operation is in progress');
      return certificationCheckpoint().plan;
    },
    planPrefixRetirement() {
      if (active) throw new Error('Protected admission history operation is in progress');
      return prefixRetirement().review;
    },
    retirePrefix(approvedDigest: string) { return exclusive(async () => {
      const { archive, review } = prefixRetirement();
      if (approvedDigest !== review.approvalDigest) throw new Error('History prefix changed; review retirement again');
      writer!.retirePrefix(archive.approvalDigest); return review;
    }); },
    certifyCheckpoint(approvedDigest: string, settings: Pick<Parameters<typeof collectHistoryCompactionCertificate>[0], 'signal' | 'timeoutMs' | 'transport'> = {}) {
      return exclusive(async () => {
        serving(); const { checkpoint, plan } = certificationCheckpoint();
        if (approvedDigest !== plan.approvalDigest) throw new Error('History changed or certification approval does not match; review again');
        const issuedAt = Date.now(), timeoutMs = settings.timeoutMs ?? p.timeoutMs ?? 30000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 30000) throw new Error('Invalid checkpoint certification timeout');
        const proposal = createHistoryCompactionProposal({ genesisId: plan.genesisId, rootId: plan.rootId, checkpoint,
          issuedAt, expiresAt: issuedAt + timeoutMs }, context, signer);
        const controller = new AbortController(), external = settings.signal, cancel = () => controller.abort();
        certificationController = controller; external?.addEventListener('abort', cancel, { once: true });
        if (external?.aborted) cancel();
        try {
          const certificate = await collectHistoryCompactionCertificate({ context, genesisId: plan.genesisId, checkpoint, proposal,
            members: p.members, signal: controller.signal, timeoutMs, transport: settings.transport });
          serving();
          if (certificationCheckpoint().plan.approvalDigest !== approvedDigest) throw new Error('History changed during checkpoint certification');
          if (controller.signal.aborted) throw new Error('Checkpoint certification cancelled');
          return writer!.retainCompactionAnchor(certificate, writer!.historyReviewDigest(), { reclaimReplicaPrefix: true });
        } finally {
          external?.removeEventListener('abort', cancel); controller.abort();
          if (certificationController === controller) certificationController = undefined;
        }
      });
    },
    /** A single durable intent/replication/apply boundary for matching proof and spend. */
    writeAuthorizedSpend(value: AdmissionSpendRecord & { issuerKey: string }, suppliedCertificate: AdmissionSpendCertificate): Promise<void> {
      const row = structuredClone(value), certificate = structuredClone(suppliedCertificate);
      return exclusive(async () => {
        if (!readyConfirmed) throw new Error('Protected admission history needs fresh readiness confirmation');
        const state = read();
        if (state.pending) {
          const pending = decode(state.pending);
          if (!exactWitnessFields(pending, ['version', 'kind', 'at', 'certificate', 'row']) || pending.kind !== 'authorized-spend'
            || JSON.stringify(pending.row) !== JSON.stringify(row) || JSON.stringify(pending.certificate) !== JSON.stringify(certificate)) {
            throw new Error('Complete the pending protected history operation first');
          }
          await finishPending(); return;
        }
        const before = available().image, record = { version: 1 as const, kind: 'authorized-spend' as const, at: now(), certificate, row };
        const reduced = await reduceAdmissionHistory(before, record, limit, 'delta', proofHistory); read();
        if (before.version === 2 && reduced.image.version === 2
          && admissionRoleHistoriesIdentity(before.roles) === admissionRoleHistoriesIdentity(reduced.image.roles)
          && JSON.stringify(before.state) === JSON.stringify(reduced.image.state)) return;
        await commit(record);
      });
    },
    write(value: AdmissionSpendRecord & { issuerKey: string }) {
      const row = structuredClone(value);
      return exclusive(async () => {
      if (!readyConfirmed) throw new Error('Protected admission history needs fresh readiness confirmation');
      const state = read();
      if (state.pending) {
        const operation = decode(state.pending);
        if (!exactWitnessFields(operation, ['version','kind','at','row']) || operation.kind !== 'spend'
          || JSON.stringify(operation.row) !== JSON.stringify(row)) throw new Error('Complete the pending protected history operation first');
        await finishPending(); return;
      }
      const previous = available().image.state.spends.find(r => r.spend === row.spend);
      // Even exact retries validate structure, attribution, permanent fences and the historical retry cutoff.
      const value = { version: 1 as const, kind: 'spend' as const, at: now(), row };
      await reduceAdmissionHistory(state.image, value, limit, 'delta', proofHistory); read();
      if (previous?.issuerKey === row.issuerKey) return;
      await commit(value);
      });
    },
    planRetirement(issuerKey: string) { if (active) throw new Error('Protected admission history operation is in progress'); return retirement(issuerKey); },
    retire(issuerKey: string, approvedDigest: string) { return exclusive(async () => {
      serving();
      const plan = retirement(issuerKey);
      if (approvedDigest !== plan.approvalDigest) throw new Error('Admission history changed or approval does not match; review retirement again');
      await commit({ version: 1, kind: 'retire', at: now(), issuerKey }); return plan;
    }); },
    planLegacyRecovery(proofs: unknown) { return exclusive(async () => {
      const { image } = available();
      if (image.policy.version === 3) throw new Error('Legacy recovery is not migrated to v3');
      const checked = await checkAdmissionLegacyRecovery({ directory: participant, policy: image.policy, state: image.state, proofs, now });
      read(); return checked.plan;
    }); },
    recoverLegacy(proofs: unknown, approvedDigest: string) { return exclusive(async () => {
      serving();
      const { image } = available();
      if (image.policy.version === 3) throw new Error('Legacy recovery is not migrated to v3');
      const checked = await checkAdmissionLegacyRecovery({ directory: participant, policy: image.policy, state: image.state, proofs, now });
      read();
      if (typeof approvedDigest !== 'string' || approvedDigest !== checked.plan.approvalDigest) throw new Error('Recovery evidence, history or approval changed; review recovery again');
      await commit({ version: 1, kind: 'legacy-recovery', at: now(), attributions: checked.attributions }); return checked.plan;
    }); },
    close,
  };
}
