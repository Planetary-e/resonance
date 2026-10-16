/** Same-file protection fence, durable pending ciphertext, four copies, then live admission state. */
import { join, resolve } from 'node:path';
import type { SigningKeyPair } from '@resonance/core';
import { copyAdmissionSigningKey, exactWitnessFields } from '@resonance/core/admission-witness';
import { admissionPolicyDigest, assertAdmissionPolicyCurrent, assertAdmissionPolicySuccessor,
  isArchivedAdmissionKey, verifyAdmissionPolicy, type SignedAdmissionPolicy } from '@resonance/core/admission-policy';
import { HISTORY_DELTA_MAX_PAYLOAD, historyCheckpointContextId, historyCheckpointEnvelopeId, isHistoryDigest, openHistoryCheckpoint,
  parseHistoryCheckpointContext, parseHistoryCheckpointEnvelope, sealHistoryCheckpoint,
  type HistoryCheckpointContext, type HistoryCheckpointEnvelope } from '@resonance/core/history-checkpoint';
import { openEncryptedLocalState } from '@resonance/core/local-state';
import { historySuccessorProposalId } from '@resonance/core/history-successor';
import { createRetainedHistoryCheckpointWriter } from './history-retained-writer.js';
import { admissionHistoryReplayDigest } from './admission-history-replay.js';
import { readPreparedAdmissionRestore, type AdmissionHistoryRestoration, type PreparedAdmissionHistoryRestore } from './admission-history-restore.js';
import { decodeLegacyAdmissionSpendState, parseAdmissionSpendState, type AdmissionSpendRecord } from './admission-spend-history.js';
import { checkAdmissionLegacyRecovery, type AdmissionSpendState } from './admission-legacy-recovery.js';
import { planAdmissionHistoryRetirement } from './admission-history-retirement.js';
import { encodeAdmissionHistoryRecord, parseAdmissionHistoryImage, reduceAdmissionHistory,
  type AdmissionHistoryImage, type AdmissionHistoryMutation, type AdmissionHistoryPolicyCheckpoint } from './admission-history-records.js';

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
  /** Explicit same-file promotion of an intact existing local ledger. */
  promoteLocalHistory?: boolean;
  /** Creation only, into the independently reviewed new directory. Reopen omits this capability. */
  restore?: { preparation: PreparedAdmissionHistoryRestore; approvedDigest: string };
  timeoutMs?: number; transport?: WriterOptions['transport']; maxArchiveBlocks?: number; maxArchiveBytes?: number;
}

export async function openProtectedAdmissionSpendHistory(options: {
  directory: string; encryptionKey: Uint8Array; authority: string; policy: unknown;
  initialize?: boolean; maxSpends?: number; now?: () => number; protection: AdmissionHistoryProtection;
}) {
  const limit = options.maxSpends ?? 10000, now = options.now ?? Date.now;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid admission spend history capacity');
  const policy = await verifyAdmissionPolicy(options.policy, options.authority);
  assertAdmissionPolicyCurrent(policy, now());
  const p = options.protection, context = parseHistoryCheckpointContext(p.context), contextId = historyCheckpointContextId(context);
  if (context.authority !== options.authority) throw new Error('Wrong admission history authority');
  if (p.restore && !options.initialize) throw new Error('Reviewed restore only initializes a new protected history');
  const key = Buffer.from(options.encryptionKey), signer = copyAdmissionSigningKey(p.signingKey);
  if (key.length !== 32 || Buffer.from(signer.publicKey).toString('base64url') !== context.owner) {
    key.fill(0); signer.secretKey.fill(0); throw new Error('Wrong admission history owner or encryption key');
  }
  const participant = resolve(options.directory);
  let storage: ReturnType<typeof openEncryptedLocalState<AdmissionSpendState | ProtectedAdmissionState>> | undefined;
  let writer: ReturnType<typeof createRetainedHistoryCheckpointWriter> | undefined;
  let closed = false, active = false, readyConfirmed = false;
  function baseline(state: AdmissionSpendState): ProtectedAdmissionState {
    if (context.policyDigest !== `sha256:${admissionPolicyDigest(policy)}`) throw new Error('Baseline policy does not match pinned history');
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
      ? parseAdmissionHistoryImage(state.restoration.baseline, context.authority, limit)
      : parseAdmissionHistoryImage(decode(state.pending), context.authority, limit);
    if (state.pending.kind === 'continuation') throw new Error('Protected admission restore requires reviewed successor activation');
    return (await reduceAdmissionHistory(state.image, decode(state.pending), limit, state.pending.kind)).image;
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
    active = true;
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
  async function commit(value: AdmissionHistoryMutation): Promise<void> {
    const before = available();
    const kind = value.kind === 'policy' && Buffer.byteLength(JSON.stringify(value)) > HISTORY_DELTA_MAX_PAYLOAD ? 'checkpoint' : 'delta';
    const record: AdmissionHistoryMutation | AdmissionHistoryPolicyCheckpoint = kind === 'checkpoint' && value.kind === 'policy'
      ? { version: 1, kind: 'admission-policy-checkpoint', at: value.at, image: { ...before.image, policy: value.policy } } : value;
    const reduced = await reduceAdmissionHistory(before.image, record, limit, kind); read();
    const pending = sealHistoryCheckpoint({ context, header: { kind, generation: before.root.generation,
      sequence: before.applied!.sequence + 1, previous: before.applied!.id },
      plaintext: encodeAdmissionHistoryRecord(reduced.record), encryptionKey: key, signingKey: signer });
    storage!.write({ ...before, pending });
    await finishPending();
  }
  function retirement(issuerKey: string) {
    const { image } = available(), state = image.state;
    return { ...planAdmissionHistoryRetirement({ role: 'local-spends', participant, policy: image.policy, issuerKey, state,
      retiredIssuerKeys: state.retiredIssuerKeys, entries: state.spends.length,
      remove: state.spends.filter(row => row.issuerKey === issuerKey).length, maximumEntries: limit, now: now() }),
      unattributedRecordsRetained: state.spends.filter(row => row.issuerKey === null).length };
  }
  function close() {
    if (!closed) { closed = true; writer?.close(); storage?.close(); key.fill(0); signer.secretKey.fill(0); }
  }
  try {
    let initial: ProtectedAdmissionState | undefined;
    if (options.initialize) {
      if (p.restore) {
        const restored = readPreparedAdmissionRestore(p.restore.preparation, p.restore.approvedDigest, participant, context, policy);
        // Check this handle's encryption key before any initialization can publish state.
        await parseAdmissionHistoryImage(decode(restored.restoration.genesis), context.authority, limit);
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
    const originalGenesis = await parseAdmissionHistoryImage(decode(genesis), context.authority, limit);
    if (`sha256:${admissionPolicyDigest(originalGenesis.policy)}` !== context.policyDigest) throw new Error('Protected baseline policy mismatch');
    const original = state.version === 4 ? await parseAdmissionHistoryImage(state.restoration.baseline, context.authority, limit) : originalGenesis;
    assertAdmissionPolicySuccessor(originalGenesis.policy, original.policy);
    if (state.version === 4 && (root.kind !== 'continuation' || state.restoration.replayDigest !== admissionHistoryReplayDigest(contextId, id(genesis),
      historySuccessorProposalId(root.proposal), original))) throw new Error('Protected restoration does not match its selected image');
    const image = await parseAdmissionHistoryImage(state.image, context.authority, limit);
    assertAdmissionPolicySuccessor(original.policy, image.policy);
    assertAdmissionPolicySuccessor(image.policy, policy);
    if (original.state.retiredIssuerKeys.some(key => !image.state.retiredIssuerKeys.includes(key))) throw new Error('Protected history lost a baseline denial');
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
    if (p.initializeWriter && state.applied !== null) throw new Error('Cannot initialize a writer for already applied admission history');
    writer = createRetainedHistoryCheckpointWriter({ directory: join(participant, 'admission-history-writer'), localKey: key,
      context, signingKey: signer, rootId: id(root), generation: root.generation, members: p.members,
      requireCurrentHead: true,
      ...(root.kind === 'continuation' ? { continuation: root } : {}),
      initialize: p.initializeWriter, initializeArchive: p.initializeArchive, timeoutMs: p.timeoutMs, transport: p.transport,
      maxArchiveBlocks: p.maxArchiveBlocks, maxArchiveBytes: p.maxArchiveBytes });
    writerMatches();
  } catch (error) { close(); throw error; }

  return {
    /** Opening and enrollment are offline; the caller enrolls this exact root on the pinned replicas. */
    enrollment() { return { context: structuredClone(context), root: structuredClone(read().root) }; },
    read() { return structuredClone(read()); },
    policy(): SignedAdmissionPolicy { return structuredClone(serving().image.policy); },
    ready() { return exclusive(async () => {
      readyConfirmed = false;
      let fresh = await finishPending();
      if (admissionPolicyDigest(read().image.policy) !== admissionPolicyDigest(policy)) {
        await commit({ version: 1, kind: 'policy', at: now(), policy });
        fresh = true;
      }
      // Reopen must not turn a coherent stale owner backup or an old root receipt into live admission.
      if (!fresh) await writer!.replicate(writer!.read().committed!.envelope);
      assertAdmissionPolicyCurrent(available().image.policy, now());
      readyConfirmed = true;
    }); },
    size() { return serving().image.state.spends.length; },
    get(spend: string) { const row = serving().image.state.spends.find(row => row.spend === spend); return row ? { ...row } : undefined; },
    isRetired(issuerKey: string) { const { image } = serving(); return image.state.retiredIssuerKeys.includes(issuerKey) || isArchivedAdmissionKey(image.policy, issuerKey); },
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
      await reduceAdmissionHistory(state.image, value, limit); read();
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
      const checked = await checkAdmissionLegacyRecovery({ directory: participant, policy: image.policy, state: image.state, proofs, now });
      read(); return checked.plan;
    }); },
    recoverLegacy(proofs: unknown, approvedDigest: string) { return exclusive(async () => {
      serving();
      const { image } = available();
      const checked = await checkAdmissionLegacyRecovery({ directory: participant, policy: image.policy, state: image.state, proofs, now });
      read();
      if (typeof approvedDigest !== 'string' || approvedDigest !== checked.plan.approvalDigest) throw new Error('Recovery evidence, history or approval changed; review recovery again');
      await commit({ version: 1, kind: 'legacy-recovery', at: now(), attributions: checked.attributions }); return checked.plan;
    }); },
    close,
  };
}
